import assert from "node:assert/strict";
import { test } from "node:test";
import type { Segment } from "../shared/protocol.ts";
import { type MapAnswer, mapNodesOf, startBrainstorm, toBrainstormView } from "./brainstorm.ts";
import { openDb } from "./db.ts";
import type { DiagramAnswer } from "./designSession.ts";
import { SketchKeeper, askSketch, closest, saveSketchSpecs } from "./sketch.ts";

const T0 = 1_700_000_000_000;
const seg = (n: number, speakerName: string, text: string): Segment => ({ id: `s${n}`, meetingId: "m", itemId: null, speakerId: speakerName, speakerName, kind: "speech", text, ts: T0 + n * 1000 }) as Segment;
const noMap: MapAnswer = { add: [], extend: [], caught: [] };
const noDiagram: DiagramAnswer = { boxes: [], arrows: [], extend: [], caught: [], place: [], groups: [], topic: null };

function sketch(prompt = "Pricing") {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const row = startBrainstorm(db, room.id, prompt, "Joe", T0);
  const maps: MapAnswer[] = [];
  const diagrams: DiagramAnswer[] = [];
  const asked: Array<{ what: "map" | "diagram"; text: string }> = [];
  const k = new SketchKeeper(
    {
      brainstormMap: async (c: string, t: string) => (asked.push({ what: "map", text: `${c}\n${t}` }), maps.shift() ?? noMap),
      designDiagram: async (c: string, t: string) => (asked.push({ what: "diagram", text: `${c}\n${t}` }), diagrams.shift() ?? noDiagram),
    },
    row,
    T0,
  );
  return { db, room, row, k, maps, diagrams, asked };
}

test("one sketch holds every subject: a new one the talk moves to is drawn as a map, or as a diagram when it is clearly steps", async () => {
  const { k, maps, diagrams, asked } = sketch();
  const talk = [seg(1, "Joe", "On pricing, what if we charge per seat"), seg(2, "Huy", "or a free tier")];
  maps.push({ add: [{ cluster: null, under: "root", label: "Plans", detail: "Kinds of plan.", by: "Joe", line: 1 }, { cluster: null, under: "new1", label: "Per seat", detail: "Charge per seat.", by: "Joe", line: 1 }], extend: [], caught: [] });
  assert.equal(await k.run(talk, ["Joe", "Huy"], [], T0, T0 + 3000), true);
  assert.deepEqual(k.state().subjects.map((s) => [s.id, s.title, s.style]), [["s0", "Pricing", "map"]]);
  assert.equal(k.liveSubject, "s0");

  // The talk moves to how refunds work, which the map pass says is parts: a second subject, as a diagram.
  talk.push(seg(60, "Huy", "Switching to how refunds work: the customer asks, then support approves"));
  maps.push({ add: [{ cluster: "How refunds work", shape: "parts", under: "root", label: "Request", detail: "The customer asks.", by: "Huy", line: 3 }], extend: [], caught: [] });
  diagrams.push({ ...noDiagram, boxes: [{ label: "Customer asks", detail: "Starts a refund.", kind: "step", group: null, by: "Huy", line: 1 }, { label: "Support approves", detail: "Checks it.", kind: "step", group: null, by: "Huy", line: 1 }], arrows: [{ from: "new1", to: "new2", label: "then", by: "Huy", line: 1 }] });
  assert.equal(await k.run(talk, ["Joe", "Huy"], [], T0, T0 + 61_000), true);
  const st = k.state();
  assert.deepEqual(st.subjects.map((s) => [s.id, s.title, s.style, s.why ?? null]), [["s0", "Pricing", "map", null], ["s1", "How refunds work", "diagram", "steps"]]);
  assert.equal(k.liveSubject, "s1", "the subject the pass added to is the one the talk is on");
  // The new subject's diagram is drawn from its own lines on the next pass, not from the pricing talk.
  talk.push(seg(64, "Huy", "and finance pays it out"));
  await k.run(talk, ["Joe", "Huy"], [], T0, T0 + 65_000);
  const d = asked.filter((a) => a.what === "diagram").at(-1)!.text;
  assert.match(d, /finance pays it out/);
  assert.doesNotMatch(d, /charge per seat/);
  assert.deepEqual(k.state().subjects[1].diagram!.boxes.map((b) => [b.label, !!b.suggested]), [["Customer asks", false], ["Support approves", false]], "what is heard joins at once");
});

