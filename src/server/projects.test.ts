import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { activeFirst, matchesProject, projectActivity, projectOf } from "../shared/projects.ts";
import { addUpNext } from "./upNext.ts";

const setup = () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Projects");
  const items = db.addItems(room.id, [
    { source: "agenda", externalId: null, title: "Pricing", url: null, description: null },
    { source: "agenda", externalId: null, title: "Launch", url: null, description: null },
  ]);
  const m = db.startMeeting(room.id);
  return { db, room, items, m };
};
/** The project of a note as the page would show it. */
const shown = (db: ReturnType<typeof openDb>, roomId: string, id: string) => db.withProjects(roomId, [db.getNote(id)!])[0].project ?? null;

test("a task follows the rules: by hand, else its agenda item's link, else its parent, else Unassigned", () => {
  const { db, room, items, m } = setup();
  try {
    const pricing = db.createProject(room.id, { name: "Billing" }, "Sam");
    const launch = db.createProject(room.id, { name: "Launch" }, "Sam");
    const [onItem] = db.syncNotes(m.id, items[0].id, [{ kind: "action", text: "Compare plans", owner: "Sam" }]);
    const [loose] = db.syncNotes(m.id, null, [{ kind: "action", text: "Write the FAQ", owner: null }]);
    const [decision] = db.syncNotes(m.id, items[1].id, [{ kind: "decision", text: "Ship on Monday", owner: null }]);
    assert.equal(shown(db, room.id, onItem.id), null, "an agenda title alone makes no project");
    db.setItemProject(room.id, items[0].id, pricing.id);
    assert.equal(shown(db, room.id, onItem.id), pricing.id, "rule 2: the item's link");
    db.raw.prepare("UPDATE notes SET parent_id = ? WHERE id = ?").run(onItem.id, loose.id);
    assert.equal(shown(db, room.id, loose.id), pricing.id, "rule 3: the parent task's project");
    db.setNoteProject(room.id, loose.id, { projectId: null, by: "Sam" });
    assert.equal(shown(db, room.id, loose.id), null, "rule 1: Unassigned by hand wins");
    db.setNoteProject(room.id, onItem.id, { projectId: launch.id, by: "Sam" });
    const n = db.withProjects(room.id, [db.getNote(onItem.id)!])[0];
    assert.deepEqual([n.project, n.ruledProject], [launch.id, pricing.id], "by hand wins, and the rules' answer is kept for Follow the agenda");
    db.setNoteProject(room.id, onItem.id, { auto: true });
    assert.equal(shown(db, room.id, onItem.id), pricing.id, "back to the rules");
    db.setItemProject(room.id, items[1].id, launch.id);
    assert.equal(shown(db, room.id, decision.id), launch.id, "decisions have projects too");
    const context = db.addNote(m.id, null, { kind: "context", text: "True", owner: null }, null);
    assert.equal(db.setNoteProject(room.id, context.id, { projectId: launch.id, by: "Sam" }), null, "context lines have no project");
    assert.equal(db.setNoteProject(db.createRoom("Other").id, onItem.id, { auto: true }), null, "a note of another space");
    assert.equal(matchesProject(pricing.id, pricing.id), true);
    assert.equal(matchesProject(null, "none"), true);
    assert.equal(matchesProject(pricing.id, "none"), false);
    assert.equal(matchesProject(null, ""), true);
  } finally {
    db.raw.close();
  }
});

