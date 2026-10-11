import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanJot, saveCapture, saveJot, spaceFeed } from "./captures.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { HeuristicAgent } from "./llm.ts";
import { addUpNext, computeUpNext } from "./upNext.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stand-captures-"));
config.dataDir = tmp;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const settle = () => new Promise((r) => setTimeout(r, 20));

test("snaps from before the change keep their meeting and take its space", () => {
  const file = path.join(tmp, "old.db");
  const db = openDb(file);
  const room = db.createRoom("Growth");
  const meeting = db.startMeeting(room.id);
  db.raw.close();
  // The table as it was: every snap needed a meeting, and had no space of its own.
  const old = new DatabaseSync(file);
  old.exec(`DROP TABLE snaps;
    CREATE TABLE snaps (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), item_id TEXT, ts INTEGER NOT NULL,
      ext TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
      taken_by_id TEXT, taken_by TEXT NOT NULL, sharer_id TEXT, sharer_name TEXT, caption TEXT, note_id TEXT, discussion_id TEXT);`);
  old.prepare("INSERT INTO snaps (id, meeting_id, ts, ext, width, height, source, taken_by, caption) VALUES (?, ?, 1, 'jpg', 10, 10, 'person', 'Huy', 'A chart')").run(
    "s1",
    meeting.id,
  );
  old.close();
  const again = openDb(file);
  const s = again.getSnap("s1")!;
  assert.deepEqual([s.roomId, s.meetingId, s.caption, s.line, s.itemSuggested], [room.id, meeting.id, "A chart", null, false]);
  assert.equal(again.meetingSnaps(meeting.id).length, 1);
  // And one can now be saved to the space with no meeting.
  saveCapture(again, new HeuristicAgent(), { roomId: room.id, buf: JPEG, ext: "jpg", width: 10, height: 10, at: 2, takenById: "u", takenBy: "Joe", itemId: null, line: null });
  assert.equal(again.spaceSnaps(room.id).length, 1);
});

test("a meeting snap an older build saves without a space takes its meeting's space on the next start", () => {
  const file = path.join(tmp, "shared.db");
  const db = openDb(file);
  const room = db.createRoom("Growth");
  const meeting = db.startMeeting(room.id);
  db.raw.close();
  // What the desktop branch writes: no room_id.
  const older = new DatabaseSync(file);
  older
    .prepare("INSERT INTO snaps (id, meeting_id, ts, ext, width, height, source, taken_by) VALUES (?, ?, 1, 'jpg', 10, 10, 'person', 'Huy')")
    .run("s2", meeting.id);
  older.close();
  assert.equal(openDb(file).getSnap("s2")!.roomId, room.id);
});

test("a snap saved to the space shows in its feed, with the item the agent suggested until someone picks one", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Growth", null, "Win our first 10 teams");
  const [chart, sso] = db.addItems(
    room.id,
    ["Signup chart", "SSO for the first team"].map((title) => ({ source: "agenda" as const, externalId: null, title, url: null, description: null })),
  );
  let told = 0;
  const id = saveCapture(
    db,
    new HeuristicAgent(),
    { roomId: room.id, buf: JPEG, ext: "jpg", width: 800, height: 500, at: Date.now(), takenById: "u1", takenBy: "Huy Ngo", itemId: null, line: "The signup chart dipped on Tuesday" },
    () => told++,
  );
  await settle();
  assert.equal(told, 1);
  const [snap] = spaceFeed(db, room.id).captures;
  assert.deepEqual([snap.id, snap.meetingId, snap.itemId, snap.itemSuggested, snap.line], [id, null, chart.id, true, "The signup chart dipped on Tuesday"]);
  assert.match(snap.url, new RegExp(`/api/snaps/${id}\\.jpg`));
  // Someone picks another item: it's theirs now, not the agent's.
  db.setSnapItem(id, sso.id);
  assert.deepEqual([db.getSnap(id)?.itemId, db.getSnap(id)?.itemSuggested], [sso.id, false]);
  // One saved on an item nobody needs the agent for.
  const picked = saveCapture(db, new HeuristicAgent(), { roomId: room.id, buf: JPEG, ext: "jpg", width: 1, height: 1, at: Date.now(), takenById: "u1", takenBy: "Huy Ngo", itemId: chart.id, line: "Signup chart again" });
  await settle();
  assert.equal(db.getSnap(picked)?.itemSuggested, false);
});

test("the feed has the space's meetings as rows, and what's decided and open", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Growth");
  const m = db.startMeeting(room.id);
  db.addSegment({ meetingId: m.id, itemId: null, speakerId: "u", speakerName: "Joe", kind: "speech", text: "Ship invites Friday", ts: Date.now() });
  db.replaceNotes(m.id, null, [
    { kind: "decision", text: "Ship invites on Friday", owner: null },
    { kind: "action", text: "Get the SSO quote", owner: "Andy" },
    { kind: "question", text: "Who owns pricing?", owner: null },
  ]);
  db.endMeeting(m.id, "Invites ship Friday.");
  // A meeting nobody spoke in isn't a row.
  db.endMeeting(db.startMeeting(room.id).id, null);
  const feed = spaceFeed(db, room.id);
  assert.deepEqual(
    feed.meetings.map((x) => [x.id, x.todos, x.decided, x.open, x.summary]),
    [[m.id, 1, 1, 1, "Invites ship Friday."]],
  );
  assert.deepEqual(feed.decided.map((n) => n.text), ["Ship invites on Friday"]);
  assert.deepEqual(feed.open.map((n) => n.text), ["Who owns pricing?"]);
});

