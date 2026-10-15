import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveRow, restoreRow } from "./archive.ts";
import { spaceFeed } from "./captures.ts";
import { openDb } from "./db.ts";

test("archiving takes a row off the space page and restoring brings it back", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Stand", null, "");
  const other = db.createRoom("Elsewhere", null, "");
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Pricing", url: null, description: null }]);
  const m = db.startMeeting(room.id);
  db.addSegment({ meetingId: m.id, itemId: null, speakerId: "u1", speakerName: "Joe", kind: "speech", text: "Let's go.", ts: Date.now() });
  const q = db.addNote(m.id, null, { kind: "question", text: "Which plan?", owner: null }, null);
  const d = db.addNote(m.id, null, { kind: "decision", text: "Ship Friday", owner: null }, null);
  db.endMeeting(m.id, null);

  assert.equal(spaceFeed(db, room.id).meetings.length, 1);
  assert.ok(archiveRow(db, room.id, `meeting:${m.id}`, "Joe Liang"));
  assert.ok(archiveRow(db, room.id, `question:${q.id}`, "Joe Liang"));
  assert.ok(archiveRow(db, room.id, `item:${item.id}`, "Joe Liang"));
  let feed = spaceFeed(db, room.id);
  assert.equal(feed.meetings.length, 0);
  assert.equal(feed.open.length, 0);
  assert.deepEqual(
    feed.decided.map((n) => n.id),
    [d.id],
  );
  assert.deepEqual(feed.archived.map((a) => [a.kind, a.title, a.by]).sort(), [
    ["item", "Pricing", "Joe Liang"],
    ["meeting", "Meeting", "Joe Liang"],
    ["question", "Which plan?", "Joe Liang"],
  ]);
  // The agenda item came off the agenda too.
  assert.equal(db.listItems(room.id).length, 0);

  // A row from another space, or of the wrong kind, isn't archived.
  assert.equal(archiveRow(db, other.id, `decision:${d.id}`, "Joe Liang"), false);
  assert.equal(archiveRow(db, room.id, `todo:${d.id}`, "Joe Liang"), false);
  assert.equal(archiveRow(db, room.id, `nonsense:${d.id}`, "Joe Liang"), false);

  assert.ok(restoreRow(db, room.id, `meeting:${m.id}`));
  assert.ok(restoreRow(db, room.id, `item:${item.id}`));
  feed = spaceFeed(db, room.id);
  assert.equal(feed.meetings.length, 1);
  assert.equal(db.listItems(room.id).length, 1);
  assert.deepEqual(
    feed.archived.map((a) => a.ref),
    [`question:${q.id}`],
  );
});
