import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { HeuristicAgent, type ProjectSuggestInput, projectSuggestPrompt } from "./llm.ts";
import { ProjectSuggester, projectSuggestInput, suggestProjects } from "./projectSuggest.ts";

type DB = ReturnType<typeof openDb>;
type Line = { kind: "action" | "question" | "decision"; text: string; owner?: string | null; discussionId?: string | null };

let clock = 1_000_000;
/** A meeting that ended, with the notes it caught, each newer than the one before. */
function ended(db: DB, roomId: string, lines: Line[], itemId: string | null = null, end = true) {
  const m = db.startMeeting(roomId);
  const notes = db.syncNotes(m.id, itemId, lines.map((l) => ({ owner: null, ...l, ts: clock++ })));
  if (end) db.endMeeting(m.id, null);
  return { m, notes };
}

/** An agent whose project pass answers with `answer`, and the inputs it was asked. */
function fake(answer: (input: ProjectSuggestInput) => Array<{ note: string; project: string }> | null) {
  const calls: ProjectSuggestInput[] = [];
  const agent = Object.assign(new HeuristicAgent(), {
    suggestProjects: async (input: ProjectSuggestInput) => {
      calls.push(input);
      return answer(input);
    },
  });
  return { agent, calls };
}
const read = (db: DB, roomId: string, id: string) => db.withProjects(roomId, [db.getNote(id)!])[0];

test("the pass asks only about open to-dos and questions of ended meetings that nothing files, newest first", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  const [linked] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Checkout", url: null, description: null }]);
  const a = db.createProject(room.id, { name: "Checkout", fromItemId: linked.id }, "Sam");
  const { notes } = ended(db, room.id, [
    { kind: "action", text: "Plain" },
    { kind: "action", text: "Done" },
    { kind: "action", text: "Dropped" },
    { kind: "question", text: "Open question?" },
    { kind: "decision", text: "A decision" },
    { kind: "action", text: "By hand" },
    { kind: "action", text: "Unassigned by hand" },
    { kind: "action", text: "Suggested" },
    { kind: "action", text: "Inherits a suggestion" },
    { kind: "action", text: "Judged" },
  ]);
  const [, done, dropped, question, , byHand, unassigned, suggested, child, judged] = notes;
  ended(db, room.id, [{ kind: "action", text: "On the linked item" }], linked.id);
  ended(db, room.id, [{ kind: "action", text: "In a meeting still on" }], null, false);
  const [newest] = ended(db, room.id, [{ kind: "action", text: "Newest" }]).notes;
  db.setActionDone(room.id, done.id, "Sam");
  db.setTaskState(room.id, dropped.id, { state: "dropped", by: "Sam", reason: "No" });
  db.setNoteProject(room.id, byHand.id, { projectId: a.id, by: "Sam" });
  db.setNoteProject(room.id, unassigned.id, { projectId: null, by: "Sam" });
  db.suggestNoteProject(room.id, suggested.id, a.id);
  db.setNoteParent(room.id, child.id, suggested.id);
  db.markProjectJudged([judged.id], 5);
  assert.deepEqual(db.projectCandidates(room.id).map((n) => n.text), ["Newest", "Open question?", "Plain"]);
  assert.deepEqual(db.projectCandidates(room.id, 2).map((n) => n.id), [newest.id, question.id], "the cap keeps the newest");
});

