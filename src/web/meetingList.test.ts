import assert from "node:assert/strict";
import { test } from "node:test";
import { hourRange, isShortCall, layoutDay, viewDays, viewTitle, weekStart } from "./meetingList.ts";

const at = (month: number, day: number, hour = 10, min = 0) => new Date(2026, month, day, hour, min).getTime();
const MIN = 60_000;

test("a week starts on Monday", () => {
  assert.equal(weekStart(at(10, 14, 15)), at(10, 9, 0)); // Saturday → Monday
  assert.equal(weekStart(at(10, 9, 0)), at(10, 9, 0));
  assert.equal(weekStart(at(10, 15, 23)), at(10, 9, 0)); // Sunday is the week's last day
});

test("a view is named for its month, or both months across a month's end", () => {
  assert.match(viewTitle(viewDays(at(10, 9, 0), 7)), /November 2026/);
  assert.match(viewTitle(viewDays(at(9, 26, 0), 7)), /Oct – Nov 2026/);
});

test("the hours widen from 9 to 6 to take in every meeting", () => {
  assert.deepEqual(hourRange([]), { from: 9, to: 18 });
  assert.deepEqual(hourRange([{ start: at(10, 9, 7, 30), end: at(10, 9, 8, 10) }, { start: at(10, 10, 20), end: at(10, 10, 21, 5) }]), { from: 7, to: 22 });
});

test("overlapping meetings sit side by side; the rest take the full width", () => {
  const p = layoutDay([
    { item: "a", start: at(10, 9, 10), end: at(10, 9, 11) },
    { item: "b", start: at(10, 9, 10, 30), end: at(10, 9, 11, 30) },
    { item: "c", start: at(10, 9, 11, 10), end: at(10, 9, 11, 40) },
    { item: "d", start: at(10, 9, 14), end: at(10, 9, 15) },
  ]);
  const by = Object.fromEntries(p.map((x) => [x.item, `${x.lane}/${x.lanes}`]));
  assert.deepEqual(by, { a: "0/2", b: "1/2", c: "0/2", d: "0/1" });
});

test("a one-minute call draws tall enough to clash with one right after it", () => {
  const p = layoutDay([
    { item: "test", start: at(10, 9, 10), end: at(10, 9, 10, 1) },
    { item: "real", start: at(10, 9, 10, 5), end: at(10, 9, 10, 45) },
  ]);
  assert.deepEqual(p.map((x) => x.lanes), [2, 2]);
});

const m = { startedAt: 0, endedAt: MIN, todos: 0, open: 0, decided: 0 };
test("a one-minute call that left nothing is a short call", () => assert.equal(isShortCall(m, false, 0), true));
test("a short call that caught a to-do or made something is not", () => {
  assert.equal(isShortCall({ ...m, todos: 1 }, false, 0), false);
  assert.equal(isShortCall(m, true, 0), false);
  assert.equal(isShortCall(m, false, 1), false);
  assert.equal(isShortCall({ ...m, endedAt: 3 * MIN }, false, 0), false);
});
