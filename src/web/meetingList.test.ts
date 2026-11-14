import assert from "node:assert/strict";
import { test } from "node:test";
import { isShortCall, matchesSearch, periodLabel, wasIn, whenLabel } from "./meetingList.ts";

// A Saturday afternoon, local time.
const now = new Date(2026, 10, 14, 15, 0).getTime();
const at = (month: number, day: number, hour = 10) => new Date(2026, month, day, hour).getTime();

test("groups by this week, last week, then month", () => {
  assert.equal(periodLabel(at(10, 9), now), "This week"); // Monday
  assert.equal(periodLabel(at(10, 14), now), "This week");
  assert.equal(periodLabel(at(10, 8), now), "Last week"); // Sunday before
  assert.equal(periodLabel(at(10, 2), now), "Last week");
  assert.match(periodLabel(at(10, 1), now), /November/);
  assert.match(periodLabel(at(9, 30), now), /October/);
  assert.match(periodLabel(new Date(2025, 11, 3).getTime(), now), /2025/);
});

test("says today, yesterday, a weekday, then a date", () => {
  assert.equal(whenLabel(at(10, 14, 9), now), "Today");
  assert.equal(whenLabel(at(10, 13, 23), now), "Yesterday");
  assert.doesNotMatch(whenLabel(at(10, 11), now), /\d/);
  assert.match(whenLabel(at(10, 5), now), /5/);
});

const m = { startedAt: 0, endedAt: 60_000, todos: 0, open: 0, decided: 0 };
test("a one-minute call that left nothing is a short call", () => assert.equal(isShortCall(m, false, 0), true));
test("a short call that caught a to-do or made something is not", () => {
  assert.equal(isShortCall({ ...m, todos: 1 }, false, 0), false);
  assert.equal(isShortCall(m, true, 0), false);
  assert.equal(isShortCall(m, false, 1), false);
  assert.equal(isShortCall({ ...m, endedAt: 3 * 60_000 }, false, 0), false);
});

test("you were in a meeting you talked in, by full or first name", () => {
  assert.equal(wasIn(["Joe Liang", "Huy Ngo"], "Joe Liang"), true);
  assert.equal(wasIn(["Joe", "Huy Ngo"], "Joe Liang"), true);
  assert.equal(wasIn(["Huy Ngo", "Andy Li"], "Joe Liang"), false);
  assert.equal(wasIn([], "Joe Liang"), false);
});

test("search takes every word, in any order, across name, summary and people", () => {
  const texts = ["Pricing for small teams", "The team settled on a flat price per space.", "Huy Ngo"];
  assert.equal(matchesSearch("pricing huy", texts), true);
  assert.equal(matchesSearch("flat PRICE", texts), true);
  assert.equal(matchesSearch("pricing andy", texts), false);
  assert.equal(matchesSearch("  ", texts), true);
});
