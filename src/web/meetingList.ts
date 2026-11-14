// How the Meetings tab lays out its calendar: which days a view shows, which hours, and where each
// meeting's block sits when two overlap.

const DAY = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });
const MONTH_YEAR = new Intl.DateTimeFormat([], { month: "long", year: "numeric" });
const MONTH = new Intl.DateTimeFormat([], { month: "short" });

/** Midnight, local time, of the day a time falls in. */
export const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** The day `n` days after (or before) a midnight, keeping clock changes out of the sum. */
export const addDays = (day: number, n: number) => {
  const d = new Date(day);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

/** Monday, 00:00, of the week a time falls in. */
export const weekStart = (t: number) => addDays(midnight(t), -((new Date(t).getDay() + 6) % 7));

/** The midnights of the days a view shows. */
export const viewDays = (start: number, count: number) => Array.from({ length: count }, (_, i) => addDays(start, i));

/** The view's name, the way a calendar heads it: "November 2026", or "Oct – Nov 2026" across a month's end. */
export function viewTitle(days: number[]) {
  const a = new Date(days[0]);
  const b = new Date(days.at(-1)!);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return MONTH_YEAR.format(a);
  if (a.getFullYear() === b.getFullYear()) return `${MONTH.format(a)} – ${MONTH.format(b)} ${b.getFullYear()}`;
  return `${DAY.format(a)}, ${a.getFullYear()} – ${DAY.format(b)}, ${b.getFullYear()}`;
}

/**
 * The hours the grid shows: the working day (9 to 6) widened to take in every meeting of the view,
 * so a late call is on the grid without the empty night above it.
 */
export function hourRange(spans: Array<{ start: number; end: number }>, from = 9, to = 18) {
  let lo = from;
  let hi = to;
  for (const s of spans) {
    const day = midnight(s.start);
    lo = Math.min(lo, Math.floor((s.start - day) / 3_600_000));
    hi = Math.max(hi, Math.min(24, Math.ceil((s.end - day) / 3_600_000)));
  }
  return { from: Math.max(0, lo), to: Math.min(24, hi) };
}

export interface Placed<T> {
  item: T;
  start: number;
  end: number;
  /** Which side-by-side column it takes, from 0, and how many its overlapping group has. */
  lane: number;
  lanes: number;
}

/**
 * One day's meetings as calendar blocks. Blocks that overlap sit side by side, like a calendar:
 * each takes the first free lane, and every block in an overlapping group shares its lane count.
 * `minMs` is how long the shortest block draws, so a one-minute call still has room for its name.
 */
export function layoutDay<T>(spans: Array<{ item: T; start: number; end: number }>, minMs = 20 * 60_000): Array<Placed<T>> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Array<Placed<T>> = [];
  let group: Array<Placed<T>> = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const close = () => {
    for (const p of group) p.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const s of sorted) {
    const drawnEnd = Math.max(s.end, s.start + minMs);
    if (s.start >= groupEnd) close();
    let lane = laneEnds.findIndex((end) => end <= s.start);
    if (lane < 0) lane = laneEnds.push(drawnEnd) - 1;
    else laneEnds[lane] = drawnEnd;
    const p = { item: s.item, start: s.start, end: s.end, lane, lanes: 1 };
    group.push(p);
    out.push(p);
    groupEnd = Math.max(groupEnd, drawnEnd);
  }
  close();
  return out;
}

/** A call of under three minutes that caught nothing and made nothing: someone trying the mic. */
export function isShortCall(m: { startedAt: number; endedAt: number; todos: number; open: number; decided: number }, hasKind: boolean, made: number) {
  return m.endedAt - m.startedAt < 3 * 60_000 && !hasKind && !made && !m.todos && !m.open && !m.decided;
}
