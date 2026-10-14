// The board shows a meeting's main topics, not every fragment live notes split the talk into.
// Topics are ranked with no model call: talk, time, people and what came of them. A long meeting
// keeps up to 6 as main topics. Every so often, once a topic goes quiet or a new one starts, one
// small call reads the topics' titles and notes (never the transcript) and places each smaller
// topic inside the main topic of its item it belongs to, or in a small group with others like it.
// The placing is stored apart from the topics, so the notes runs never see it and can't undo it.
// As the meeting ends, the tidy model places them once more for the recap.
import type { Discussion, Note, Segment } from "../shared/protocol.ts";
import { SETTLE_AFTER_MS } from "./settle.ts";

/** A remark counts for the time until the next one, up to this. */
const REMARK_MAX_MS = 60_000;
const LABEL: Partial<Record<Note["kind"], string>> = { decision: "Decided", action: "To do", question: "Open" };
const WEIGHT: Partial<Record<Note["kind"], number>> = { decision: 3, action: 2, question: 1 };
/** Notes per topic the model sees: enough to tell what it's about. */
const PROMPT_NOTES = 6;

export interface RankedTopic {
  d: Discussion;
  score: number;
  remarks: number;
  /** Time spent on it, in minutes. */
  minutes: number;
  speakers: number;
  /** Nothing said about it for a while (settle.ts). */
  settled: boolean;
  notes: Note[];
}

/** How many main topics a meeting this long keeps: 3 for a short one, 5 at half an hour, at most 6. */
export function mainCount(meetingMinutes: number): number {
  return Math.min(6, 3 + Math.floor(meetingMinutes / 15));
}

/** The meeting's topics, most important first. Talk counts most; a short topic that still
 *  came to a decision or to-do moves up. */
export function rankTopics(discussions: Discussion[], segments: Segment[], notes: Note[], now: number): RankedTopic[] {
  const sorted = [...segments].sort((a, b) => a.ts - b.ts);
  const spent = new Map(sorted.map((s, i) => [s.id, Math.min((sorted[i + 1]?.ts ?? s.ts) - s.ts, REMARK_MAX_MS)]));
  const byId = new Map(sorted.map((s) => [s.id, s]));
  return discussions
    .map((d) => {
      const turns = d.segmentIds.flatMap((id) => byId.get(id) ?? []);
      const own = notes.filter((n) => n.discussionId === d.id && WEIGHT[n.kind]);
      const remarks = turns.length;
      const minutes = turns.reduce((ms, s) => ms + (spent.get(s.id) ?? 0), 0) / 60_000;
      const speakers = new Set(turns.map((s) => s.speakerName)).size;
      const weight = own.reduce((w, n) => w + (WEIGHT[n.kind] ?? 0), 0);
      const last = Math.max(-Infinity, ...turns.map((s) => s.ts));
      return {
        d,
        score: 2 * Math.sqrt(remarks) + 0.3 * Math.min(minutes, 30) + speakers + 1.5 * weight,
        remarks,
        minutes,
        speakers,
        settled: turns.length > 0 && last < now - SETTLE_AFTER_MS,
        notes: own,
      };
    })
    .sort((a, b) => b.score - a.score || a.d.ts - b.d.ts);
}

export interface MergePlan {
  main: RankedTopic[];
  small: RankedTopic[];
  /** Changes when a topic starts or settles, or moves in or out of the main ones: worth asking again. */
  sig: string;
}

/** A main topic stays main until a smaller one outranks it by this much, so two topics close in
 *  rank don't swap places (and the bar's chapters with them) on every placing. */
export const KEEP_MAIN = 1.25;

/** wasMain: the topics that were main last time, kept main unless clearly outranked. */
export function planMerge(discussions: Discussion[], segments: Segment[], notes: Note[], now: number, wasMain: ReadonlySet<string> = new Set()): MergePlan {
  const ranked = rankTopics(discussions, segments, notes, now)
    .map((t) => ({ t, keep: wasMain.has(t.d.id) ? t.score * KEEP_MAIN : t.score }))
    .sort((a, b) => b.keep - a.keep || a.t.d.ts - b.t.d.ts)
    .map(({ t }) => t);
  const times = segments.map((s) => s.ts);
  const minutes = times.length ? (Math.max(...times) - Math.min(...times)) / 60_000 : 0;
  const n = mainCount(minutes);
  const main = ranked.slice(0, n);
  const small = ranked.slice(n);
  const ids = (list: RankedTopic[]) => list.map((t) => `${t.d.id}${t.settled ? "." : ""}`).sort();
  return { main, small, sig: `${ids(main).join(",")}|${ids(small).join(",")}` };
}