test("adding a capture from Up next puts it on the agenda as its own line, pinned there", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Growth");
  const id = saveCapture(db, new HeuristicAgent(), { roomId: room.id, buf: JPEG, ext: "jpg", width: 1, height: 1, at: Date.now(), takenById: "u1", takenBy: "Huy Ngo", itemId: null, line: "Signup chart dropped Tuesday" });
  await settle();
  const live = db.startMeeting(room.id);
  const { upNext } = computeUpNext(db.upNextInput(room.id, live.startedAt));
  const s = upNext.suggestions.find((x) => x.key === `snap:${id}`)!;
  assert.equal(s.title, "Signup chart dropped Tuesday");
  const itemId = addUpNext(db, room.id, s, live)!;
  assert.equal(db.getItem(itemId)?.title, "Signup chart dropped Tuesday");
  assert.deepEqual([db.getSnap(id)?.itemId, db.getSnap(id)?.itemSuggested], [itemId, false]);
  // On the agenda now, so it's not suggested again.
  assert.ok(!computeUpNext(db.upNextInput(room.id, live.startedAt)).upNext.suggestions.some((x) => x.key === `snap:${id}`));
});

test("a note saved to the space shows in its feed, filed under the item it's about until someone picks another", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Growth");
  const [, sso] = db.addItems(
    room.id,
    ["Signup chart", "SSO for the first team"].map((title) => ({ source: "agenda" as const, externalId: null, title, url: null, description: null })),
  );
  let told = 0;
  const text = cleanJot("  Okta wants   a call about SSO for the first team\r\n\r\n\r\nbefore Friday ")!;
  assert.equal(text, "Okta wants a call about SSO for the first team\n\nbefore Friday");
  assert.equal(cleanJot("   "), null);
  const id = saveJot(db, new HeuristicAgent(), { roomId: room.id, text, at: Date.now(), byId: "u1", by: "Joe Liang", itemId: null }, () => told++);
  await settle();
  assert.equal(told, 1);
  const [jot] = spaceFeed(db, room.id).jots;
  assert.deepEqual([jot.id, jot.itemId, jot.itemSuggested, jot.by], [id, sso.id, true, "Joe Liang"]);
  db.setJotItem(id, null);
  assert.deepEqual([db.getJot(id)?.itemId, db.getJot(id)?.itemSuggested], [null, false]);
  // Up next offers it once a meeting starts, and adding it gives it its own agenda line.
  const live = db.startMeeting(room.id);
  const s = computeUpNext(db.upNextInput(room.id, live.startedAt - 60_000)).upNext.suggestions.find((x) => x.key === `jot:${id}`)!;
  assert.deepEqual([s.title, s.reason], ["Okta wants a call about SSO for the first team", "Note saved by Joe Liang"]);
  const itemId = addUpNext(db, room.id, s, live)!;
  assert.equal(db.getItem(itemId)?.title, "Okta wants a call about SSO for the first team");
  assert.equal(db.getJot(id)?.itemId, itemId);
});

test("snaps pinned to a note show with it, not on their own, and go where it goes", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Growth");
  const [chart, sso] = db.addItems(
    room.id,
    ["Signup chart", "SSO for the first team"].map((title) => ({ source: "agenda" as const, externalId: null, title, url: null, description: null })),
  );
  const jot = saveJot(db, new HeuristicAgent(), { roomId: room.id, text: "The signup chart dipped on Tuesday", at: Date.now(), byId: "u1", by: "Joe Liang", itemId: null });
  await settle();
  assert.deepEqual([db.getJot(jot)?.itemId, db.getJot(jot)?.itemSuggested], [chart.id, true]);
  const pin = (line: string | null) =>
    saveCapture(db, new HeuristicAgent(), { roomId: room.id, buf: JPEG, ext: "jpg", width: 10, height: 10, at: Date.now(), takenById: "u1", takenBy: "Joe Liang", itemId: db.getJot(jot)!.itemId, line, jotId: jot });
  const [a, b] = [pin(null), pin("SSO for the first team")];
  // One on its own, for comparison.
  const alone = saveCapture(db, new HeuristicAgent(), { roomId: room.id, buf: JPEG, ext: "jpg", width: 10, height: 10, at: Date.now(), takenById: "u1", takenBy: "Joe Liang", itemId: null, line: null });
  await settle();
  const feed = spaceFeed(db, room.id);
  assert.deepEqual(feed.captures.map((s) => s.id), [alone]);
  assert.deepEqual(feed.jots[0].snaps?.map((s) => [s.id, s.itemId, s.itemSuggested, s.jotId]), [
    [a, chart.id, true, jot],
    // The agent doesn't move a pinned snap to another item, whatever it shows.
    [b, chart.id, true, jot],
  ]);
  // Someone files the note under another item: its snaps follow.
  db.setJotItem(jot, sso.id);
  assert.deepEqual(db.jotSnaps(jot).map((s) => [s.itemId, s.itemSuggested]), [[sso.id, false], [sso.id, false]]);
  // Up next offers the note, not its snaps.
  const live = db.startMeeting(room.id);
  db.setJotItem(jot, null);
  const keys = computeUpNext(db.upNextInput(room.id, live.startedAt - 60_000)).upNext.suggestions.map((s) => s.key);
  assert.deepEqual(keys.filter((k) => k.startsWith("jot:") || k.startsWith("snap:")).sort(), [`jot:${jot}`, `snap:${alone}`].sort());
  db.deleteJot(jot);
  assert.deepEqual([db.getSnap(a), db.getSnap(b), db.getSnap(alone)?.id], [null, null, alone]);
});
