// Shared transcripts travel through a durable SQLite outbox; credentials stay in env.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import express, { type Request } from "express";
import { config } from "./config.ts";
import { origin } from "./auth.ts";
import type { DB } from "./db.ts";

export interface ConxtDestination { key: string; label: string; submissionUrl: string; token: string }
type Row = Record<string, unknown>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseDestinations(raw: string | undefined): ConxtDestination[] {
  if (!raw?.trim()) return [];
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new Error("CONXT_DESTINATIONS must be a JSON array"); }
  if (!Array.isArray(values) || values.length > 50) throw new Error("Invalid CONXT_DESTINATIONS");
  const keys = new Set<string>();
  return values.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid Conxt destination");
    const d = value as ConxtDestination;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(d.key) || keys.has(d.key) || typeof d.label !== "string" ||
        !d.label.trim() || d.label.length > 256 || typeof d.token !== "string" ||
        !d.token.trim() || d.token.length > 1024 || /[\r\n]/.test(d.token)) throw new Error("Invalid Conxt destination fields");
    let url: URL;
    try { url = new URL(d.submissionUrl); } catch { throw new Error("Invalid Conxt submission URL"); }
    const match = /^\/api\/v1\/integrations\/([^/]+)\/sources$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        !match || !uuid.test(match[1])) throw new Error("Use the HTTPS Conxt integration submission URL");
    keys.add(d.key);
    return { key: d.key, label: d.label.trim(), submissionUrl: url.toString(), token: d.token.trim() };
  });
}

export function initConxt(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS conxt_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conxt_connections (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), destination_key TEXT NOT NULL,
      submission_url TEXT NOT NULL, label TEXT NOT NULL, connected_by TEXT NOT NULL REFERENCES users(id),
      connected_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conxt_active_room ON conxt_connections(room_id) WHERE enabled=1;
    CREATE TABLE IF NOT EXISTS conxt_meetings (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
      connection_id TEXT NOT NULL REFERENCES conxt_connections(id)
    );
    CREATE TRIGGER IF NOT EXISTS conxt_meeting_started AFTER INSERT ON meetings BEGIN
      INSERT INTO conxt_meetings(meeting_id,connection_id)
      SELECT NEW.id,id FROM conxt_connections WHERE room_id=NEW.room_id AND enabled=1;
    END;
    CREATE TABLE IF NOT EXISTS conxt_deliveries (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES conxt_connections(id),
      meeting_id TEXT NOT NULL REFERENCES meetings(id), payload TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      lease_id TEXT, lease_until INTEGER, receipt_id TEXT, remote_status TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(connection_id, meeting_id)
    );
    CREATE INDEX IF NOT EXISTS conxt_due ON conxt_deliveries(state,next_at);
  `);
  sql.prepare("INSERT OR IGNORE INTO conxt_settings VALUES ('instance_id', ?)").run(randomUUID());
}

/** Called inside the same transaction that ends a meeting. No network or model call. */
export function enqueueConxtMeeting(sql: DatabaseSync, meetingId: string) {
  if (sql.prepare("SELECT 1 FROM conxt_deliveries WHERE meeting_id=?").get(meetingId)) return;
  const row = sql.prepare(`SELECT m.id,m.room_id,m.started_at,r.name,c.id AS connection_id
    FROM meetings m JOIN rooms r ON r.id=m.room_id JOIN conxt_meetings cm ON cm.meeting_id=m.id
    JOIN conxt_connections c ON c.id=cm.connection_id
    WHERE m.id=? AND m.ended_at IS NOT NULL AND c.enabled=1`).get(meetingId) as Row | undefined;
  if (!row) return;
  const segments = sql.prepare(`SELECT speaker_name,kind,text,ts FROM segments
    WHERE meeting_id=? ORDER BY ts,rowid`).all(meetingId) as Row[];
  // Send exactly the recorded remarks, not generated notes or inferred decisions.
  const content = segments.map(s => `[${new Date(s.ts as number).toISOString()}] ${s.speaker_name} (${s.kind}): ${s.text}`).join("\n");
  const instance = (sql.prepare("SELECT value FROM conxt_settings WHERE key='instance_id'").get() as Row).value;
  const id = randomUUID();
  const body: Record<string, unknown> = {
    id, external_id: `stand:${instance}:${meetingId}`,
    external_revision: "1", title: String(row.name).slice(0, 256), format: "txt", content,
    occurred_at: new Date(row.started_at as number).toISOString(), timezone: "UTC",
  };
  if (config.publicUrl) {
    try {
      const url = new URL(`/meetings/${encodeURIComponent(meetingId)}`, config.publicUrl);
      if (url.protocol === "https:" && !url.username && !url.password) body.origin_url = url.toString();
    } catch { /* Optional provenance URL must never stop meeting finalization. */ }
  }
  // A revision identifies the whole immutable source envelope, excluding delivery UUID.
  const revision = { ...body }; delete revision.id; delete revision.external_revision;
  body.external_revision = createHash("sha256").update(JSON.stringify(revision)).digest("hex");
  const size = Buffer.byteLength(content, "utf8");
  const state = !content ? "skipped" : size > 250_000 ? "failed" : "queued";
  const error = !content ? "No recorded transcript" : size > 250_000 ? "Transcript exceeds Conxt's 250 KB limit; nothing was truncated or sent" : null;
  sql.prepare(`INSERT OR IGNORE INTO conxt_deliveries
    (id,connection_id,meeting_id,payload,state,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, row.connection_id as string, meetingId, JSON.stringify(body), state, error, Date.now(), Date.now());
}

