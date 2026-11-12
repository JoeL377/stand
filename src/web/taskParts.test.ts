import assert from "node:assert/strict";
import { test } from "node:test";
import { partsTally, withParts } from "../shared/tasks.ts";

const row = (id: string, parentId: string | null = null) => ({ id, parentId });
const shape = (rows: Array<{ note: { id: string }; parts: Array<{ id: string }> }>) => rows.map((r) => [r.note.id, ...r.parts.map((p) => p.id)]);

test("a to-do's parts go under it, in the list's order, wherever they were in the list", () => {
  const rows = withParts([row("b1", "a"), row("x"), row("a"), row("b2", "a"), row("y")]);
  assert.deepEqual(shape(rows), [["x"], ["a", "b1", "b2"], ["y"]]);
});

test("a part whose parent isn't in the list stands on its own", () => {
  assert.deepEqual(shape(withParts([row("b", "gone"), row("x")])), [["b"], ["x"]]);
});

test("no row is lost when the data has more than one level, a loop or a to-do that names itself", () => {
  assert.deepEqual(shape(withParts([row("a"), row("b", "a"), row("c", "b")])), [["a", "b"], ["c"]]);
  assert.deepEqual(shape(withParts([row("a", "b"), row("b", "a")])), [["a"], ["b"]]);
  assert.deepEqual(shape(withParts([row("a", "a")])), [["a"]]);
});

test("the tally counts done parts of the ones still wanted", () => {
  const part = (id: string, more: { doneAt?: number | null; state?: "open" | "doing" | "done" | "dropped" | null } = {}) => ({ id, kind: "action" as const, parentId: "a", doneAt: null, ...more });
  const tally = partsTally([
    { id: "a", kind: "action", doneAt: null, parentId: null },
    part("b", { doneAt: 1 }),
    part("c", { state: "doing" }),
    part("d", { doneAt: 2, state: "dropped" }),
    { id: "q", kind: "question", doneAt: null, state: "done", parentId: "a" },
    { id: "self", kind: "action", doneAt: null, parentId: "self" },
  ]);
  assert.deepEqual([...tally], [["a", { done: 2, total: 3 }]]);
});
