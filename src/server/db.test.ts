import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";

test("a unit of writes that fails leaves nothing behind, and units nest", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space");
  const m = db.startMeeting(room.id);
  db.syncNotes(m.id, null, [{ kind: "action", text: "Ship the fix", owner: null }]);
  assert.throws(() =>
    db.tx(() => {
      db.syncNotes(m.id, null, [{ kind: "decision", text: "Half written", owner: null }]);
      throw new Error("the model's answer didn't fit");
    }),
  );
  assert.deepEqual(
    db.meetingNotes(m.id).map((n) => n.text),
    ["Ship the fix"],
    "the notes stay as the last run left them",
  );
  db.tx(() => db.tx(() => db.syncNotes(m.id, null, [{ kind: "action", text: "Nested", owner: null }])));
  assert.deepEqual(
    db.meetingNotes(m.id).map((n) => n.text),
    ["Nested"],
  );
});

test("a note the agent rewords keeps where its task stands, as well as its id", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space");
  const m = db.startMeeting(room.id);
  const [n] = db.syncNotes(m.id, null, [{ kind: "action", text: "Ship the fix", owner: "Joe" }]);
  db.setTaskState(room.id, n.id, { state: "dropped", by: "Joe", reason: "Not needed" });
  const dropped = db.getNote(n.id)!;
  db.syncNotes(m.id, null, [{ id: n.id, kind: "action", text: "Ship the fix by Friday", owner: "Joe", doneAt: dropped.doneAt, doneBy: dropped.doneBy }]);
  const after = db.getNote(n.id)!;
  assert.equal(after.text, "Ship the fix by Friday");
  assert.equal(after.state, "dropped", "a rewording doesn't open a dropped task again");
});

test("a notes run updates notes in place: a note keeps its row, and one someone acted on is never deleted", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space");
  const m = db.startMeeting(room.id);
  const [fix, info, plan] = db.syncNotes(m.id, null, [
    { kind: "action", text: "Ship the fix", owner: "Joe" },
    { kind: "summary", text: "Staging is down", owner: null },
    { kind: "action", text: "Write the rollout plan", owner: null },
  ]);
  db.setActionDone(room.id, fix.id, "Joe");
  const release = db.createProject(room.id, { name: "Release" }, "Joe");
  db.setNoteProject(room.id, fix.id, { projectId: release.id, by: "Joe" });
  db.addPlan(room.id, plan.id, "# Plan", "Agent");
  // The next run rewords the fix and leaves out the other two.
  const after = db.syncNotes(m.id, null, [{ id: fix.id, kind: "action", text: "Ship the fix today", owner: "Joe" }]);
  const byId = new Map(db.meetingNotes(m.id).map((n) => [n.id, n]));
  assert.equal(byId.get(fix.id)?.text, "Ship the fix today");
  assert.ok(byId.get(fix.id)?.doneAt, "still checked off");
  assert.equal(byId.get(fix.id)?.projectId, release.id, "and still in its project");
  assert.ok(byId.has(plan.id), "a to-do with a plan stays, though the run left it out");
  assert.ok(!byId.has(info.id), "a note nobody acted on goes");
  assert.deepEqual(after.map((n) => n.id), [fix.id, plan.id], "the run gets back every note on the item, its own first");
});

test("a notes run never unticks a to-do, even when it passes no done time", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space");
  const m = db.startMeeting(room.id);
  const [n] = db.syncNotes(m.id, null, [{ kind: "action", text: "Ship the fix", owner: null }]);
  db.setActionDone(room.id, n.id, "Joe");
  db.syncNotes(m.id, null, [{ id: n.id, kind: "action", text: "Ship the fix", owner: null, doneAt: null }]);
  assert.ok(db.getNote(n.id)?.doneAt);
});
