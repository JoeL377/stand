import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ChatEvent } from "../shared/chat.ts";
import { CHAT_MAX_AGE_MS, CHAT_MAX_MESSAGES, CHAT_QUIET_MS, Chat, type IntakeEvent } from "./chat.ts";
import { openDb } from "./db.ts";
import { computeUpNext } from "./upNext.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stand-chat-"));
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 17, 0);

function setup(file?: string) {
  const db = openDb(file);
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe Liang", picture: null });
  const huy = db.upsertUser({ googleSub: null, email: "huy@example.test", name: "Huy Ngo", picture: null });
  const room = db.createRoom("Growth", joe.id);
  for (const u of [joe, huy]) db.touchMembership(room.id, u.id);
  const events: ChatEvent[] = [];
  const chat = new Chat(db, (_roomId, e) => events.push(e));
  const channel = db.spaceChannel(room.id, joe.id);
  const say = (userId: string, text: string, ts: number, more: Partial<Extract<IntakeEvent, { type: "message" }>> = {}) =>
    chat.accept(channel.id, [{ type: "message", author: { userId }, text, ts, ...more }]).messages[0];
  return { db, joe, huy, room, chat, channel, events, say };
}

test("a space has one chat of its own, and its first message starts a session", () => {
  const { db, joe, huy, room, channel, say } = setup();
  assert.equal(db.spaceChannel(room.id, huy.id).id, channel.id);
  assert.deepEqual([channel.source, channel.openSessionId], ["stand", null]);

  const first = say(joe.id, "  Can we ship the invite flow on Friday?  ", T0);
  const second = say(huy.id, "Yes, if the email copy is done.", T0 + MIN, { replyTo: first.id });
  assert.deepEqual([first.author, first.text, first.ts], ["Joe Liang", "Can we ship the invite flow on Friday?", T0]);
  assert.equal(second.replyTo, first.id);
  assert.ok(second.seq > first.seq);

  // One session holds both, and it is the channel's open one.
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(db.getChannel(channel.id)!.openSessionId, first.sessionId);
  assert.deepEqual(db.chatSession(first.sessionId), { id: first.sessionId, channelId: channel.id, roomId: room.id, startedAt: T0, endedAt: T0 + MIN, messages: 2 });

  // A message is a chat segment of its session, so what reads a meeting's talk reads it.
  assert.deepEqual(
    db.meetingSegments(first.sessionId).map((s) => [s.id, s.speakerId, s.speakerName, s.kind, s.itemId, s.text]),
    [
      [first.id, joe.id, "Joe Liang", "chat", null, "Can we ship the invite flow on Friday?"],
      [second.id, huy.id, "Huy Ngo", "chat", null, "Yes, if the email copy is done."],
    ],
  );
  // The session has an end from its first message on: it isn't a meeting left running.
  assert.equal(db.getMeeting(first.sessionId)!.endedAt, T0 + MIN);
  assert.deepEqual(db.openMeetings(), []);
});

test("a message sent again with the same key is saved once", () => {
  const { db, joe, chat, channel } = setup();
  const key = randomUUID();
  const send: IntakeEvent = { type: "message", externalId: key, author: { userId: joe.id }, text: "Send the invoice", ts: T0 };
  const first = chat.accept(channel.id, [send]);
  const again = chat.accept(channel.id, [{ ...send, ts: T0 + 5000 }]);
  assert.deepEqual([first.accepted, first.duplicates, again.accepted, again.duplicates], [1, 0, 0, 1]);
  assert.equal(again.messages[0].id, first.messages[0].id);
  assert.equal(db.channelMessages(channel.id).length, 1);
  // The key is the channel's: the same one in another space's chat is another message.
  const other = db.spaceChannel(db.createRoom("Ops").id, joe.id);
  assert.equal(chat.accept(other.id, [send]).accepted, 1);
});

