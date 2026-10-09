import assert from "node:assert/strict";
import { test } from "node:test";
import { agentApi, AgentError, parseRef } from "./agents.ts";
import { openDb } from "./db.ts";
import { addUpNext } from "./upNext.ts";
import { upNextView } from "./upNextPolish.ts";

function setup() {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const andy = db.upsertUser({ googleSub: "g-andy", email: "andy@example.com", name: "Andy Li", picture: null });
  const room = db.createRoom("Checkout v2", joe.id, "Ship one-page checkout");
  db.touchMembership(room.id, joe.id);
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Transcript lag", url: null, description: null }]);
  const m = db.startMeeting(room.id);
  const [topic] = db.replaceDiscussions(m.id, item.id, [
    {
      topic: "Where transcription runs",
      positions: [{ speaker: "Andy", position: "Move it to the server" }],
      outcome: "action",
      segmentIds: [],
      continuesId: null,
    },
  ]);
  const notes = db.replaceNotes(m.id, item.id, [
    { kind: "decision", text: "Keep LiveKit; drop the browser fallback", owner: null, discussionId: topic.id },
    { kind: "action", text: "Move transcript capture to the server", owner: "Joe", discussionId: topic.id },
    { kind: "action", text: "Write the migration note", owner: "Andy", discussionId: topic.id },
    { kind: "question", text: "Do we need it on mobile first?", owner: null, discussionId: null },
  ]);
  db.endMeeting(m.id, null);
  const notified: string[] = [];
  const api = agentApi({
    db,
    notify: (r, what) => notified.push(`${r}:${what}`),
    brief: (id) => ({ meeting: id }),
    suggested: (r) => upNextView(db, r, null),
  });
  const action = notes.find((n) => n.text.startsWith("Move"))!;
  return { db, api, joe, andy, room, item, topic, action, notes, notified };
}

test("references parse from refs, short forms and Stand links", () => {
  assert.deepEqual(parseRef("stand:action/k3m9xq2p"), { kind: "action", id: "k3m9xq2p" });
  assert.deepEqual(parseRef("topic/abcd2345"), { kind: "topic", id: "abcd2345" });
  assert.deepEqual(parseRef("https://stand.example/ref/decision/abcd2345"), { kind: "decision", id: "abcd2345" });
  assert.equal(parseRef("hello"), null);
});

test("agent tokens: shown once, stored hashed, revocable", () => {
  const { db, joe } = setup();
  const { token, info } = db.createToken(joe.id, "Claude Code", "write");
  assert.match(token, /^stand_pat_/);
  assert.equal(db.tokenUser(token)?.user.id, joe.id);
  assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM api_tokens").all()).includes(token), false);
  assert.equal(db.revokeToken(joe.id, info.id), true);
  assert.equal(db.tokenUser(token), null);
});

test("get returns a to-do with its decision, topic and item, only to people in the space", () => {
  const { api, joe, andy, action } = setup();
  const got = api.get({ user: joe, token: null }, `stand:action/${action.id}`, "http://stand.test") as Record<string, any>;
  assert.equal(got.text, "Move transcript capture to the server");
  assert.equal(got.status, "open");
  assert.equal(got.space.name, "Checkout v2");
  assert.equal(got.item.title, "Transcript lag");
  assert.deepEqual(got.decided_with_it, ["Keep LiveKit; drop the browser fallback"]);
  assert.equal(got.topic.topic, "Where transcription runs");
  assert.deepEqual(
    got.on_this_item.open_questions.map((q: { text: string }) => q.text),
    ["Do we need it on mobile first?"],
  );
  assert.equal(got.url, `http://stand.test/ref/action/${action.id}`);
  // Andy never opened the space, so it doesn't exist for his agents.
  assert.throws(() => api.get({ user: andy, token: null }, `stand:action/${action.id}`, "x"), AgentError);
});

test("the copied prompt names the ref, the to-do and the decision", () => {
  const { api, joe, action } = setup();
  const text = api.prompt({ user: joe, token: null }, `stand:action/${action.id}`, "http://stand.test");
  assert.match(text, new RegExp(`^Work on this Stand to-do: stand:action/${action.id}\n`));
  assert.match(text, /"Move transcript capture to the server" \(owner: Joe, space: Checkout v2, item: Transcript lag\)/);
  assert.match(text, /Decided: Keep LiveKit; drop the browser fallback/);
});

test("list_my_work matches owners by name across the spaces you're in", () => {
  const { api, joe } = setup();
  const mine = api.listMyWork({ user: joe, token: null }, {}, "http://stand.test");
  assert.deepEqual(
    mine.work.map((w) => w.text),
    ["Move transcript capture to the server"],
  );
  assert.equal(mine.work[0].decided, "Keep LiveKit; drop the browser fallback");
});

