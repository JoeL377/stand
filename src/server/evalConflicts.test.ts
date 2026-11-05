import assert from "node:assert/strict";
import { test } from "node:test";
import { score, wordOverlap, type Key } from "../../scripts/eval-conflicts.ts";

const key: Key = {
  reversals: [{ a: "r1", b: "r2" }],
  duplicates: [
    { a: "d1", b: "d2" },
    { a: "d3", b: "d4" },
  ],
  traps: [{ a: "t1", b: "t2" }],
};

test("the conflict eval scores pairs in either order and keeps unlabeled flags apart", () => {
  const s = score(
    [
      { a: "r2", b: "r1", relation: "replaces" },
      { a: "d1", b: "d2", relation: "duplicate" },
      { a: "d3", b: "d4", relation: "replaces" },
      { a: "t1", b: "t2", relation: "duplicate" },
      { a: "x", b: "y", relation: "replaces" },
    ],
    key,
  );
  assert.equal(s.reversals.found.length, 1);
  assert.equal(s.duplicates.merged.length, 1);
  assert.equal(s.duplicates.conflicts.length, 1);
  assert.equal(s.traps.tripped.length, 1);
  assert.deepEqual(s.unlabeled.map((f) => f.a), ["x"]);
});

test("a reversal called a duplicate doesn't count as found", () => {
  const s = score([{ a: "r1", b: "r2", relation: "duplicate" }], key);
  assert.equal(s.reversals.found.length, 0);
  assert.equal(s.reversals.missed.length, 1);
});

test("the word baseline only reaches lines that share two words", () => {
  const found = wordOverlap([
    { id: "a", on: "2026-10-17", text: "Port the review queue" },
    { id: "b", on: "2026-10-18", text: "Drop the review queue" },
    { id: "c", on: "2026-10-30", text: "Rebuild natively instead" },
  ]);
  assert.deepEqual(found.map((f) => [f.a, f.b]), [["a", "b"]]);
});
