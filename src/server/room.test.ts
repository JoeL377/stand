import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { HeuristicAgent } from "./llm.ts";
import { parseLinearInput } from "./linear.ts";
import { RoomSession } from "./room.ts";

function setup() {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const items = db.addItems(
    room.id,
    ["One", "Two", "Three"].map((title) => ({ source: "agenda" as const, externalId: null, title, url: null, description: null })),
  );
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  return { db, session, items, meetingId: session.meetingId };
}

test("speech is pinned to the item in focus when it was spoken, not when it arrived", () => {
  const { db, session, items, meetingId } = setup();
  const spokeAt = Date.now() - 2_000;
  session.setFocus(items[1].id, "Joe", "manual");
  // A transcript for words spoken before the switch lands late.
  session.addSpeech("p1", "Priya", "Wrapping up the first one", spokeAt);
  session.addSpeech("p1", "Priya", "Now the second", Date.now());
  const segs = db.meetingSegments(meetingId);
  assert.equal(segs.find((s) => s.text.startsWith("Wrapping"))?.itemId, items[0].id);
  assert.equal(segs.find((s) => s.text.startsWith("Now"))?.itemId, items[1].id);
});

test("accepting the agent's suggestion re-pins what was said since the screen changed", async () => {
  const { db, session, items, meetingId } = setup();
  session.addSpeech("p1", "Sam", "Before the screen changed", Date.now() - 5_000);
  session.demoSuggest(items[2].id, "Three is on screen");
  await new Promise((r) => setTimeout(r, 5));
  session.addSpeech("p1", "Sam", "Talking about three already", Date.now());
  session.demoAccept();
  const segs = db.meetingSegments(meetingId);
  assert.equal(segs[0].itemId, items[0].id);
  assert.equal(segs[1].itemId, items[2].id);
  assert.equal(session.state().focusItemId, items[2].id);
  assert.equal(session.state().suggestion, null);
});

test("items keep their history when re-imported", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const issue = { source: "linear" as const, externalId: "ENG-1", title: "A", url: null, description: null };
  const [first] = db.addItems(room.id, [issue]);
  db.archiveItem(first.id);
  const [again] = db.addItems(room.id, [{ ...issue, title: "A (renamed)" }]);
  assert.equal(again.id, first.id);
  assert.equal(again.title, "A (renamed)");
});

test("parses Linear links and keys", () => {
  assert.deepEqual(parseLinearInput("https://linear.app/acme/project/q4-launch-8f2a9c1b3d4e/issues"), { kind: "project", id: "8f2a9c1b3d4e" });
  assert.deepEqual(parseLinearInput("https://linear.app/acme/team/ENG/cycle/12"), { kind: "cycle", teamKey: "ENG", number: 12 });
  assert.deepEqual(parseLinearInput("https://linear.app/acme/team/eng/active"), { kind: "cycle", teamKey: "ENG", number: "active" });
  assert.deepEqual(parseLinearInput("https://linear.app/acme/issue/ENG-42/fix-login"), { kind: "issues", keys: ["ENG-42"] });
  assert.deepEqual(parseLinearInput("ENG-1, ENG-2 and ENG-1"), { kind: "issues", keys: ["ENG-1", "ENG-2"] });
  assert.equal(parseLinearInput("https://example.com/x"), null);
});

test("sessions resolve to users, and Google sign-in links to an existing email", () => {
  const db = openDb(":memory:");
  const dev = db.upsertUser({ googleSub: null, email: "Joe@Example.com", name: "Joe", picture: null });
  const google = db.upsertUser({ googleSub: "g-123", email: "joe@example.com", name: "Joe Liang", picture: "https://x/p.png" });
  assert.equal(google.id, dev.id);
  assert.equal(google.name, "Joe Liang");
  const s = db.createSession(google.id);
  assert.equal(db.sessionUser(s.id)?.email, "joe@example.com");
  db.deleteSession(s.id);
  assert.equal(db.sessionUser(s.id), null);
});
