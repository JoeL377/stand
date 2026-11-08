import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { matchesTopic, topicOf, topicOptions } from "../shared/topics.ts";

test("topics inherit from agenda items and group outcomes across meetings without altering source", () => {
  const db = openDb(":memory:");
  try {
    const room = db.createRoom("Topics");
    const items = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Pricing", url: null, description: null }]);
    const first = db.startMeeting(room.id);
    const action = db.addNote(first.id, items[0].id, { kind: "action", text: "Compare plans", owner: "Sam" }, null);
    db.endMeeting(first.id, null);
    const second = db.startMeeting(room.id);
    const decision = db.addNote(second.id, null, { kind: "decision", text: "Use monthly billing", owner: null }, null);
    assert.equal(topicOf(action, items), "Pricing");
    const updated = db.setNoteTopic(room.id, decision.id, "  pricing \n ")!;
    assert.deepEqual(topicOptions([action, updated], items), ["Pricing"]);
    assert.equal(matchesTopic(topicOf(updated, items), "topic:pricing"), true);
    assert.equal(matchesTopic(topicOf(updated, items), "topic:launch"), false);
    assert.equal(updated.itemId, null);
    assert.equal(updated.meetingId, second.id);
    assert.equal(updated.kind, "decision");
    assert.equal(topicOf(db.setNoteTopic(room.id, action.id, "")!, items), null);
    assert.equal(matchesTopic(null, "none"), true);
    assert.equal(matchesTopic("Pricing", "none"), false);
    assert.equal(matchesTopic(null, ""), true);
    assert.equal(topicOf(db.setNoteTopic(room.id, action.id, null)!, items), "Pricing");
    assert.equal(db.setNoteTopic(db.createRoom("Other").id, action.id, "Other"), null);
    const context = db.addNote(second.id, null, { kind: "context", text: "True", owner: null }, null);
    assert.equal(db.setNoteTopic(room.id, context.id, "Other"), null);
    assert.throws(() => db.setNoteTopic(room.id, action.id, "a".repeat(81)), /80 characters/);
  } finally { db.raw.close(); }
});

test("topic edits survive live redrafts, rewording and delete/restore, including explicit no topic", () => {
  const db = openDb(":memory:");
  try {
    const room = db.createRoom("Topics");
    const m = db.startMeeting(room.id);
    const notes = db.replaceNotes(m.id, null, [
      { kind: "action", text: "Check prices", owner: "Sam" },
      { kind: "decision", text: "Choose monthly", owner: null },
      { kind: "question", text: "Annual too?", owner: null },
    ]);
    db.setNoteTopic(room.id, notes[0].id, "Pricing");
    db.setNoteTopic(room.id, notes[1].id, "");
    db.setNoteTopic(room.id, notes[2].id, "Billing");
    const redrafted = db.replaceNotes(m.id, null, notes.map((n) => ({ ...n, text: n.kind === "question" ? "Offer annual billing?" : n.text })));
    assert.deepEqual(redrafted.map((n) => n.topic), ["Pricing", "", "Billing"]);
    db.editNote(notes[0].id, { text: "Compare prices", owner: "Sam" }, "Sam");
    assert.equal(db.getNote(notes[0].id)?.topic, "Pricing");
    const removed = db.removeNote(notes[1].id)!;
    db.restoreNote(removed);
    assert.equal(db.getNote(notes[1].id)?.topic, "");
    assert.equal(db.roomQuestions(room.id)[0]?.topic, undefined); // live meeting is excluded
    db.endMeeting(m.id, null);
    assert.equal(db.roomQuestions(room.id)[0]?.topic, "Billing");
    assert.equal(db.roomFollowUps(room.id)[0]?.topic, "Pricing");
  } finally { db.raw.close(); }
});
