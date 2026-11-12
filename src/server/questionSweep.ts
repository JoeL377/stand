// The sweep of a space's open questions: Stand reads them against what the space has decided and
// holds as true, and proposes which a decision answers and which nobody needs answered any more.
// Stand runs it by itself: once a space has enough open questions, and after that only when enough
// new questions, decisions or lines of context came in since the last one. What it found is kept
// (question_sweep) and the Tasks tab shows that, so opening the list never asks the model. It
// changes nothing: the person ticks what they agree with and closes those in one step (agents.ts
// closeQuestion), because Stand never decides on its own. A proposal they untick is a question to
// keep open, and Stand leaves it alone from then on.

import type { QuestionSweep, SweepProposal } from "../shared/protocol.ts";
import { config } from "./config.ts";
import type { DB } from "./db.ts";
import type { Agent, SweepRow } from "./llm.ts";
import { openQuestions, settledView } from "./spaceSettle.ts";
import { forSpace } from "./usage.ts";

/** A space is swept once it has this many open questions. */
export const SWEEP_FROM = 5;
/** The next sweep waits for this many questions, decisions or lines of context the last one didn't read. */
export const SWEEP_AFTER_NEW = 5;
/** Fewer new ones than that still get a sweep once the last one is this old. */
export const SWEEP_STALE_MS = 7 * 86_400_000;
/** Something was added between meetings: wait for the rest of the batch. */
export const SWEEP_AFTER_CHANGE_MS = 10 * 60_000;
/** How many questions one sweep reads, oldest first. */
export const SWEEP_MAX = 120;
/** How many decisions and lines of context it reads them against, newest first. */
const AGAINST = 200;

/** A space's last sweep, as kept. */
export interface Swept {
  at: number;
  /** The questions, decisions and lines of context it read, by id. */
  seen: string[];
  /** What it proposed to close. by: the decision that answers the question. */
  rows: Array<{ id: string; how: SweepRow["how"]; by: string | null; why: string }>;
  /** Questions someone chose to keep open. A sweep doesn't read them. */
  kept: string[];
}

const standing = (view: ReturnType<typeof settledView>) => view.decided.filter((d) => d.decisionState === "kept");

/** What a sweep would read now, and whether enough of it is new since the last one. */
function read(db: DB, roomId: string, now: number) {
  const view = settledView(db, roomId);
  const open = openQuestions(db, roomId, view);
  const last = db.getQuestionSweep(roomId);
  const kept = new Set(last?.kept);
  const questions = open.filter((n) => !kept.has(n.id)).slice(0, SWEEP_MAX);
  const decisions = standing(view).reverse();
  const context = db.spaceContext(roomId, AGAINST);
  const seen = [...questions, ...decisions, ...context].map((n) => n.id);
  const before = new Set(last?.seen);
  const fresh = seen.filter((id) => !before.has(id)).length;
  const due = open.length >= SWEEP_FROM && !!questions.length && (!last || fresh >= SWEEP_AFTER_NEW || (fresh > 0 && now - last.at >= SWEEP_STALE_MS));
  return { open, questions, decisions, context, seen, due };
}

