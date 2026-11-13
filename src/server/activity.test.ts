import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActivityEvent, groupActivity } from "../shared/activity.ts";
import { spaceActivity } from "./activity.ts";
import { agentApi } from "./agents.ts";
import { openDb } from "./db.ts";
import { upNextView } from "./upNextPolish.ts";
import { UploadLinks } from "./workLog.ts";

function setup() {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const andy = db.upsertUser({ googleSub: "g-andy", email: "andy@example.com", name: "Andy Li", picture: null });
  const room = db.createRoom("Checkout v2", joe.id, "Ship one-page checkout");
  db.touchMembership(room.id, joe.id);
  db.touchMembership(room.id, andy.id);
  const m = db.startMeeting(room.id);
  const notes = db.syncNotes(m.id, null, [
    { kind: "action", text: "Move transcript capture to the server", owner: "Joe", discussionId: null },
    { kind: "question", text: "Do we need it on mobile first?", owner: null, discussionId: null },
    { kind: "decision", text: "Ship the web first", owner: null, discussionId: null },
  ]);
  db.endMeeting(m.id, null);
  const api = agentApi({ db, notify: () => {}, brief: () => ({}), suggested: (r) => upNextView(db, r, null), uploads: new UploadLinks() });
  const token = (label: string) => ({ id: `tok-${label}`, label, scope: "write" as const });
  const claude = { user: joe, token: token("Claude"), model: "claude-test" } as never;
  const codex = { user: andy, token: token("Codex") } as never;
  return { db, api, joe, andy, room, m, notes, claude, codex };
}

const lines = (events: ActivityEvent[], names: Map<string, string>) => events.map((e) => `${names.get(e.who)} ${e.verb}${e.target ? ` ${e.target.text}` : ""}`);

test("the timeline reads agents' reports, what they added and closed, what Stand caught and a merge", () => {
  const { db, api, room, m, notes, claude, codex, joe } = setup();
  const [action, question] = notes;
  const ref = `stand:action/${action.id}`;
  api.startWork(claude, { ref, note: "On it" });
  api.postUpdate(claude, { ref, status: "ready", text: "Capture runs on the server now.", links: ["https://github.com/acme/app/pull/12"] });
  api.createAction(codex, { space: room.id, text: "Write the migration", summary: "Needs a backfill." });
  api.closeQuestion(codex, { ref: `stand:question/${question.id}`, drop: "Web only for now" });
  api.renameMeetings(claude, { renames: [{ meeting: m.id, title: "Capture planning" }] });
  // A person's comment is not an agent's event.
  db.addUpdate({ roomId: room.id, itemId: null, noteId: action.id, noteText: action.text, userId: joe.id, userName: joe.name, client: null, status: "comment", text: "Looks right", links: [] });

  const page = spaceActivity(db, room.id);
  const names = new Map(page.agents.map((a) => [a.key, a.name]));
  const got = lines(page.events, names);
  for (const want of [
    "Joe’s Claude started on Move transcript capture to the server",
    "Joe’s Claude opened PR #12 for Move transcript capture to the server",
    "Andy’s Codex added Write the migration",
    "Andy’s Codex dropped Do we need it on mobile first?",
    "Joe’s Claude named a meeting Capture planning",
    "Stand caught 3 items in Capture planning",
  ])
    assert.ok(got.includes(want), `${want}\n  in:\n  ${got.join("\n  ")}`);
  assert.equal(got.length, 6, got.join("\n"));
  assert.equal(page.next, null);
  assert.deepEqual(page.agents.map((a) => a.name), ["Joe’s Claude", "Andy’s Codex", "Stand"]);

  const added = page.events.find((e) => e.kind === "added")!;
  assert.equal(added.detail, "Needs a backfill.", "the summary given with a to-do is its detail, not a second row");
  const caught = page.events.find((e) => e.kind === "caught")!;
  assert.equal(caught.items?.length, 3);
  assert.equal(caught.target?.href, `/meetings/${m.id}`);

  // Ready is flagged while the to-do is open and nothing was said after it; a merge closes it as GitHub's.
  const ready = page.events.find((e) => e.kind === "ready")!;
  assert.equal(ready.flag, "Ready to ship");
  assert.equal(ready.model, "claude-test");
  db.setActionDone(room.id, action.id, "Joe Liang via Claude", "pr:https://github.com/acme/app/pull/12");
  db.addUpdate({ roomId: room.id, itemId: null, noteId: action.id, noteText: action.text, userId: joe.id, userName: joe.name, client: "Claude", status: "done", text: "Shipped: PR #12 merged. Capture runs on the server now.", links: ["https://github.com/acme/app/pull/12"] });
  const after = spaceActivity(db, room.id);
  assert.equal(after.events.find((e) => e.kind === "ready")!.flag, undefined);
  const shipped = after.events.find((e) => e.kind === "shipped")!;
  assert.equal(shipped.who, "github");
  assert.equal(shipped.verb, "PR #12 merged, closing");

  // The filter keeps one agent's events.
  const mine = spaceActivity(db, room.id, { who: page.agents[1].key });
  assert.deepEqual(lines(mine.events, names), ["Andy’s Codex dropped Do we need it on mobile first?", "Andy’s Codex added Write the migration"].sort((a, b) => (got.indexOf(a) - got.indexOf(b))));
});

