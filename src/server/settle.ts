// A long meeting's notes stay quick. Every notes run used to send an item's whole transcript
// and get every line back under its topic, so a two-hour item meant a run that grew until it
// stalled. Now a topic nobody has come back to for a while is settled: its lines aren't sent
// again, the model sees it as one line with the notes it already has, and those notes are kept
// as they are. A run reads the topics still going and the recent talk, so it's about the same
// size at minute 110 as at minute 20. The run as the meeting ends reads everything once more.
//
// One topic can still run for an hour. Inside a topic that's still going, talk older than
// FOLD_AFTER_MS folds once there's a lot of it: the model sees the topic's positions and notes
// so far in place of those lines, as a running summary that costs no extra call, and carries
// the topic on from the recent talk.

import type { Discussion, Segment } from "../shared/protocol.ts";

/** A topic is settled once nothing has been said about it for this long. */
export const SETTLE_AFTER_MS = 10 * 60_000;
/** Talk a run put under no topic drops out once it's that old too, in steps of this, so the
 *  start of what a run sends only changes now and then and the prompt cache keeps working. */
const SMALL_TALK_STEP_MS = 5 * 60_000;
/** Inside a topic still going, talk older than this folds into what the topic says so far... */
export const FOLD_AFTER_MS = 15 * 60_000;
/** ...once that's at least this many lines; less isn't worth losing the wording for. */
export const FOLD_MIN_LINES = 30;
/** Live, a topic's talk locks to it sooner than that: once it's this old (and there's a little of
 *  it), the runs no longer regroup it, so a stretch already on the board stops flipping between one
 *  topic and two. Only the last few minutes are drawn again. The run as the meeting ends still
 *  regroups everything for the recap. */
export const LOCK_AFTER_MS = 4 * 60_000;
export const LOCK_MIN_LINES = 6;

export interface Settled {
  /** Topics left as they are, oldest first. */
  settled: Discussion[];
  /** Topics still going whose older talk folds: each with only the lines that fold. */
  folded: Discussion[];
  /** The lines a run still reads, in order. */
  window: Segment[];
}

/** readUpTo: the newest line the last run that worked had read. Talk after it hasn't been put
 *  under a topic yet, however old (the notes were failing, say), so it stays in. */
export function settle(
  segments: Segment[],
  discussions: Discussion[],
  now: number,
  readUpTo = -Infinity,
  { foldAfterMs = FOLD_AFTER_MS, foldMinLines = FOLD_MIN_LINES }: { foldAfterMs?: number; foldMinLines?: number } = {},
): Settled {
  const at = new Map(segments.map((s) => [s.id, s.ts]));
  const quiet = now - SETTLE_AFTER_MS;
  const settled: Array<{ d: Discussion; first: number }> = [];
  const going = new Set<string>();
  for (const d of discussions) {
    const times = d.segmentIds.map((id) => at.get(id)).filter((t) => t !== undefined);
    if (times.length && Math.max(...times) < quiet) settled.push({ d, first: Math.min(...times) });
    else for (const id of d.segmentIds) going.add(id);
  }
  const step = (t: number) => Math.min(Math.floor(t / SMALL_TALK_STEP_MS) * SMALL_TALK_STEP_MS, readUpTo + 1);
  const foldEdge = step(now - foldAfterMs);
  const folded: Array<{ d: Discussion; first: number }> = [];
  for (const d of discussions) {
    if (!d.segmentIds.some((id) => going.has(id))) continue;
    const old = d.segmentIds.filter((id) => (at.get(id) ?? Infinity) < foldEdge);
    if (old.length < foldMinLines) continue;
    folded.push({ d: { ...d, segmentIds: old }, first: Math.min(...old.map((id) => at.get(id)!)) });
    for (const id of old) going.delete(id);
  }
  const done = new Set([...settled, ...folded].flatMap(({ d }) => d.segmentIds));
  const edge = step(quiet);
  const byFirst = (a: { first: number }, b: { first: number }) => a.first - b.first;
  return {
    settled: settled.sort(byFirst).map(({ d }) => d),
    folded: folded.sort(byFirst).map(({ d }) => d),
    window: segments.filter((s) => going.has(s.id) || (!done.has(s.id) && s.ts >= edge)),
  };
}
