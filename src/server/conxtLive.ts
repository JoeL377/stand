// Durable, ordered updates to provisional transcript evidence. No model calls.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { DB } from "./db.ts";
import type { ConxtDestination } from "./conxt.ts";
import { config } from "./config.ts";
type Row = Record<string, any>;

export function initConxtLive(sql: DatabaseSync) {
  const fresh = !sql.prepare("SELECT 1 FROM sqlite_master WHERE name='conxt_live_deliveries'").get();
  sql.exec(`
    CREATE TABLE IF NOT EXISTS conxt_live_deliveries (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id), connection_id TEXT NOT NULL REFERENCES conxt_connections(id),
      state TEXT NOT NULL DEFAULT 'queued', sequence INTEGER NOT NULL DEFAULT 0, ack_event_id INTEGER NOT NULL DEFAULT 0,
      metadata TEXT, pending_payload TEXT, pending_cursor INTEGER, next_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER, stream_id TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS conxt_live_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id), turn_id TEXT NOT NULL,
      speaker TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conxt_live_event_cursor ON conxt_live_events(meeting_id,id);
    CREATE TRIGGER IF NOT EXISTS conxt_live_meeting AFTER INSERT ON conxt_meetings BEGIN
      INSERT OR IGNORE INTO conxt_live_deliveries(meeting_id,connection_id) VALUES (NEW.meeting_id,NEW.connection_id);
    END;
    CREATE TRIGGER IF NOT EXISTS conxt_live_segment AFTER INSERT ON segments BEGIN
      INSERT INTO conxt_live_events(meeting_id,turn_id,speaker,text,kind,ts)
      SELECT NEW.meeting_id,NEW.id,NEW.speaker_name,NEW.text,NEW.kind,NEW.ts
      FROM conxt_live_deliveries d JOIN conxt_connections c ON c.id=d.connection_id
      WHERE d.meeting_id=NEW.meeting_id AND c.enabled=1;
    END;
    CREATE TRIGGER IF NOT EXISTS conxt_live_segment_updated AFTER UPDATE OF text ON segments WHEN NEW.text != OLD.text BEGIN
      INSERT INTO conxt_live_events(meeting_id,turn_id,speaker,text,kind,ts)
      SELECT NEW.meeting_id,NEW.id,NEW.speaker_name,NEW.text,NEW.kind,NEW.ts
      FROM conxt_live_deliveries d JOIN conxt_connections c ON c.id=d.connection_id
      WHERE d.meeting_id=NEW.meeting_id AND c.enabled=1;
    END;
  `);
  if (fresh) {
    // Catch up connected meetings currently in progress; never adopt old ended meetings.
    sql.exec(`INSERT OR IGNORE INTO conxt_live_deliveries(meeting_id,connection_id)
      SELECT cm.meeting_id,cm.connection_id FROM conxt_meetings cm JOIN meetings m ON m.id=cm.meeting_id
      JOIN conxt_connections c ON c.id=cm.connection_id WHERE m.ended_at IS NULL AND c.enabled=1;
      INSERT INTO conxt_live_events(meeting_id,turn_id,speaker,text,kind,ts)
      SELECT s.meeting_id,s.id,s.speaker_name,s.text,s.kind,s.ts FROM segments s
      JOIN conxt_live_deliveries d ON d.meeting_id=s.meeting_id ORDER BY s.ts,s.rowid;`);
  }
}

export class ConxtLiveDelivery {
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private stopped = false;
  private abort?: AbortController;
  constructor(private db: DB, private destinations: ConxtDestination[], private send: typeof fetch = fetch) {}

