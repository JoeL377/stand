import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainCaught, Segment } from "../shared/protocol.ts";
import { brainstormsOf, finishBrainstorm, startBrainstorm, toBrainstormView } from "./brainstorm.ts";
import { openDb } from "./db.ts";
import { type DiagramAnswer, DiagramKeeper, MAX_WAITING, diagramMermaid, draftSpec, isDiagramText, mermaidIn, parseSeed, saveDraftSpec, seedFromAnswer } from "./designSession.ts";

const T0 = 1_700_000_000_000;
const seg = (n: number, speakerName: string, text: string): Segment => ({ id: `s${n}`, meetingId: "m", itemId: null, speakerId: speakerName, speakerName, kind: "speech", text, ts: T0 + n * 1000 }) as Segment;
const none: DiagramAnswer = { boxes: [], arrows: [], extend: [], caught: [] };

test("a starting diagram is read as typed: boxes, arrows, and a mermaid flowchart", () => {
  const d = parseSeed(["Task: a to-do with an owner", "- Project: a group of tasks", "Task -> Project: belongs to", "Decision", "Question → Decision: becomes", "We talked about a lot of things today."].join("\n"), T0);
  assert.deepEqual(d.boxes.map((b) => [b.id, b.label, b.detail]), [["b1", "Task", "a to-do with an owner"], ["b2", "Project", "a group of tasks"], ["b3", "Decision", null], ["b4", "Question", null]]);
  assert.deepEqual(d.arrows.map((a) => [a.from, a.to, a.label]), [["b1", "b2", "belongs to"], ["b4", "b3", "becomes"]]);
  // Everything a person pasted is kept, not suggested.
  assert.ok(d.boxes.every((b) => !b.suggested) && d.arrows.every((a) => !a.suggested));

  const m = parseSeed("```mermaid\nflowchart LR\n  t[Task] -->|belongs to| p[Project]\n  t -- waits on --> t2[Other task]\n  p --> s((Space))\n```");
  assert.deepEqual(m.boxes.map((b) => b.label), ["Task", "Project", "Other task", "Space"]);
  assert.deepEqual(m.arrows.map((a) => [a.from, a.to, a.label]), [["b1", "b2", "belongs to"], ["b1", "b3", "waits on"], ["b2", "b4", ""]]);

  assert.equal(isDiagramText("Task: a to-do\nTask -> Project: belongs to\nDecision"), true);
  assert.equal(isDiagramText("We met on Tuesday and talked about how tasks should work.\nNobody agreed on what a project is, which is a problem."), false);
  assert.equal(mermaidIn("# Plan\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\ntext"), "flowchart LR\n  a --> b\n");
  // Notes the model read: its boxes and arrows, all kept.
  const fromModel = seedFromAnswer({ ...none, boxes: [{ label: "Idea", detail: "Something raised.", by: null, line: 0 }, { label: "Spec", detail: "A written plan.", by: null, line: 0 }], arrows: [{ from: "new1", to: "new2", label: "turns into", by: null, line: 0 }] }, T0);
  assert.deepEqual([fromModel.boxes.map((b) => b.label), fromModel.arrows.map((a) => [a.from, a.to, a.label])], [["Idea", "Spec"], [["b1", "b2", "turns into"]]]);
});

