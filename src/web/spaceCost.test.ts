import assert from "node:assert/strict";
import { test } from "node:test";
import { callsLabel, dayBars, daysSummary, usdLabel } from "./spaceCost.ts";

const day = (d: string, usd: number, calls = 1, between = 0) => ({ day: d, usd, calls, between });

test("a cost under a cent reads as under a cent, and nothing as nothing", () => {
  assert.deepEqual([usdLabel(4.123), usdLabel(0.004), usdLabel(0.0099), usdLabel(0.01), usdLabel(0), usdLabel(12.34)], ["$4.12", "under $0.01", "under $0.01", "$0.01", "$0.00", "$12.34"]);
  assert.deepEqual([callsLabel(1), callsLabel(310)], ["1 call", "310 calls"]);
});

test("bars are in proportion to the day that cost most, a day of nothing is a hairline, and a tiny day still shows", () => {
  const bars = dayBars([day("2026-11-10", 2, 3, 1), day("2026-11-11", 0, 0), day("2026-11-12", 4, 31, 4), day("2026-11-13", 0.001)]);
  assert.deepEqual(bars.map((b) => [b.height, b.between]), [[50, 50], [0, 0], [100, 100], [3, 0]]);
  assert.match(bars[2].title, /^(Nov 12|12 Nov) · \$4\.00 · 31 calls$/);
  assert.match(bars[3].title, /under \$0\.01 · 1 call$/);
  assert.deepEqual(dayBars([day("2026-11-10", 0, 0)]).map((b) => b.height), [0]);
});

test("a screen reader hears the range and its most expensive day", () => {
  assert.match(daysSummary([day("2026-11-11", 0.1), day("2026-11-12", 0.42), day("2026-11-13", 0.2)]), /^Cost by day for the last 3 days: most on (Nov 12|12 Nov), \$0\.42$/);
  assert.equal(daysSummary([day("2026-11-12", 0, 0)]), "Cost by day for the last 1 day: nothing");
});