test("the prompt lists the active projects with goal and firm examples, and each line with its item and topic", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Payments", url: null, description: null }]);
  const pay = db.createProject(room.id, { name: "Checkout", goal: "Pay in one step" }, "Sam");
  const old = db.createProject(room.id, { name: "Old site" }, "Sam");
  db.updateProject(room.id, old.id, { archived: true });
  const m = db.startMeeting(room.id);
  const [topic] = db.replaceDiscussions(m.id, item.id, [{ topic: "Card errors", positions: [], outcome: "action", segmentIds: [], continuesId: null }]);
  const [line] = db.syncNotes(m.id, item.id, [{ kind: "action", text: "Show the card error", owner: "Ann", discussionId: topic.id }]);
  const [shut, openOne, maybe] = db.syncNotes(m.id, null, [
    { kind: "action", text: "Closed example", owner: null },
    { kind: "action", text: "Open example", owner: null },
    { kind: "action", text: "Only suggested", owner: null },
  ]);
  db.endMeeting(m.id, null);
  db.setNoteProject(room.id, shut.id, { projectId: pay.id, by: "Sam" });
  db.setNoteProject(room.id, openOne.id, { projectId: pay.id, by: "Sam" });
  db.setActionDone(room.id, shut.id, "Sam");
  db.suggestNoteProject(room.id, maybe.id, pay.id);

  const { input, noteOf, projectOf } = projectSuggestInput(db, room.id)!;
  assert.deepEqual(input.projects, [{ key: "P1", name: "Checkout", goal: "Pay in one step", examples: ["Open example", "Closed example"] }], "firm only: open first, never an archived project");
  assert.deepEqual(input.candidates, [{ key: "N1", kind: "action", text: "Show the card error", owner: "Ann", item: "Payments", topic: "Card errors" }]);
  assert.deepEqual([noteOf.get("N1")?.id, projectOf.get("P1")], [line.id, pay.id]);
  const prompt = projectSuggestPrompt(input);
  assert.match(prompt, /- P1 · Checkout · goal: Pay in one step\n    · Open example\n    · Closed example/);
  assert.match(prompt, /To file:\n- N1 · to-do: Show the card error\n    owner Ann · agenda item "Payments" · topic "Card errors"/);
  assert.doesNotMatch(prompt, /Old site/);
});

test("what the pass writes: suggestions, judged notes, and nothing it can't stand behind", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  const pay = db.createProject(room.id, { name: "Checkout" }, "Sam");
  const [first, second, third, fourth, fifth] = ended(db, room.id, [
    { kind: "action", text: "One" },
    { kind: "action", text: "Two" },
    { kind: "question", text: "Three?" },
    { kind: "action", text: "Four" },
    { kind: "action", text: "Five" },
  ]).notes;
  const key = (input: ProjectSuggestInput, text: string) => input.candidates.find((c) => c.text === text)?.key ?? "gone";

  // A failed call writes nothing.
  const failing = fake(() => null);
  assert.deepEqual(await suggestProjects(db, failing.agent, room.id), { asked: 5, suggested: 0 });
  assert.equal(db.projectCandidates(room.id).length, 5);

  const { agent, calls } = fake((input) => {
    // A person files Five while the model works.
    db.setNoteProject(room.id, fifth.id, { projectId: null, by: "Ann" });
    return [
      { note: key(input, "One"), project: "P1" },
      { note: key(input, "Two"), project: "none" },
      { note: key(input, "Three?"), project: "P7" },
      { note: "N99", project: "P1" },
      { note: key(input, "Five"), project: "P1" },
    ];
  });
  assert.deepEqual(await suggestProjects(db, agent, room.id), { asked: 5, suggested: 1 });
  const one = read(db, room.id, first.id);
  assert.deepEqual([one.project, one.projectSuggested, one.projectSetBy], [pay.id, true, undefined], "a project answer is a suggestion");
  assert.deepEqual([read(db, room.id, second.id).project, db.getNote(second.id)?.projectJudgedAt != null], [null, true], "none only marks it read");
  assert.equal(db.getNote(third.id)?.projectJudgedAt, undefined, "an unknown project key is skipped");
  assert.equal(db.getNote(fourth.id)?.projectJudgedAt, undefined, "left out: asked again next time");
  const five = db.getNote(fifth.id)!;
  assert.deepEqual([five.projectSetBy, five.suggestedProjectId, five.projectJudgedAt], ["Ann", undefined, undefined], "filed by a person meanwhile: left alone");

  await suggestProjects(db, agent, room.id);
  assert.deepEqual(calls[1].candidates.map((c) => c.text).sort(), ["Four", "Three?"], "a judged note isn't asked again");
  assert.equal(read(db, room.id, first.id).project, pay.id, "a suggestion already there stays");
});

