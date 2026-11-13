import assert from "node:assert/strict";
import { test } from "node:test";
import { agentApi, AgentError } from "./agents.ts";
import { buildBrief, briefToMarkdown } from "./brief.ts";
import { openDb } from "./db.ts";
import { cleanMeetingTitle, meetingKindName } from "./meetingNames.ts";
import { withFrom } from "./noteFrom.ts";
import { spaceFeed } from "./captures.ts";
import { UploadLinks } from "./workLog.ts";
import { upNextView } from "./upNextPolish.ts";

function setup() {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const andy = db.upsertUser({ googleSub: "g-andy", email: "andy@example.com", name: "Andy Li", picture: null });
  const room = db.createRoom("Checkout v2", joe.id);
  db.touchMembership(room.id, joe.id);
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Transcript lag", url: null, description: null }]);
  const m = db.startMeeting(room.id);
  db.addSegment({ meetingId: m.id, itemId: item.id, speakerId: joe.id, speakerName: "Joe Liang", kind: "speech", text: "Let's move capture to the server.", ts: m.startedAt + 1000 });
  const [topic] = db.replaceDiscussions(m.id, item.id, [
    { topic: "Where transcription runs", positions: [], outcome: "action", segmentIds: [], continuesId: null },
  ]);
  const [todo] = db.syncNotes(m.id, item.id, [{ kind: "action", text: "Move transcript capture to the server", owner: "Joe", discussionId: topic.id }]);
  db.endMeeting(m.id, "We moved transcription to the server.", null, m.startedAt + 20 * 60_000);
  const notified: string[] = [];
  const api = agentApi({ db, notify: (r, what) => notified.push(`${r}:${what}`), brief: () => ({}), suggested: (r) => upNextView(db, r, null), uploads: new UploadLinks() });
  const caller = { user: joe, token: { id: "tok1", label: "Claude", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null } };
  return { db, api, caller, joe, andy, room, meeting: m, todo, notified };
}

test("a meeting nobody named reads as its kind; a name someone gives it wins everywhere", () => {
  const { db, api, caller, room, meeting, todo, notified } = setup();
  assert.equal(meetingKindName(db, meeting.id), "Meeting");

  const before = api.listMeetings(caller, { space: "Checkout" }, "https://stand.test");
  assert.equal(before.meetings.length, 1);
  assert.deepEqual(
    { name: before.meetings[0].name, named: before.meetings[0].named, topics: before.meetings[0].topics, summary: before.meetings[0].summary },
    { name: "Meeting", named: false, topics: ["Where transcription runs"], summary: "We moved transcription to the server." },
  );

  const out = api.renameMeetings(caller, { renames: [{ meeting: `https://stand.test/meetings/${meeting.id}`, title: "  Transcription\n on the server  " }] }, "https://stand.test");
  assert.deepEqual(out.renamed.map((r) => [r.name, r.was]), [["Transcription on the server", "Meeting"]]);
  assert.deepEqual(notified, [`${room.id}:followups`]);

  assert.equal(db.getMeeting(meeting.id)!.title, "Transcription on the server");
  assert.equal(spaceFeed(db, room.id).meetings[0].title, "Transcription on the server");
  assert.equal(withFrom(db, [db.getNote(todo.id)!])[0].from?.title, "Transcription on the server");
  assert.equal(api.listMeetings(caller, { space: "Checkout", unnamed: true }).meetings.length, 0);
  const whatsNew = api.whatsNew(caller, { space: "Checkout" });
  assert.equal(whatsNew.meetings[0].name, "Transcription on the server");

  const brief = buildBrief({ meeting: db.getMeeting(meeting.id)!, roomName: room.name, groups: [], decks: [], baseUrl: "" });
  assert.equal(brief.meeting.title, "Transcription on the server");
  assert.match(briefToMarkdown(brief), /^# Transcription on the server · /m);

  // An empty title takes the name off again.
  api.renameMeetings(caller, { renames: [{ meeting: meeting.id, title: "" }] });
  assert.equal(db.getMeeting(meeting.id)!.title, null);
  assert.equal(api.listMeetings(caller, { space: "Checkout" }).meetings[0].name, "Meeting");
});

test("renaming checks every meeting first: a stranger's or unknown meeting renames nothing", () => {
  const { db, api, caller, andy, meeting } = setup();
  const theirs = db.createRoom("Andy's space", andy.id);
  db.touchMembership(theirs.id, andy.id);
  const other = db.startMeeting(theirs.id);
  assert.throws(() => api.renameMeetings(caller, { renames: [{ meeting: meeting.id, title: "Ours" }, { meeting: other.id, title: "Not ours" }] }), AgentError);
  assert.throws(() => api.renameMeetings(caller, { renames: [{ meeting: "nope", title: "x" }] }), /list_meetings/);
  assert.throws(() => api.renameMeetings(caller, { renames: [{ meeting: meeting.id, title: "x".repeat(81) }] }), /at most 80/);
  assert.equal(db.getMeeting(meeting.id)!.title, null);
  assert.equal(db.getMeeting(other.id)!.title, null);

  const readOnly = { ...caller, token: { ...caller.token, scope: "read" as const } };
  assert.throws(() => api.renameMeetings(readOnly, { renames: [{ meeting: meeting.id, title: "x" }] }), AgentError);
});

test("a name is one trimmed line of at most 80 characters", () => {
  assert.equal(cleanMeetingTitle("  a\n\tb  "), "a b");
  assert.equal(cleanMeetingTitle("   "), null);
  assert.equal(cleanMeetingTitle(42), null);
  assert.equal(cleanMeetingTitle("x".repeat(100))!.length, 80);
});
