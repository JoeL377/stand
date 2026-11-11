import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionedIn } from "../shared/mentions.ts";
import { agentApi } from "./agents.ts";
import { openDb } from "./db.ts";
import { recordMentions } from "./mentions.ts";
import { toSpaceSummary } from "./spaces.ts";
import { UploadLinks } from "./workLog.ts";
import { upNextView } from "./upNextPolish.ts";

const people = [
  { id: "joe", name: "Joe Liang" },
  { id: "joey", name: "Joey Park" },
  { id: "andy", name: "Andy Li" },
  { id: "ann", name: "Ann Lee" },
  { id: "ann2", name: "Ann Moss" },
];

test("@Full Name tags someone, and @First name does too when nobody else in the space has it", () => {
  assert.deepEqual(mentionedIn("@Joe Liang can you look?", people), ["joe"]);
  assert.deepEqual(mentionedIn("cc @andy and @Joey", people), ["andy", "joey"]);
  assert.deepEqual(mentionedIn("@Joe", people), ["joe"], "Joey is another first name, not a clash");
  assert.deepEqual(mentionedIn("@Ann what do you think?", people), [], "two Anns: the first name tags neither");
  assert.deepEqual(mentionedIn("@Ann Moss what do you think?", people), ["ann2"]);
  assert.deepEqual(mentionedIn("@Joe Liang, @Joe Liang again", people), ["joe"]);
});

test("a tag needs its own word: emails, longer words and @@ don't tag", () => {
  assert.deepEqual(mentionedIn("mail joe@andy.com", people), []);
  assert.deepEqual(mentionedIn("@Joeline", people), []);
  assert.deepEqual(mentionedIn("@@Joe", people), []);
  assert.deepEqual(mentionedIn("(@Andy)", people), ["andy"]);
});

test("the longer name wins, so @Joe Liang doesn't also tag a Joe", () => {
  const two = [{ id: "joe", name: "Joe" }, { id: "jl", name: "Joe Liang" }];
  assert.deepEqual(mentionedIn("@Joe Liang please", two), ["jl"]);
  assert.deepEqual(mentionedIn("@Joe please", two), ["joe"]);
});

function setup() {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const andy = db.upsertUser({ googleSub: "g-andy", email: "andy@example.com", name: "Andy Li", picture: null });
  const room = db.createRoom("Checkout v2", joe.id, "Ship one-page checkout");
  db.touchMembership(room.id, joe.id);
  db.touchMembership(room.id, andy.id);
  const m = db.startMeeting(room.id);
  const notes = db.replaceNotes(m.id, null, [
    { kind: "action", text: "Move transcript capture to the server", owner: "Joe", discussionId: null },
    { kind: "question", text: "Do we need it on mobile first?", owner: null, discussionId: null },
  ]);
  db.endMeeting(m.id, null);
  const api = agentApi({ db, notify: () => {}, brief: () => ({}), suggested: (r) => upNextView(db, r, null), uploads: new UploadLinks() });
  const [action, question] = notes;
  const comment = (by: { id: string; name: string }, noteId: string, text: string) => {
    const n = db.getNote(noteId)!;
    const u = db.addUpdate({ roomId: room.id, itemId: null, noteId, noteText: n.text, userId: by.id, userName: by.name, client: null, status: "comment", text, links: [] });
    return recordMentions(db, u, by.id);
  };
  return { db, api, joe, andy, room, action, question, comment };
}

test("a tag waits on the person tagged until they reply on the task", () => {
  const { db, joe, andy, room, action, comment } = setup();
  assert.deepEqual(comment(joe, action.id, "@Andy can you check the migration?"), ["Andy Li"]);
  assert.equal(db.openMentions(andy.id, room.id).length, 1);
  assert.equal(db.openMentions(joe.id).length, 0, "you don't tag yourself");

  comment(joe, action.id, "@Joe note to self");
  assert.equal(db.openMentions(joe.id).length, 0);

  // Joe writing again doesn't answer it; Andy's reply does.
  comment(joe, action.id, "Any news?");
  assert.equal(db.openMentions(andy.id).length, 1);
  comment(andy, action.id, "Checked, it's fine");
  assert.equal(db.openMentions(andy.id).length, 0);
});

test("dismissing a tag, or closing the task, takes it off", () => {
  const { db, joe, andy, room, action, question, comment } = setup();
  comment(joe, action.id, "@Andy Li look");
  comment(joe, question.id, "@Andy Li and this one");
  assert.equal(db.openMentions(andy.id).length, 2);

  assert.equal(db.clearMentions(question.id, andy.id), 1);
  assert.deepEqual(db.openMentions(andy.id).map((u) => u.noteId), [action.id]);

  db.setActionDone(room.id, action.id, "Joe Liang");
  assert.equal(db.openMentions(andy.id).length, 0);
});

test("an agent's comment tags people, and their agent sees it in list_my_work and whats_new", () => {
  const { db, api, joe, andy, room, question } = setup();
  const token = { id: "tok1", label: "Claude Code", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  const posted = api.postUpdate({ user: joe, token }, { ref: `stand:question/${question.id}`, status: "comment", text: "@Andy do we need mobile first?" }) as { tagged?: string };
  assert.match(posted.tagged ?? "", /Andy Li/);

  const andyCaller = { user: andy, token: null };
  const mine = api.listMyWork(andyCaller, {}, "http://stand.test");
  assert.equal(mine.count, 0, "Andy owns nothing here");
  assert.equal(mine.mentions_you?.length, 1);
  assert.equal(mine.mentions_you?.[0].ref, `stand:question/${question.id}`);
  assert.equal(mine.mentions_you?.[0].by, "Joe Liang via Claude Code");
  assert.equal(api.listMyWork(andyCaller, { space: "nowhere" }, "").mentions_you, undefined);

  const news = api.whatsNew(andyCaller, { space: room.id }) as { mentions_you?: unknown[] };
  assert.equal(news.mentions_you?.length, 1);
  assert.equal(db.openMentions(joe.id).length, 0);
});

test("the space card counts your open tasks where a comment tags you", () => {
  const { db, joe, andy, comment, action } = setup();
  comment(joe, action.id, "@Andy first");
  comment(joe, action.id, "@Andy second");
  const tasks = new Set(db.openMentions(andy.id).map((u) => u.noteId));
  const [row] = db.spaceRows(andy.id);
  assert.equal(toSpaceSummary(row, andy, null, 0, tasks.size).mentions, 1, "two comments on one task count once");
});