test("text with nothing in it, and a reply to a message of another channel, are not taken", () => {
  const { db, joe, chat, channel, say } = setup();
  assert.deepEqual(chat.accept(channel.id, [{ type: "message", author: { userId: joe.id }, text: "  \n ", ts: T0 }]), { accepted: 0, duplicates: 0, messages: [] });
  assert.equal(db.getChannel(channel.id)!.openSessionId, null);
  const other = db.spaceChannel(db.createRoom("Ops").id, joe.id);
  const elsewhere = chat.accept(other.id, [{ type: "message", author: { userId: joe.id }, text: "Over here", ts: T0 }]).messages[0];
  assert.equal(say(joe.id, "Hello", T0, { replyTo: elsewhere.id }).replyTo, null);
  assert.throws(() => chat.accept("nowhere", []), /No chat channel/);
  assert.throws(() => say("nobody", "Hello", T0), /No user/);
});

test("an hour of quiet closes a session, and the next message starts another", () => {
  const { db, joe, huy, chat, channel, events, say } = setup();
  const first = say(joe.id, "Morning", T0);
  // Still talking: nothing is due.
  assert.equal(chat.sweep(T0 + CHAT_QUIET_MS - 1), 0);
  const second = say(huy.id, "Morning", T0 + CHAT_QUIET_MS - 1);
  assert.equal(second.sessionId, first.sessionId);

  // The sweep finds it once the channel has been quiet for the hour.
  assert.equal(chat.sweep(second.ts + CHAT_QUIET_MS), 1);
  assert.equal(db.getChannel(channel.id)!.openSessionId, null);
  assert.equal(chat.sweep(second.ts + CHAT_QUIET_MS), 0);
  const third = say(joe.id, "Back", second.ts + CHAT_QUIET_MS + MIN);
  assert.notEqual(third.sessionId, first.sessionId);

  // And a message that arrives before any sweep ran closes the old session itself.
  const fourth = say(huy.id, "Next day", third.ts + 20 * 60 * MIN);
  assert.notEqual(fourth.sessionId, third.sessionId);
  assert.equal(db.getChannel(channel.id)!.openSessionId, fourth.sessionId);
  assert.deepEqual(db.channelSessions(channel.id).map((s) => [s.id, s.messages]), [[fourth.sessionId, 1], [third.sessionId, 1], [first.sessionId, 2]]);
  // A closed session keeps the end its last message gave it.
  assert.equal(db.chatSession(first.sessionId)!.endedAt, second.ts);

  assert.deepEqual(
    events.map((e) => (e.type === "session" ? `${e.open ? "open" : "close"} ${e.sessionId}` : `message ${e.message.id}`)),
    [
      `open ${first.sessionId}`, `message ${first.id}`, `message ${second.id}`, `close ${first.sessionId}`,
      `open ${third.sessionId}`, `message ${third.id}`,
      `close ${third.sessionId}`, `open ${fourth.sessionId}`, `message ${fourth.id}`,
    ],
  );
});

test("a busy session closes at its message limit, and twelve hours after it started", () => {
  const { db, joe, chat, channel, say } = setup();
  const sent = chat.accept(
    channel.id,
    Array.from({ length: CHAT_MAX_MESSAGES + 1 }, (_, i): IntakeEvent => ({ type: "message", author: { userId: joe.id }, text: `Line ${i + 1}`, ts: T0 + i * 1000 })),
  );
  assert.equal(sent.accepted, CHAT_MAX_MESSAGES + 1);
  const [full, next] = [sent.messages[0].sessionId, sent.messages.at(-1)!.sessionId];
  assert.equal(sent.messages[CHAT_MAX_MESSAGES - 1].sessionId, full);
  assert.notEqual(next, full);
  assert.deepEqual([db.chatSession(full)!.messages, db.chatSession(next)!.messages], [CHAT_MAX_MESSAGES, 1]);

  // Never quiet for an hour, yet past twelve hours: the sweep closes it, and so does the next message.
  const start = T0 + 24 * 60 * MIN;
  let last = say(joe.id, "Start", start);
  const long = last.sessionId;
  for (let t = start + 50 * MIN; t < start + CHAT_MAX_AGE_MS; t += 50 * MIN) last = say(joe.id, "Still here", t);
  assert.equal(last.sessionId, long);
  assert.notEqual(say(joe.id, "Hour twelve", start + CHAT_MAX_AGE_MS).sessionId, long);
  const again = say(joe.id, "Start", start + 48 * 60 * MIN);
  for (let t = again.ts + 50 * MIN; t < again.ts + CHAT_MAX_AGE_MS; t += 50 * MIN) say(joe.id, "Still here", t);
  assert.equal(chat.sweep(again.ts + CHAT_MAX_AGE_MS), 1);
});