test("agents report back: complete_action checks off and records who, via which agent", () => {
  const { db, api, joe, action, room, notified } = setup();
  const { info } = db.createToken(joe.id, "Claude Code on Joe's Mac", "write");
  const caller = { user: joe, token: info };
  const res = api.completeAction(caller, {
    ref: `stand:action/${action.id}`,
    note: "Shipped",
    links: ["https://github.com/x/y/pull/12", "javascript:alert(1)"],
  });
  assert.equal(res.done_by, "Joe Liang via Claude Code on Joe's Mac");
  assert.equal(db.getNote(action.id)?.doneAt !== null, true);
  const [u] = db.roomUpdates(room.id);
  assert.equal(u.status, "done");
  assert.deepEqual(u.links, ["https://github.com/x/y/pull/12"]);
  assert.deepEqual(notified, [`${room.id}:followups`]);

  api.postUpdate(caller, { ref: `stand:action/${action.id}`, text: "Waiting on infra", status: "blocked" });
  assert.equal(db.roomUpdates(room.id)[0].status, "blocked");
});

test("a read-only token can't report back", () => {
  const { db, api, joe, item } = setup();
  const { info } = db.createToken(joe.id, "Cursor", "read");
  assert.throws(() => api.postUpdate({ user: joe, token: info }, { itemId: item.id, text: "hi" }), /read only/);
});

test("references survive the agent rewriting the notes and topics mid-meeting", () => {
  const { db, room, item } = setup();
  const m = db.startMeeting(room.id);
  const [t1] = db.replaceDiscussions(m.id, item.id, [
    { topic: "Pricing", positions: [], outcome: "open", segmentIds: [], continuesId: null },
  ]);
  const [q1] = db.replaceNotes(m.id, item.id, [{ kind: "question", text: "Monthly too?", owner: null }]);
  const [t2] = db.replaceDiscussions(m.id, item.id, [
    { topic: "pricing ", positions: [], outcome: "decided", segmentIds: [], continuesId: null },
  ]);
  const [q2] = db.replaceNotes(m.id, item.id, [{ kind: "question", text: "Monthly too?", owner: null }]);
  assert.equal(t2.id, t1.id);
  assert.equal(q2.id, q1.id);
});

test("sign-in flow: codes work once, refresh swaps the pair, signing in again replaces the app's token", () => {
  const { db, joe } = setup();
  const app = db.registerClient("Claude", ["https://claude.ai/api/mcp/auth_callback"]);
  const code = db.createAuthCode({ clientId: app.id, userId: joe.id, redirectUri: app.redirectUris[0], challenge: "c", scope: "write" });
  assert.equal(db.takeAuthCode(code)?.userId, joe.id);
  assert.equal(db.takeAuthCode(code), null);

  const first = db.createToken(joe.id, app.name, "write", { clientId: app.id });
  const next = db.refreshToken(first.refresh!, app.id)!;
  assert.equal(db.tokenUser(first.token), null);
  assert.equal(db.tokenUser(next.token)?.user.id, joe.id);
  assert.equal(db.refreshToken(first.refresh!, app.id), null);

  db.revokeClientTokens(joe.id, app.id);
  assert.equal(db.tokenUser(next.token), null);
  assert.deepEqual(db.listTokens(joe.id), []);
});

test("list_actions returns everyone's to-dos in a space, filtered by owner or status", () => {
  const { api, joe } = setup();
  const caller = { user: joe, token: null };
  const all = api.listActions(caller, { space: "checkout" }, "http://stand.test");
  assert.equal(all.space.name, "Checkout v2");
  assert.deepEqual(all.actions.map((a) => a.owner).sort(), ["Andy", "Joe"]);
  assert.deepEqual(
    api.listActions(caller, { space: "Checkout v2", owner: "Andy Li" }, "x").actions.map((a) => a.text),
    ["Write the migration note"],
  );
  assert.equal(api.listActions(caller, { space: "checkout", status: "done" }, "x").count, 0);
  assert.throws(() => api.listActions(caller, { space: "nowhere" }, "x"), /not in a space/);
});

test("a new space offers the open to-dos of a space everyone in it shares, and carrying them moves them over", () => {
  const { db, api, joe, andy, room } = setup();
  const launch = db.createRoom("Launch", joe.id, "");
  db.touchMembership(launch.id, joe.id);
  const m = db.startMeeting(launch.id);
  const agenda = api.suggestedAgenda({ user: joe, token: null }, "Launch", "https://stand.test");
  assert.deepEqual(
    agenda.suggested.map((s) => [s.title, s.why]),
    [["Open to-dos from Checkout v2", "2 open to-dos in Checkout v2"]],
  );

  const itemId = addUpNext(db, launch.id, { key: `space:${room.id}`, merged: [] }, { id: m.id });
  assert.ok(itemId);
  assert.equal(db.getItem(itemId)!.title, "To-dos from Checkout v2");
  assert.deepEqual(
    db.itemNotes(itemId).map((n) => [n.text, n.owner, n.doneAt]),
    [
      ["Move transcript capture to the server", "Joe", null],
      ["Write the migration note", "Andy", null],
    ],
  );
  assert.equal(db.openActions(room.id).length, 0);
  assert.equal(db.roomFollowUps(room.id)[0].doneBy, "carry-over to “Launch”");

  // Someone who isn't in Checkout v2 is in this space: it isn't offered, so its name doesn't leak.
  const side = db.createRoom("Side", joe.id, "");
  db.touchMembership(side.id, joe.id);
  db.touchMembership(side.id, andy.id);
  assert.deepEqual(db.sharedSpacesWithOpenWork(side.id), []);
});
