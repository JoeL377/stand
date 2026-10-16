// The topic board's chapter bar as stretches of time (TopicBoard.tsx; the replay scorer reads
// the same). A chapter is a main topic with the smaller topics placed inside it, a small group of
// topics, or a topic not placed yet (see server/topicMerge.ts). A stretch lasts from when talk
// turned to a chapter until it moved on. A short aside, under a minute, doesn't cut the stretch
// around it in two: it folds into it.

import type { Discussion, DiscussionOutcome, Segment } from "./protocol.ts";

/** A pause longer than this between two stretches shows as a gap. */
export const GAP_MS = 180_000;
/** How long a stretch lasts past its last remark when a gap follows it. */
export const TAIL_MS = 30_000;
/** A stretch shorter than this folds into the one before it. */
export const FOLD_MS = 60_000;

export interface ChapterTopic {
  id: string;
  itemId: string | null;
  mergedInto?: string | null;
  group?: string | null;
  /** Its remarks' times. */
  times: number[];
}

export interface Stretch {
  chapter: string;
  from: number;
  to: number;
}

const MIN = 60_000;
/** The lengths the live chapter bar can span, so it fills from left to right like a progress bar. */
const SPANS = [30, 45, 60, 90, 120].map((m) => m * MIN);
/** How close the meeting gets to the bar's end before the bar takes the next, longer span. */
const HEADROOM_MS = 5 * MIN;

/** How long a meeting the live chapter bar spans after `elapsed` ms: 30 minutes to begin with, then
 *  45, 60, 90, 120 and on by the hour, taking the next one when the meeting is 5 minutes from the
 *  end. The bar runs to this rather than to now, so talk fills it from the left and the stretches
 *  don't squeeze as the clock moves. */
export function barSpan(elapsed: number): number {
  for (const span of SPANS) if (elapsed < span - HEADROOM_MS) return span;
  const last = SPANS.at(-1)!;
  return last + (Math.floor((elapsed + HEADROOM_MS - last) / (60 * MIN)) + 1) * 60 * MIN;
}

/** The chapter a topic draws in: the main topic it was placed inside, its group, or its own. */
export function chapterOf(t: ChapterTopic, byId: Map<string, ChapterTopic>): string {
  const parent = t.mergedInto ? byId.get(t.mergedInto) : undefined;
  if (parent && !parent.mergedInto && !parent.group) return parent.id;
  if (t.group) return `group:${t.itemId ?? ""}:${t.group.trim().toLowerCase()}`;
  return t.id;
}

/** The meeting's talk as stretches, one per run of remarks in the same chapter. `live`: the chapter
 *  being talked about now, which runs on to now and never folds. `fold: false`: every aside keeps
 *  its own stretch, as the bar drew them before (for comparing). */
export function stretches(topics: ChapterTopic[], live: string | null, now: number, { fold = true } = {}): Stretch[] {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const remarks = topics.flatMap((t) => t.times.map((ts) => ({ chapter: chapterOf(t, byId), ts }))).sort((a, b) => a.ts - b.ts);
  const runs: Array<{ chapter: string; from: number; last: number }> = [];
  for (const r of remarks) {
    const run = runs.at(-1);
    if (run && run.chapter === r.chapter) run.last = r.ts;
    else runs.push({ chapter: r.chapter, from: r.ts, last: r.ts });
  }
  const kept: typeof runs = [];
  runs.forEach((r, i) => {
    const prev = kept.at(-1);
    const near = prev && r.from - prev.last < GAP_MS;
    if (prev && near && prev.chapter === r.chapter) {
      prev.last = r.last;
      return;
    }
    const length = (runs[i + 1]?.from ?? r.last + TAIL_MS) - r.from;
    const isLive = i === runs.length - 1 && r.chapter === live;
    if (fold && prev && near && length < FOLD_MS && !isLive) {
      prev.last = r.last;
      return;
    }
    kept.push({ ...r });
  });
  return kept.map((r, i) => {
    const next = kept[i + 1];
    const to = next ? (next.from - r.last < GAP_MS ? next.from : r.last + TAIL_MS) : r.chapter === live ? now : r.last + TAIL_MS;
    return { chapter: r.chapter, from: r.from, to: Math.min(Math.max(to, r.from + 1000), now) };
  });
}

/** How long each remark held the floor: until the next remark, up to a minute. */
export function remarkTimes(remarks: Array<{ id: string; ts: number }>): Map<string, number> {
  const sorted = [...remarks].sort((a, b) => a.ts - b.ts);
  return new Map(sorted.map((s, i) => [s.id, Math.min((sorted[i + 1]?.ts ?? s.ts) - s.ts, 60_000)]));
}

