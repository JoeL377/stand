// A long meeting's notes stay quick. Every notes run used to send an item's whole transcript
// and get every line back under its topic, so a two-hour item meant a run that grew until it
// stalled. Now a topic nobody has come back to for a while is settled: its lines aren't sent
// again, the model sees it as one line with the notes it already has, and those notes are kept
// as they are. A run reads the topics still going and the recent talk, so it's about the same
// size at minute 110 as at minute 20. The run as the meeting ends reads everything once more.

import type { Discussion, Segment } from "../shared/protocol.ts";

/** A topic is settled once nothing has been said about it for this long. */
export const SETTLE_AFTER_MS = 10 * 60_000;
/** Talk a run put under no topic drops out once it's that old too, in steps of this, so the
 *  start of what a run sends only changes now and then and the prompt cache keeps working. */
const SMALL_TALK_STEP_MS = 5 * 60_000;

export interface Settled {
  /** Topics left as they are, oldest first. */
  settled: Discussion[];
  /** The lines a run still reads, in order. */
  window: Segment[];
}

/** readUpTo: the newest line the last run that worked had read. Talk after it hasn't been put
 *  under a topic yet, however old (the notes were failing, say), so it stays in. */
export function settle(segments: Segment[], discussions: Discussion[], now: number, readUpTo = -Infinity): Settled {
  const at = new Map(segments.map((s) => [s.id, s.ts]));
  const quiet = now - SETTLE_AFTER_MS;
  const settled: Array<{ d: Discussion; first: number }> = [];
  const going = new Set<string>();
  for (const d of discussions) {
    const times = d.segmentIds.map((id) => at.get(id)).filter((t) => t !== undefined);
    if (times.length && Math.max(...times) < quiet) settled.push({ d, first: Math.min(...times) });
    else for (const id of d.segmentIds) going.add(id);
  }
  const done = new Set(settled.flatMap(({ d }) => d.segmentIds));
  const edge = Math.min(Math.floor(quiet / SMALL_TALK_STEP_MS) * SMALL_TALK_STEP_MS, readUpTo + 1);
  return {
    settled: settled.sort((a, b) => a.first - b.first).map(({ d }) => d),
    window: segments.filter((s) => going.has(s.id) || (!done.has(s.id) && s.ts >= edge)),
  };
}
