import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { HeuristicAgent, type SettleInput, type SettleRow } from "./llm.ts";
import { settleSpace, settledView } from "./spaceSettle.ts";

const tick = () => new Promise((r) => setTimeout(r, 3));
/** One note after another, a moment apart, as they're said. */
const said = async <T,>(add: () => T) => {
  await tick();
  return add();
};

test("the space page drops answered and repeated questions and marks replaced decisions, only looking forward", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Stand / Conxt", null, "");
  const m1 = db.startMeeting(room.id);
  const keep = await said(() => db.addNote(m1.id, null, { kind: "decision", text: "Keep Connect separate from Stand for now", owner: null }, null));
  const merge = await said(() => db.addNote(m1.id, null, { kind: "question", text: "Should Connect and Stand be merged?", owner: null }, null));
  const janesh = await said(() => db.addNote(m1.id, null, { kind: "question", text: "Wait for Janesh before deciding?", owner: null }, null));
  db.endMeeting(m1.id, null);
  await tick();
  const m2 = db.startMeeting(room.id);
  const one = await said(() => db.addNote(m2.id, null, { kind: "decision", text: "Connect and Stand are one product", owner: null }, null));
  const again = await said(() => db.addNote(m2.id, null, { kind: "question", text: "Should we wait for Janesh's view?", owner: null }, null));
  const role = await said(() => db.addNote(m2.id, null, { kind: "question", text: "Which part does Huy drive?", owner: null }, null));
  db.endMeeting(m2.id, null);

  let calls = 0;
  let seen: SettleInput[] = [];
  const agent = Object.assign(new HeuristicAgent(), {
    settleSpace: async (_space: unknown, notes: SettleInput[]): Promise<SettleRow[]> => {
      calls++;
      seen = notes;
      const key = (text: string) => notes.find((n) => n.text === text)!.key;
      return [
        { key: key(keep.text), by: key(one.text), how: "replaced" },
        { key: key(merge.text), by: key(one.text), how: "answered" },
        { key: key(janesh.text), by: key(again.text), how: "repeated" },
        // Pointing back in time, or a decision "answered" by a question, is ignored.
        { key: key(one.text), by: key(keep.text), how: "replaced" },
        { key: key(role.text), by: key(merge.text), how: "answered" },
      ];
    },
  });
  await settleSpace(db, agent, room.id);
  assert.deepEqual(
    seen.map((n) => n.text),
    [keep.text, merge.text, janesh.text, one.text, again.text, role.text],
  );
  const view = settledView(db, room.id);
  assert.deepEqual(
    view.open.map((n) => n.text),
    [role.text, again.text],
  );
  assert.deepEqual(
    view.decided.map((n) => [n.text, n.replacedBy?.text ?? null]),
    [
      [one.text, null],
      [keep.text, one.text],
    ],
  );
  // Nothing changed: no second call.
  await settleSpace(db, agent, room.id);
  assert.equal(calls, 1);
});

test("without a model nothing is settled and every meeting's open questions show", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Space", null, "");
  for (const text of ["First question?", "Second question?"]) {
    const m = db.startMeeting(room.id);
    db.addNote(m.id, null, { kind: "question", text, owner: null }, null);
    db.endMeeting(m.id, null);
    await tick();
  }
  await settleSpace(db, new HeuristicAgent(), room.id);
  assert.deepEqual(
    settledView(db, room.id).open.map((n) => n.text),
    ["Second question?", "First question?"],
  );
});
