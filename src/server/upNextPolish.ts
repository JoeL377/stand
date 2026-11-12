// Claude's pass over a space's suggested agenda: folds duplicates, writes short
// agenda lines and reasons, and orders it (see upNext.ts for the plain ranking
// underneath). It never runs while people are talking: when a meeting ends,
// when a call opens (before anyone speaks), and in batches (POLISH_BATCH_MS) after
// agents report on the space between meetings.

import type { RoomState } from "../shared/protocol.ts";
import { config } from "./config.ts";
import type { DB } from "./db.ts";
import type { Agent, AgendaDraftRow } from "./llm.ts";
import { settleSpace } from "./spaceSettle.ts";
import { applyPolish, computeUpNext, polishBasis } from "./upNext.ts";
import { forSpace } from "./usage.ts";

// Off unless SUGGESTED_AGENDA=on (config.ts): no suggestions in calls, on the space page, the recap or
// the MCP, and no Claude pass to tidy them. The decision check that runs alongside it (settleSpace)
// still runs when a call starts or ends.

/** The suggested agenda as people see it: the plain ranking with Claude's last pass laid over it. */
export function upNextView(db: DB, roomId: string, currentStart: number | null, polishing = false): Pick<RoomState, "upNext" | "carried"> {
  const { upNext, carried } = computeUpNext(db.upNextInput(roomId, currentStart));
  if (!config.suggestedAgenda) return { upNext: { ...upNext, suggestions: [], parked: [], closed: 0, total: 0, polishedAt: null, polishing: false }, carried };
  return { upNext: { ...applyPolish(upNext, db.getPolish(roomId)), polishing }, carried };
}

/** Between meetings, agents' reports are batched: at most one pass this often per space. A call
 *  starting or ending still runs one straight away. */
export const POLISH_BATCH_MS = 30 * 60_000;

export class UpNextPolisher {
  private timers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  private running = new Set<string>();

  constructor(
    private db: DB,
    private agent: Agent,
    /** When the space's live meeting started, if one is running. */
    private liveStart: (roomId: string) => number | null,
    /** Tells people in the space that the list changed (or started changing). */
    private changed: (roomId: string) => void,
  ) {}

  busy(roomId: string) {
    return this.running.has(roomId);
  }

  /** A pass already waiting keeps its time unless this asks for sooner, so a stream of reports never pushes it back. */
  schedule(roomId: string, delayMs: number) {
    // With the agenda off, only a call starting or ending runs the decision check; reports between meetings don't.
    if (!config.suggestedAgenda && delayMs > 0) return;
    const due = Date.now() + delayMs;
    const waiting = this.timers.get(roomId);
    if (waiting && waiting.due <= due) return;
    if (waiting) clearTimeout(waiting.timer);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      this.run(roomId).catch((err) => console.error("[agent] agenda polish failed:", err));
    }, delayMs);
    timer.unref?.();
    this.timers.set(roomId, { timer, due });
  }

  async run(roomId: string) {
    if (this.running.has(roomId)) return;
    const room = this.db.getRoom(roomId);
    if (!room) return;
    // The space's decisions and open questions change at the same moments its agenda does.
    await settleSpace(this.db, this.agent, roomId).catch((err) => console.error("[agent] settling decisions and questions failed:", err));
    if (!config.suggestedAgenda) return;
    const input = this.db.upNextInput(roomId, this.liveStart(roomId));
    const { suggestions } = computeUpNext(input).upNext;
    // Nothing new since the last pass: every suggestion was written from the same facts.
    const last = this.db.getPolish(roomId);
    const done = new Map(last?.rows.map((r) => [r.key, r.basis]));
    if (!suggestions.length || suggestions.every((s) => done.get(s.key) === polishBasis(s))) return;

    const latest = (s: (typeof suggestions)[number]) =>
      input.updates.filter((u) => (s.noteId ? u.noteId === s.noteId : u.itemId === s.itemId && !!s.itemId)).sort((a, b) => b.ts - a.ts)[0];
    const rows: AgendaDraftRow[] = suggestions.map((s) => {
      const u = latest(s);
      const from = s.noteId && s.itemId ? input.items.get(s.itemId)?.title : undefined;
      return {
        key: s.key,
        kind: s.kind,
        title: s.title,
        reason: s.reason,
        owner: s.owner,
        from: from ?? null,
        latestUpdate: u ? `${u.status}: ${u.text}` : null,
      };
    });

    this.running.add(roomId);
    this.changed(roomId);
    try {
      const started = Date.now();
      const out = await forSpace(this.agent, roomId).polishAgenda(room, rows);
      if (!out) return;
      const basis = new Map(suggestions.map((s) => [s.key, polishBasis(s)]));
      this.db.savePolish(roomId, { at: Date.now(), rows: out.map((r) => ({ ...r, basis: basis.get(r.key)! })) });
      console.log(`[agent] agenda for ${roomId}: ${out.length} suggestions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } finally {
      this.running.delete(roomId);
      this.changed(roomId);
    }
  }
}
