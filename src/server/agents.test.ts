import assert from "node:assert/strict";
import { test } from "node:test";
import { UPLOAD_LINK_MAX, UPLOAD_LINK_MS, UploadLinks, WORKING_QUIET_MS, prOf, readyToShip, workLog, workingOn } from "./workLog.ts";
import { ShipWatch, githubPrState, type PrState } from "./shipWatch.ts";
import { agentApi, AgentError, parseRef } from "./agents.ts";
import { openDb } from "./db.ts";
import { addUpNext } from "./upNext.ts";
import { upNextView } from "./upNextPolish.ts";

function setup(deps: { readyToShip?: () => void } = {}) {
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
    ...deps,
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

test("create_action adds a to-do no meeting caught: it lists like the others, with its status and summary in its log", () => {
  const { db, api, joe, room, item, notified } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const meetingsBefore = db.listMeetings(room.id).length;
  const res = api.createAction(
    caller,
    { space: "checkout", text: "  Renew the   Apple developer cert ", itemId: item.id, summary: "It runs out on Nov 2; the .dmg won't sign after." },
    "http://stand.test",
  );
  assert.equal(res.created.text, "Renew the Apple developer cert");
  assert.equal(res.created.owner, "Joe Liang", "owner defaults to the person the token belongs to");
  assert.equal(res.created.status, "open");
  assert.equal(res.log?.text, "It runs out on Nov 2; the .dmg won't sign after.");
  assert.equal(res.log?.status, "added", "the details aren't a report, so it doesn't show as being worked on");
  assert.deepEqual(notified, [`${room.id}:followups`]);

  // It's a to-do of the space like any other, but no meeting shows up for it.
  const id = parseRef(res.created.ref)!.id;
  assert.ok(db.roomFollowUps(room.id).some((f) => f.id === id));
  assert.ok(db.openActions(room.id).some((f) => f.id === id));
  assert.equal(db.listMeetings(room.id).length, meetingsBefore);
  assert.equal(db.previousMeetingEnd(room.id, Date.now() + 1), db.getMeeting(db.latestMeeting(room.id)!)!.endedAt);
  const listed = api.listActions(caller, { space: "checkout" }, "x").actions.find((a) => a.ref === res.created.ref)!;
  assert.equal(listed.from_meeting, undefined);
  assert.equal(listed.added?.by, "Joe Liang via Claude Code");
  const got = api.get(caller, res.created.ref, "x") as Record<string, any>;
  assert.equal(got.meeting, undefined);
  assert.equal(got.added.by, "Joe Liang via Claude Code");
  assert.equal(got.item.title, "Transcript lag");
  assert.equal(got.updates[0].text, "It runs out on Nov 2; the .dmg won't sign after.");
  assert.equal(api.locate(caller, "action", id).added, true);
});

test("create_action takes a status: already done or dropped closes it, with who and why", () => {
  const { db, api, joe, room } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const done = api.createAction(caller, {
    space: room.id,
    text: "Fix the black board after a share",
    owner: "Andy",
    status: "done",
    summary: "useMedia skips ending tracks now.",
    links: ["https://github.com/JoeL377/stand/pull/32"],
  });
  assert.equal(done.created.status, "done");
  assert.equal(done.created.owner, "Andy");
  const note = db.getNote(parseRef(done.created.ref)!.id)!;
  assert.equal(note.closedBy, "pr:https://github.com/JoeL377/stand/pull/32");
  assert.equal(note.doneBy, "Joe Liang via Claude Code");
  assert.equal(done.log?.status, "done");

  const dropped = api.createAction(caller, { space: room.id, text: "Try Kanban", owner: "unassigned", status: "dropped", reason: "One card instead" });
  assert.equal(dropped.created.status, "dropped");
  assert.equal(dropped.created.owner, undefined);
  assert.equal(dropped.created.why_dropped, "One card instead");
  assert.equal(api.listActions(caller, { space: room.id, status: "open" }, "x").actions.some((a) => a.ref === dropped.created.ref), false);

  const doing = api.createAction(caller, { space: room.id, text: "Mic picker", status: "doing" });
  assert.equal(doing.created.status, "doing");
  assert.throws(() => api.createAction(caller, { space: room.id, text: "x", status: "shipped" }), /Status is one of/);
  assert.throws(() => api.createAction(caller, { space: room.id, text: "   " }), /needs its text/);
});

test("update_action rewords, reassigns and moves any to-do, and logs the summary", () => {
  const { db, api, joe, action } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const ref = `stand:action/${action.id}`;
  const res = api.updateAction(caller, { ref, text: "Move transcript capture to the server (LiveKit agent)", owner: "Andy Li", status: "doing" });
  assert.equal(res.updated.text, "Move transcript capture to the server (LiveKit agent)");
  assert.equal(res.updated.owner, "Andy Li");
  assert.equal(res.updated.status, "doing");
  assert.equal(res.log, undefined);

  const closed = api.updateAction(caller, { ref, status: "done", summary: "Runs on the server since Tuesday." });
  assert.equal(closed.updated.status, "done");
  assert.equal(db.getNote(action.id)!.closedBy, "agent");
  assert.equal(closed.log?.text, "Runs on the server since Tuesday.");

  const reopened = api.updateAction(caller, { ref, status: "open" });
  assert.equal(reopened.updated.status, "open");
  assert.equal(db.getNote(action.id)!.doneAt, null);
  assert.throws(() => api.updateAction(caller, { ref }), /Nothing to change/);

  // An added to-do keeps who added it when someone else rewords it.
  const added = api.createAction(caller, { space: "checkout", text: "Renew the cert" });
  api.updateAction({ user: joe, token: null }, { ref: added.created.ref, text: "Renew the Apple cert" });
  assert.equal(db.getNote(parseRef(added.created.ref)!.id)!.editedBy, "Joe Liang via Claude Code");

  const ro = db.createToken(joe.id, "Reader", "read").info;
  assert.throws(() => api.updateAction({ user: joe, token: ro }, { ref, status: "done" }), /read only/);
  assert.throws(() => api.createAction({ user: joe, token: ro }, { space: "checkout", text: "x" }), /read only/);
});

test("a to-do added by hand comes up on the next agenda as added, and doesn't count as a meeting passing", () => {
  const { db, api, joe, room } = setup();
  const m = db.startMeeting(room.id);
  const [loose] = db.replaceNotes(m.id, null, [{ kind: "action", text: "Book the offsite", owner: null, discussionId: null }]);
  db.endMeeting(m.id, null);
  api.createAction({ user: joe, token: null }, { space: room.id, text: "Renew the cert" });
  const { upNext } = upNextView(db, room.id, null);
  const added = upNext.suggestions.find((s) => s.title === "Renew the cert")!;
  assert.match(added.reason, /^To-do added since last meeting/);
  assert.equal(added.carried, 0);
  assert.match(upNext.suggestions.find((s) => s.noteId === loose.id)!.reason, /^To-do from last meeting/);
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

test("a to-do finished as a PR shows ready to ship, and Stand checks it off when the PR merges", async () => {
  let asked = 0;
  const { db, api, joe, action, notes, notified } = setup({ readyToShip: () => asked++ });
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const ref = `stand:action/${action.id}`;
  const pr = "https://github.com/JoeL377/stand/pull/15";
  assert.throws(() => api.postUpdate(caller, { itemId: action.itemId!, status: "ready", text: "x" }), /to-do/);
  api.postUpdate(caller, { ref, status: "working" });
  const res = api.postUpdate(caller, { ref, status: "ready", text: "The chapter bar fills from the left.", links: [pr] });
  assert.match(res.ships!, /checks it off by itself when https:\/\/github\.com\/JoeL377\/stand\/pull\/15 merges/);
  assert.equal(asked, 1, "Stand looks at the PR right away");
  let ups = db.notesUpdates([action.id]);
  assert.equal(workingOn(ups, false), null, "ready stops the spinner");
  assert.deepEqual(readyToShip(ups, false), { by: "Joe Liang via Claude Code", since: ups.at(-1)!.ts, text: "The chapter bar fills from the left.", pr });

  // Without a PR link it still shows ready, but the agent hears it has to come back.
  const other = notes.find((n) => n.text.startsWith("Write"))!;
  const bare = api.postUpdate(caller, { ref: `stand:action/${other.id}`, status: "ready", text: "Drafted in the doc." });
  assert.match(bare.ships!, /can't tell when it ships/);
  assert.equal(asked, 1);

  const states = new Map<string, PrState | null>([[pr, "open"]]);
  const watch = new ShipWatch(db, (r) => notified.push(`${r}:ship`), async (l) => states.get(l) ?? null);
  await watch.check();
  assert.equal(db.getNote(action.id)!.doneAt, null, "an open PR leaves it alone");

  states.set(pr, "merged");
  await watch.check();
  const done = db.getNote(action.id)!;
  assert.ok(done.doneAt);
  assert.equal(done.doneBy, "Joe Liang via Claude Code");
  ups = db.notesUpdates([action.id]);
  assert.equal(ups.at(-1)!.status, "done");
  assert.equal(ups.at(-1)!.text, "Shipped: PR #15 merged. The chapter bar fills from the left.");
  assert.equal(readyToShip(ups, true), null);
  assert.equal(db.readyToShip().some((u) => u.noteId === action.id), false, "a shipped to-do isn't watched any more");
  assert.equal(db.getNote(other.id)!.doneAt, null, "no PR, nothing to watch");
});

test("a to-do whose PR closes without merging stays open and says why", async () => {
  const { db, api, joe, action } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const pr = "https://github.com/JoeL377/stand/pull/16";
  api.postUpdate({ user: joe, token: info }, { ref: `stand:action/${action.id}`, status: "ready", text: "Done in a PR.", links: [pr] });
  await new ShipWatch(db, () => {}, async () => "closed").check();
  assert.equal(db.getNote(action.id)!.doneAt, null);
  const last = db.notesUpdates([action.id]).at(-1)!;
  assert.equal(last.status, "blocked");
  assert.match(last.text, /PR #16 was closed without merging/);
  assert.equal(db.readyToShip().length, 0);
});

test("PR links and GitHub's answer about them", async () => {
  assert.deepEqual(prOf("https://github.com/JoeL377/stand/pull/15"), { owner: "JoeL377", repo: "stand", number: 15 });
  assert.deepEqual(prOf("https://github.com/JoeL377/stand/pull/15/files"), { owner: "JoeL377", repo: "stand", number: 15 });
  assert.equal(prOf("https://github.com/JoeL377/stand/issues/15"), null);
  const seen: Array<{ url: string; auth?: string }> = [];
  const answer = (body: unknown, status = 200) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const pr = "https://github.com/JoeL377/stand/pull/15";
  assert.equal(await githubPrState(pr, "tok", answer({ state: "closed", merged: true })), "merged");
  assert.deepEqual(seen[0], { url: "https://api.github.com/repos/JoeL377/stand/pulls/15", auth: "Bearer tok" });
  assert.equal(await githubPrState(pr, undefined, answer({ state: "closed", merged: false })), "closed");
  assert.equal(seen[1].auth, undefined);
  assert.equal(await githubPrState(pr, undefined, answer({ state: "open", merged: false })), "open");
  assert.equal(await githubPrState(pr, undefined, answer({ message: "Not Found" }, 404)), null);
});
