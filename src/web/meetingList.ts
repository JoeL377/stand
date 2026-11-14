import { fmtDay } from "./util.ts";

// How the Meetings tab groups and labels its rows.

const MONTH = new Intl.DateTimeFormat([], { month: "long" });
const MONTH_YEAR = new Intl.DateTimeFormat([], { month: "long", year: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat([], { weekday: "short" });
const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
/** Monday, 00:00, of the week a time falls in. */
const weekStart = (t: number) => {
  const d = new Date(midnight(t));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};

/** The stretch a meeting sits under: "This week", "Last week", then "October" (with the year when it isn't this one). */
export function periodLabel(ts: number, now = Date.now()) {
  const thisWeek = weekStart(now);
  if (ts >= thisWeek) return "This week";
  const last = new Date(thisWeek);
  last.setDate(last.getDate() - 7);
  if (ts >= last.getTime()) return "Last week";
  return new Date(ts).getFullYear() === new Date(now).getFullYear() ? MONTH.format(ts) : MONTH_YEAR.format(ts);
}

/** When, on a row: "Today", "Yesterday", the weekday for the last few days, else "Nov 5". */
export function whenLabel(ts: number, now = Date.now()) {
  const days = Math.round((midnight(now) - midnight(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY.format(ts);
  return fmtDay(ts);
}

/** A call of under three minutes that caught nothing and made nothing: someone trying the mic. */
export function isShortCall(m: { startedAt: number; endedAt: number; todos: number; open: number; decided: number }, hasKind: boolean, made: number) {
  return m.endedAt - m.startedAt < 3 * 60_000 && !hasKind && !made && !m.todos && !m.open && !m.decided;
}
