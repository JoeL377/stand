import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainNode } from "../shared/protocol.ts";
import { layoutAll } from "./room/BrainMap.tsx";

const node = (id: string, parent: string | null, cluster?: string): BrainNode => ({ id, parent, label: id, detail: null, by: null, ts: 0, quote: null, points: [], caught: [], ...(cluster ? { cluster } : {}) });

test("a map with one centre keeps the whole canvas", () => {
  const { hubs, placed } = layoutAll([node("d1", null), node("i1", "d1"), node("d2", null)], 1200, 700);
  assert.deepEqual(hubs.map((h) => [h.id, h.x, h.y]), [["root", 600, 350]]);
  assert.ok(placed.filter((p) => !p.node?.parent).every((p) => p.from === "root"));
});

test("a subject the talk moved to gets a centre of its own, beside the map's own centre", () => {
  const nodes = [node("d1", null), node("i1", "d1"), node("d2", null, "Credit cards"), node("i2", "d2"), node("d3", null, "Credit cards")];
  const { hubs, placed } = layoutAll(nodes, 1200, 700);
  assert.deepEqual(hubs.map((h) => [h.id, h.label]), [["root", null], ["hub:Credit cards", "Credit cards"]]);
  assert.ok(hubs[0]!.x < hubs[1]!.x, "side by side on a wide screen, the map's own centre first");
  const from = (id: string) => placed.find((p) => p.id === id)!.from;
  assert.deepEqual([from("d1"), from("d2"), from("d3"), from("i2")], ["root", "hub:Credit cards", "hub:Credit cards", "d2"]);
  // Its directions sit nearer their own centre than the map's.
  const d2 = placed.find((p) => p.id === "d2")!;
  assert.ok(Math.hypot(d2.x - hubs[1]!.x, d2.y - hubs[1]!.y) < Math.hypot(d2.x - hubs[0]!.x, d2.y - hubs[0]!.y));
  // A tall screen stacks them.
  const tall = layoutAll(nodes, 700, 1400).hubs;
  assert.ok(tall[0]!.y < tall[1]!.y && tall[0]!.x === tall[1]!.x);
});