test("only whoever wrote a message edits or deletes it, and a deleted one keeps its place with nothing in it", () => {
  const { db, joe, huy, chat, channel, events, say } = setup();
  const key = randomUUID();
  const m = say(joe.id, "Ship on Friday", T0, { externalId: key });
  const other = say(huy.id, "Sounds good", T0 + 1000);

  // Someone else's edit and delete change nothing.
  assert.equal(chat.accept(channel.id, [{ type: "edit", id: m.id, by: { userId: huy.id }, text: "Ship never", ts: T0 + 2000 }]).accepted, 0);
  assert.equal(chat.accept(channel.id, [{ type: "delete", id: m.id, by: { userId: huy.id }, ts: T0 + 2000 }]).accepted, 0);
  assert.equal(db.chatMessage(m.id)!.text, "Ship on Friday");

  // The author's edit, by id or by the key it was sent with. The same words again are no edit.
  events.length = 0;
  const edited = chat.accept(channel.id, [{ type: "edit", externalId: key, by: { userId: joe.id }, text: " Ship on Monday ", ts: T0 + 3000 }]);
  assert.deepEqual([edited.accepted, edited.messages[0].text, edited.messages[0].editedAt, edited.messages[0].seq], [1, "Ship on Monday", T0 + 3000, m.seq]);
  assert.equal(chat.accept(channel.id, [{ type: "edit", id: m.id, by: { userId: joe.id }, text: "Ship on Monday", ts: T0 + 4000 }]).accepted, 0);
  assert.equal(chat.accept(channel.id, [{ type: "edit", id: m.id, by: { userId: joe.id }, text: " ", ts: T0 + 4000 }]).accepted, 0);
  assert.equal(db.meetingSegments(m.sessionId)[0].text, "Ship on Monday");
  // An edit is not new talk: the session's end stays at its last message.
  assert.equal(db.chatSession(m.sessionId)!.endedAt, other.ts);

  const gone = chat.accept(channel.id, [{ type: "delete", id: m.id, by: { userId: joe.id }, ts: T0 + 5000 }]).messages[0];
  assert.deepEqual([gone.text, gone.deletedAt], ["", T0 + 5000]);
  assert.deepEqual(db.channelMessages(channel.id).map((x) => [x.id, x.text]), [[m.id, ""], [other.id, "Sounds good"]]);
  // Deleted stays deleted.
  assert.equal(chat.accept(channel.id, [{ type: "edit", id: m.id, by: { userId: joe.id }, text: "Back again", ts: T0 + 6000 }]).accepted, 0);
  assert.equal(chat.accept(channel.id, [{ type: "delete", id: m.id, by: { userId: joe.id }, ts: T0 + 6000 }]).accepted, 0);
  assert.deepEqual(events.map((e) => e.type === "message" && [e.message.id, e.message.text]), [[m.id, "Ship on Monday"], [m.id, ""]]);

  // A message of another channel can't be changed through this one.
  const elsewhere = db.spaceChannel(db.createRoom("Ops").id, joe.id);
  assert.equal(chat.accept(elsewhere.id, [{ type: "delete", id: other.id, by: { userId: huy.id }, ts: T0 + 7000 }]).accepted, 0);
});

test("someone an outside source names can write, edit and delete, with no Stand account", () => {
  const { db, joe, room, chat } = setup();
  db.raw.prepare("INSERT INTO channels (id, room_id, source, external_id, name, created_by, created_at) VALUES ('d1', ?, 'discord', 'guild/123', 'pt-team', ?, ?)").run(room.id, joe.id, T0);
  const sam = { externalId: "u-88", name: "Sam" };
  const m = chat.accept("d1", [{ type: "message", externalId: "msg-1", author: sam, text: "Booked the venue", ts: T0 }]).messages[0];
  assert.deepEqual([m.authorId, m.author, m.channelId], ["discord:u-88", "Sam", "d1"]);
  assert.equal(chat.accept("d1", [{ type: "edit", externalId: "msg-1", by: { externalId: "u-99", name: "Eve" }, text: "Cancelled the venue", ts: T0 + 1 }]).accepted, 0);
  assert.equal(chat.accept("d1", [{ type: "edit", externalId: "msg-1", by: sam, text: "Booked the venue for May", ts: T0 + 1 }]).messages[0].text, "Booked the venue for May");
  // The space's own chat is another channel, with its own sessions.
  const own = db.spaceChannel(room.id, joe.id);
  assert.notEqual(own.id, "d1");
  assert.notEqual(chat.accept(own.id, [{ type: "message", author: { userId: joe.id }, text: "Thanks Sam", ts: T0 + 2 }]).messages[0].sessionId, m.sessionId);
  assert.deepEqual(db.roomChannels(room.id).map((c) => c.source), ["stand", "discord"]);
});