export class ConxtDelivery {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy = false;
  private abort?: AbortController;
  constructor(private db: DB, private destinations: ConxtDestination[], private send: typeof fetch = fetch) {}

  /** Reconciliation catches finalization gaps; it never exports pre-connection history. */
  reconcile() {
    const rows = this.db.raw.prepare(`SELECT m.id FROM meetings m JOIN conxt_meetings cm ON cm.meeting_id=m.id
      JOIN conxt_connections c ON c.id=cm.connection_id
      WHERE m.ended_at IS NOT NULL AND c.enabled=1
      AND NOT EXISTS (SELECT 1 FROM conxt_deliveries d WHERE d.meeting_id=m.id) LIMIT 100`).all() as Row[];
    for (const row of rows) enqueueConxtMeeting(this.db.raw, row.id as string);
  }

  private claim(): Row | undefined {
    const sql = this.db.raw, now = Date.now();
    sql.exec("BEGIN IMMEDIATE");
    try {
      const row = sql.prepare(`SELECT d.*,c.destination_key,c.submission_url FROM conxt_deliveries d
        JOIN conxt_connections c ON c.id=d.connection_id WHERE c.enabled=1 AND d.next_at<=?
        AND (d.state IN ('queued','delivered') OR (d.state='sending' AND d.lease_until<=?)
        OR (d.state='failed' AND d.receipt_id IS NOT NULL AND d.remote_status='failed'))
        ORDER BY d.next_at,d.created_at LIMIT 1`).get(now, now) as Row | undefined;
      if (!row) { sql.exec("COMMIT"); return; }
      const lease = randomUUID();
      sql.prepare("UPDATE conxt_deliveries SET state='sending',lease_id=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?")
        .run(lease, now + 60_000, now, row.id as string);
      sql.exec("COMMIT");
      return { ...row, lease_id: lease, attempts: Number(row.attempts) + 1 };
    } catch (err) { sql.exec("ROLLBACK"); throw err; }
  }

  private update(job: Row, state: string, error: string | null, nextAt = 0, receipt?: string, remote?: string) {
    this.db.raw.prepare(`UPDATE conxt_deliveries SET state=?,error=?,next_at=?,lease_id=NULL,lease_until=NULL,
      receipt_id=COALESCE(?,receipt_id),remote_status=COALESCE(?,remote_status),updated_at=?,
      attempts=CASE WHEN ? IS NOT NULL THEN 0 ELSE attempts END WHERE id=? AND lease_id=?`)
      .run(state, error, nextAt, receipt ?? null, remote ?? null, Date.now(), receipt ?? null,
           job.id as string, job.lease_id as string);
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.reconcile();
      const job = this.claim();
      if (!job) return;
      const destination = this.destinations.find(d => d.key === job.destination_key && d.submissionUrl === job.submission_url);
      if (!destination) { this.update(job, "failed", "Destination was removed or changed; restore its original server configuration before retrying"); return; }
      const payload = JSON.parse(job.payload as string);
      const endpoint = job.receipt_id ? `${destination.submissionUrl}/${job.receipt_id}` : destination.submissionUrl;
      this.abort = new AbortController();
      const timeout = setTimeout(() => this.abort?.abort(), 20_000);
      try {
        const response = await this.send(endpoint, {
          method: job.receipt_id ? "GET" : "POST", redirect: "error", signal: this.abort.signal,
          headers: { Authorization: `Bearer ${destination.token}`, "Content-Type": "application/json" },
          ...(!job.receipt_id ? { body: job.payload as string } : {}),
        });
        if (!response.ok) {
          const retry = response.status === 429 || response.status >= 500;
          if (retry) throw new Error("transient");
          this.update(job, "failed", `Conxt returned HTTP ${response.status}; check the connection and retry`);
          return;
        }
        // Ignore status_path from remote JSON: polling stays on this configured origin and integration.
        const text = await boundedResponse(response);
        const data = JSON.parse(text);
        const receipt = job.receipt_id ? data : data.receipt;
        const integrationId = new URL(destination.submissionUrl).pathname.split("/")[4];
        if (!receipt || !uuid.test(receipt.id) || receipt.integration_id !== integrationId ||
            receipt.external_id !== payload.external_id || receipt.external_revision !== payload.external_revision ||
            !["queued", "processing", "ready", "failed"].includes(receipt.status)) throw new Error("invalid receipt");
        if (job.receipt_id && receipt.id !== job.receipt_id) throw new Error("invalid receipt");
        const state = receipt.status === "ready" ? "ready" : receipt.status === "failed" ? "failed" : "delivered";
        this.update(job, state, state === "failed" ? "Conxt processing failed; inspect and retry the source in Conxt" : null,
                    Date.now() + 15_000, receipt.id, receipt.status);
      } catch {
        const exhausted = Number(job.attempts) >= 12;
        this.update(job, exhausted ? "failed" : job.receipt_id ? "delivered" : "queued",
                    exhausted ? "Could not confirm delivery after 12 attempts; retry when the connection is restored" : "Waiting to retry Conxt",
                    Date.now() + Math.min(300_000, 2_000 * 2 ** Math.min(8, Number(job.attempts))));
      } finally { clearTimeout(timeout); this.abort = undefined; }
    } finally { this.busy = false; }
  }

  start() {
    const run = async () => {
      try { await this.tick(); } catch { console.error("[conxt] Delivery queue unavailable; retrying"); }
      if (!this.stopped) { this.timer = setTimeout(run, 2_000); this.timer.unref(); }
    };
    void run();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.abort?.abort(); }
}