/** What the model reads: each agenda item's main and smaller topics, as titles and notes, keyed T1, T2... */
export function mergePrompt(plan: MergePlan, itemTitle: (itemId: string | null) => string): { text: string; keys: Map<string, RankedTopic> } {
  const keys = new Map<string, RankedTopic>();
  [...plan.main, ...plan.small].forEach((t, i) => keys.set(`T${i + 1}`, t));
  const keyOf = new Map([...keys].map(([k, t]) => [t.d.id, k]));
  const line = (t: RankedTopic) =>
    `- ${keyOf.get(t.d.id)} ${t.d.topic} (${t.remarks} remarks)${t.notes
      .slice(0, PROMPT_NOTES)
      .map((n) => `\n  ${LABEL[n.kind]}: ${n.text}`)
      .join("")}`;
  const items = [...new Set([...plan.main, ...plan.small].map((t) => t.d.itemId))];
  const text = items
    .map((itemId) => {
      const main = plan.main.filter((t) => t.d.itemId === itemId);
      const small = plan.small.filter((t) => t.d.itemId === itemId);
      if (!small.length) return null;
      return `Agenda item: ${itemTitle(itemId)}\nMain topics:\n${main.map(line).join("\n") || "(none)"}\nSmaller topics:\n${small.map(line).join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return { text, keys };
}

export interface TopicMerge {
  discussionId: string;
  parentId: string | null;
  group: string | null;
}

/** The model's answer as the board stores it. A smaller topic goes into a main topic of its own
 *  item, or into a group of two or more on its item; anything else leaves it on its own. */
export function applyMerges(plan: MergePlan, keys: Map<string, RankedTopic>, answer: Array<{ key: string; into: string }>): TopicMerge[] {
  const main = new Set(plan.main.map((t) => t.d.id));
  const placed = new Map<string, { parent: RankedTopic } | { group: string }>();
  for (const a of answer) {
    const t = keys.get(a.key.trim());
    if (!t || main.has(t.d.id) || placed.has(t.d.id)) continue;
    const into = a.into.trim();
    const parent = keys.get(into);
    if (parent) {
      if (main.has(parent.d.id) && parent.d.itemId === t.d.itemId) placed.set(t.d.id, { parent });
      continue;
    }
    if (into) placed.set(t.d.id, { group: into.slice(0, 80) });
  }
  // A group of one is just the topic under a vaguer name: it stays as it is.
  const groupKey = (t: RankedTopic, title: string) => `${t.d.itemId}\n${title.toLowerCase()}`;
  const size = new Map<string, number>();
  for (const t of plan.small) {
    const p = placed.get(t.d.id);
    if (p && "group" in p) size.set(groupKey(t, p.group), (size.get(groupKey(t, p.group)) ?? 0) + 1);
  }
  return plan.small.flatMap((t): TopicMerge[] => {
    const p = placed.get(t.d.id);
    if (!p) return [];
    if ("parent" in p) return [{ discussionId: t.d.id, parentId: p.parent.d.id, group: null }];
    return (size.get(groupKey(t, p.group)) ?? 0) > 1 ? [{ discussionId: t.d.id, parentId: null, group: p.group }] : [];
  });
}

/** Placings change only when the model says so twice in a row: a smaller topic placed for the
 *  first time goes in at once (that's what tidies the bar), but one that is already placed moves,
 *  or comes out on its own again, only if the next placing agrees. `pending` holds the moves seen
 *  once; it's updated in place. */
export function stickyMerges(before: TopicMerge[], proposed: TopicMerge[], plan: MergePlan, pending: Map<string, string>): TopicMerge[] {
  const was = new Map(before.map((m) => [m.discussionId, m]));
  const now = new Map(proposed.map((m) => [m.discussionId, m]));
  const where = (m: TopicMerge | undefined) => (m ? (m.parentId ? `in:${m.parentId}` : `group:${(m.group ?? "").toLowerCase()}`) : "own");
  const main = new Set(plan.main.map((t) => t.d.id));
  const out: TopicMerge[] = [];
  for (const t of plan.small) {
    const id = t.d.id;
    const old = was.get(id);
    const next = now.get(id);
    // Its main topic is still main: anything else and the old placing can't stand.
    const oldValid = old && (!old.parentId || main.has(old.parentId));
    if (!oldValid || where(old) === where(next)) {
      pending.delete(id);
      if (next) out.push(next);
      continue;
    }
    if (pending.get(id) === where(next)) {
      pending.delete(id);
      if (next) out.push(next);
      continue;
    }
    pending.set(id, where(next));
    out.push(old);
  }
  for (const id of [...pending.keys()]) if (!plan.small.some((t) => t.d.id === id)) pending.delete(id);
  return out;
}
