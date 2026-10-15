import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_EVERY_MS, pickFocus } from "../shared/boardFocus.ts";

const S = 1000;
const M = 60 * S;
/** A topic whose remarks are named by the second they were said at. */
const topic = (id: string, ...seconds: number[]) => ({ id, lines: seconds.map((s) => ({ id: `r${s}`, ts: s * S })) });
const on = (id: string, last: number, check: number) => ({ id, line: `r${last}`, check });

test("the board looks again only every two minutes", () => {
  assert.equal(CHECK_EVERY_MS, 2 * M);
  const a = topic("a", 0, 10, 20, 30);
  // Plenty said on b, but the next check isn't until 2:00: the board stays.
  const b = topic("b", 40, 50, 60, 70, 80, 90, 100);
  assert.deepEqual(pickFocus(on("a", 30, 0), "b", [a, b], 100 * S, 0), on("a", 30, 0));
  // At 2:00 b held most of the last two minutes: it takes the board.
  assert.deepEqual(pickFocus(on("a", 30, 0), "b", [a, b], 120 * S, 0), on("b", 100, 1));
});

test("an aside at the check doesn't take the board", () => {
  const a = topic("a", 10, 30, 50, 70, 90, 110);
  // The latest remark went to b just before the check, but a held most of the two minutes.
  assert.deepEqual(pickFocus(on("a", 90, 0), "b", [a, topic("b", 115, 118)], 120 * S, 0), on("a", 110, 1));
  // And it stays until the next check, whatever is said meanwhile.
  assert.deepEqual(pickFocus(on("a", 110, 1), "b", [a, topic("b", 115, 118, 125, 130, 140, 150)], 200 * S, 0), on("a", 110, 1));
});

test("checks count from the start of the meeting, so every screen checks at the same moments", () => {
  const start = 1_000 * S;
  const a = topic("a", 1_010);
  const b = topic("b", 1_050, 1_060, 1_070);
  assert.deepEqual(pickFocus(on("a", 1_010, 0), "b", [a, b], start + 119 * S, start), on("a", 1_010, 0));
  assert.deepEqual(pickFocus(on("a", 1_010, 0), "b", [a, b], start + 121 * S, start), on("b", 1_070, 1));
});

test("when a run regroups the topic on screen under a new id, the board stays with its remarks", () => {
  // a's remarks now sit in a2, and the latest remark went to b.
  const now = [topic("a2", 0, 10, 20, 30), topic("b", 35)];
  assert.deepEqual(pickFocus(on("a", 30, 0), "b", now, 35 * S, 0), on("a2", 30, 0));
});

test("the board follows at once when there's nothing on it or what was on it is gone", () => {
  assert.deepEqual(pickFocus(null, "b", [topic("b", 1)], 1 * S, 0), on("b", 1, 0));
  assert.deepEqual(pickFocus(on("gone", 99, 0), "b", [topic("b", 1)], 1 * S, 0), on("b", 1, 0));
  assert.deepEqual(pickFocus(on("a", 1, 0), null, [topic("a", 1)], 1 * S, 0), on("a", 1, 0));
});
