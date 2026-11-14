import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import type { Agent } from "./llm.ts";
import { ProjectStatuses, STATUS_MIN_GAP_MS, projectStatusInput } from "./projectStatus.ts";

const setup = () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Status");
  const project = db.createProject(room.id, { name: "Billing", goal: "Charge teams by seat" }, "Sam");
  const m = db.startMeeting(room.id);
  const [todo, later] = db.syncNotes(m.id, null, [
    { kind: "action", text: "Add seat counts to invoices", owner: "Huy" },
    { kind: "action", text: "Email teams about the change", owner: "Sam" },
  ]);
  db.endMeeting(m.id, "Talked through billing.");
  return { db, room, project, m, todo, later };
};
const tick = () => new Promise((r) => setImmediate(r));

test("a project with nothing in it has no paragraph, and asks no model", async () => {
  const { db, room, project } = setup();
  let calls = 0;
  const statuses = new ProjectStatuses(db, { projectStatus: async () => (calls++, "x") } as unknown as Agent);
  assert.equal(projectStatusInput(db, room.id, project.id), null);
  assert.deepEqual(statuses.get(room.id, project.id), { text: null, at: null, pending: false });
  await tick();
  assert.equal(calls, 0);
  db.raw.close();
});

test("the paragraph is written once per change, kept, and waits out the gap", async () => {
  const { db, room, project, todo, later } = setup();
  const prompts: string[] = [];
  const agent = { projectStatus: async (p: string) => (prompts.push(p), `Paragraph ${prompts.length}`) } as unknown as Agent;
  const statuses = new ProjectStatuses(db, agent);
  db.setNoteProject(room.id, todo.id, { projectId: project.id, by: "Sam" });

  const t0 = Date.now();
  assert.deepEqual(statuses.get(room.id, project.id, t0), { text: null, at: null, pending: true });
  assert.equal(statuses.get(room.id, project.id, t0).pending, true, "one write at a time");
  await tick();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Add seat counts to invoices \(owner: Huy\)/);
  assert.equal(statuses.get(room.id, project.id, t0).text, "Paragraph 1");
  await tick();
  assert.equal(prompts.length, 1, "nothing changed: no new call");

  db.setNoteProject(room.id, later.id, { projectId: project.id, by: "Sam" });
  assert.notEqual(projectStatusInput(db, room.id, project.id)!.fingerprint, db.getProjectStatus(project.id)!.fingerprint, "a new to-do changes what it reads");
  assert.equal(statuses.get(room.id, project.id, Date.now()).pending, false, "changed within the gap: keeps the last one");
  const next = statuses.get(room.id, project.id, Date.now() + STATUS_MIN_GAP_MS + 1);
  assert.deepEqual([next.text, next.pending], ["Paragraph 1", true]);
  await tick();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Email teams about the change/);
  db.raw.close();
});

test("without a model there is no paragraph", () => {
  const { db, room, project } = setup();
  assert.deepEqual(new ProjectStatuses(db, {} as Agent).get(room.id, project.id), { text: null, at: null, pending: false });
  db.raw.close();
});