test("a slide follows its deck's agenda item, and a presented task's talk follows the task", () => {
  const { db, room, items, m } = setup();
  try {
    const p = db.createProject(room.id, { name: "Deck work" }, "Sam");
    const deck = db.createDeck(room.id, "Pitch", 1);
    db.addItems(room.id, [{ source: "slide", externalId: null, title: "Slide 1", url: null, description: null, deckId: deck.id, slideNo: 1 }]);
    db.setDeckParent(deck.id, items[1].id);
    const slide = db.listItems(room.id).find((i) => i.deckId === deck.id)!;
    const [onSlide] = db.syncNotes(m.id, slide.id, [{ kind: "action", text: "Fix slide two", owner: null }]);
    db.setItemProject(room.id, items[1].id, p.id);
    assert.equal(shown(db, room.id, onSlide.id), p.id, "the slide's deck sits under a linked item");
    const [task] = db.syncNotes(m.id, null, [{ kind: "action", text: "Present me", owner: null }]);
    const other = db.createProject(room.id, { name: "Presented" }, "Sam");
    db.setNoteProject(room.id, task.id, { projectId: other.id, by: "Sam" });
    const taskItem = db.taskItem(room.id, task.id, task.text, null);
    db.setItemProject(room.id, taskItem.id, p.id);
    const [said] = db.syncNotes(m.id, taskItem.id, [{ kind: "action", text: "Follow up on it", owner: null }]);
    assert.equal(shown(db, room.id, said.id), other.id, "the task the item shows comes before the item's own link");
    db.archiveTaskItems(room.id);
    assert.equal(shown(db, room.id, said.id), other.id, "and stays after the item leaves the agenda");
    // A loop of parents stops instead of running for ever.
    db.raw.prepare("UPDATE notes SET parent_id = ? WHERE id = ?").run(said.id, task.id);
    db.setNoteProject(room.id, task.id, { auto: true });
    assert.equal(projectOf({ id: "x", itemId: null, parentId: said.id }, db.projectGraph(room.id)), p.id);
  } finally {
    db.raw.close();
  }
});

test("names are unique in a space whatever the case; archive needs no open to-dos and comes back by itself", () => {
  const { db, room, items, m } = setup();
  try {
    const p = db.createProject(room.id, { name: "  Billing   work ", goal: "Charge monthly" }, "Sam");
    assert.equal(p.name, "Billing work");
    assert.throws(() => db.createProject(room.id, { name: "billing WORK" }, "Sam"), /already a project/);
    assert.throws(() => db.createProject(room.id, { name: "" }, "Sam"), /needs a name/);
    assert.throws(() => db.createProject(room.id, { name: "a".repeat(81) }, "Sam"), /80 characters/);
    assert.throws(() => db.createProject(room.id, { name: "Goal", goal: "g".repeat(201) }, "Sam"), /200 characters/);
    const other = db.createRoom("Other");
    assert.equal(db.createProject(other.id, { name: "Billing work" }, "Sam").name, "Billing work", "another space can use the name");
    const second = db.createProject(room.id, { name: "Launch", fromItemId: items[1].id }, "Sam");
    assert.equal(db.getItem(items[1].id)?.projectId, second.id, "Make project links the item");
    assert.throws(() => db.updateProject(room.id, second.id, { name: "billing work" }), /already a project/);
    assert.deepEqual(db.updateProject(room.id, second.id, { position: 0 })!.position, 0);
    assert.deepEqual(db.listProjects(room.id).map((x) => x.name), ["Launch", "Billing work"]);

    const [todo] = db.syncNotes(m.id, null, [{ kind: "action", text: "Bill Acme", owner: "Sam" }]);
    db.endMeeting(m.id, null);
    db.setNoteProject(room.id, todo.id, { projectId: p.id, by: "Sam" });
    assert.equal(db.getProject(room.id, p.id)?.openTodos, 1);
    assert.throws(() => db.updateProject(room.id, p.id, { archived: true }), /1 open to-do/);
    db.setActionDone(room.id, todo.id, "Sam");
    assert.equal(db.updateProject(room.id, p.id, { archived: true })?.archived, true);
    assert.equal(db.withProjects(room.id, [db.getNote(todo.id)!])[0].project, p.id, "its tasks keep the link");
    db.setActionDone(room.id, todo.id, null);
    assert.equal(db.getProject(room.id, p.id)?.archived, false, "a task that opens again brings it back");
    db.setActionDone(room.id, todo.id, "Sam");
    db.updateProject(room.id, p.id, { archived: true });
    assert.equal(db.createProject(room.id, { name: "BILLING WORK" }, "Ann").id, p.id, "its name brings an archived project back");
    assert.equal(db.getProject(room.id, p.id)?.archived, false);
  } finally {
    db.raw.close();
  }
});