test("a subject is redrawn the other way and back, and the last change can be undone for a while", async () => {
  const { k, maps } = sketch();
  maps.push({ add: [{ cluster: null, under: "root", label: "Plans", detail: "One line.", by: "Joe", line: 1 }, { cluster: null, under: "new1", label: "Per seat", detail: "Charge for each seat.", by: "Joe", line: 1 }, { cluster: null, under: "new1", label: "Free tier", detail: "Free for small teams.", by: "Huy", line: 2 }], extend: [], caught: [] });
  await k.run([seg(1, "Joe", "what if we charge per seat"), seg(2, "Huy", "or a free tier for small teams")], ["Joe", "Huy"], [], T0, T0 + 3000);

  assert.equal(k.setStyle("s0", "diagram", "Joe Liang", T0 + 3500), "Redrawn as a diagram");
  assert.equal(k.styleOf("s0"), "diagram");
  assert.deepEqual(k.nodes().filter((n) => !n.removed).map((n) => n.label), ["Plans", "Per seat", "Free tier"], "its circles are kept, so going back is at once");
  assert.deepEqual(k.undoView(T0 + 4000), { text: "Redrawn as a diagram", by: "Joe", at: T0 + 3500 });
  assert.equal(k.undo(T0 + 4000), true);
  assert.equal(k.styleOf("s0"), "map");
  assert.equal(k.undo(T0 + 4000), false, "one step");

  // Stand offers the other way once per subject and style, and only when it isn't already drawn so.
  assert.equal(k.suggest("map"), false);
  assert.equal(k.suggest("diagram"), true);
  assert.deepEqual(k.offer, { subject: "s0", style: "diagram" });
  assert.equal(k.answerOffer(false, "Huy", T0 + 5000), true);
  assert.equal(k.styleOf("s0"), "map");
  assert.equal(k.suggest("diagram"), false, "waved off: not offered again");

  // Fixes by hand: rename, move, remove, each undone by Undo within its time.
  assert.equal(k.edit("s0", "i1", "rename", { label: "Per seat pricing" }, "Huy", T0 + 6000), "Renamed “Per seat”");
  assert.equal(k.nodes().find((n) => n.id === "i1")!.label, "Per seat pricing");
  assert.equal(k.edit("s0", "i2", "remove", {}, "Huy", T0 + 7000), "Removed “Free tier”");
  assert.deepEqual(k.nodes().filter((n) => !n.removed).map((n) => n.id), ["d1", "i1"]);
  assert.equal(k.undo(T0 + 7000 + 31_000), false, "too late");
  assert.equal(k.edit("s0", "s0", "rename", { label: "Pricing for teams" }, "Joe", T0 + 50_000), "Renamed “Pricing”");
  assert.equal(k.prompt, "Pricing for teams");
  assert.equal(k.undo(T0 + 51_000), true);
  assert.equal(k.prompt, "Pricing");
});

test("a change to the sketch has to be said to Stand, and plain talk about adding things is never one", () => {
  assert.equal(askSketch("we should add a step for approval"), null);
  assert.equal(askSketch("remove the free tier"), null);
  assert.deepEqual(askSketch("remove the free tier", true), { op: "remove", what: "the free tier" });
  assert.deepEqual(askSketch("Stand, add a step for legal review after support approves"), { op: "add", what: "legal review", kind: "step", where: "after", near: "support approves" });
  assert.deepEqual(askSketch("@stand rename per seat to per user"), { op: "rename", what: "per seat", to: "per user" });
  assert.deepEqual(askSketch("Hey Stand, can you redraw this as a diagram? Thanks."), { op: "redraw", style: "diagram" });
  assert.deepEqual(askSketch("Stand, make it a map"), { op: "redraw", style: "map" });
  assert.deepEqual(askSketch("Stand undo"), { op: "undo" });
  assert.equal(askSketch("Stand, what does Fly cost?"), null, "a question is Ask Stand's");
  assert.equal(closest("the free tier", [{ label: "Per seat" }, { label: "Free tier" }])?.label, "Free tier");
  assert.equal(closest("something else", [{ label: "Per seat" }]), null);
});