/** A finished meeting's chapter, as the recap and the brief show it. */
export interface MeetingChapter {
  /** The chapter's key (chapterOf): its main topic's id, or "group:…". */
  key: string;
  title: string;
  itemId: string | null;
  /** The main topic, when it isn't a group. */
  headId: string | null;
  /** Its topics, the main one first, then the ones placed inside it by when they started. */
  topicIds: string[];
  /** When talk first turned to it, and when its last stretch ended. */
  start: number;
  end: number;
  /** Time spent on it, in minutes (remarks hold the floor up to a minute each). */
  minutes: number;
  outcome: DiscussionOutcome;
  speakers: string[];
  /** Its remarks, in order. */
  segmentIds: string[];
  /** Where it sits on the chapter bar. */
  stretches: Stretch[];
}

/** When a to-do, decision or open question came up, for its time pill: the moment of the words it
 *  was said in, when the run as the meeting ends found them; otherwise when the live notes first
 *  caught it, as long as that was while people were still talking (a note the end run wrote fresh
 *  has no moment of its own). Null when neither: the pill falls back to its chapter's start. A
 *  chapter can come back late in a meeting, so its start can be an hour off. */
export function saidAt(n: { ts: number; quote?: { ts: number } | null }, startedAt: number, lastTalk: number): number | null {
  if (n.quote && n.quote.ts >= startedAt) return n.quote.ts;
  return n.ts >= startedAt && n.ts <= lastTalk ? n.ts : null;
}

/** For a group, which outcome its topics add up to. */
const OUTCOME_RANK: Record<DiscussionOutcome, number> = { decided: 3, action: 2, open: 1, info: 0 };

/** A finished meeting's topics as chapters, in the order they were first talked about. */
export function meetingChapters(
  discussions: Array<Pick<Discussion, "id" | "itemId" | "topic" | "outcome" | "segmentIds" | "mergedInto" | "group">>,
  segments: Array<Pick<Segment, "id" | "ts" | "speakerName">>,
  end = Infinity,
): MeetingChapter[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const held = remarkTimes(segments);
  const shapes: ChapterTopic[] = discussions.map((d) => ({
    id: d.id,
    itemId: d.itemId,
    mergedInto: d.mergedInto,
    group: d.group,
    times: d.segmentIds.flatMap((id) => byId.get(id)?.ts ?? []),
  }));
  const shapeById = new Map(shapes.map((t) => [t.id, t]));
  const last = Math.max(-Infinity, ...segments.map((s) => s.ts));
  const bar = stretches(shapes, null, Math.min(end, last + TAIL_MS));
  const chapters = new Map<string, MeetingChapter & { first: Map<string, number> }>();
  discussions.forEach((d, i) => {
    const key = chapterOf(shapes[i], shapeById);
    const turns = d.segmentIds.flatMap((id) => byId.get(id) ?? []);
    const c =
      chapters.get(key) ??
      ({ key, title: d.group ?? d.topic, itemId: d.itemId, headId: null, topicIds: [], start: Infinity, end: -Infinity, minutes: 0, outcome: d.outcome, speakers: [], segmentIds: [], stretches: [], first: new Map() } as MeetingChapter & { first: Map<string, number> });
    if (d.id === key) {
      c.headId = d.id;
      c.title = d.topic;
      c.outcome = d.outcome;
    } else if (!c.headId && OUTCOME_RANK[d.outcome] > OUTCOME_RANK[c.outcome]) c.outcome = d.outcome;
    c.topicIds.push(d.id);
    c.first.set(d.id, Math.min(Infinity, ...turns.map((t) => t.ts)));
    c.segmentIds.push(...turns.map((t) => t.id));
    c.minutes += turns.reduce((ms, t) => ms + (held.get(t.id) ?? 0), 0) / 60_000;
    for (const t of turns) if (!c.speakers.includes(t.speakerName)) c.speakers.push(t.speakerName);
    chapters.set(key, c);
  });
  return [...chapters.values()]
    .map(({ first, ...c }) => {
      const turns = c.segmentIds.flatMap((id) => byId.get(id) ?? []).sort((a, b) => a.ts - b.ts);
      const own = bar.filter((s) => s.chapter === c.key);
      return {
        ...c,
        topicIds: [...c.topicIds].sort((a, b) => (a === c.headId ? -1 : b === c.headId ? 1 : first.get(a)! - first.get(b)!)),
        segmentIds: turns.map((t) => t.id),
        start: Math.min(own[0]?.from ?? Infinity, turns[0]?.ts ?? Infinity),
        end: Math.max(own.at(-1)?.to ?? -Infinity, turns.at(-1)?.ts ?? -Infinity),
        stretches: own,
      };
    })
    .filter((c) => c.segmentIds.length)
    .sort((a, b) => a.start - b.start);
}