test("what Stand hears is a suggestion until someone keeps it, and a dropped one never comes back", async () => {
  const answers: DiagramAnswer[] = [];
  const asked: string[] = [];
  const model = { designDiagram: async (_c: string, talk: string) => (asked.push(talk), answers.shift() ?? none) };
  const k = new DiagramKeeper(model, "Stand's primitives", T0, parseSeed("Task: a to-do\nProject: a group of tasks", T0), "Task: a to-do");
  const caught: BrainCaught[] = [{ id: "li_1", kind: "question", text: "Is an idea a primitive?", owner: null, done: false }];
  const talk = [seg(1, "Joe Liang", "A task should belong to one project."), seg(2, "Janesh", "And we need an idea, which can become a task.")];

  answers.push({
    boxes: [{ label: "Idea", detail: "Something raised that isn't a to-do yet.", by: "Janesh", line: 2 }, { label: "task", detail: "Same thing again.", by: "Joe", line: 1 }],
    arrows: [{ from: "b1", to: "b2", label: "Belongs to.", by: "Joe", line: 1 }, { from: "new1", to: "b1", label: "becomes", by: "Janesh", line: 2 }, { from: "new2", to: "b2", label: "is in", by: null, line: 1 }],
    extend: [{ id: "b1", point: "Has exactly one project", by: "Joe", line: 1 }],
    caught: [{ id: "new1", item: "li_1" }, { id: "b1", item: "li_1" }],
  });
  assert.equal(await k.run(talk, ["Joe Liang", "Janesh"], caught, T0, T0 + 5000), true);
  let d = k.all();
  // "task" is already there, so it isn't suggested again; its arrow finds the Task that is there and
  // that pair is already joined.
  assert.deepEqual(d.boxes.map((b) => [b.id, b.label, !!b.suggested, b.by]), [["b1", "Task", false, null], ["b2", "Project", false, null], ["b3", "Idea", true, "Janesh"]]);
  assert.deepEqual(d.arrows.map((a) => [a.id, a.from, a.to, a.label, !!a.suggested]), [["a1", "b1", "b2", "Belongs to", true], ["a2", "b3", "b1", "becomes", true]]);
  assert.deepEqual(d.boxes[0].points.map((p) => p.text), ["Has exactly one project"]);
  assert.deepEqual(d.boxes[0].caught.map((c) => c.id), ["li_1"]);
  assert.equal(d.boxes[2].quote?.speaker, "Janesh");
  assert.match(asked[0], /NEW \[1\].*belong to one project/);

  // Keeping an arrow keeps the suggested box at its end. Nothing new: no pass.
  assert.equal(k.keep("a2"), true);
  assert.deepEqual([k.all().boxes[2].suggested, k.all().arrows[1].suggested], [undefined, undefined]);
  assert.equal(k.keep("a2"), false);
  assert.equal(await k.run(talk, ["Joe Liang"], caught, T0, T0 + 6000), false);

  // Dropped: it leaves the diagram, the model is told, and the same thing isn't suggested again.
  assert.equal(k.drop("a1"), true);
  answers.push({ ...none, boxes: [{ label: "Sprint", detail: "A two week box.", by: "Joe", line: 1 }], arrows: [{ from: "b2", to: "b1", label: "has many", by: "Joe", line: 1 }] });
  talk.push(seg(8, "Joe Liang", "Maybe sprints. And a project has many tasks."));
  await k.run(talk, ["Joe Liang"], caught, T0, T0 + 9000);
  assert.match(asked[1], /Dropped by the team[^]*Task --Belongs to--> Project/);
  assert.match(asked[1], /\[b3\] Idea:/);
  d = k.all();
  assert.deepEqual(d.arrows.filter((a) => !a.removed).map((a) => a.id), ["a2"]);
  assert.equal(k.drop("b4"), true);
  answers.push({ ...none, boxes: [{ label: "Sprint", detail: "Again.", by: null, line: 1 }] });
  talk.push(seg(12, "Janesh", "Sprints, really?"));
  await k.run(talk, ["Janesh"], caught, T0, T0 + 13000);
  assert.deepEqual(k.all().boxes.filter((b) => !b.removed).map((b) => b.label), ["Task", "Project", "Idea"]);

  // The board stays calm: past a handful waiting, new suggestions are left out.
  answers.push({ ...none, boxes: Array.from({ length: MAX_WAITING + 4 }, (_, i) => ({ label: `Zq${i} thing${i}`, detail: `Part number ${i}.`, by: null, line: 1 })) });
  talk.push(seg(20, "Joe Liang", "Lots of things."));
  await k.run(talk, ["Joe Liang"], caught, T0, T0 + 21000);
  assert.equal(k.all().boxes.filter((b) => b.suggested && !b.removed).length, MAX_WAITING);

  // A restarted server carries on: ids continue and talk it has read isn't read again.
  const again = new DiagramKeeper(model, "Stand's primitives", T0, JSON.parse(JSON.stringify(k.all())));
  assert.equal(again.unreadSince(talk), null);
  // Taking a box off takes its arrows with it.
  assert.equal(k.drop("b3"), true);
  assert.equal(k.all().arrows.find((a) => a.id === "a2")?.removed, true);
});

