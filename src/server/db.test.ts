import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";

test("a unit of writes that fails leaves nothing behind, and units nest", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space");
  const m = db.startMeeting(room.id);
  db.replaceNotes(m.id, null, [{ kind: "action", text: "Ship the fix", owner: null }]);
  assert.throws(() =>
    db.tx(() => {
      db.replaceNotes(m.id, null, [{ kind: "decision", text: "Half written", owner: null }]);
      throw new Error("the model's answer didn't fit");
    }),
  );
  assert.deepEqual(
    db.meetingNotes(m.id).map((n) => n.text),
    ["Ship the fix"],
    "the notes stay as the last run left them",
  );
  db.tx(() => db.tx(() => db.replaceNotes(m.id, null, [{ kind: "action", text: "Nested", owner: null }])));
  assert.deepEqual(
    db.meetingNotes(m.id).map((n) => n.text),
    ["Nested"],
  );
});

test("a note the agent rewords keeps where its task stands, as well as its id", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space");
  const m = db.startMeeting(room.id);
  const [n] = db.replaceNotes(m.id, null, [{ kind: "action", text: "Ship the fix", owner: "Joe" }]);
  db.setTaskState(room.id, n.id, { state: "dropped", by: "Joe", reason: "Not needed" });
  const dropped = db.getNote(n.id)!;
  db.replaceNotes(m.id, null, [{ id: n.id, kind: "action", text: "Ship the fix by Friday", owner: "Joe", doneAt: dropped.doneAt, doneBy: dropped.doneBy }]);
  const after = db.getNote(n.id)!;
  assert.equal(after.text, "Ship the fix by Friday");
  assert.equal(after.state, "dropped", "a rewording doesn't open a dropped task again");
});