test("messages page by their order, newest page first", () => {
  const { db, joe, channel, say } = setup();
  const all = Array.from({ length: 7 }, (_, i) => say(joe.id, `Line ${i + 1}`, T0 + i * 1000));
  const texts = (page: Parameters<typeof db.channelMessages>[1]) => db.channelMessages(channel.id, page).map((m) => m.text);
  assert.deepEqual(texts({ limit: 3 }), ["Line 5", "Line 6", "Line 7"]);
  assert.deepEqual(texts({ limit: 3, before: all[4].seq }), ["Line 2", "Line 3", "Line 4"]);
  assert.deepEqual(texts({ after: all[4].seq }), ["Line 6", "Line 7"]);
  assert.deepEqual(texts({ after: all[6].seq }), []);
});

test("after a restart, a session carries on if its channel is still talking and closes if it went quiet", () => {
  const file = path.join(tmp, "restart.db");
  const before = setup(file);
  const busy = before.say(before.joe.id, "Deploy is going out", T0);
  const quietRoom = before.db.createRoom("Ops");
  const quiet = before.chat.accept(before.db.spaceChannel(quietRoom.id, before.joe.id).id, [
    { type: "message", author: { userId: before.joe.id }, text: "Anyone here?", ts: T0 - 50 * MIN },
  ]).messages[0];
  before.db.raw.close();

  // The server comes back 15 minutes later: one channel has been quiet for over an hour.
  const db = openDb(file);
  const events: ChatEvent[] = [];
  const chat = new Chat(db, (_roomId, e) => events.push(e));
  assert.equal(chat.sweep(T0 + 15 * MIN), 1);
  assert.deepEqual(events, [{ type: "session", channelId: quiet.channelId, sessionId: quiet.sessionId, open: false }]);
  assert.equal(db.getChannel(quiet.channelId)!.openSessionId, null);
  const after = chat.accept(busy.channelId, [{ type: "message", author: { userId: before.joe.id }, text: "It is out", ts: T0 + 16 * MIN }]).messages[0];
  assert.equal(after.sessionId, busy.sessionId);
  assert.ok(after.seq > quiet.seq);
  db.raw.close();
});

test("start() closes what went quiet while the server was down", () => {
  const { db, joe, chat, channel, say } = setup();
  say(joe.id, "Long ago", Date.now() - CHAT_QUIET_MS - MIN);
  chat.start();
  chat.stop();
  assert.equal(db.getChannel(channel.id)!.openSessionId, null);
});

test("a listener that fails doesn't fail what was saved", () => {
  const db = openDb();
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe Liang", picture: null });
  const channel = db.spaceChannel(db.createRoom("Growth").id, joe.id);
  const chat = new Chat(db, () => {
    throw new Error("stream closed");
  });
  const logged = console.error;
  console.error = () => {};
  try {
    assert.equal(chat.accept(channel.id, [{ type: "message", author: { userId: joe.id }, text: "Saved all the same", ts: T0 }]).accepted, 1);
  } finally {
    console.error = logged;
  }
  assert.equal(db.channelMessages(channel.id).length, 1);
});