test("the session ends as a draft spec on its to-do, and its page shows the diagram", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Conxt 1.0", null, "");
  const diagram = parseSeed("Task: a to-do with an owner\nProject: a group of tasks\nTask -> Project: belongs to", T0);
  diagram.boxes.push({ id: "b3", label: "Sprint", detail: "Not agreed.", by: "Joe", ts: T0, quote: null, points: [], caught: [], suggested: true });
  diagram.boxes[0].points.push({ text: "Has one owner", by: "Joe", ts: T0, quote: null });
  diagram.boxes[0].caught.push({ id: "n1", kind: "decision", text: "A task has one project", owner: null, done: false });
  const b = startBrainstorm(db, room.id, "Stand's primitives", "Joe Liang", T0, { diagram, seed: "Task: a to-do", taskId: null });
  assert.equal(b.kind, "design");
  // Its view carries the diagram; a brainstorm's doesn't.
  assert.deepEqual(toBrainstormView(b).design?.boxes.map((x) => x.label), ["Task", "Project", "Sprint"]);
  assert.deepEqual(brainstormsOf(db, room.id)[0].design, { boxes: 2, arrows: 1 });
  // The same sentence as a plain brainstorm is another thing.
  assert.equal(toBrainstormView(startBrainstorm(db, room.id, "Something else", "Joe Liang", T0 + 1)).design, undefined);
  startBrainstorm(db, room.id, "Stand's primitives", "Joe Liang", T0 + 2, { diagram, seed: null, taskId: null });

  const caught: BrainCaught[] = [
    { id: "n1", kind: "decision", text: "A task has one project", owner: null, done: false },
    { id: "n2", kind: "question", text: "What is an idea?", owner: null, done: false },
    { id: "n3", kind: "action", text: "Write up projects", owner: "Janesh", done: false },
  ];
  assert.equal(diagramMermaid(diagram), 'flowchart LR\n  b1["Task"]\n  b2["Project"]\n  b1 -->|"belongs to"| b2');
  const spec = draftSpec("Stand's primitives", diagram, caught);
  assert.match(spec, /^# Stand's primitives\n/);
  assert.match(spec, /```mermaid\nflowchart LR[^]*```/);
  assert.match(spec, /## Parts\n\n- \*\*Task\*\*: a to-do with an owner\n {2}- Has one owner\n- \*\*Project\*\*: a group of tasks/);
  assert.match(spec, /## How they relate\n\n- Task belongs to Project/);
  assert.match(spec, /## Decided\n\n- A task has one project \(Task\)/);
  assert.match(spec, /## Open questions\n\n- What is an idea\?/);
  assert.match(spec, /## To-dos\n\n- Write up projects, Janesh/);
  assert.match(spec, /## Suggested, not kept\n\n- Sprint: Not agreed\./);

  const m = db.startMeeting(room.id);
  const done = finishBrainstorm(db, room.id, m.id, T0 + 99)!;
  const taskId = saveDraftSpec(db, done, caught)!;
  const task = db.getNote(taskId)!;
  assert.deepEqual([task.kind, task.text, task.owner], ["action", "Design: Stand's primitives", "Joe Liang"]);
  assert.equal(db.notePlan(taskId)?.text, spec);
  assert.equal(db.notePlan(taskId)?.by, "Stand");
  assert.equal(db.getBrainstorm(done.id)?.taskId, taskId);
  assert.match(db.noteUpdates(taskId).at(-1)!.text, /Draft spec from the design session/);
  // A session that named its to-do saves there, as a new version; one with nothing kept saves nothing.
  const next = finishBrainstorm(db, room.id, m.id) ?? startBrainstorm(db, room.id, "Round two", "Joe Liang", T0 + 200, { diagram, seed: null, taskId });
  assert.equal(saveDraftSpec(db, { ...next, meetingId: m.id }, []), taskId);
  assert.equal(db.planVersions(taskId).length, 2);
  assert.equal(saveDraftSpec(db, { ...next, diagram: { boxes: [diagram.boxes[2]], arrows: [] } }, []), null);
});
