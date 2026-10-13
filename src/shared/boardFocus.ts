// Which topic the board's middle shows. Live notes regroup the recent talk on every run, so the
// topic holding the latest remark can change from one run to the next while the talk hasn't moved
// on: a stretch drawn as one topic, then as two, then as one again. The board waits before it
// follows: the topic on screen stays until the new one has taken a few remarks of its own since the
// one on screen was last talked about, or the one on screen has gone quiet. A rename keeps the id
// (db.replaceDiscussions), so it changes the title in place and doesn't count as a switch; when a
// run regroups the topic on screen under a new id, the board stays with whichever topic now holds
// the remarks it was showing.

export interface FocusTopic {
  id: string;
  /** Its remarks: their ids and when each was said. */
  lines: Array<{ id: string; ts: number }>;
}

/** What the board is showing: the topic, and the latest of its remarks it had then. */
export interface Focus {
  id: string;
  line: string | null;
}

/** Remarks the new topic needs since the one on screen was last talked about... */
export const SWITCH_REMARKS = 3;
/** ...or how long the one on screen has to have gone quiet while the new one is talked about. */
export const SWITCH_QUIET_MS = 30_000;

const latestLine = (t: FocusTopic) => t.lines.reduce<{ id: string; ts: number } | null>((a, l) => (!a || l.ts > a.ts ? l : a), null);
const focusOn = (t: FocusTopic): Focus => ({ id: t.id, line: latestLine(t)?.id ?? null });

/** shown: what the board shows now, if anything. candidate: the topic holding the latest remark
 *  (or the one talked about most recently). Returns what to show. */
export function pickFocus(shown: Focus | null, candidate: string | null, topics: FocusTopic[], now: number): Focus | null {
  const next = candidate ? topics.find((t) => t.id === candidate) : undefined;
  // The topic on screen, or the one its remarks went to when a run regrouped them.
  const on = shown ? (topics.find((t) => t.id === shown.id) ?? topics.find((t) => shown.line && t.lines.some((l) => l.id === shown.line))) : undefined;
  if (!next) return on ? focusOn(on) : shown;
  if (!on || on.id === next.id || !on.lines.length) return focusOn(next);
  const lastOn = Math.max(...on.lines.map((l) => l.ts));
  const since = next.lines.filter((l) => l.ts > lastOn);
  if (since.length >= SWITCH_REMARKS) return focusOn(next);
  if (since.length && now - lastOn >= SWITCH_QUIET_MS) return focusOn(next);
  return focusOn(on);
}