test("a chat session is not a meeting: not in the list of meetings, the feed, last time, or the count of meetings since a to-do", () => {
  const { db, joe, huy, room, say } = setup();
  const meeting = db.startMeeting(room.id);
  db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: joe.id, speakerName: "Joe Liang", kind: "speech", text: "Let's fix the invite email.", ts: meeting.startedAt });
  db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: huy.id, speakerName: "Huy Ngo", kind: "speech", text: "I'll take it.", ts: meeting.startedAt + 1 });
  const [todo] = db.syncNotes(meeting.id, null, [{ kind: "action", text: "Fix the invite email", owner: "Huy Ngo" }]);
  db.endMeeting(meeting.id, "Invite email", null, meeting.startedAt + MIN);
  const later = meeting.startedAt + 10 * MIN;
  const m = say(joe.id, "Any news on the email?", later);
  const next = say(huy.id, "Tomorrow", later + CHAT_QUIET_MS);
  assert.notEqual(next.sessionId, m.sessionId);

  assert.deepEqual(db.listMeetings(room.id).map((x) => x.id), [meeting.id]);
  assert.deepEqual(db.feedMeetings(room.id).map((x) => x.id), [meeting.id]);
  assert.equal(db.latestMeeting(room.id), meeting.id);
  assert.equal(db.lastRealMeeting(room.id)!.id, meeting.id);
  assert.equal(db.previousMeetingEnd(room.id, later + MIN), meeting.startedAt + MIN);

  // The to-do is still "from last meeting": two chats after it didn't make that two meetings ago.
  const { upNext } = computeUpNext(db.upNextInput(room.id, null));
  assert.match(upNext.suggestions.find((s) => s.noteId === todo.id)!.reason, /^To-do from last meeting/);
});

test("a chat session is not sent to Conxt, in a database from before chat too", () => {
  const file = path.join(tmp, "conxt.db");
  const first = setup(file);
  first.db.raw
    .prepare("INSERT INTO conxt_connections VALUES ('c1', ?, 'product', 'https://conxt.test/api/v1/integrations/x/sources', 'Team', ?, ?, 1)")
    .run(first.room.id, first.joe.id, T0);
  first.db.raw.close();
  // As the last version left it: every new meetings row joined the space's connection.
  const old = new DatabaseSync(file);
  old.exec(`DROP TRIGGER conxt_meeting_started;
    CREATE TRIGGER conxt_meeting_started AFTER INSERT ON meetings BEGIN
      INSERT INTO conxt_meetings(meeting_id,connection_id) SELECT NEW.id,id FROM conxt_connections WHERE room_id=NEW.room_id AND enabled=1;
    END;`);
  old.close();

  const db = openDb(file);
  const chat = new Chat(db);
  const channel = db.spaceChannel(first.room.id, first.joe.id);
  const m = chat.accept(channel.id, [{ type: "message", author: { userId: first.joe.id }, text: "Between us", ts: T0 }]).messages[0];
  chat.accept(channel.id, [{ type: "edit", id: m.id, by: { userId: first.joe.id }, text: "Between the two of us", ts: T0 + 1 }]);
  const count = (table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.deepEqual([count("conxt_meetings"), count("conxt_live_deliveries"), count("conxt_live_events")], [0, 0, 0]);
  // A meeting in the same space still is.
  const meeting = db.startMeeting(first.room.id);
  db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: first.joe.id, speakerName: "Joe Liang", kind: "speech", text: "Hello", ts: T0 });
  assert.deepEqual([count("conxt_meetings"), count("conxt_live_deliveries"), count("conxt_live_events")], [1, 1, 1]);
  db.raw.close();
});

test("a database from before chat gets its tables and the session's channel on the next start", () => {
  const file = path.join(tmp, "old.db");
  const first = openDb(file);
  const room = first.createRoom("Growth");
  const meeting = first.startMeeting(room.id);
  first.raw.close();
  const old = new DatabaseSync(file);
  old.exec("DROP INDEX meetings_channel; ALTER TABLE meetings DROP COLUMN channel_id; DROP TABLE chat_messages; DROP TABLE channels;");
  old.close();

  const db = openDb(file);
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe Liang", picture: null });
  const channel = db.spaceChannel(room.id, joe.id);
  const m = new Chat(db).accept(channel.id, [{ type: "message", author: { userId: joe.id }, text: "First", ts: T0 }]).messages[0];
  assert.equal(db.chatSession(m.sessionId)!.channelId, channel.id);
  // The meeting from before is no session.
  assert.equal(db.chatSession(meeting.id), null);
  db.raw.close();
});
