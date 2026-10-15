// The Conxt project's vocabulary for a room: keyterms for speech-to-text and a line for
// the notes prompt. Read with the room's existing integration credential; cached, never
// blocking a meeting. No connection, no glossary, or Conxt down: nothing changes.
import type { DatabaseSync } from "node:sqlite";
import type { ConxtDestination } from "./conxt.ts";

export interface Vocabulary { keyterms: string[]; prompt: string | null }
const EMPTY: Vocabulary = { keyterms: [], prompt: null };
const TTL_MS = 5 * 60_000;
const MAX_KEYTERMS = 50;

/** The integration's glossary URL beside its source submission URL. */
export function glossaryUrl(submissionUrl: string): string | null {
  const url = new URL(submissionUrl);
  if (!/\/sources$/.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/sources$/, "/glossary");
  return url.toString();
}

export class ConxtGlossary {
  private cache = new Map<string, { at: number; value: Vocabulary }>();
  private inflight = new Map<string, Promise<Vocabulary>>();

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
  cached(roomId: string): Vocabulary {
    const d = this.destination(roomId);
    return (d && this.cache.get(d.submissionUrl)?.value) || EMPTY;
  }

  /** Fetch if stale; the meeting never waits on this. */
  refresh(roomId: string): Promise<Vocabulary> {
    const d = this.destination(roomId);
    if (!d) return Promise.resolve(EMPTY);
    const hit = this.cache.get(d.submissionUrl);
    if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
    const pending = this.inflight.get(d.submissionUrl);
    if (pending) return pending;
    const url = glossaryUrl(d.submissionUrl);
    if (!url) return Promise.resolve(EMPTY);
    const job = (async () => {
      try {
        const r = await this.send(url, { redirect: "error", signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${d.token}` } });
        if (!r.ok) return hit?.value ?? EMPTY;
        const body = await r.json() as { keyterms?: unknown; prompt?: unknown };
        const keyterms = Array.isArray(body.keyterms)
          ? body.keyterms.filter((t): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= 100).slice(0, MAX_KEYTERMS)
          : [];
        const value = { keyterms, prompt: typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null };
        this.cache.set(d.submissionUrl, { at: Date.now(), value });
        return value;
      } catch {
        return hit?.value ?? EMPTY;
      } finally {
        this.inflight.delete(d.submissionUrl);
      }
    })();
    this.inflight.set(d.submissionUrl, job);
    return job;
  }
}

let shared: ConxtGlossary | null = null;
export function setConxtGlossary(g: ConxtGlossary | null) { shared = g; }
export function roomVocabulary(roomId: string): Vocabulary { return shared?.cached(roomId) ?? EMPTY; }
export function refreshRoomVocabulary(roomId: string) { void shared?.refresh(roomId); }
