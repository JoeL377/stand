import assert from "node:assert/strict";
import { test } from "node:test";
import { UPLOAD_LINK_MAX, UPLOAD_LINK_MS, UploadLinks, WORKING_QUIET_MS, workLog, workingOn } from "./workLog.ts";
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
    uploads: new UploadLinks(),
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

test("get brings the snaps that go with a topic or a note", () => {
  const { db, api, joe, item, topic, action, notes } = setup();
  const decision = notes.find((n) => n.kind === "decision")!;
  const meetingId = decision.meetingId;
  const snap = (id: string) =>
    db.addSnap({
      id,
      roomId: item.roomId,
      meetingId,
      itemId: item.id,
      ts: Date.now(),
      ext: "jpg",
      width: 800,
      height: 500,
      source: "person",
      takenById: joe.id,
      takenBy: "Joe Liang",
      sharerId: joe.id,
      sharerName: "Joe Liang",
      noteId: null,
    });
  // The recap put one under the decision; the other was taken while nobody spoke.
  snap("backsdecision");
  db.placeSnap("backsdecision", { noteId: decision.id, discussionId: topic.id, caption: "Transcript lag by browser" });
  snap("loose");
  const caller = { user: joe, token: null };
  const ids = (got: Record<string, any>) => (got.snaps ?? []).map((p: { image_url: string }) => p.image_url.split("/").pop()!.split(".")[0]);

  const ofTopic = api.get(caller, `stand:topic/${topic.id}`, "http://stand.test") as Record<string, any>;
  assert.deepEqual(ids(ofTopic), ["backsdecision"]);
  assert.equal(ofTopic.snaps[0].image_url, "http://stand.test/api/snaps/backsdecision.jpg?v=1");
  assert.equal(ofTopic.snaps[0].caption, "Transcript lag by browser");
  assert.equal(ofTopic.snaps[0].backs, decision.text);
  assert.deepEqual(ids(api.get(caller, `stand:decision/${decision.id}`, "http://stand.test") as Record<string, any>), ["backsdecision"]);
  // A to-do in the same topic doesn't get a snap that backs a different note.
  assert.equal((api.get(caller, `stand:action/${action.id}`, "http://stand.test") as Record<string, any>).snaps, undefined);
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

test("an agent working on a to-do: working shows, clears when it's done, and the log carries its screenshots", () => {
  const { db, api, joe, andy, action, room } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const ref = `stand:action/${action.id}`;
  assert.throws(() => api.postUpdate(caller, { itemId: action.itemId!, status: "working" }), /to-do/);
  api.postUpdate(caller, { ref, status: "working" });
  const t0 = Date.now();
  let ups = db.notesUpdates([action.id]);
  assert.equal(ups[0].text, "Started on it");
  assert.equal(workingOn(ups, false)?.by, "Joe Liang via Claude Code");
  assert.equal(workingOn(ups, false, t0 + WORKING_QUIET_MS + 1), null, "quiet for too long reads as stopped");

  // A screenshot sent to the upload link joins the next report.
  const link = api.screenshotUploadUrl(caller, { ref }, "https://stand.test");
  const grant = link.upload_url.split("/").pop()!;
  assert.ok(grant.length > 20);
  db.addWorkShot({ roomId: room.id, noteId: action.id, userId: joe.id, userName: joe.name, client: "Claude Code", caption: "New panel", ext: "png" });
  db.addWorkShot({ roomId: room.id, noteId: action.id, userId: andy.id, userName: andy.name, client: null, caption: "Andy's", ext: "png" });
  api.completeAction(caller, { ref, note: "Moved capture to the server.\n- New worker\n- Old path removed" });
  ups = db.notesUpdates([action.id]);
  assert.equal(workingOn(ups, true), null);
  const log = workLog(ups, db.noteWorkShots([action.id]));
  assert.equal(log[0].status, "done");
  assert.deepEqual(log[0].shots.map((s) => s.caption), ["New panel"]);
  assert.ok(log.some((e) => e.status === "shots" && e.shots[0].caption === "Andy's"), "someone else's loose screenshot stays on its own");
  const got = api.get({ user: joe, token: null }, ref, "https://stand.test") as Record<string, any>;
  assert.match(got.updates[0].screenshots[0].image_url, /^https:\/\/stand\.test\/api\/work-shots\//);
});

test("upload links run out", () => {
  const links = new UploadLinks();
  const s = links.create({ roomId: "r", noteId: "n", userId: "u", userName: "U", client: null }, 0);
  for (let i = 0; i < UPLOAD_LINK_MAX; i++) assert.ok(links.use(s, 1));
  assert.equal(links.use(s, 1), null);
  const t = links.create({ roomId: "r", noteId: "n", userId: "u", userName: "U", client: null }, 0);
  assert.equal(links.use(t, UPLOAD_LINK_MS + 1), null);
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

test("notes saved from the bar reach agents: list_notes, get on stand:note, the item's context and the agenda", () => {
  const { db, api, joe, andy, room, item } = setup();
  const me = { user: joe, token: null };
  const at = Date.parse("2026-10-11T08:00:00Z");
  db.addJot({ id: "jotchart1", roomId: room.id, itemId: item.id, itemSuggested: true, text: "Lag spikes when two people talk", byId: joe.id, by: "Joe Liang", ts: at });
  db.addJot({ id: "jotolder1", roomId: room.id, itemId: null, text: "Ask Okta about SSO", byId: joe.id, by: "Joe Liang", ts: at - 2 * 86_400_000 });
  const snap = (id: string, jotId: string | null, ts: number) =>
    db.addSnap({
      id,
      roomId: room.id,
      meetingId: null,
      itemId: jotId ? item.id : null,
      ts,
      ext: "jpg",
      width: 800,
      height: 500,
      source: "person",
      takenById: joe.id,
      takenBy: "Joe Liang",
      sharerId: null,
      sharerName: null,
      noteId: null,
      screenText: "p95 1.8s",
      jotId,
    });
  snap("pinnedsnap", "jotchart1", at - 1000);
  snap("alonesnap1", null, at - 5000);

  const all = api.listNotes(me, { space: "checkout" }, "http://stand.test");
  assert.deepEqual(all.notes.map((n) => [n.ref, n.text, n.item?.title ?? null]), [
    ["stand:note/jotchart1", "Lag spikes when two people talk", "Transcript lag"],
    ["stand:note/jotolder1", "Ask Okta about SSO", null],
  ]);
  assert.equal(all.notes[0].item?.filed_by, "the Stand agent (not confirmed yet)");
  assert.deepEqual(all.notes[0].snaps?.map((s) => [s.image_url, s.text_on_screen]), [["http://stand.test/api/snaps/pinnedsnap.jpg?v=1", "p95 1.8s"]]);
  // A snap pinned to a note shows with it, not again on its own.
  assert.deepEqual(all.snaps_on_their_own?.map((s) => s.image_url), ["http://stand.test/api/snaps/alonesnap1.jpg?v=1"]);
  assert.deepEqual(api.listNotes(me, { space: room.id, since: "2026-10-10" }, "x").notes.map((n) => n.ref), ["stand:note/jotchart1"]);
  assert.deepEqual(api.listNotes(me, { space: room.id, itemId: item.id }, "x").notes.map((n) => n.ref), ["stand:note/jotchart1"]);
  assert.throws(() => api.listNotes(me, { space: room.id, since: "last week" }, "x"), AgentError);

  const got = api.get(me, "stand:note/jotchart1", "http://stand.test") as Record<string, any>;
  assert.equal(got.kind, "note");
  assert.equal(got.space.name, "Checkout v2");
  assert.equal(got.snaps.length, 1);
  assert.deepEqual(got.on_this_item.decisions.map((d: { text: string }) => d.text), ["Keep LiveKit; drop the browser fallback"]);
  assert.equal(got.url, `http://stand.test/s/${room.id}`);
  // Spaces are invite only: Andy's agents can't read it.
  assert.throws(() => api.get({ user: andy, token: null }, "stand:note/jotchart1", "x"), AgentError);
  assert.throws(() => api.listNotes({ user: andy, token: null }, { space: room.id }, "x"), AgentError);

  const ctx = api.itemContext(me, item.id, "http://stand.test");
  assert.deepEqual(ctx.saved_notes?.map((n) => n.ref), ["stand:note/jotchart1"]);
  assert.equal(ctx.snaps.some((s) => s.image_url.includes("pinnedsnap")), false);
});
