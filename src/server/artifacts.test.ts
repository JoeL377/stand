import assert from "node:assert/strict";
import { test } from "node:test";
import { filterArtifacts, makersOf } from "../shared/artifacts.ts";
import { spaceActivity } from "./activity.ts";
import { agentApi } from "./agents.ts";
import { artifactDetail, makerOf, parseDocRef, plainPreview, spaceArtifacts } from "./artifacts.ts";
import { openDb } from "./db.ts";
import { upNextView } from "./upNextPolish.ts";
import { UploadLinks } from "./workLog.ts";

function setup() {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const andy = db.upsertUser({ googleSub: "g-andy", email: "andy@example.com", name: "Andy Li", picture: null });
  const room = db.createRoom("Checkout v2", joe.id, "Ship one-page checkout");
  const other = db.createRoom("Elsewhere", andy.id, "");
  db.touchMembership(room.id, joe.id);
  db.touchMembership(room.id, andy.id);
  db.touchMembership(other.id, andy.id);
  const m = db.startMeeting(room.id);
  db.addSegment({ meetingId: m.id, itemId: null, speakerId: joe.id, speakerName: joe.name, kind: "speech", text: "Let's move capture to the server.", ts: Date.now() });
  const notes = db.syncNotes(m.id, null, [
    { kind: "action", text: "Move transcript capture to the server", owner: "Joe", discussionId: null },
    { kind: "action", text: "Write the migration", owner: "Andy", discussionId: null },
    { kind: "decision", text: "Ship the web first", owner: null, discussionId: null },
  ]);
  db.endMeeting(m.id, "Capture moves to the server; the web ships first.");
  const api = agentApi({ db, notify: () => {}, brief: () => ({}), suggested: (r) => upNextView(db, r, null), uploads: new UploadLinks() });
  const token = (label: string) => ({ id: `tok-${label}`, label, scope: "write" as const });
  const claude = { user: joe, token: token("Claude"), model: "claude-test" } as never;
  const codex = { user: andy, token: token("Codex") } as never;
  const project = db.createProject(room.id, { name: "Capture", goal: null }, joe.id);
  db.setNoteProject(room.id, notes[0].id, { projectId: project.id, by: joe.name });
  return { db, api, joe, andy, room, other, m, notes, claude, codex, project };
}

test("a to-do's plan is a spec: named by its heading, with its versions, its project and who wrote it", () => {
  const { db, api, room, notes, claude, project } = setup();
  const ref = `stand:action/${notes[0].id}`;
  api.attachPlan(claude, { ref, plan: "# Server capture\n\nFirst cut." });
  api.attachPlan(claude, { ref, plan: "# Server capture\n\n## Plan\n- Record on the server\n- Drop the browser path" });
  api.postUpdate(claude, { ref, status: "ready", text: "Done.", links: ["https://github.com/acme/app/pull/12"] });
  const spec = spaceArtifacts(db, room.id).artifacts.find((a) => a.kind === "spec")!;
  assert.equal(spec.title, "Server capture");
  assert.equal(spec.badge, "v2");
  assert.deepEqual(spec.projects, [project.id]);
  assert.deepEqual(spec.makers, [{ key: "a:joe liang:claude", name: "Joe’s Claude" }]);
  assert.equal(spec.preview.text, "Plan · Record on the server · Drop the browser path");
  const detail = artifactDetail(db, room.id, spec.id)!;
  assert.equal(detail.versions?.length, 2);
  assert.match(detail.body ?? "", /Drop the browser path/);
  assert.deepEqual(detail.links.map((l) => [l.text, l.note]), [["Move transcript capture to the server", "the to-do it is on"], ["PR #12", "the work so far"]]);
});

test("a meeting with a summary is a recap, filed under the project most of it was about", () => {
  const { db, room, m, project } = setup();
  const recap = spaceArtifacts(db, room.id).artifacts.find((a) => a.kind === "recap")!;
  assert.equal(recap.id, `recap:${m.id}`);
  assert.equal(recap.href, `/meetings/${m.id}`);
  assert.deepEqual(recap.projects, [project.id]);
  assert.deepEqual(recap.preview.counts, { todos: 2, decided: 1, open: 0 });
  assert.equal(artifactDetail(db, room.id, recap.id)?.body, "Capture moves to the server; the web ships first.");
});

test("save_doc keeps a write-up, saves it again as a new version, and shows in Activity", () => {
  const { db, api, room, notes, codex, claude, project } = setup();
  const saved = api.saveDoc(codex, { space: room.id, title: "Capture options", text: "## Options\n\n| A | B |\n| --- | --- |\n| Browser | Server |", ref: `stand:action/${notes[0].id}` }, "https://stand.test") as unknown as { saved: { ref: string; url: string } };
  assert.match(saved.saved.ref, /^stand:doc\/[a-z0-9]+$/);
  const id = parseDocRef(saved.saved.ref)!;
  assert.equal(saved.saved.url, `https://stand.test/s/${room.id}?artifact=${encodeURIComponent(`doc:${id}`)}`);
  let doc = spaceArtifacts(db, room.id).artifacts.find((a) => a.kind === "doc")!;
  // With no project given it follows the to-do it was written for.
  assert.deepEqual(doc.projects, [project.id]);
  assert.equal(doc.preview.text, "Options · A, B · Browser, Server");
  assert.equal(doc.badge, undefined);

  api.saveDoc(claude, { doc: saved.saved.ref, text: "Server it is." });
  doc = spaceArtifacts(db, room.id).artifacts.find((a) => a.kind === "doc")!;
  assert.equal(doc.badge, "v2");
  assert.equal(doc.title, "Capture options");
  // Who made it stays the one who first saved it.
  assert.deepEqual(doc.makers.map((m) => m.name), ["Andy’s Codex"]);
  const detail = artifactDetail(db, room.id, doc.id)!;
  assert.equal(detail.body, "Server it is.");
  assert.equal(detail.links[0].taskId, notes[0].id);

  const page = spaceActivity(db, room.id);
  const names = new Map(page.agents.map((a) => [a.key, a.name]));
  const lines = page.events.filter((e) => e.kind === "doc").map((e) => `${names.get(e.who)} ${e.verb} ${e.target?.text}`);
  assert.deepEqual(lines, ["Joe’s Claude rewrote the doc Capture options", "Andy’s Codex saved the doc Capture options"]);

  assert.throws(() => api.saveDoc(codex, { space: room.id, text: "No title" }), /needs a title/);
  assert.throws(() => api.saveDoc(codex, { space: room.id, title: "Empty", text: "  " }), /empty/);
});