  private claim(): Row | undefined {
    const sql = this.db.raw, now = Date.now();
    sql.exec("BEGIN IMMEDIATE");
    try {
      const row = sql.prepare(`SELECT d.*,c.destination_key,c.submission_url,m.started_at,m.ended_at,r.name
        FROM conxt_live_deliveries d JOIN conxt_connections c ON c.id=d.connection_id
        JOIN meetings m ON m.id=d.meeting_id JOIN rooms r ON r.id=m.room_id
        WHERE c.enabled=1 AND d.state='queued' AND d.next_at<=? AND (d.lease_until IS NULL OR d.lease_until<=?)
        ORDER BY d.next_at,d.rowid LIMIT 1`).get(now,now) as Row | undefined;
      if (!row) { sql.exec("COMMIT"); return; }
      let payload = row.pending_payload;
      let cursor = row.pending_cursor;
      let metadata = row.metadata;
      if (!payload) {
        const events = sql.prepare("SELECT * FROM conxt_live_events WHERE meeting_id=? AND id>? ORDER BY id LIMIT 100")
          .all(row.meeting_id,row.ack_event_id) as Row[];
        cursor = events.at(-1)?.id ?? row.ack_event_id;
        const remaining = sql.prepare("SELECT 1 FROM conxt_live_events WHERE meeting_id=? AND id>? LIMIT 1").get(row.meeting_id,cursor);
        const ended = row.ended_at != null && !remaining;
        if (!events.length && row.sequence > 0 && !ended) {
          sql.prepare("UPDATE conxt_live_deliveries SET next_at=? WHERE meeting_id=?").run(now+1000,row.meeting_id);
          sql.exec("COMMIT"); return;
        }
        if (!metadata) {
          const instance = sql.prepare("SELECT value FROM conxt_settings WHERE key='instance_id'").get()!.value;
          const meta: Row = {external_id:`stand:${instance}:${row.meeting_id}`,title:String(row.name).slice(0,256),occurred_at:new Date(row.started_at).toISOString()};
          if (config.publicUrl?.startsWith("https://")) meta.origin_url = new URL(`/meetings/${row.meeting_id}`,config.publicUrl).toString();
          metadata = JSON.stringify(meta);
        }
        const changes = new Map<string,Row>();
        for (const e of events) changes.set(e.turn_id,{id:e.turn_id,speaker:e.speaker,text:e.text.replace(/\r\n?/g,"\n"),kind:e.kind,occurred_at:new Date(e.ts).toISOString()});
        payload = JSON.stringify({...JSON.parse(metadata),sequence:row.sequence+1,turns:[...changes.values()],ended});
      }
      const lease = randomUUID();
      sql.prepare(`UPDATE conxt_live_deliveries SET metadata=?,pending_payload=?,pending_cursor=?,lease_id=?,lease_until=?,attempts=attempts+1 WHERE meeting_id=?`)
        .run(metadata,payload,cursor,lease,now+60000,row.meeting_id);
      sql.exec("COMMIT");return {...row,pending_payload:payload,pending_cursor:cursor,lease_id:lease,attempts:row.attempts+1};
    } catch(e) {sql.exec("ROLLBACK");throw e;}
  }

  private fail(job: Row, error: string, permanent: boolean) {
    const exhausted = permanent || job.attempts >= 12;
    this.db.raw.prepare(`UPDATE conxt_live_deliveries SET state=?,error=?,next_at=?,lease_id=NULL,lease_until=NULL WHERE meeting_id=? AND lease_id=?`)
      .run(exhausted?"failed":"queued",error,Date.now()+Math.min(60000,1000*2**Math.min(6,job.attempts)),job.meeting_id,job.lease_id);
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const job = this.claim();if (!job) return;
      const destination = this.destinations.find(d=>d.key===job.destination_key && d.submissionUrl===job.submission_url);
      if (!destination) {this.fail(job,"Live destination configuration changed; restore it before retrying",true);return;}
      this.abort = new AbortController();const timeout = setTimeout(()=>this.abort?.abort(),20000);
      try {
        const payload=JSON.parse(job.pending_payload);
        const r=await this.send(destination.submissionUrl.replace(/\/sources$/,"/live-transcripts"),{
          method:"POST",redirect:"error",signal:this.abort.signal,
          headers:{Authorization:`Bearer ${destination.token}`,"Content-Type":"application/json"},body:job.pending_payload,
        });
        if (!r.ok) {this.fail(job,`Live Conxt returned HTTP ${r.status}`,r.status!==429 && r.status<500);return;}
        const text=await r.text();if(text.length>4000)throw new Error("Oversized live receipt");
        const receipt=JSON.parse(text);
        if(!/^[a-f0-9-]{36}$/i.test(receipt.id)||receipt.external_id!==payload.external_id||receipt.sequence!==payload.sequence||
          !["live","ended"].includes(receipt.status)||(job.stream_id&&receipt.id!==job.stream_id))throw new Error("Invalid live receipt");
        const acknowledged = this.db.raw.prepare(`UPDATE conxt_live_deliveries SET sequence=?,ack_event_id=?,stream_id=?,state=?,error=NULL,
          pending_payload=NULL,pending_cursor=NULL,attempts=0,lease_id=NULL,lease_until=NULL,next_at=? WHERE meeting_id=? AND lease_id=?`)
          .run(payload.sequence,job.pending_cursor,receipt.id,payload.ended?"ended":"queued",Date.now(),job.meeting_id,job.lease_id);
        if(acknowledged.changes)this.db.raw.prepare("DELETE FROM conxt_live_events WHERE meeting_id=? AND id<=?").run(job.meeting_id,job.pending_cursor);
      } catch {this.fail(job,"Live transcript delivery waiting to retry",false);}
      finally {clearTimeout(timeout);this.abort=undefined;}
    } finally {this.busy=false;}
  }
  start() {
    const run=async()=>{try{await this.tick();}catch{console.error("[conxt] Live transcript queue unavailable");}
      if(!this.stopped){this.timer=setTimeout(run,500);this.timer.unref();}};void run();
  }
  stop(){this.stopped=true;clearTimeout(this.timer);this.abort?.abort();}
}