/** One sweep of a space, when one is due. It keeps what the model proposed; swept says whether it asked. */
export async function sweepQuestions(db: DB, agent: Agent, roomId: string, now = Date.now()): Promise<{ swept: boolean; proposed: number }> {
  const room = db.getRoom(roomId);
  const none = { swept: false, proposed: 0 };
  if (!room || !agent.sweepQuestions) return none;
  const { open, questions, decisions, context, seen, due } = read(db, roomId, now);
  if (!due) return none;
  const started = Date.now();
  const asked = questions.map((n, i) => ({ n, key: `Q${i + 1}` }));
  const decided = decisions.map((n, i) => ({ n, key: `D${i + 1}` }));
  const out = await forSpace(agent, roomId).sweepQuestions!(
    { name: room.name, purpose: room.purpose },
    {
      today: now,
      questions: asked.map(({ n, key }) => ({ key, text: n.text, asked: n.meetingStartedAt })),
      decisions: decided.map(({ n, key }) => ({ key, text: n.text, on: n.meetingStartedAt })),
      context: context.map((c) => c.text),
    },
  );
  // A failed call keeps the last sweep: the next change in the space tries again.
  if (!out) return none;
  // Someone may have kept questions open while the model read.
  const stillOpen = new Set(open.map((n) => n.id));
  const kept = (db.getQuestionSweep(roomId)?.kept ?? []).filter((id) => stillOpen.has(id));
  const rows: Swept["rows"] = [];
  for (const { n, key } of asked) {
    const r = out.find((x) => x.key === key);
    if (!r || kept.includes(n.id)) continue;
    const by = r.how === "answered" ? decided.find((d) => d.key === r.by)?.n : undefined;
    // An answer names a decision the space has; one that doesn't is no proposal.
    if (r.how === "answered" && !by) continue;
    rows.push({ id: n.id, how: r.how, by: by?.id ?? null, why: r.why.replace(/\s+/g, " ").trim().slice(0, 200) });
  }
  db.saveQuestionSweep(roomId, { at: now, seen, rows, kept });
  console.log(`[agent] swept ${questions.length} open questions in ${roomId}: ${rows.length} to close, in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { swept: true, proposed: rows.length };
}

/** What the last sweep proposes that still holds: the question is open, nobody kept it, and the
 *  decision that answers it stands. Null when there is nothing to show. */
export function currentSweep(db: DB, roomId: string, view = settledView(db, roomId)): QuestionSweep | null {
  const last = db.getQuestionSweep(roomId);
  if (!last?.rows.length) return null;
  const open = new Map(openQuestions(db, roomId, view).map((n) => [n.id, n]));
  const decisions = new Map(standing(view).map((d) => [d.id, d]));
  const proposals = last.rows.flatMap((r): SweepProposal[] => {
    const q = open.get(r.id);
    const by = r.by ? decisions.get(r.by) : undefined;
    if (!q || last.kept.includes(r.id) || (r.how === "answered" && !by)) return [];
    return [{ id: q.id, text: q.text, askedAt: q.meetingStartedAt, how: r.how, decision: by && { id: by.id, text: by.text }, why: r.why }];
  });
  return proposals.length ? { at: last.at, proposals } : null;
}

/** Someone unticked these proposals: the questions stay open, and no sweep proposes them again. */
export function keepOpen(db: DB, roomId: string, ids: string[]) {
  const last = db.getQuestionSweep(roomId);
  if (!last) return;
  const add = [...new Set(ids)].filter((id) => last.rows.some((r) => r.id === id) && !last.kept.includes(id));
  if (add.length) db.saveQuestionSweep(roomId, { ...last, kept: [...last.kept, ...add] });
}

export class QuestionSweeper {
  private timers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  private running = new Set<string>();
  /** Spaces scheduled while a sweep ran in them: one more look after it. */
  private again = new Set<string>();

  constructor(
    private db: DB,
    private agent: Agent,
  ) {}

  private get on() {
    return config.questionSweep && !!this.agent.sweepQuestions;
  }

  /** Something in the space changed: a look in a while. One already waiting keeps its time unless
   *  this asks for sooner. */
  schedule(roomId: string, delayMs = SWEEP_AFTER_CHANGE_MS) {
    if (!this.on) return;
    const due = Date.now() + delayMs;
    const waiting = this.timers.get(roomId);
    if (waiting && waiting.due <= due) return;
    if (waiting) clearTimeout(waiting.timer);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      this.run(roomId).catch((err) => console.error("[agent] question sweep failed:", err));
    }, delayMs);
    timer.unref?.();
    this.timers.set(roomId, { timer, due });
  }

  /** Each space with enough open questions gets one look, spread over the first minute. It asks the
   *  model only where a sweep is due; the events that schedule a look cover what happens after. */
  start() {
    if (!this.on) return;
    for (const roomId of this.db.roomsWithQuestions(SWEEP_FROM)) this.schedule(roomId, 1000 + Math.random() * 59_000);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
  }

  async run(roomId: string): Promise<void> {
    if (!this.on) return;
    if (this.running.has(roomId)) {
      this.again.add(roomId);
      return;
    }
    this.running.add(roomId);
    try {
      await sweepQuestions(this.db, this.agent, roomId);
    } finally {
      this.running.delete(roomId);
    }
    if (this.again.delete(roomId)) await this.run(roomId);
  }
}
