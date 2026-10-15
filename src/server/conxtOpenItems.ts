// What the connected Conxt project says needs people (decisions waiting on
// someone who was away, conflicts, words used two ways, open questions), for
// the space's suggested agenda. Read with the room's integration credential,
// refreshed in the background and cached: the agenda never waits on Conxt, and
// no connection or Conxt being down leaves it as it was.
import type { DatabaseSync } from "node:sqlite";
import type { ConxtLive } from "../shared/protocol.ts";
import type { ConxtDestination } from "./conxt.ts";

export interface ConxtOpenItem {
  kind: "confirmation" | "conflict" | "divergence" | "question";
  id: string;
  title: string;
  why: string;
  needs: Array<{ id: string; name: string }>;
  path: string | null;
  at: string | null;
  /** The decision as it was when it waited on these people; a confirmation sends it back. */
  contentHash: string | null;
  /** The word used two ways, for a divergence. */
  term: string | null;
}

const TTL_MS = 2 * 60_000;
const MAX_ITEMS = 20;
/** Cards on the live panel at once. */
const MAX_LIVE = 3;
const KINDS = new Set(["confirmation", "conflict", "divergence", "question"]);

/** The integration's open-items URL beside its source submission URL. */
export function openItemsUrl(submissionUrl: string): string | null {
  const url = new URL(submissionUrl);
  if (!/\/sources$/.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/sources$/, "/open-items");
  return url.toString();
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function parse(body: unknown): ConxtOpenItem[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: ConxtOpenItem[] = [];
  for (const raw of items) {
    const i = raw as Record<string, unknown>;
    const id = text(i.id, 100), title = text(i.title, 500), why = text(i.why, 300);
    if (!id || !title || !why || typeof i.kind !== "string" || !KINDS.has(i.kind)) continue;
    const needs = Array.isArray(i.needs)
      ? i.needs.flatMap((n: { id?: unknown; name?: unknown }) => {
          const nid = text(n?.id, 320), name = text(n?.name, 200);
          return nid && name ? [{ id: nid, name }] : [];
        })
      : [];
    const hash = typeof i.content_hash === "string" && /^[0-9a-f]{64}$/.test(i.content_hash) ? i.content_hash : null;
    out.push({
      kind: i.kind as ConxtOpenItem["kind"], id, title, why, needs, path: text(i.path, 300), at: text(i.at, 64),
      contentHash: hash, term: i.kind === "divergence" ? text(i.term, 80) : null,
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export class ConxtOpenItems {
  private cache = new Map<string, { at: number; value: ConxtOpenItem[] }>();
  private inflight = new Map<string, Promise<ConxtOpenItem[]>>();
  private sql: DatabaseSync;
  private destinations: ConxtDestination[];
  private send: typeof fetch;

  constructor(sql: DatabaseSync, destinations: ConxtDestination[], send: typeof fetch = fetch) {
    this.sql = sql;
    this.destinations = destinations;
    this.send = send;
  }

  private destination(roomId: string): ConxtDestination | null {
    const row = this.sql.prepare("SELECT destination_key,submission_url FROM conxt_connections WHERE room_id=? AND enabled=1")
      .get(roomId) as { destination_key: string; submission_url: string } | undefined;
    if (!row) return null;
    return this.destinations.find(d => d.key === row.destination_key && d.submissionUrl === row.submission_url) ?? null;
  }

  /** What is known now, without waiting: the last fetch, or nothing. */
  cached(roomId: string): ConxtOpenItem[] {
    const d = this.destination(roomId);
    return (d && this.cache.get(d.submissionUrl)?.value) || [];
  }

  /** Fetch if stale; nothing ever waits on this. */
  refresh(roomId: string): Promise<ConxtOpenItem[]> {
    const d = this.destination(roomId);
    if (!d) return Promise.resolve([]);
    const hit = this.cache.get(d.submissionUrl);
    if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
    const pending = this.inflight.get(d.submissionUrl);
    if (pending) return pending;
    const url = openItemsUrl(d.submissionUrl);
    if (!url) return Promise.resolve([]);
    const job = (async () => {
      try {
        const r = await this.send(url, { redirect: "error", signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${d.token}` } });
        if (!r.ok) return hit?.value ?? [];
        const value = parse(await r.json());
        this.cache.set(d.submissionUrl, { at: Date.now(), value });
        return value;
      } catch {
        return hit?.value ?? [];
      } finally {
        this.inflight.delete(d.submissionUrl);
      }
    })();
    this.inflight.set(d.submissionUrl, job);
    return job;
  }

  /** Confirms a decision for a person signed in here, as one of the people it waits on.
   *  Conxt checks they are; the list is fetched again either way. */
  async confirm(roomId: string, itemId: string, person: string): Promise<{ ok: true } | { ok: false; why: string }> {
    const d = this.destination(roomId);
    const item = this.cached(roomId).find((i) => i.id === itemId && i.kind === "confirmation");
    const base = d && openItemsUrl(d.submissionUrl);
    if (!d || !base || !item?.contentHash) return { ok: false, why: "this decision isn't waiting on anyone now" };
    try {
      const r = await this.send(`${base}/${encodeURIComponent(item.id)}/confirm`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ person, content_hash: item.contentHash }),
      });
      if (r.ok) return { ok: true };
      return { ok: false, why: r.status === 409 ? "it changed or doesn't wait on you" : `Conxt returned HTTP ${r.status}` };
    } catch {
      return { ok: false, why: "Conxt didn't answer" };
    } finally {
      this.cache.delete(d.submissionUrl);
      void this.refresh(roomId);
    }
  }
}

/** Conxt items worth raising while people talk: a decision waiting on someone who
 *  is here now, and a word used two ways that was just said again. */
export function liveCards(
  items: ConxtOpenItem[],
  here: Array<{ participantId: string; name: string; email: string | null }>,
  said: ReadonlySet<string>,
): ConxtLive[] {
  const out: ConxtLive[] = [];
  for (const i of items) {
    if (i.kind === "confirmation" && i.contentHash) {
      const waits = new Set(i.needs.map((n) => n.id.toLowerCase()));
      const present = here.filter((p) => p.email && waits.has(p.email.toLowerCase())).map(({ participantId, name }) => ({ participantId, name }));
      if (present.length) out.push({ kind: "confirmation", id: i.id, title: i.title, why: i.why, here: present, term: null });
    } else if (i.kind === "divergence" && i.term && said.has(i.id)) {
      out.push({ kind: "divergence", id: i.id, title: i.title, why: i.why, here: [], term: i.term });
    }
    if (out.length >= MAX_LIVE) break;
  }
  return out;
}

/** The divergences whose word this remark says, matched as a whole word. */
export function saysTerm(items: ConxtOpenItem[], remark: string): string[] {
  const lower = remark.toLowerCase();
  return items.filter((i) => {
    if (i.kind !== "divergence" || !i.term) return false;
    const t = i.term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${t}($|[^\\p{L}\\p{N}])`, "u").test(lower);
  }).map((i) => i.id);
}

// ---- agenda lines raised from Conxt ------------------------------------------
// An agenda line added from a Conxt item remembers it, so what the meeting says
// under that line goes back to Conxt as discussing it.

export function initConxtAgendaLinks(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS conxt_agenda_links (
    item_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, open_item_id TEXT NOT NULL,
    kind TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
}

export function linkAgendaLine(sql: DatabaseSync, roomId: string, itemId: string, item: ConxtOpenItem) {
  sql.prepare("INSERT OR REPLACE INTO conxt_agenda_links VALUES (?,?,?,?,?)").run(itemId, roomId, item.id, item.kind, Date.now());
}

/** For a meeting's delivery: each Conxt item an agenda line came from, with the
 *  remarks filed under that line. Lines nobody spoke under are left out. */
export function meetingAddresses(sql: DatabaseSync, meetingId: string, roomId: string) {
  const rows = sql.prepare(`SELECT l.open_item_id, l.kind, s.id AS turn_id FROM conxt_agenda_links l
    JOIN segments s ON s.item_id=l.item_id AND s.meeting_id=?
    WHERE l.room_id=? ORDER BY l.created_at, s.ts, s.rowid`).all(meetingId, roomId) as Array<{ open_item_id: string; kind: string; turn_id: string }>;
  const by = new Map<string, { open_item_id: string; kind: string; turn_ids: string[] }>();
  for (const r of rows) {
    const a = by.get(r.open_item_id) ?? { open_item_id: r.open_item_id, kind: r.kind, turn_ids: [] };
    if (a.turn_ids.length < 500) a.turn_ids.push(r.turn_id);
    by.set(r.open_item_id, a);
  }
  return [...by.values()].filter((a) => KINDS.has(a.kind)).slice(0, 100);
}

let shared: ConxtOpenItems | null = null;
export function setConxtOpenItems(o: ConxtOpenItems | null) { shared = o; }
export function roomOpenItems(roomId: string): ConxtOpenItem[] { return shared?.cached(roomId) ?? []; }
export function confirmRoomOpenItem(roomId: string, itemId: string, person: string) {
  return shared ? shared.confirm(roomId, itemId, person) : Promise.resolve({ ok: false as const, why: "this space isn't connected to Conxt" });
}
export function refreshRoomOpenItems(roomId: string): Promise<ConxtOpenItem[]> { return shared?.refresh(roomId) ?? Promise.resolve([]); }
