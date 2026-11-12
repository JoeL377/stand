import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignBox, DesignDiagram } from "../shared/protocol.ts";
import { boxSize, fitView, layoutDiagram, roundedPath } from "./room/designLayout.ts";

const box = (id: string, more: Partial<DesignBox> = {}): DesignBox => ({ id, label: `Part ${id}`, detail: "One line on what it is for.", by: null, ts: 0, quote: null, points: [], caught: [], ...more });

test("a diagram is laid out with every box inside its group and no two boxes on top of each other", async () => {
  const d: DesignDiagram = {
    boxes: [box("b1", { group: "g1" }), box("b2", { group: "g1", kind: "store" }), box("b3", { group: "g2", points: [{ text: "A rule someone stated about it", by: "Joe", ts: 0, quote: null }] }), box("b4", { group: "g2" }), box("b5")],
    arrows: [
      { id: "a1", from: "b1", to: "b2", label: "feeds", by: null, ts: 0, quote: null },
      { id: "a2", from: "b2", to: "b3", label: "fills", by: null, ts: 0, quote: null },
      { id: "a3", from: "b4", to: "b4", label: "waits on", by: null, ts: 0, quote: null },
    ],
    groups: [{ id: "g1", label: "Capture", detail: "What the call hears" }, { id: "g2", label: "Review", detail: null }],
  };
  for (const tall of [false, true]) {
    const laid = await layoutDiagram(d, { tall, text: true });
    assert.equal(laid.boxes.length, 5);
    assert.deepEqual(laid.arrows.map((a) => a.arrow.id).sort(), ["a1", "a2", "a3"]);
    assert.ok(laid.arrows.every((a) => a.path.startsWith("M") && Number.isFinite(a.x) && Number.isFinite(a.y)));
    for (const g of laid.groups)
      for (const b of laid.boxes.filter((b) => b.box.group === g.group.id)) assert.ok(b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h, `${b.box.id} sits inside ${g.group.label}`);
    for (const a of laid.boxes) for (const b of laid.boxes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.box.id} and ${b.box.id} don't overlap`);
    assert.ok(laid.boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= laid.w && b.y + b.h <= laid.h));
  }
});

test("a box leaves room for its description and notes only when text shows", () => {
  const b = box("b1", { points: [{ text: "Short note", by: null, ts: 0, quote: null }] });
  const on = boxSize(b, true);
  const off = boxSize(b, false);
  assert.ok(on.h > on.body && on.body > off.body - 22);
  // Without text the notes fold into a count mark on the box.
  assert.equal(off.h, off.body);
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), "M0,0 L10,0");
});

test("the board opens on the whole diagram, or on its topmost part when it can't all fit", () => {
  const laid = { w: 400, h: 200, boxes: [], groups: [] };
  const whole = fitView(laid, { w: 800, h: 400 }, false);
  assert.deepEqual([Math.round(whole.x), Math.round(whole.y), whole.zoom], [170, 85, 1.15]);
  const wide = { w: 2000, h: 1000, groups: [], boxes: [{ box: box("b1"), x: 900, y: 20, w: 204, h: 60, body: 60 }, { box: box("b2"), x: 20, y: 600, w: 204, h: 60, body: 60 }] };
  const v = fitView(wide, { w: 390, h: 600 }, true);
  assert.equal(v.zoom, 0.62);
  // The topmost box starts in view, a little in from the left edge.
  assert.equal(v.x, 12 - 900 * 0.62);
});