async function boundedResponse(response: Response) {
  if (!response.body) throw new Error("missing receipt");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 32_000) throw new Error("receipt too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function roomId(req: Request) { return String(req.params["id"] ?? ""); }

export function conxtRoutes(db: DB, destinations: ConxtDestination[]) {
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    const room = db.getRoom(roomId(req));
    if (!room || !db.isMember(room.id, req.user!.id)) return void res.status(404).json({ error: "Space not found" });
    res.set("Cache-Control", "no-store"); next();
  });
  const owner = (req: Request) => {
    const room = db.getRoom(roomId(req))!;
    return !room.createdBy || room.createdBy === req.user!.id;
  };
  const mutation = (req: Request) => owner(req) && req.headers.origin === origin(req);
  router.get("/", (req, res) => {
    const id = roomId(req);
    const connection = db.raw.prepare("SELECT id,label,destination_key AS destinationKey,enabled FROM conxt_connections WHERE room_id=? ORDER BY connected_at DESC,rowid DESC LIMIT 1").get(id);
    const deliveries = db.raw.prepare(`SELECT d.id,d.meeting_id AS meetingId,d.state,d.remote_status AS remoteStatus,d.error,d.attempts,
      d.updated_at AS updatedAt,c.label,c.enabled FROM conxt_deliveries d JOIN conxt_connections c ON c.id=d.connection_id
      WHERE c.room_id=? ORDER BY d.created_at DESC LIMIT 50`).all(id);
    res.json({ destinations: destinations.map(({ key, label }) => ({ key, label })), connection: connection ?? null,
               deliveries, canManage: owner(req) });
  });
  router.post("/", (req, res) => {
    if (!mutation(req)) return void res.status(403).json({ error: "Only the space owner can connect from this app" });
    const destination = destinations.find(d => d.key === req.body?.destinationKey);
    if (!destination || req.body?.confirmedTeamAccess !== true) return void res.status(400).json({ error: "Choose a configured destination and confirm team access" });
    const active = db.raw.prepare("SELECT destination_key,submission_url FROM conxt_connections WHERE room_id=? AND enabled=1").get(roomId(req));
    if (active?.destination_key === destination.key && active.submission_url === destination.submissionUrl)
      return void res.json({ ok: true });
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      db.raw.prepare("UPDATE conxt_connections SET enabled=0 WHERE room_id=?").run(roomId(req));
      db.raw.prepare("INSERT INTO conxt_connections VALUES (?,?,?,?,?,?,?,1)")
        .run(randomUUID(), roomId(req), destination.key, destination.submissionUrl,
             destination.label, req.user!.id, Date.now());
      db.raw.exec("COMMIT"); res.json({ ok: true });
    } catch (err) { db.raw.exec("ROLLBACK"); throw err; }
  });
  router.delete("/", (req, res) => {
    if (!mutation(req)) return void res.status(403).json({ error: "Only the space owner can disconnect from this app" });
    db.raw.prepare("UPDATE conxt_connections SET enabled=0 WHERE room_id=?").run(roomId(req));
    res.json({ ok: true });
  });
  router.post("/:deliveryId/retry", (req, res) => {
    if (!mutation(req)) return void res.status(403).json({ error: "Only the space owner can retry from this app" });
    const result = db.raw.prepare(`UPDATE conxt_deliveries SET state=CASE WHEN receipt_id IS NULL THEN 'queued' ELSE 'delivered' END,
      attempts=0,next_at=0,error=NULL WHERE id=? AND state='failed' AND remote_status IS NOT 'failed'
      AND connection_id IN (SELECT id FROM conxt_connections WHERE room_id=? AND enabled=1)
      AND length(CAST(json_extract(payload,'$.content') AS BLOB))<=250000`)
      .run(req.params.deliveryId as string, roomId(req));
    res.status(result.changes ? 200 : 409).json(result.changes ? { ok: true } : { error: "Delivery cannot be retried here; inspect its connection or Conxt processing status" });
  });
  return router;
}
