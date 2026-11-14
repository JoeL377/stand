import { fmtDate, fmtDay } from "./util.ts";

// How the Meetings tab groups, labels and searches its rows.

const WEEKDAY = new Intl.DateTimeFormat([], { weekday: "short" });
const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
/** The day a meeting sits under on the timeline: "Today", "Yesterday", else "Wed, Nov 11" (with the year when it isn't this one). */
export function dayLabel(ts: number, now = Date.now()) {
  const days = Math.round((midnight(now) - midnight(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(ts).getFullYear() === new Date(now).getFullYear() ? fmtDate(ts) : `${fmtDate(ts)}, ${new Date(ts).getFullYear()}`;
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

/** Whether this person talked or wrote in a meeting, by full name or by first name alone. */
export function wasIn(people: string[], me: string) {
  const norm = (s: string) => s.trim().toLowerCase();
  const mine = norm(me);
  return people.some((p) => norm(p) === mine || norm(p) === mine.split(" ")[0] || norm(p).split(" ")[0] === mine);
}

/** Every word of the search is somewhere in the texts (a name, a summary, who was there), in any order. */
export function matchesSearch(query: string, texts: Array<string | null | undefined>) {
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
