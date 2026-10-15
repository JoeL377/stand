// Which topic the board's middle shows. Live notes regroup the recent talk on every run, so the
// topic holding the latest remark can change from one run to the next while the talk hasn't moved
// on: a stretch drawn as one topic, then as two, then as one again. So the board doesn't follow
// each run. It looks again only every two minutes, counted from the start of the meeting so every
// screen checks at the same moments, and then shows whichever topic held the most of the talk in
// the two minutes before; between checks it stays put. It follows at once only when there's
// nothing on it, or the topic on it is gone (another agenda item came into focus, say). A rename
// keeps the id (db.replaceDiscussions), so it changes the title in place; when a run regroups the
// topic on screen under a new id, the board stays with whichever topic now holds its remarks.

export interface FocusTopic {
  id: string;
  /** Its remarks: their ids and when each was said. */
  lines: Array<{ id: string; ts: number }>;
}

/** What the board is showing: the topic, the latest of its remarks it had then, and the check it was chosen at. */
export interface Focus {
  id: string;
  line: string | null;
  check: number;
}

/** How often the board looks again, and how far back it looks when it does. */
export const CHECK_EVERY_MS = 120_000;

const latestLine = (t: FocusTopic) => t.lines.reduce<{ id: string; ts: number } | null>((a, l) => (!a || l.ts > a.ts ? l : a), null);
const focusOn = (t: FocusTopic, check: number): Focus => ({ id: t.id, line: latestLine(t)?.id ?? null, check });

/** shown: what the board shows now, if anything. candidate: the topic holding the latest remark
 *  (or the one talked about most recently). startedAt: when the meeting started, which the checks
 *  count from. Returns what to show. */
export function pickFocus(shown: Focus | null, candidate: string | null, topics: FocusTopic[], now: number, startedAt: number): Focus | null {
  const check = Math.floor(Math.max(0, now - startedAt) / CHECK_EVERY_MS);
  const next = candidate ? topics.find((t) => t.id === candidate) : undefined;
  // The topic on screen, or the one its remarks went to when a run regrouped them.
  const on = shown ? (topics.find((t) => t.id === shown.id) ?? topics.find((t) => shown.line && t.lines.some((l) => l.id === shown.line))) : undefined;
  if (!on || !on.lines.length) return next ? focusOn(next, check) : on ? focusOn(on, check) : shown;
  if (shown!.check === check) return focusOn(on, check);
  // A check: the topic that held the most of the last two minutes takes the board.
  const since = startedAt + check * CHECK_EVERY_MS - CHECK_EVERY_MS;
  const said = (t: FocusTopic) => t.lines.filter((l) => l.ts > since && l.ts <= now).length;
  const top = topics.reduce<FocusTopic | null>((a, t) => (said(t) > (a ? said(a) : 0) ? t : a), null);
  return focusOn(top && said(top) > said(on) ? top : on, check);
}