test("one order for a space: the projects named go first in that order, the rest keep theirs after", () => {
  const { db, room } = setup();
  try {
    const [a, b, c, d] = ["Alpha", "Beta", "Gamma", "Delta"].map((name) => db.createProject(room.id, { name }, "Sam"));
    const names = () => db.listProjects(room.id).map((x) => x.name);
    assert.deepEqual(db.orderProjects(room.id, [c.id, a.id]).map((x) => x.name), ["Gamma", "Alpha", "Beta", "Delta"]);
    assert.deepEqual(db.listProjects(room.id).map((x) => x.position), [0, 1, 2, 3]);
    db.orderProjects(room.id, [d.id, d.id]);
    assert.deepEqual(names(), ["Delta", "Gamma", "Alpha", "Beta"], "a project named twice counts once");
    db.updateProject(room.id, b.id, { position: 1 });
    assert.deepEqual(names(), ["Delta", "Beta", "Gamma", "Alpha"], "a move by position, as the drag sends it");
    const other = db.createProject(db.createRoom("Other").id, { name: "Elsewhere" }, "Sam");
    assert.throws(() => db.orderProjects(room.id, [a.id, other.id]), /isn't in this space/);
    assert.deepEqual(names(), ["Delta", "Beta", "Gamma", "Alpha"], "a bad order changes nothing");
    assert.equal(db.createProject(room.id, { name: "Epsilon" }, "Sam").position, 4, "a new project goes last");
  } finally {
    db.raw.close();
  }
});

test("deleting a project unlinks its tasks and items, which follow the rules again", () => {
  const { db, room, items, m } = setup();
  try {
    const a = db.createProject(room.id, { name: "A", fromItemId: items[0].id }, "Sam");
    const b = db.createProject(room.id, { name: "B", fromItemId: items[1].id }, "Sam");
    const [x] = db.syncNotes(m.id, items[1].id, [{ kind: "action", text: "X", owner: null }]);
    db.setNoteProject(room.id, x.id, { projectId: a.id, by: "Sam" });
    assert.equal(db.deleteProject(room.id, a.id), true);
    assert.equal(db.getItem(items[0].id)?.projectId, null);
    assert.equal(db.getNote(x.id)?.projectSetBy, undefined);
    assert.equal(shown(db, room.id, x.id), b.id, "back to its item's project");
    assert.equal(db.deleteProject(room.id, a.id), false);
    assert.equal(db.deleteProject(db.createRoom("Other").id, b.id), false);
  } finally {
    db.raw.close();
  }
});

test("a project set by hand survives redrafts, rewording and delete/restore, Unassigned too", () => {
  const { db, room } = setup();
  try {
    const p = db.createProject(room.id, { name: "Pricing" }, "Sam");
    const m = db.startMeeting(room.id);
    const notes = db.syncNotes(m.id, null, [
      { kind: "action", text: "Check prices", owner: "Sam" },
      { kind: "decision", text: "Choose monthly", owner: null },
    ]);
    db.setNoteProject(room.id, notes[0].id, { projectId: p.id, by: "Sam" });
    db.setNoteProject(room.id, notes[1].id, { projectId: null, by: "Sam" });
    const redrafted = db.syncNotes(m.id, null, notes.map((n) => ({ ...n, text: `${n.text}!` })));
    assert.deepEqual(redrafted.map((n) => [n.projectId, n.projectSetBy]), [[p.id, "Sam"], [null, "Sam"]]);
    db.editNote(notes[0].id, { text: "Compare prices", owner: "Sam" }, "Sam");
    assert.equal(db.getNote(notes[0].id)?.projectId, p.id);
    const removed = db.removeNote(notes[0].id)!;
    db.restoreNote(removed);
    assert.equal(db.getNote(notes[0].id)?.projectId, p.id);
    // A note given only a project is one someone acted on: a run that leaves it out keeps it.
    db.syncNotes(m.id, null, []);
    assert.ok(db.getNote(notes[1].id), "Unassigned by hand counts as acted on");
  } finally {
    db.raw.close();
  }
});

/** The note as the page would get it. */
const read = (db: ReturnType<typeof openDb>, roomId: string, id: string) => db.withProjects(roomId, [db.getNote(id)!])[0];

test("Stand's suggestion is the last rule: by hand, the agenda item and the parent all come first", () => {
  const { db, room, items, m } = setup();
  try {
    const a = db.createProject(room.id, { name: "A" }, "Sam");
    const b = db.createProject(room.id, { name: "B" }, "Sam");
    const c = db.createProject(room.id, { name: "C" }, "Sam");
    const [parent] = db.syncNotes(m.id, null, [{ kind: "action", text: "Parent", owner: null }]);
    const [todo] = db.syncNotes(m.id, items[0].id, [{ kind: "action", text: "Child", owner: null }]);
    assert.ok(db.suggestNoteProject(room.id, todo.id, a.id));
    let n = read(db, room.id, todo.id);
    assert.deepEqual([n.project, n.ruledProject, n.projectSuggested, n.suggestedProjectId], [a.id, null, true, a.id], "rule 4 when nothing else applies");
    db.setNoteProject(room.id, parent.id, { projectId: b.id, by: "Sam" });
    db.raw.prepare("UPDATE notes SET parent_id = ? WHERE id = ?").run(parent.id, todo.id);
    n = read(db, room.id, todo.id);
    assert.deepEqual([n.project, n.ruledProject, n.projectSuggested], [b.id, b.id, undefined], "the parent beats the suggestion");
    db.setItemProject(room.id, items[0].id, c.id);
    n = read(db, room.id, todo.id);
    assert.deepEqual([n.project, n.ruledProject, n.projectSuggested], [c.id, c.id, undefined], "the agenda item beats the parent");
    db.setNoteProject(room.id, todo.id, { projectId: null, by: "Sam" });
    n = read(db, room.id, todo.id);
    assert.deepEqual([n.project, n.projectSuggested], [null, undefined], "by hand beats them all, Unassigned too");
    assert.equal(db.getNote(todo.id)?.suggestedProjectId, a.id, "a suggestion never changes what was set by hand, nor the reverse");
  } finally {
    db.raw.close();
  }
});

test("a suggestion is confirmed or rejected by hand; following the agenda keeps it", () => {
  const { db, room, m } = setup();
  try {
    const a = db.createProject(room.id, { name: "A" }, "Sam");
    const b = db.createProject(room.id, { name: "B" }, "Sam");
    const [x, y] = db.syncNotes(m.id, null, [
      { kind: "action", text: "X", owner: null },
      { kind: "question", text: "Y?", owner: null },
    ]);
    db.suggestNoteProject(room.id, x.id, a.id);
    db.suggestNoteProject(room.id, y.id, a.id);
    db.setNoteProject(room.id, x.id, { projectId: a.id, by: "Sam" });
    assert.deepEqual([read(db, room.id, x.id).project, read(db, room.id, x.id).projectSuggested], [a.id, undefined], "confirmed");
    db.setNoteProject(room.id, y.id, { projectId: null, by: "Sam" });
    assert.deepEqual([read(db, room.id, y.id).project, read(db, room.id, y.id).projectSuggested], [null, undefined], "rejected: Unassigned by hand");
    db.setNoteProject(room.id, y.id, { auto: true });
    assert.deepEqual([read(db, room.id, y.id).project, read(db, room.id, y.id).projectSuggested], [a.id, true], "back to the rules: the suggestion stays");
    db.suggestNoteProject(room.id, y.id, null);
    assert.equal(read(db, room.id, y.id).project, null, "taken off");
    assert.throws(() => db.suggestNoteProject(room.id, x.id, db.createProject(db.createRoom("Other").id, { name: "O" }, "Sam").id), /isn't in this space/);
    const context = db.addNote(m.id, null, { kind: "context", text: "True", owner: null }, null);
    assert.equal(db.suggestNoteProject(room.id, context.id, b.id), null, "context lines have no project");
    db.updateProject(room.id, b.id, { archived: true });
    assert.throws(() => db.suggestNoteProject(room.id, y.id, b.id), /archived/);
  } finally {
    db.raw.close();
  }
});

test("deleting or archiving a project takes its suggestions off, so an archived one doesn't come back", () => {
  const { db, room, m } = setup();
  try {
    const a = db.createProject(room.id, { name: "A" }, "Sam");
    const b = db.createProject(room.id, { name: "B" }, "Sam");
    const [x, y] = db.syncNotes(m.id, null, [
      { kind: "action", text: "X", owner: null },
      { kind: "action", text: "Y", owner: null },
    ]);
    db.endMeeting(m.id, null);
    db.suggestNoteProject(room.id, x.id, a.id);
    db.suggestNoteProject(room.id, y.id, b.id);
    assert.equal(db.getProject(room.id, a.id)?.openTodos, 1, "a suggested to-do counts as open in it");
    assert.equal(db.deleteProject(room.id, a.id), true);
    assert.equal(db.getNote(x.id)?.suggestedProjectId, undefined);
    assert.equal(read(db, room.id, x.id).project, null);
    db.setActionDone(room.id, y.id, "Sam");
    assert.equal(db.updateProject(room.id, b.id, { archived: true })?.archived, true);
    assert.equal(db.getNote(y.id)?.suggestedProjectId, undefined);
    db.setActionDone(room.id, y.id, null);
    assert.equal(db.getProject(room.id, b.id)?.archived, true, "the to-do opens again, and the project stays archived");
    assert.equal(read(db, room.id, y.id).project, null);
  } finally {
    db.raw.close();
  }
});

test("a suggestion and when Stand judged it survive a redraft and delete/restore, and alone don't keep a note", () => {
  const { db, room, m } = setup();
  try {
    const a = db.createProject(room.id, { name: "A" }, "Sam");
    const notes = db.syncNotes(m.id, null, [
      { kind: "action", text: "Check prices", owner: "Sam" },
      { kind: "question", text: "Monthly?", owner: null },
    ]);
    db.suggestNoteProject(room.id, notes[0].id, a.id);
    db.raw.prepare("UPDATE notes SET project_judged_at = 5 WHERE id IN (?, ?)").run(notes[0].id, notes[1].id);
    const redrafted = db.syncNotes(m.id, null, notes.map((n) => ({ ...n, text: `${n.text}!` })));
    assert.deepEqual(redrafted.map((n) => [n.suggestedProjectId, n.projectJudgedAt]), [[a.id, 5], [undefined, 5]]);
    const removed = db.removeNote(notes[0].id)!;
    db.restoreNote(removed);
    assert.deepEqual([db.getNote(notes[0].id)?.suggestedProjectId, db.getNote(notes[0].id)?.projectJudgedAt], [a.id, 5]);
    assert.equal(db.noteActedOn(notes[0].id), false, "Stand wrote it, no person did");
    db.syncNotes(m.id, null, []);
    assert.equal(db.getNote(notes[0].id), null, "a run that leaves it out deletes it");
  } finally {
    db.raw.close();
  }
});

test("a new, renamed, re-aimed or returned project has Stand read the notes it found none for again", () => {
  const { db, room, m } = setup();
  try {
    const a = db.createProject(room.id, { name: "A" }, "Sam");
    const [x, y] = db.syncNotes(m.id, null, [
      { kind: "action", text: "X", owner: null },
      { kind: "action", text: "Y", owner: null },
    ]);
    db.suggestNoteProject(room.id, x.id, a.id);
    const judge = () => db.raw.prepare("UPDATE notes SET project_judged_at = 5 WHERE id IN (?, ?)").run(x.id, y.id);
    const judged = () => [x, y].map((n) => db.getNote(n.id)?.projectJudgedAt ?? null);
    const other = db.createRoom("Other");
    const [z] = db.syncNotes(db.startMeeting(other.id).id, null, [{ kind: "action", text: "Z", owner: null }]);
    db.raw.prepare("UPDATE notes SET project_judged_at = 5 WHERE id = ?").run(z.id);
    judge();
    const b = db.createProject(room.id, { name: "B" }, "Sam");
    assert.deepEqual(judged(), [5, null], "only the note with no suggestion");
    assert.equal(db.getNote(z.id)?.projectJudgedAt, 5, "only in this space");
    for (const change of [{ name: "Bee" }, { goal: "Buzz" }, { archived: false }] as const) {
      db.updateProject(room.id, b.id, { archived: true });
      judge();
      db.updateProject(room.id, b.id, change);
      assert.deepEqual(judged(), [5, null], JSON.stringify(change));
    }
    db.updateProject(room.id, b.id, { archived: false });
    judge();
    db.updateProject(room.id, b.id, { position: 0 });
    assert.deepEqual(judged(), [5, 5], "a new place in the list changes nothing");
  } finally {
    db.raw.close();
  }
});

test("a to-do carried to the agenda keeps the project it had, as a suggestion", () => {
  const { db, room, m } = setup();
  try {
    const p = db.createProject(room.id, { name: "Checkout" }, "Sam");
    const q = db.createProject(room.id, { name: "Other" }, "Sam");
    const [feature, byHand, none] = db.syncNotes(m.id, null, [
      { kind: "action", text: "Build checkout", owner: "Sam" },
      { kind: "action", text: "Set by hand", owner: null },
      { kind: "action", text: "No project", owner: null },
    ]);
    db.setNoteProject(room.id, feature.id, { projectId: p.id, by: "Sam" });
    db.setNoteProject(room.id, byHand.id, { projectId: q.id, by: "Sam" });
    // A product review slide that shows the feature's to-do.
    const review = db.createReview(room.id);
    const deck = db.createDeck(room.id, "Review", 1);
    db.addItems(room.id, [{ source: "slide", externalId: null, title: "Checkout", url: null, description: null, deckId: deck.id, slideNo: 1 }]);
    const slideItem = db.listItems(room.id).find((i) => i.deckId === deck.id)!;
    const slide = db.addReviewSlide(review.id, { title: "Checkout", body: "", noteId: feature.id, owner: null, addedBy: null, pr: null });
    db.updateReviewSlide(slide.id, { itemId: slideItem.id });
    const [caught, other] = db.syncNotes(m.id, slideItem.id, [
      { kind: "action", text: "Fix the coupon field", owner: null },
      { kind: "action", text: "Retry the payment", owner: null },
    ]);
    assert.equal(shown(db, room.id, caught.id), p.id, "caught on the slide, it is in the feature's project");
    const itemId = addUpNext(db, room.id, { key: `note:${caught.id}`, merged: [`note:${other.id}`, `note:${byHand.id}`, `note:${none.id}`] }, m);
    assert.ok(itemId);
    const n = read(db, room.id, caught.id);
    assert.deepEqual([n.itemId, n.project, n.projectSuggested], [itemId, p.id, true], "on its new line, the project stays as a suggestion");
    assert.deepEqual([read(db, room.id, other.id).project, read(db, room.id, other.id).projectSuggested], [p.id, true], "one folded into it too");
    const kept = db.getNote(byHand.id)!;
    assert.deepEqual([kept.projectId, kept.projectSetBy, kept.suggestedProjectId], [q.id, "Sam", undefined], "set by hand: unchanged");
    assert.equal(db.getNote(none.id)?.suggestedProjectId, undefined, "no project before: no suggestion");
  } finally {
    db.raw.close();
  }
});

test("the suggestion columns are added to an older database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stand-projects-"));
  const file = path.join(dir, "stand.db");
  let db = openDb(file);
  db.raw.exec("ALTER TABLE notes DROP COLUMN suggested_project_id; ALTER TABLE notes DROP COLUMN project_judged_at;");
  db.raw.close();
  db = openDb(file);
  try {
    const cols = (db.raw.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes("suggested_project_id") && cols.includes("project_judged_at"));
    db.raw.close();
    db = openDb(file);
  } finally {
    db.raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the topic labels become projects once, in the spelling used most", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stand-projects-"));
  const file = path.join(dir, "stand.db");
  let db = openDb(file);
  const room = db.createRoom("Old");
  const other = db.createRoom("Other");
  const m = db.startMeeting(room.id);
  const o = db.startMeeting(other.id);
  const [a, b, c, d, e] = db.syncNotes(m.id, null, [
    { kind: "action", text: "A", owner: null },
    { kind: "action", text: "B", owner: null },
    { kind: "decision", text: "C", owner: null },
    { kind: "question", text: "D", owner: null },
    { kind: "action", text: "E", owner: null },
  ]);
  const [f] = db.syncNotes(o.id, null, [{ kind: "action", text: "F", owner: null }]);
  // As an older version left it: labels in notes.topic, and no project columns yet.
  const set = db.raw.prepare("UPDATE notes SET topic = ? WHERE id = ?");
  set.run("pricing", a.id);
  set.run("Pricing", b.id);
  set.run(" Pricing ", c.id);
  set.run("", d.id);
  set.run("Pricing", f.id);
  db.raw.exec("DELETE FROM projects; DROP INDEX notes_project; ALTER TABLE notes DROP COLUMN project_set_by; ALTER TABLE notes DROP COLUMN project_id;");
  db.raw.close();
  db = openDb(file);
  try {
    const projects = db.listProjects(room.id);
    assert.deepEqual(projects.map((p) => p.name), ["Pricing"], "one project for the three spellings, in the one used most");
    const at = (id: string) => db.getNote(id)!;
    assert.deepEqual([a, b, c].map((n) => [at(n.id).projectId, at(n.id).projectSetBy]), Array(3).fill([projects[0].id, "migrated"]));
    assert.deepEqual([at(d.id).projectId, at(d.id).projectSetBy], [null, "migrated"], "an empty label is Unassigned by hand");
    assert.equal(at(e.id).projectSetBy, undefined, "no label: it follows the rules");
    assert.notEqual(at(f.id).projectId, projects[0].id, "each space gets its own");
    assert.equal(db.listProjects(other.id).length, 1);
    db.raw.close();
    db = openDb(file);
    assert.equal(db.listProjects(room.id).length, 1, "running again changes nothing");
  } finally {
    db.raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Active first: projects with work in progress, then the newest to-dos, then the team's order", () => {
  const team = ["quiet", "old", "busy", "new", "empty"].map((id) => ({ id }));
  const activity = projectActivity([
    { project: "old", ts: 100, inProgress: false },
    { project: "busy", ts: 50, inProgress: true },
    { project: "busy", ts: 60, inProgress: false },
    { project: "new", ts: 300, inProgress: false },
    { project: "quiet", ts: 100, inProgress: false },
    { project: null, ts: 900, inProgress: true },
  ]);
  assert.deepEqual(activity.get("busy"), { inProgress: 1, latest: 60 });
  assert.equal(activity.has("empty"), false, "a project with nothing open has no activity");
  const names = (list: Array<{ id: string }>) => list.map((p) => p.id);
  assert.deepEqual(names(activeFirst(team, activity)), ["busy", "new", "quiet", "old", "empty"], "a tie keeps the team's order");
  assert.deepEqual(names(team), ["quiet", "old", "busy", "new", "empty"], "the team's order is not changed");
  // A report on a to-do counts as much as a new one.
  const reported = projectActivity([
    { project: "old", ts: 100, inProgress: false, reportedAt: 500 },
    { project: "new", ts: 300, inProgress: false },
  ]);
  assert.deepEqual(names(activeFirst(team, reported)).slice(0, 2), ["old", "new"]);
  // Two projects in progress: the one with the newest to-do first.
  const both = projectActivity([
    { project: "old", ts: 100, inProgress: true },
    { project: "new", ts: 300, inProgress: true },
    { project: "quiet", ts: 900, inProgress: false },
  ]);
  assert.deepEqual(names(activeFirst(team, both)).slice(0, 3), ["new", "old", "quiet"]);
});
