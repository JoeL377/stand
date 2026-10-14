import assert from "node:assert/strict";
import { test } from "node:test";
import { pickFocus } from "../shared/boardFocus.ts";

const S = 1000;
/** A topic whose remarks are named by the second they were said at. */
const topic = (id: string, ...seconds: number[]) => ({ id, lines: seconds.map((s) => ({ id: `r${s}`, ts: s * S })) });
const on = (id: string, last: number) => ({ id, line: `r${last}` });

test("the board waits for a new topic to take a few remarks before it switches", () => {
  const a = topic("a", 0, 10, 20, 30);
  // A run moved the latest remark into b: one remark isn't enough.
  assert.deepEqual(pickFocus(on("a", 30), "b", [a, topic("b", 35)], 35 * S), on("a", 30));
  // Three remarks on b since a was last talked about: switch.
  assert.deepEqual(pickFocus(on("a", 30), "b", [a, topic("b", 35, 40, 45)], 45 * S), on("b", 45));
  // Or a has been quiet for 30 seconds while b is talked about.
  assert.deepEqual(pickFocus(on("a", 30), "b", [a, topic("b", 61)], 61 * S), on("b", 61));
});

test("when a run regroups the topic on screen under a new id, the board stays with its remarks", () => {
  // a's remarks now sit in a2, and the latest remark went to b.
  const now = [topic("a2", 0, 10, 20, 30), topic("b", 35)];
  assert.deepEqual(pickFocus(on("a", 30), "b", now, 35 * S), on("a2", 30));
});

test("the board follows at once when there's nothing on it or what was on it is gone", () => {
  assert.deepEqual(pickFocus(null, "b", [topic("b", 1)], 1 * S), on("b", 1));
  assert.deepEqual(pickFocus(on("gone", 99), "b", [topic("b", 1)], 1 * S), on("b", 1));
  assert.deepEqual(pickFocus(on("a", 1), null, [topic("a", 1)], 1 * S), on("a", 1));
});
