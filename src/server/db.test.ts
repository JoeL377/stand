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