test("asked by voice: Stand adds, renames and removes on the subject the talk is on", async () => {
  const { k, maps } = sketch();
  maps.push({ add: [{ cluster: null, under: "root", label: "Plans", detail: "One line.", by: "Joe", line: 1 }, { cluster: null, under: "new1", label: "Per seat", detail: "Charge for each seat.", by: "Joe", line: 1 }], extend: [], caught: [] });
  await k.run([seg(1, "Joe", "per seat")], ["Joe"], [], T0, T0 + 2000);
  assert.equal(k.ask({ op: "add", what: "annual discount" }, "Joe Liang", T0 + 3000), "Added “Annual discount” under “Plans”");
  assert.equal(k.ask({ op: "rename", what: "per seat", to: "per user" }, "Joe", T0 + 4000), "Renamed “Per seat”");
  assert.equal(k.ask({ op: "remove", what: "nothing like it" }, "Joe", T0 + 5000), null, "it doesn't guess");
  assert.equal(k.ask({ op: "remove", what: "annual discount" }, "Joe", T0 + 6000), "Removed “Annual discount”");
  assert.deepEqual(k.nodes().filter((n) => !n.removed).map((n) => n.label), ["Plans", "Per user"]);
  assert.equal(k.ask({ op: "redraw", style: "diagram" }, "Joe", T0 + 7000), "Redrawn as a diagram");
  assert.match(k.ask({ op: "add", what: "checkout", kind: "step" }, "Joe", T0 + 8000) ?? "", /^Added “Checkout”/);
  assert.deepEqual(k.state().subjects[0].diagram!.boxes.map((b) => [b.label, b.kind]), [["Checkout", "step"]]);
});

test("when it stops, each diagram is a draft spec on a to-do, and a diagram's circles are not ideas", async () => {
  const { db, row, k, maps, diagrams } = sketch("How refunds work");
  maps.push({ add: [{ cluster: null, under: "root", label: "Request", detail: "One line.", by: "Huy", line: 1 }, { cluster: null, under: "new1", label: "Customer asks", detail: "One line.", by: "Huy", line: 1 }], extend: [], caught: [] });
  await k.run([seg(1, "Huy", "the customer asks")], ["Huy"], [], T0, T0 + 2000);
  k.setStyle("s0", "diagram", "Huy", T0 + 3000);
  diagrams.push({ ...noDiagram, boxes: [{ label: "Customer asks", detail: "Starts a refund.", kind: "step", group: null, by: "Huy", line: 1 }] });
  await k.run([seg(1, "Huy", "the customer asks"), seg(5, "Huy", "then support approves")], ["Huy"], [], T0, T0 + 6000);
  db.setBrainstorm(row.id, { meetingId: db.startMeeting(row.roomId).id });
  db.saveBrainstormMap(row.id, k.nodes());
  db.saveBrainstormSketch(row.id, k.state());
  db.saveDesignDiagram(row.id, k.state().subjects[0].diagram!);
  const kept = saveSketchSpecs(db, db.getBrainstorm(row.id)!, []);
  assert.ok(kept.taskId, "the first subject's spec is on the sketch's to-do");
  assert.match(db.notePlan(kept.taskId!)!.text, /^# How refunds work\n/);
  const view = toBrainstormView(kept);
  assert.deepEqual(view.subjects!.map((s) => [s.title, s.style, s.taskId]), [["How refunds work", "diagram", kept.taskId]]);
  assert.deepEqual(mapNodesOf(kept), [], "nothing to review as ideas");
});