test("a doc can't be read or rewritten from outside its space", () => {
  const { db, api, room, other, joe, andy, codex } = setup();
  const eve = db.upsertUser({ googleSub: "g-eve", email: "eve@example.com", name: "Eve Stone", picture: null });
  db.touchMembership(other.id, eve.id);
  const evesAgent = { user: eve, token: { id: "tok-eve", label: "Cursor", scope: "write" as const } } as never;
  const saved = api.saveDoc(codex, { space: room.id, title: "Private notes", text: "Only for Checkout v2." }) as unknown as { saved: { ref: string } };
  assert.throws(() => api.saveDoc(evesAgent, { doc: saved.saved.ref, text: "Mine now." }), /No doc with that ref/);
  assert.throws(() => api.listArtifacts(evesAgent, { ref: saved.saved.ref }), /Not found/);
  assert.throws(() => api.listArtifacts(evesAgent, { space: room.id }));
  assert.equal(artifactDetail(db, other.id, `doc:${parseDocRef(saved.saved.ref)}`), null);
  void joe;
  void andy;
});

test("screenshots on a to-do are one set of screens, and list_artifacts reads them for an agent", () => {
  const { db, api, room, notes, andy, codex } = setup();
  for (const caption of ["Before", "After"]) db.addWorkShot({ roomId: room.id, noteId: notes[1].id, userId: andy.id, userName: andy.name, client: "Codex", caption, ext: "png" });
  const list = api.listArtifacts(codex, { space: room.id, kind: "screens" }, "https://stand.test") as { count: number; artifacts: Array<{ id: string; title: string; made_by: string; size: string; todo: string }> };
  assert.equal(list.count, 1);
  assert.deepEqual([list.artifacts[0].title, list.artifacts[0].made_by, list.artifacts[0].size, list.artifacts[0].todo], ["Write the migration", "Andy’s Codex", "2", `stand:action/${notes[1].id}`]);
  const one = api.listArtifacts(codex, { space: room.id, ref: list.artifacts[0].id }, "https://stand.test") as { images: Array<{ url: string; caption: string }> };
  assert.deepEqual(one.images.map((i) => i.caption), ["Before", "After"]);
  assert.match(one.images[0].url, /^https:\/\/stand\.test\/api\/work-shots\/[a-z0-9]+\.png$/);
});

test("an archived to-do or meeting takes its artifacts off the list", () => {
  const { db, api, room, m, notes, claude } = setup();
  api.attachPlan(claude, { ref: `stand:action/${notes[0].id}`, plan: "A plan." });
  assert.deepEqual(spaceArtifacts(db, room.id).artifacts.map((a) => a.kind).sort(), ["recap", "spec"]);
  db.putArchived(room.id, { ref: `todo:${notes[0].id}`, title: "x", ts: Date.now(), by: "Joe" });
  db.putArchived(room.id, { ref: `meeting:${m.id}`, title: "x", ts: Date.now(), by: "Joe" });
  assert.deepEqual(spaceArtifacts(db, room.id).artifacts, []);
});

test("filters and makers", () => {
  const { db, api, room, notes, claude, codex, project } = setup();
  api.attachPlan(claude, { ref: `stand:action/${notes[0].id}`, plan: "A plan." });
  api.saveDoc(codex, { space: room.id, title: "Loose notes", text: "Nothing to file." });
  const all = spaceArtifacts(db, room.id).artifacts;
  assert.deepEqual(filterArtifacts(all, { kind: "doc" }).map((a) => a.title), ["Loose notes"]);
  assert.deepEqual(filterArtifacts(all, { project: "none" }).map((a) => a.kind), ["doc"]);
  assert.deepEqual(filterArtifacts(all, { project: project.id }).map((a) => a.kind).sort(), ["recap", "spec"]);
  assert.deepEqual(filterArtifacts(all, { maker: "stand" }).map((a) => a.kind), ["recap"]);
  assert.deepEqual(makersOf(all).map((m) => m.name).sort(), ["Andy’s Codex", "Joe’s Claude", "Stand"]);
});

test("names and previews", () => {
  assert.deepEqual(makerOf(null, "Priya Shah via Claude Code"), { key: "a:priya shah:claude code", name: "Priya’s Claude Code" });
  assert.deepEqual(makerOf(null, "Sam Rivera"), { key: "p:sam rivera", name: "Sam" });
  assert.equal(makerOf(null, null), null);
  assert.equal(plainPreview("# Title\n\nSome **bold** text.\n\n```js\ncode()\n```\n1. One\n2. Two", "Title"), "Some bold text. · One · Two");
  assert.equal(parseDocRef("stand:doc/abc123xyz"), "abc123xyz");
  assert.equal(parseDocRef("https://stand.test/s/room?artifact=doc%3Aabc123xyz"), "abc123xyz");
  assert.equal(parseDocRef("stand:action/abc123xyz"), null);
});
