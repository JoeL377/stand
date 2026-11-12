import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { matchesProject, projectOf } from "../shared/projects.ts";

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