test("no model call without an active project or anything to file; a new or renamed project asks again", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  const { agent, calls } = fake((input) => input.candidates.map((c) => ({ note: c.key, project: "none" })));
  const [todo] = ended(db, room.id, [{ kind: "action", text: "Fix the coupon" }]).notes;
  assert.deepEqual(await suggestProjects(db, agent, room.id), { asked: 0, suggested: 0 });
  const p = db.createProject(room.id, { name: "Checkout" }, "Sam");
  db.updateProject(room.id, p.id, { archived: true });
  await suggestProjects(db, agent, room.id);
  assert.equal(calls.length, 0, "no active project");

  db.updateProject(room.id, p.id, { archived: false });
  await suggestProjects(db, agent, room.id);
  assert.equal(calls.length, 1);
  await suggestProjects(db, agent, room.id);
  assert.equal(calls.length, 1, "nothing left to file");
  db.updateProject(room.id, p.id, { name: "Coupons" });
  await suggestProjects(db, agent, room.id);
  assert.equal(calls.length, 2, "a renamed project: read again");
  db.createProject(room.id, { name: "Search" }, "Sam");
  await suggestProjects(db, agent, room.id);
  assert.deepEqual([calls.length, calls[2].candidates[0].text], [3, todo.text], "a new project: read again");
});

test("without a model a line gets a project only when it names that one project, whole words", async () => {
  const agent = new HeuristicAgent();
  const out = await agent.suggestProjects({
    projects: [
      { key: "P1", name: "Checkout", goal: null, examples: [] },
      { key: "P2", name: "Search bar", goal: null, examples: [] },
      { key: "P3", name: "C++ port", goal: null, examples: [] },
    ],
    candidates: [
      { key: "N1", kind: "action", text: "Fix the checkout button", owner: null, item: null, topic: null },
      { key: "N2", kind: "action", text: "Checkouts are slow", owner: null, item: null, topic: null },
      { key: "N3", kind: "question", text: "Should the search bar go in checkout?", owner: null, item: null, topic: null },
      { key: "N4", kind: "action", text: "Finish the C++ port", owner: null, item: null, topic: null },
      { key: "N5", kind: "action", text: "Search for a bar", owner: null, item: null, topic: null },
    ],
  });
  assert.deepEqual(out, [
    { note: "N1", project: "P1" },
    { note: "N2", project: "none" },
    { note: "N3", project: "none" },
    { note: "N4", project: "P3" },
    { note: "N5", project: "none" },
  ]);
});

test("the scheduler runs a space once for two schedules, the sooner wins, and a schedule during a run runs again", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  db.createProject(room.id, { name: "Checkout" }, "Sam");
  ended(db, room.id, [{ kind: "action", text: "Fix the checkout button" }]);
  let release: () => void = () => {};
  // It leaves everything out, so each run asks again.
  const { agent, calls } = fake(() => []);
  const slow = Object.assign(agent, {
    suggestProjects: async (input: ProjectSuggestInput) => {
      calls.push(input);
      await new Promise<void>((r) => (release = r));
      return [];
    },
  });
  const changed: string[] = [];
  const s = new ProjectSuggester(db, slow, (roomId) => changed.push(roomId));
  s.schedule(room.id, 60_000);
  s.schedule(room.id, 5);
  s.schedule(room.id, 30_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1, "one run, at the soonest time");
  // Scheduled while it runs: one more run after it.
  s.schedule(room.id, 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2);
  release();
  await new Promise((r) => setTimeout(r, 10));
  s.stop();
  assert.equal(changed.length, 0, "nothing written, nothing told");

  // With a suggestion written, the space hears of it.
  const told = new ProjectSuggester(db, new HeuristicAgent(), (roomId) => changed.push(roomId));
  await told.run(room.id);
  assert.deepEqual(changed, [room.id]);

  config.projectSuggest = false;
  try {
    const off = fake(() => []);
    const quiet = new ProjectSuggester(db, off.agent, () => {});
    ended(db, room.id, [{ kind: "action", text: "Another checkout fix" }]);
    quiet.schedule(room.id, 0);
    quiet.start();
    await quiet.run(room.id);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(off.calls.length, 0, "off: nothing runs");
  } finally {
    config.projectSuggest = true;
  }
});
