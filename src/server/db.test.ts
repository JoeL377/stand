import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("a database from when Stand sent transcripts to Conxt copies nothing more into its tables", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stand-db-")), "conxt.db");
  const first = openDb(file);
  const joe = first.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe", picture: null });
  const room = first.createRoom("Space", joe.id);
  first.raw.close();
  // As the last version left it: a connected space, an app default, and the triggers on meetings, segments and rooms.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE conxt_connections (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), destination_key TEXT NOT NULL,
      submission_url TEXT NOT NULL, label TEXT NOT NULL, connected_by TEXT NOT NULL REFERENCES users(id),
      connected_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE conxt_meetings (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id), connection_id TEXT NOT NULL REFERENCES conxt_connections(id)
    );
    CREATE TRIGGER conxt_meeting_started AFTER INSERT ON meetings WHEN NEW.kind IS NOT 'chat' BEGIN
      INSERT INTO conxt_meetings(meeting_id,connection_id)
      SELECT NEW.id,id FROM conxt_connections WHERE room_id=NEW.room_id AND enabled=1;
    END;
    CREATE TABLE conxt_live_deliveries (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id), connection_id TEXT NOT NULL REFERENCES conxt_connections(id)
    );
    CREATE TABLE conxt_live_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id), turn_id TEXT NOT NULL,
      speaker TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE TRIGGER conxt_live_meeting AFTER INSERT ON conxt_meetings BEGIN
      INSERT OR IGNORE INTO conxt_live_deliveries(meeting_id,connection_id) VALUES (NEW.meeting_id,NEW.connection_id);
    END;
    CREATE TRIGGER conxt_live_segment AFTER INSERT ON segments BEGIN
      INSERT INTO conxt_live_events(meeting_id,turn_id,speaker,text,kind,ts)
      SELECT NEW.meeting_id,NEW.id,NEW.speaker_name,NEW.text,NEW.kind,NEW.ts
      FROM conxt_live_deliveries d JOIN conxt_connections c ON c.id=d.connection_id
      WHERE d.meeting_id=NEW.meeting_id AND c.enabled=1;
    END;
    CREATE TRIGGER conxt_live_segment_updated AFTER UPDATE OF text ON segments WHEN NEW.text != OLD.text BEGIN
      INSERT INTO conxt_live_events(meeting_id,turn_id,speaker,text,kind,ts)
      SELECT NEW.meeting_id,NEW.id,NEW.speaker_name,NEW.text,NEW.kind,NEW.ts
      FROM conxt_live_deliveries d JOIN conxt_connections c ON c.id=d.connection_id
      WHERE d.meeting_id=NEW.meeting_id AND c.enabled=1;
    END;
    CREATE TABLE conxt_app_default (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), destination_key TEXT NOT NULL,
      submission_url TEXT NOT NULL, label TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE conxt_default_connections (connection_id TEXT PRIMARY KEY REFERENCES conxt_connections(id));
    CREATE TRIGGER conxt_default_new_room AFTER INSERT ON rooms BEGIN
      INSERT INTO conxt_connections(id,room_id,destination_key,submission_url,label,connected_by,connected_at,enabled)
      SELECT lower(hex(randomblob(16))),NEW.id,destination_key,submission_url,label,actor_id,
             CAST(unixepoch('subsec')*1000 AS INTEGER),1 FROM conxt_app_default;
      INSERT INTO conxt_default_connections(connection_id)
      SELECT id FROM conxt_connections WHERE room_id=NEW.id AND enabled=1;
    END;
  `);
  const url = "https://conxt.test/api/v1/integrations/x/sources";
  old.prepare("INSERT INTO conxt_connections VALUES ('c1', ?, 'product', ?, 'Team', ?, 1, 1)").run(room.id, url, joe.id);
  old.prepare("INSERT INTO conxt_app_default VALUES (1, 'product', ?, 'Team', ?)").run(url, joe.id);
  old.close();

  const db = openDb(file);
  const m = db.startMeeting(room.id);
  const said = db.addSegment({ meetingId: m.id, itemId: null, speakerId: joe.id, speakerName: "Joe", kind: "speech", text: "Hello", ts: 1 });
  db.raw.prepare("UPDATE segments SET text = 'Hello there' WHERE id = ?").run(said.id);
  db.createRoom("Another space", joe.id);
  const count = (table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.deepEqual(
    ["conxt_connections", "conxt_meetings", "conxt_live_deliveries", "conxt_live_events", "conxt_default_connections"].map(count),
    [1, 0, 0, 0, 0],
    "what was there stays, and nothing is added",
  );
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'conxt%'").get() as { n: number }).n, 0);
  db.raw.close();
});
