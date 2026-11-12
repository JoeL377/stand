// What the Manage spaces cost panel shows (CostPanel.tsx), kept apart so it can be tested without a page.
import type { SpaceCost } from "../shared/protocol.ts";

/** "$4.12", to the cent at any size so a column of them lines up; a cost under a cent reads "under $0.01", not "$0.00". */
export const usdLabel = (usd: number) => (usd > 0 && usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

export const callsLabel = (n: number) => `${n} ${n === 1 ? "call" : "calls"}`;

/** "Nov 12" for the day "2026-11-12", which is already in the viewer's time. */
export const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

/** One bar per day: its height as a share of the day that cost most, and the part of it that was
 *  between meetings as a share of the bar. A day that cost something always shows. */
export function dayBars(days: SpaceCost["days"]) {
  const most = Math.max(0, ...days.map((d) => d.usd));
  return days.map((d) => ({
    day: d.day,
    height: most > 0 && d.usd > 0 ? Math.max(3, (d.usd / most) * 100) : 0,
    between: d.usd > 0 ? Math.min(100, (d.between / d.usd) * 100) : 0,
    title: `${dayLabel(d.day)} · ${usdLabel(d.usd)} · ${callsLabel(d.calls)}`,
  }));
}

/** What a screen reader hears for the row of bars. */
export function daysSummary(days: SpaceCost["days"]) {
  const top = days.reduce<SpaceCost["days"][number] | null>((a, d) => (d.usd > (a?.usd ?? 0) ? d : a), null);
  const range = `Cost by day for the last ${days.length} ${days.length === 1 ? "day" : "days"}`;
  return top ? `${range}: most on ${dayLabel(top.day)}, ${usdLabel(top.usd)}` : `${range}: nothing`;
}