test("pages follow each other with nothing lost or shown twice, with a filter too", () => {
  const { db, room, notes, joe, andy } = setup();
  const [action] = notes;
  const T0 = 1_700_000_000_000;
  const raw = db.raw.prepare("INSERT INTO updates (id, room_id, item_id, note_id, note_text, user_id, user_name, client, status, text, links_json, ts) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'progress', ?, '[]', ?)");
  // 230 reports: every third by a person, the rest by two agents; several share a moment.
  for (let i = 0; i < 230; i++) {
    const [who, client] = i % 3 === 0 ? [joe, null] : i % 3 === 1 ? [joe, "Claude"] : [andy, "Codex"];
    raw.run(`up${i}`, room.id, action.id, action.text, who.id, who.name, client, `step ${i}`, T0 + Math.floor(i / 4) * 1000);
  }
  const walk = (who?: string) => {
    const seen: string[] = [];
    let before: number | undefined;
    for (let pages = 0; pages < 40; pages++) {
      const page = spaceActivity(db, room.id, { before, who, limit: 20 });
      seen.push(...page.events.map((e) => e.id));
      if (page.next === null) return seen;
      before = page.next;
    }
    assert.fail("never reached the end");
  };
  const all = walk();
  assert.equal(new Set(all).size, all.length, "nothing twice");
  // 153 agent reports (230 less the 77 a person wrote), and the call Stand caught things in.
  assert.equal(all.filter((id) => id.startsWith("u:")).length, 153);
  assert.ok(all.includes(`c:${notes[0].meetingId}`));
  const codex = spaceActivity(db, room.id).agents.find((a) => a.short === "Codex")!;
  const only = walk(codex.key);
  assert.equal(only.length, 76);
  assert.equal(new Set(only).size, 76);
});

test("a to-do's steps fold into one row that reads as the newest; a burst of one kind by one agent folds too", () => {
  const e = (id: string, ts: number, who: string, kind: ActivityEvent["kind"], text: string, task = true): ActivityEvent => ({ id, ts, who, kind, verb: kind, target: { text, taskId: task ? text : undefined } });
  const MIN = 60_000;
  const rows = groupActivity([
    e("1", 300 * MIN, "github", "shipped", "tab"),
    e("2", 299 * MIN, "a", "slide", "one", false),
    e("3", 298 * MIN, "b", "working", "other"),
    e("4", 297 * MIN, "a", "slide", "two", false),
    e("5", 296 * MIN, "a", "ready", "tab"),
    e("6", 295 * MIN, "a", "slide", "three", false),
    e("7", 200 * MIN, "a", "working", "tab"),
    e("8", 199 * MIN, "a", "added", "tab"),
    // The same to-do, a day before: its own stretch.
    e("9", -1200 * MIN, "a", "progress", "tab"),
    e("10", -1300 * MIN, "a", "slide", "long before", false),
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.who, r.verb, r.burst?.length ?? 1, !!r.steps]), [
    ["steps:1", "github", "shipped", 4, true],
    ["burst:2", "a", "added 3 slides to the product review", 3, false],
    ["3", "b", "working", 1, false],
    ["9", "a", "progress", 1, false],
    ["10", "a", "slide", 1, false],
  ]);
});
