import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UPLOAD_LINK_MAX, UPLOAD_LINK_MS, UploadLinks, WORKING_QUIET_MS, prOf, readyToShip, workLog, workingOn } from "./workLog.ts";
import { ShipWatch, githubPrState, type PrState } from "./shipWatch.ts";
import { agentApi, AgentError, parseRef } from "./agents.ts";
import { finishBrainstorm, startBrainstorm } from "./brainstorm.ts";
import { CHAT_QUIET_MS, Chat } from "./chat.ts";
import { openDb } from "./db.ts";
import { parseActor } from "../shared/actors.ts";
import { addUpNext } from "./upNext.ts";
import { upNextView } from "./upNextPolish.ts";

function setup(deps: { readyToShip?: () => void; liveMeeting?: (roomId: string) => { meeting_id: string; people: string[] } | null } = {}) {
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
  const notes = db.syncNotes(m.id, item.id, [
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

test("writes keep who did them: the person, their agent, its connection and the model it reported", () => {
  const { api, db, joe, room, action } = setup();
  const token = { id: "tok1", label: "Claude Code", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  const agent = { user: joe, token, model: "claude-opus-5-5" };
  const expected = { kind: "agent", person: "Joe Liang", personId: joe.id, agent: "Claude Code", connection: "tok1", model: "claude-opus-5-5" };

  const made = api.createAction(agent, { space: room.id, text: "Write the docs" });
  const added = db.getNote(made.created.ref.split("/")[1]);
  assert.deepEqual(added?.addedActor, expected);

  api.completeAction(agent, { ref: `stand:action/${action.id}`, note: "Done" });
  assert.deepEqual(db.getNote(action.id)?.doneActor, expected);
  assert.deepEqual(db.noteUpdates(action.id)[0].actor, expected);

  db.setActionDone(room.id, action.id, null);
  assert.equal(db.getNote(action.id)?.doneActor, null);
});

test("every way a to-do closes says what kind of actor closed it", () => {
  const { api, db, joe, room, notes } = setup();
  const [, first, second] = notes;
  const token = { id: "tok1", label: "Codex", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  const kindOf = (id: string) => db.getNote(id)?.doneActor?.kind ?? null;

  api.updateAction({ user: joe, token }, { ref: `stand:action/${first.id}`, status: "dropped", reason: "Not needed" });
  assert.equal(kindOf(first.id), "agent");
  db.setTaskState(room.id, first.id, { state: "open", by: joe.name });
  assert.equal(kindOf(first.id), null, "reopening clears it");
  db.setTaskState(room.id, first.id, { state: "done", by: joe.name });
  assert.equal(kindOf(first.id), "person", "a later close by hand replaces the agent");
  db.setActionDone(room.id, second.id, "JoeL377 via GitHub", "pr:https://github.com/a/b/pull/2");
  assert.equal(kindOf(second.id), "github");
  db.setActionDone(room.id, second.id, "carry-over to “Next”", "moved");
  assert.equal(kindOf(second.id), "stand");
});

test("a redraft of the notes and an undone removal keep who closed a to-do", () => {
  const { api, db, joe, item, action } = setup();
  const token = { id: "tok1", label: "Codex", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  api.completeAction({ user: joe, token, model: "gpt-5" }, { ref: `stand:action/${action.id}` });
  const [redrafted] = db.syncNotes(action.meetingId, item.id, [{ kind: "action", text: action.text, owner: "Joe" }]);
  assert.equal(redrafted.doneActor?.connection, "tok1");
  const kept = db.getNote(redrafted.id)!;
  db.removeNote(kept.id);
  db.restoreNote(kept);
  assert.equal(db.getNote(kept.id)?.doneActor?.model, "gpt-5");
});

test("a database from before actors opens, and its rows read their actor from the strings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stand-actors-"));
  const file = path.join(dir, "old.db");
  const first = openDb(file);
  const joe = first.upsertUser({ googleSub: "g", email: "j@example.com", name: "Joe Liang", picture: null });
  const room = first.createRoom("Old", joe.id, "");
  const note = first.addTask(room.id, { text: "Old to-do", owner: null, itemId: null }, "Joe Liang via Claude");
  first.setActionDone(room.id, note.id, "Joe Liang via Claude", "agent");
  first.addUpdate({ roomId: room.id, itemId: null, noteId: note.id, noteText: note.text, userId: joe.id, userName: joe.name, client: "Claude", status: "done", text: "Done", links: [] });
  first.raw.exec("ALTER TABLE notes DROP COLUMN done_actor_json; ALTER TABLE notes DROP COLUMN added_actor_json; ALTER TABLE updates DROP COLUMN actor_json;");
  first.raw.close();
  const db = openDb(file);
  assert.deepEqual(db.getNote(note.id)?.doneActor, { kind: "agent", person: "Joe Liang", agent: "Claude" });
  assert.equal(db.noteUpdates(note.id)[0].actor?.kind, "agent");
  db.raw.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("anyone in a space can confirm a replacement, and agents see whether a decision stands", () => {
  const { api, db, joe, andy, room, item, notes, action } = setup();
  db.touchMembership(room.id, andy.id);
  const old = notes[0];
  const m = db.startMeeting(room.id);
  const [later] = db.syncNotes(m.id, item.id, [{ kind: "decision", text: "Drop LiveKit", owner: null }]);
  db.endMeeting(m.id, null);
  const token = { id: "tok1", label: "Codex", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  const ref = `stand:decision/${old.id}`;
  const by = `stand:decision/${later.id}`;

  assert.equal((api.get({ user: joe, token: null }, ref, "") as { state?: string }).state, "kept");
  assert.throws(() => api.confirmReplaced({ user: joe, token: null }, { ref, by: `stand:action/${action.id}`, replaced: true }), /two decisions/);
  assert.throws(() => api.confirmReplaced({ user: joe, token: null }, { ref, by: ref, replaced: true }), /itself/);
  assert.throws(() => api.confirmReplaced({ user: joe, token: { ...token, scope: "read" } }, { ref, by, replaced: true }));

  assert.equal(api.confirmReplaced({ user: andy, token }, { ref, by, replaced: true }).state, "replaced");
  const seen = api.whatsNew({ user: joe, token: null }, { space: room.id, since: "2020-01-01" }).decided.find((d) => d.text === old.text);
  assert.equal(seen?.state, "replaced");
  assert.equal(seen?.replaced_by?.text, "Drop LiveKit");
  const link = db.raw.prepare("SELECT made_by, made_actor_json FROM links WHERE relation = 'replaces'").get() as { made_by: string; made_actor_json: string };
  assert.equal(link.made_by, "Andy Li via Codex");
  assert.equal(JSON.parse(link.made_actor_json).connection, "tok1");
});

test("a decision says why, from its discussion and quote, for agents catching up", () => {
  const { api, joe, room, notes } = setup();
  const decision = notes[0];
  const caller = { user: joe, token: null };
  const line = api.whatsNew(caller, { space: room.id, since: "2020-01-01" }).decided.find((d) => d.text === decision.text);
  assert.equal(line?.why?.topic, "Where transcription runs");
  assert.deepEqual(line?.why?.positions, ["Andy: Move it to the server"]);
  assert.equal((api.get(caller, `stand:decision/${decision.id}`, "") as { why?: { topic?: string } }).why?.topic, "Where transcription runs");
});

test("an agent takes a conflict check, and what it finds stays a proposal until someone confirms", () => {
  const { api, db, joe, andy, room, item, notes } = setup();
  db.touchMembership(room.id, andy.id);
  const old = notes[0];
  const m = db.startMeeting(room.id);
  db.raw.prepare("UPDATE meetings SET started_at = started_at + 1000 WHERE id = ?").run(m.id);
  const [later] = db.syncNotes(m.id, item.id, [{ kind: "decision", text: "Drop LiveKit", owner: null }]);
  db.endMeeting(m.id, null);
  const token = { id: "tok1", label: "Codex", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  const agent = { user: joe, token, model: "gpt-5" };

  const job = api.nextCheck(agent, room.id);
  assert.equal(job.new_decision?.text, "Drop LiveKit");
  assert.deepEqual(job.earlier_decisions?.map((d) => d.text), [old.text]);
  assert.ok(job.instructions?.includes("replaces"));
  assert.equal(api.nextCheck({ user: andy, token }, room.id).waiting, 0, "a held check isn't handed out twice");

  const ref = `stand:decision/${later.id}`;
  const done = api.submitCheck(agent, {
    ref,
    findings: [
      { ref: `stand:decision/${old.id}`, relation: "replaces", confidence: 0.9, why: "Reverses it" },
      { ref: "stand:decision/madeupid", relation: "replaces", confidence: 1 },
    ],
  });
  assert.deepEqual([done.kept, done.dropped, done.shown_as_proposals], [1, 1, 1], "an id it wasn't given is dropped");

  const seen = api.get({ user: joe, token: null }, `stand:decision/${old.id}`, "") as { state?: string; may_be_replaced_by?: { text: string } };
  assert.equal(seen.state, "kept");
  assert.equal(seen.may_be_replaced_by?.text, "Drop LiveKit");
  assert.equal(api.nextCheck(agent, room.id).waiting, 0, "a finished check stays finished");
  assert.equal(api.submitCheck(agent, { ref, findings: [] }).already_checked, true);
});

test("a check's low-confidence findings stay on record and don't show", () => {
  const { api, db, joe, room, item, notes } = setup();
  const m = db.startMeeting(room.id);
  db.raw.prepare("UPDATE meetings SET started_at = started_at + 1000 WHERE id = ?").run(m.id);
  const [later] = db.syncNotes(m.id, item.id, [{ kind: "decision", text: "Keep LiveKit for now", owner: null }]);
  db.endMeeting(m.id, null);
  const token = { id: "tok1", label: "Codex", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  const out = api.submitCheck({ user: joe, token }, {
    ref: `stand:decision/${later.id}`,
    findings: [{ ref: `stand:decision/${notes[0].id}`, relation: "replaces", confidence: 0.3 }],
  });
  assert.deepEqual([out.kept, out.shown_as_proposals], [1, 0]);
  assert.equal((api.get({ user: joe, token: null }, `stand:decision/${notes[0].id}`, "") as { may_be_replaced_by?: unknown }).may_be_replaced_by, undefined);
});

test("a to-do closed by its PR merging keeps the agent that reported it ready", async () => {
  const { api, db, joe, room, action } = setup();
  const token = { id: "tok1", label: "Claude Code", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null };
  api.postUpdate({ user: joe, token, model: "gpt-5" }, { ref: `stand:action/${action.id}`, status: "ready", text: "Ready", links: ["https://github.com/a/b/pull/1"] });
  await new ShipWatch(db, () => {}, async () => "merged").check();
  const done = db.getNote(action.id);
  assert.ok(done?.doneAt);
  assert.equal(done?.doneActor?.connection, "tok1");
  assert.equal(done?.doneActor?.model, "gpt-5");
  assert.equal(room.id, done?.roomId);
});

test("a person's own write and an older row read as what they were", () => {
  const { api, db, joe, room, action } = setup();
  api.updateAction({ user: joe, token: null }, { ref: `stand:action/${action.id}`, status: "done" });
  assert.deepEqual(db.getNote(action.id)?.doneActor, { kind: "person", person: "Joe Liang", personId: joe.id });
  db.setActionDone(room.id, action.id, "Joe Liang via Claude", "agent");
  assert.deepEqual(db.getNote(action.id)?.doneActor, { kind: "agent", person: "Joe Liang", agent: "Claude" });
  assert.deepEqual(parseActor("Joe Liang via GitHub"), { kind: "github", person: "Joe Liang" });
  assert.deepEqual(parseActor("carry-over to “Conxt”"), { kind: "stand", person: null });
});

test("list_spaces says which spaces have a meeting running", () => {
  const meeting = { meeting_id: "m1", people: ["Joe Liang", "Andy Li"] };
  const on = setup({ liveMeeting: () => meeting });
  assert.deepEqual(on.api.listSpaces({ user: on.joe } as never)[0].live, meeting);
  const off = setup({ liveMeeting: () => null });
  assert.equal(off.api.listSpaces({ user: off.joe } as never)[0].live, null);
  const unwired = setup();
  assert.equal(unwired.api.listSpaces({ user: unwired.joe } as never)[0].live, null);
});

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
  const [q1] = db.syncNotes(m.id, item.id, [{ kind: "question", text: "Monthly too?", owner: null }]);
  const [t2] = db.replaceDiscussions(m.id, item.id, [
    { topic: "pricing ", positions: [], outcome: "decided", segmentIds: [], continuesId: null },
  ]);
  const [q2] = db.syncNotes(m.id, item.id, [{ kind: "question", text: "Monthly too?", owner: null }]);
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
  const [loose] = db.syncNotes(m.id, null, [{ kind: "action", text: "Book the offsite", owner: null, discussionId: null }]);
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

test("add_context keeps what's true in a space, and a later line replaces an older one", () => {
  const { db, api, joe, room, notified } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const meetingsBefore = db.listMeetings(room.id).length;
  const first = api.addContext(caller, { space: "checkout", text: "  Checkout runs on   Stripe " }, "http://stand.test");
  assert.equal(first.created.text, "Checkout runs on Stripe");
  assert.match(first.created.ref, /^stand:context\//);
  assert.equal(first.created.by, "Joe Liang via Claude Code");
  assert.deepEqual(parseRef(first.created.ref)?.kind, "context");
  assert.equal((api.get(caller, first.created.ref, "") as { kind: string }).kind, "context");
  assert.ok(notified.includes(`${room.id}:followups`));

  const second = api.addContext(caller, { space: room.id, text: "Checkout runs on Adyen", replaces: first.created.ref });
  assert.equal(second.replaced?.text, "Checkout runs on Stripe");
  assert.deepEqual(
    api.listContext(caller, room.id).context.map((c) => c.text),
    ["Checkout runs on Adyen"],
  );
  assert.deepEqual(
    db.spaceContext(room.id).map((n) => n.text),
    ["Checkout runs on Adyen"],
  );
  assert.equal(db.listMeetings(room.id).length, meetingsBefore, "context adds no meeting to the space's list");
});

test("add_context needs a write token, and only replaces context from the same space", () => {
  const { db, api, joe, room, action } = setup();
  const write = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  const read = { user: joe, token: db.createToken(joe.id, "Reader", "read").info };
  assert.throws(() => api.addContext(read, { space: room.id, text: "Stripe" }), AgentError);
  assert.throws(() => api.addContext(write, { space: room.id, text: "  " }), AgentError);
  assert.throws(() => api.addContext(write, { space: room.id, text: "Stripe", replaces: `stand:action/${action.id}` }), AgentError);

  const other = db.createRoom("Billing", joe.id, "");
  db.touchMembership(other.id, joe.id);
  const elsewhere = api.addContext(write, { space: other.id, text: "Invoices are monthly" });
  assert.throws(() => api.addContext(write, { space: room.id, text: "Stripe", replaces: elsewhere.created.ref }), AgentError);
  assert.equal(api.listContext(write, room.id).count, 0);
});

test("whats_new says what changed in a space since a date, in one call", () => {
  const { db, api, joe, room, action } = setup();
  const caller = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  api.addContext(caller, { space: room.id, text: "Checkout runs on Stripe" });
  db.setActionDone(room.id, action.id, "Joe Liang", "confirmed");

  const week = api.whatsNew(caller, { space: "checkout" });
  assert.deepEqual(
    week.decided.map((d) => d.text),
    ["Keep LiveKit; drop the browser fallback"],
  );
  assert.deepEqual(
    week.open_questions.map((q) => q.text),
    ["Do we need it on mobile first?"],
  );
  assert.deepEqual(
    week.context.map((c) => c.text),
    ["Checkout runs on Stripe"],
  );
  assert.deepEqual(
    week.new_to_dos.map((t) => t.text),
    ["Write the migration note"],
  );
  assert.deepEqual(
    week.closed_to_dos.map((t) => [t.text, t.closed_by]),
    [["Move transcript capture to the server", "confirmed"]],
  );

  const later = api.whatsNew(caller, { space: room.id, since: "2999-01-01" });
  assert.equal(later.decided.length + later.closed_to_dos.length + later.context.length + later.new_to_dos.length, 0);
  assert.throws(() => api.whatsNew(caller, { space: room.id, since: "last week" }), AgentError);
});

test("agents see who's on what: every read says when another agent is on a to-do or it waits to ship", () => {
  const { api, db, joe, andy, room, item, action } = setup();
  db.touchMembership(room.id, andy.id);
  const token = (user: typeof joe, label: string) => ({
    user,
    token: { id: `t-${label}`, label, scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null },
  });
  const ref = `stand:action/${action.id}`;
  const before = api.listActions(token(andy, "Codex"), { space: room.id }, "").actions.find((a) => a.ref === ref)!;
  assert.equal(before.status, "open");
  assert.equal(before.working, undefined);

  api.postUpdate(token(joe, "Claude Code"), { ref, status: "working", text: "Moving capture" });

  const row = api.listActions(token(andy, "Codex"), { space: room.id }, "").actions.find((a) => a.ref === ref)!;
  assert.equal(row.status, "doing", "the status says so, not just the log");
  assert.equal(row.working?.by, "Joe Liang via Claude Code");
  assert.equal(row.working?.doing, "Moving capture");
  const got = api.get(token(andy, "Codex"), ref, "") as { status?: string; working?: { by: string } };
  assert.equal(got.status, "doing");
  assert.equal(got.working?.by, "Joe Liang via Claude Code");
  const onItem = api.itemContext(token(andy, "Codex"), item.id, "").open_todos.find((a) => a.ref === ref)!;
  assert.equal(onItem.working?.by, "Joe Liang via Claude Code");
  const news = api.whatsNew(token(andy, "Codex"), { space: room.id }, "");
  assert.deepEqual(news.being_worked_on.map((a) => a.ref), [ref]);

  api.postUpdate(token(joe, "Claude Code"), { ref, status: "ready", text: "PR is up", links: ["https://github.com/acme/stand/pull/9"] });

  const ready = api.whatsNew(token(andy, "Codex"), { space: room.id }, "").being_worked_on[0];
  assert.equal(ready.status, "open", "ready isn't being worked on, but it's spoken for");
  assert.equal(ready.working, undefined);
  assert.equal(ready.ready?.pr, "https://github.com/acme/stand/pull/9");
});

test("a plan lives on the to-do: it keeps versions, and attaching one doesn't change who's on it", () => {
  const { api, db, joe, room, action, notes } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const ref = `stand:action/${action.id}`;
  type Got = { status?: string; working?: { by: string }; plan?: { text: string; by: string; versions: number; actor?: { model?: string } } };

  assert.equal((api.get(caller, ref, "") as Got).plan, undefined);
  api.attachPlan({ ...caller, model: "claude-opus-5-5" }, { ref, plan: "# Move capture\n\n1. Worker\n2. Remove the old path" });
  assert.equal(workingOn(db.notesUpdates([action.id]), false), null, "a plan alone doesn't mean anyone started");
  assert.equal(db.notesUpdates([action.id])[0].text, "Move capture", "the log gets the title, not the whole plan");
  assert.equal(api.listActions(caller, { space: room.id }, "").actions.find((a) => a.ref === ref)?.has_plan, true);

  api.postUpdate(caller, { ref, status: "working" });
  api.attachPlan(caller, { ref, plan: "Changed: keep the old path a week" });
  const got = api.get(caller, ref, "") as Got;
  assert.equal(got.working?.by, "Joe Liang via Claude Code", "attaching while working keeps the spinner");
  assert.equal(got.plan?.text, "Changed: keep the old path a week");
  assert.equal(got.plan?.versions, 2);
  assert.equal(got.plan?.by, "Joe Liang via Claude Code");

  assert.throws(() => api.attachPlan(caller, { ref, plan: "  " }), /empty/);
  assert.throws(() => api.attachPlan(caller, { ref, plan: "x".repeat(100_001) }), /100000/);
  const decision = notes.find((n) => n.kind === "decision")!;
  assert.throws(() => api.attachPlan(caller, { ref: `stand:decision/${decision.id}`, plan: "x" }), /to-dos/);
  assert.throws(() => api.attachPlan({ user: joe, token: { ...info, scope: "read" } }, { ref, plan: "x" }), /read only/);
});

test("to-dos can depend on each other: both sides see it, it never stops anyone, and it can't loop", () => {
  const { api, db, joe, room, action, notes } = setup();
  const { info } = db.createToken(joe.id, "Claude Code", "write");
  const caller = { user: joe, token: info };
  const first = `stand:action/${action.id}`;
  const second = `stand:action/${notes.find((n) => n.text.startsWith("Write"))!.id}`;
  type Dep = { ref: string; status: string; working?: { by: string } };
  type Got = { waits_on?: Dep[]; waiting_on_this?: Dep[]; status?: string };
  const row = (ref: string) => api.listActions(caller, { space: room.id }, "").actions.find((a) => a.ref === ref)!;

  api.postUpdate(caller, { ref: second, status: "working" });
  api.linkTodos(caller, { ref: second, dependsOn: first });
  assert.equal((api.get(caller, second, "") as Got).status, "doing", "linking doesn't stop the work");
  assert.deepEqual((api.get(caller, second, "") as Got).waits_on?.map((d) => d.ref), [first]);
  assert.deepEqual((api.get(caller, first, "") as Got).waiting_on_this?.map((d) => d.ref), [second]);
  assert.equal((api.get(caller, first, "") as Got).waiting_on_this?.[0].working?.by, "Joe Liang via Claude Code");
  assert.deepEqual(row(second).waits_on, [first]);
  assert.equal(db.notesUpdates([action.id]).length, 0, "the log entry goes on the to-do that waits");

  assert.equal((api.linkTodos(caller, { ref: second, dependsOn: first }) as { unchanged?: boolean }).unchanged, true);
  assert.throws(() => api.linkTodos(caller, { ref: first, dependsOn: first }), /itself/);
  assert.throws(() => api.linkTodos(caller, { ref: first, dependsOn: second }), /each other/);

  api.postUpdate(caller, { ref: first, status: "working" });
  assert.equal(row(first).status, "doing", "a to-do that waits on nothing and one that others wait on both start freely");
  api.completeAction(caller, { ref: first, note: "Done" });
  assert.equal(row(second).waits_on, undefined, "what's finished stops showing on list rows");
  assert.equal((api.get(caller, second, "") as Got).waits_on?.[0].status, "done", "get still shows it, as done");

  api.linkTodos(caller, { ref: second, dependsOn: first, remove: true });
  assert.equal((api.get(caller, second, "") as Got).waits_on, undefined);
  assert.equal((api.linkTodos(caller, { ref: second, dependsOn: first, remove: true }) as { unchanged?: boolean }).unchanged, true);
});

test("start_work: one call marks the to-do and gives back all an agent needs, with heads-ups that stop nothing", () => {
  const { api, db, joe, andy, room, action, notes } = setup();
  db.touchMembership(room.id, andy.id);
  const mine = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  const theirs = { user: andy, token: db.createToken(andy.id, "Codex", "write").info };
  const first = `stand:action/${action.id}`;
  const second = `stand:action/${notes.find((n) => n.text.startsWith("Write"))!.id}`;
  api.attachPlan(mine, { ref: first, plan: "# Move it" });
  api.linkTodos(mine, { ref: first, dependsOn: second });

  const started = api.startWork({ ...mine, model: "claude-opus-5-5" }, { ref: first, note: "Adding the worker" }) as Record<string, any>;
  assert.equal(started.started, true);
  assert.equal(started.status, "doing");
  assert.equal(started.working.doing, "Adding the worker");
  assert.equal(started.plan.text, "# Move it");
  assert.equal(started.topic.topic, "Where transcription runs");
  assert.deepEqual(started.decided_with_it, ["Keep LiveKit; drop the browser fallback"]);
  assert.deepEqual(started.waits_on.map((d: { ref: string }) => d.ref), [second]);
  assert.match(started.heads_up[0], /waits on "Write the migration note"/);
  assert.equal(db.notesUpdates([action.id]).at(-1)?.actor?.model, "claude-opus-5-5");

  const again = api.startWork(mine, { ref: first }) as Record<string, any>;
  assert.equal(again.heads_up.length, 1, "you aren't warned about yourself");

  const other = api.startWork(theirs, { ref: first }) as Record<string, any>;
  assert.equal(other.started, true, "someone else being on it is a heads-up, not a stop");
  assert.match(other.heads_up[0], /Joe Liang via Claude Code is already on this/);

  const elsewhere = api.startWork(mine, { ref: second }) as Record<string, any>;
  assert.deepEqual(elsewhere.also_being_worked_on.map((d: { ref: string }) => d.ref), [first]);
  assert.match(elsewhere.heads_up[0], /waits on this/);

  api.completeAction(mine, { ref: first, note: "Done" });
  const late = api.startWork(mine, { ref: first }) as Record<string, any>;
  assert.equal(late.started, false);
  assert.match(late.heads_up[0], /already done/);
  assert.throws(() => api.startWork({ user: joe, token: { ...mine.token, scope: "read" } }, { ref: second }), /read only/);
  assert.throws(() => api.startWork(mine, { ref: `stand:decision/${notes[0].id}` }), /to-do/);
});

test("agent reads stay light: one line per to-do in whats_new, and a brief leaves out what list_actions has", () => {
  const { db, room, action, notes, joe } = setup();
  const api = agentApi({
    db,
    notify: () => {},
    brief: (id) => ({ meeting: id, carriedOver: [{ id: "a" }, { id: "b" }], items: [] }),
    suggested: (r) => upNextView(db, r, null),
    uploads: new UploadLinks(),
  });
  const caller = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  const first = `stand:action/${action.id}`;
  const second = `stand:action/${notes.find((n) => n.text.startsWith("Write"))!.id}`;
  api.postUpdate(caller, { ref: first, status: "working" });
  api.postUpdate(caller, { ref: first, text: "Halfway" });
  api.postUpdate(caller, { ref: first, text: "Nearly there" });
  api.postUpdate(caller, { ref: second, status: "working" });
  api.completeAction(caller, { ref: second, note: "Wrote the note" });

  const news = api.whatsNew(caller, { space: room.id }, "");
  assert.equal(news.updates.length, 1, "a closed to-do is told once, under closed_to_dos");
  const line = news.updates[0] as { ref: string; text: string; reports?: number };
  assert.equal(line.ref, first);
  assert.equal(line.text, "Nearly there");
  assert.equal(line.reports, 3);
  assert.equal(news.closed_to_dos.find((a) => a.ref === second)?.summary, "Wrote the note");
  assert.equal(api.whatsNew(caller, { space: room.id, allUpdates: true }, "").updates.length, 5);

  const m = notes[0].meetingId;
  const brief = api.meetingBrief(caller, { meetingId: m }, "") as Record<string, unknown>;
  assert.equal(brief.carriedOver, undefined);
  assert.equal(brief.carried_over_count, 2);
  const full = api.meetingBrief(caller, { meetingId: m, carriedOver: true }, "") as Record<string, unknown>;
  assert.equal((full.carriedOver as unknown[]).length, 2);
});

test("an agent comments on a passage of a plan by quoting it, and the to-do's log says so", () => {
  const { api, db, joe, action } = setup();
  const caller = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  const ref = `stand:action/${action.id}`;
  assert.throws(() => api.updatePlanReview(caller, { ref, action: "create", quote: "Run it", text: "Why?" }), /no plan/);
  api.attachPlan(caller, { ref, plan: "# Capture\n\nRun it on the server.\n\n- Keep the browser path\n- Keep the browser fallback for a week" });

  assert.throws(() => api.updatePlanReview(caller, { ref, action: "create", quote: "Run it in the cloud", text: "Why?" }), /isn't in the latest plan/);
  assert.throws(() => api.updatePlanReview(caller, { ref, action: "create", quote: "Keep the browser", text: "Why?" }), /more than once/);
  assert.throws(() => api.updatePlanReview(caller, { ref, action: "create", quote: "Run it", text: " " }), /Say what/);

  const thread = api.updatePlanReview(caller, { ref, action: "create", quote: "fallback for a week", text: "Is a week enough for the mobile clients?" });
  assert.equal(thread.original.quote, "- Keep the browser fallback for a week");
  assert.equal(thread.messages[0].by, "Joe Liang via Claude Code");
  const got = api.get(caller, ref, "") as { plan_review_threads?: Array<{ id: string }> };
  assert.deepEqual(got.plan_review_threads?.map((t) => t.id), [thread.id]);

  api.updatePlanReview(caller, { ref, thread: thread.id, action: "resolve" });
  const log = db.noteUpdates(action.id).filter((u) => u.status === "comment").map((u) => u.text);
  assert.equal(log.length, 2);
  assert.ok(log.includes('Commented on the plan, at "Keep the browser fallback for a week": Is a week enough for the mobile clients?'));
  assert.ok(log.includes('Resolved a comment on the plan: "Is a week enough for the mobile clients?"'));
});

test("an agent asks for a design review of its plan, with the questions the team has to decide", () => {
  const { api, db, joe, room, action, notified } = setup();
  const caller = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  const ref = `stand:action/${action.id}`;
  assert.throws(() => api.requestDesignReview(caller, { ref }), /no plan yet/);
  assert.throws(() => api.requestDesignReview({ ...caller, token: { ...caller.token, scope: "read" } }, { ref }), AgentError);
  api.attachPlan(caller, { ref, plan: "# Capture\n\n## Where it runs\n\nRun it on the server.\n\n## Fallback\n\nKeep the browser fallback for a week." });

  assert.throws(() => api.requestDesignReview(caller, { ref, questions: [{ quote: "Run it in the cloud", question: "Why?" }] }), /isn't in the latest plan/);
  const out = api.requestDesignReview(caller, { ref, questions: [{ quote: "fallback for a week", question: "Is a week enough?" }] }, "https://stand.test") as Record<string, unknown>;
  assert.equal(out.requested, ref);
  assert.equal(out.questions_added, 1);
  assert.equal(out.questions_open, 1);
  assert.equal(out.review_url, `https://stand.test/s/${room.id}/design-review`);
  assert.ok(notified.includes(`${room.id}:updates`));
  assert.equal((api.requestDesignReview(caller, { ref }) as Record<string, unknown>).already_requested, ref);
  assert.match((api.get(caller, ref, "") as { design_review?: string }).design_review ?? "", /next design review/);
  const thread = db.planThreads(action.id)[0];
  assert.equal(thread.messages[0].by, "Joe Liang via Claude Code");
  const requested = db.noteUpdates(action.id).find((u) => u.text.startsWith("Review requested"))!;
  assert.equal(requested.status, "comment");
  assert.equal(requested.actor?.kind, "agent");

  // get_review tells an agent what waits on the next design review.
  const review = api.getReview(caller, { space: room.id }, "https://stand.test") as { design_review: { next: { status: string; specs: Array<{ shows: string; section_slides: number; questions: Array<{ question: string }> }> } | null; last: unknown } };
  assert.equal(review.design_review.next?.status, "not started");
  assert.deepEqual(review.design_review.next?.specs.map((s) => [s.shows, s.section_slides, s.questions.map((p) => p.question)]), [[ref, 2, ["Is a week enough?"]]]);
  assert.equal(review.design_review.last, null);

  // A new version of the plan: the review is of that one.
  api.attachPlan(caller, { ref, plan: "# Capture\n\n## Fallback\n\nKeep the browser fallback for a week." });
  const draft = db.reviewIn(room.id, ["draft"], "design")!;
  assert.equal(db.reviewSlides(draft.id)[0].planVersion, db.planVersions(action.id).at(-1)!.id);
  assert.equal(db.reviewIn(room.id, ["draft"]), null);
});

test("get_brainstorm gives an agent the map as an outline, with what was caught on each circle", () => {
  const { api, db, joe, room, action } = setup();
  const caller = { user: joe, token: db.createToken(joe.id, "Claude Code", "read").info };
  type Circle = { label: string; by?: string; said?: string; built_on?: Array<{ text: string }>; todos?: Array<{ ref: string; text: string; owner?: string; done: boolean }>; ideas?: Circle[] };
  type Out = { brainstorm: { id: string; url: string; topic: string; status: string; meeting?: string; counts: Record<string, number>; directions: Circle[] } | null; others: Array<{ id: string; topic: string; ideas: number }> };
  const read = (brainstorm?: string) => api.getBrainstorm(caller, { space: room.id, brainstorm }, "https://stand.test") as Out;
  assert.equal(read().brainstorm, null);

  const first = startBrainstorm(db, room.id, "Pricing", "Joe Liang", 1000);
  db.saveBrainstormMap(first.id, [{ id: "d1", parent: null, label: "Plans", detail: null, by: "Joe", ts: 1000, quote: null, points: [], caught: [] }]);
  const b = startBrainstorm(db, room.id, "Where should capture run?", "Joe Liang", 2000);
  db.saveBrainstormMap(b.id, [
    { id: "d1", parent: null, label: "On the server", detail: "One place to fix", by: "Joe", ts: 2000, quote: { segmentId: "s1", ts: 2000, speaker: "Joe Liang", text: "Let's run it on the server." }, points: [], caught: [] },
    { id: "i1", parent: "d1", label: "Move capture", detail: null, by: "Andy", ts: 2001, quote: null, points: [{ text: "Keep a fallback", by: "Joe", ts: 2002, quote: null }], caught: [{ id: action.id, kind: "action", text: "An older wording", owner: null, done: false }] },
    { id: "i2", parent: "d1", label: "Taken off", detail: null, by: null, ts: 2003, quote: null, points: [], caught: [], removed: true },
    { id: "d2", parent: null, label: "In the browser", detail: null, by: null, ts: 2004, quote: null, points: [], caught: [] },
  ]);
  // While it runs it is the one returned, and the earlier one is listed.
  assert.equal(read().brainstorm?.status, "in a call now");
  finishBrainstorm(db, room.id, action.meetingId, 3000);

  const out = read();
  const got = out.brainstorm!;
  assert.deepEqual([got.topic, got.status, got.meeting, got.url], ["Where should capture run?", "finished", action.meetingId, `https://stand.test/s/${room.id}/brainstorm/${b.id}`]);
  assert.deepEqual(got.counts, { directions: 2, ideas: 1, todos: 1, decisions: 0, questions: 0 });
  assert.deepEqual(got.directions.map((d) => [d.label, d.ideas?.map((i) => i.label)]), [["On the server", ["Move capture"]], ["In the browser", []]]);
  assert.equal(got.directions[0].said, "Joe Liang: Let's run it on the server.");
  const idea = got.directions[0].ideas![0];
  assert.deepEqual(idea.built_on, [{ text: "Keep a fallback", by: "Joe" }]);
  // The to-do reads as it does now, not as it did when the map was saved.
  assert.deepEqual(idea.todos, [{ ref: `stand:action/${action.id}`, text: action.text, owner: action.owner ?? undefined, done: false }]);
  assert.deepEqual(out.others.map((o) => [o.id, o.topic]), [[first.id, "Pricing"]]);

  // An earlier one by its id or its link; not another space's, and not one that isn't there.
  assert.equal(read(first.id).brainstorm?.topic, "Pricing");
  assert.equal(read(`https://stand.test/s/${room.id}/brainstorm/${first.id}`).brainstorm?.id, first.id);
  assert.throws(() => read("nope"), AgentError);
  const stranger = db.upsertUser({ googleSub: "g-x", email: "x@example.com", name: "X", picture: null });
  assert.throws(() => api.getBrainstorm({ user: stranger, token: db.createToken(stranger.id, "Claude Code", "read").info }, { space: room.id }, ""), AgentError);
});

test("start_design_session sets up a session with its context, and the same topic adds to it", () => {
  const { api, db, joe, room, action } = setup();
  const write = { user: joe, token: db.createToken(joe.id, "Claude Code", "write").info };
  type Made = { created?: { id: string; url: string; context: string[]; parts: number; relations: number; spec_on?: string }; updated?: { id: string; context: string[]; spec_on?: string }; shows_on: string };
  const start = (args: Parameters<typeof api.startDesignSession>[1]) => api.startDesignSession(write, args, "https://stand.test") as Made;

  const made = start({
    space: room.id,
    topic: "Stand's primitives",
    diagram: "Task: a to-do with an owner\nProject: a group of tasks\nTask -> Project: belongs to",
    context: [{ title: "Projects spec", text: "# Projects\n\nOne layer above tasks.", url: "https://example.com/spec" }],
  });
  assert.deepEqual([made.created?.parts, made.created?.relations, made.created?.context], [2, 1, ["Projects spec"]]);
  assert.match(made.shows_on, /waits for the team/);
  const b = db.brainstormLive(room.id)!;
  assert.equal(b.kind, "design");
  assert.equal(made.created?.url, `https://stand.test/s/${room.id}/brainstorm/${b.id}`);
  assert.deepEqual(b.context.map((c) => [c.title, c.url, c.by]), [["Projects spec", "https://example.com/spec", "Joe Liang via Claude Code"]]);

  // The same topic again: more context on the same session, a piece with the same title replaced, the to-do set.
  const more = start({ space: room.id, topic: "stand's primitives", ref: `stand:action/${action.id}`, context: [{ title: "projects spec", text: "Rewritten." }, { title: "Review notes", text: "Not too generative." }] });
  assert.equal(more.updated?.id, b.id);
  assert.equal(more.updated?.spec_on, `stand:action/${action.id}`);
  const after = db.getBrainstorm(b.id)!;
  assert.deepEqual(after.context.map((c) => [c.title, c.text]), [["projects spec", "Rewritten."], ["Review notes", "Not too generative."]]);
  assert.equal(db.brainstorms(room.id).length, 1);

  // People see it on the session, and an agent reads it back.
  const read = api.getBrainstorm(write, { space: room.id }, "https://stand.test") as { brainstorm: { design_session: { context: Array<{ title: string }> } } };
  assert.deepEqual(read.brainstorm.design_session.context.map((c) => c.title), ["projects spec", "Review notes"]);

  assert.throws(() => start({ space: room.id, topic: "Other", context: [{ title: "", text: "x" }] }), AgentError);
  assert.throws(() => api.startDesignSession({ user: joe, token: db.createToken(joe.id, "Claude Code", "read").info }, { space: room.id, topic: "Other" }, ""), AgentError);
});

test("agents read a space's chat: where it stands, the stretches since a date, and one stretch with what was written", () => {
  const { db, joe, andy, room } = setup();
  db.touchMembership(room.id, andy.id);
  const api = agentApi({ db, notify: () => {}, brief: (id) => ({ meeting: { id }, carriedOver: [] }), suggested: (r) => upNextView(db, r, null), uploads: new UploadLinks() });
  const caller = { user: joe, token: null };
  const iso = (t: number) => new Date(t).toISOString();

  // A space nobody has written in.
  assert.deepEqual(api.chatStatus(caller, room.id), { space: { id: room.id, name: room.name }, channels: [], live: [], recent: [] });
  assert.deepEqual(api.whatsNew(caller, { space: room.id }).chats, []);
  assert.equal(api.listSpaces(caller)[0].chat, undefined);

  // A stretch three hours ago, closed since, and one going on now.
  const chat = new Chat(db);
  const channel = db.spaceChannel(room.id, joe.id);
  const say = (user: { id: string }, text: string, ts: number) => chat.accept(channel.id, [{ type: "message", author: { userId: user.id }, text, ts }]).messages[0];
  const t0 = Date.now() - 3 * CHAT_QUIET_MS;
  const first = say(joe, "Can we ship the invite flow on Friday?", t0);
  say(andy, "Yes, if the email copy is done.", t0 + 60_000);
  const slip = say(andy, "Wrong window, sorry", t0 + 120_000);
  chat.accept(channel.id, [{ type: "delete", id: slip.id, by: { userId: andy.id }, ts: t0 + 130_000 }]);
  chat.accept(channel.id, [{ type: "edit", id: first.id, by: { userId: joe.id }, text: "Can we ship the invite flow on Monday?", ts: t0 + 140_000 }]);
  assert.equal(chat.sweep(), 1);
  const now = say(andy, "Deploy is out", Date.now() - 60_000);

  const status = api.chatStatus(caller, "checkout");
  assert.deepEqual(status.channels, [{ id: channel.id, name: "Chat", source: "stand", last_message_at: iso(now.ts) }]);
  assert.deepEqual(status.live, [
    { chat_id: now.sessionId, channel: "Chat", from: iso(now.ts), to: iso(now.ts), people: ["Andy Li"], messages: 1, summary: undefined, to_dos: 0, decided: 0, open: 0, live: true },
  ]);
  assert.deepEqual(status.recent, [
    { chat_id: first.sessionId, channel: "Chat", from: iso(t0), to: iso(t0 + 120_000), people: ["Joe Liang", "Andy Li"], messages: 3, summary: undefined, to_dos: 0, decided: 0, open: 0, live: undefined },
  ]);

  // One stretch. The messages come only when asked for, a deleted one never.
  const closed = api.getChat(caller, { chatId: first.sessionId });
  assert.deepEqual([closed.chat_id, closed.space.id, closed.transcript, closed.to_dos, closed.topics], [first.sessionId, room.id, undefined, [], []]);
  assert.deepEqual(api.getChat(caller, { chatId: first.sessionId, transcript: true }).transcript, [
    { by: "Joe Liang", at: iso(t0), text: "Can we ship the invite flow on Monday?", edited: true },
    { by: "Andy Li", at: iso(t0 + 60_000), text: "Yes, if the email copy is done.", edited: undefined },
  ]);

  // What Stand files under a stretch shows on it, like a meeting's notes.
  const [topic] = db.replaceDiscussions(first.sessionId, null, [
    { topic: "When the invite flow ships", positions: [{ speaker: "Joe Liang", position: "Monday" }], outcome: "action", segmentIds: [first.id], continuesId: null },
  ]);
  db.syncNotes(first.sessionId, null, [
    { kind: "action", text: "Finish the email copy", owner: "Andy", discussionId: topic.id },
    { kind: "question", text: "Who reviews the copy?", owner: null, discussionId: topic.id },
  ]);
  const filed = api.getChat(caller, { chatId: first.sessionId });
  assert.deepEqual(filed.topics.map((t) => [t.topic, t.outcome]), [["When the invite flow ships", "action"]]);
  assert.deepEqual([filed.to_dos.map((t) => t.text), filed.open_questions.map((q) => q.text), filed.decided], [["Finish the email copy"], ["Who reviews the copy?"], []]);
  assert.deepEqual([api.chatStatus(caller, room.id).recent[0].to_dos, api.chatStatus(caller, room.id).recent[0].open], [1, 1]);

  // whats_new lists the stretches since a date, apart from the meetings.
  const week = api.whatsNew(caller, { space: room.id });
  assert.deepEqual(week.chats.map((c) => [c.chat_id, c.live]), [[now.sessionId, true], [first.sessionId, undefined]]);
  assert.equal(week.meetings.some((m) => m.id === first.sessionId || m.id === now.sessionId), false);
  assert.deepEqual(api.whatsNew(caller, { space: room.id, since: iso(Date.now() - CHAT_QUIET_MS) }).chats.map((c) => c.chat_id), [now.sessionId]);
  assert.deepEqual(api.listSpaces(caller)[0].chat, { last_message_at: iso(now.ts) });

  // The brief of a stretch says it is chat. The latest meeting of the space is still a meeting.
  assert.deepEqual((api.meetingBrief(caller, { meetingId: first.sessionId }, "") as { meeting: object }).meeting, { id: first.sessionId, kind: "chat", channel: "Chat" });
  assert.equal((api.meetingBrief(caller, { spaceId: room.id }, "") as { meeting: { id: string; kind?: string } }).meeting.kind, undefined);

  // Someone who isn't in the space reads none of it.
  const outsider = { user: db.upsertUser({ googleSub: "g-eve", email: "eve@example.com", name: "Eve Adams", picture: null }), token: null };
  assert.throws(() => api.getChat(outsider, { chatId: first.sessionId, transcript: true }), AgentError);
  assert.throws(() => api.chatStatus(outsider, room.id), AgentError);
  assert.throws(() => api.getChat(caller, { chatId: "nope" }), /No chat with that id/);
});
