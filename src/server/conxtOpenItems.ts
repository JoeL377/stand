// What the connected Conxt project says needs people (decisions waiting on
// someone who was away, conflicts, words used two ways, open questions), for
// the space's suggested agenda. Read with the room's integration credential,
// refreshed in the background and cached: the agenda never waits on Conxt, and
// no connection or Conxt being down leaves it as it was.
import type { DatabaseSync } from "node:sqlite";
import type { ConxtDestination } from "./conxt.ts";

export interface ConxtOpenItem {
  kind: "confirmation" | "conflict" | "divergence" | "question";
  id: string;
  title: string;
  why: string;
  needs: Array<{ id: string; name: string }>;
  path: string | null;
  at: string | null;
}

const TTL_MS = 2 * 60_000;
const MAX_ITEMS = 20;
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
    out.push({ kind: i.kind as ConxtOpenItem["kind"], id, title, why, needs, path: text(i.path, 300), at: text(i.at, 64) });
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
}

let shared: ConxtOpenItems | null = null;
export function setConxtOpenItems(o: ConxtOpenItems | null) { shared = o; }
export function roomOpenItems(roomId: string): ConxtOpenItem[] { return shared?.cached(roomId) ?? []; }
export function refreshRoomOpenItems(roomId: string): Promise<ConxtOpenItem[]> { return shared?.refresh(roomId) ?? Promise.resolve([]); }
