// The topic board's chapter bar as stretches of time (TopicBoard.tsx; the replay scorer reads
// the same). A chapter is a main topic with the smaller topics placed inside it, a small group of
// topics, or a topic not placed yet (see server/topicMerge.ts). A stretch lasts from when talk
// turned to a chapter until it moved on. A short aside, under a minute, doesn't cut the stretch
// around it in two: it folds into it.

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
