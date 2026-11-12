import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { HeuristicAgent, type SweepInput, type SweepRow } from "./llm.ts";
import { sweepQuestions } from "./questionSweep.ts";
import { recordUsage, setUsageSink, type UsageRow } from "./usage.ts";

const tick = () => new Promise((r) => setTimeout(r, 3));

async function space() {
  const db = openDb(":memory:");
  const room = db.createRoom("Stand / Conxt", null, "");
  const m1 = db.startMeeting(room.id);
  /** One question after another, a moment apart, as they're asked. */
  const ask = async (text: string) => {
    await tick();
    return db.addNote(m1.id, null, { kind: "question", text, owner: null }, null);
  };
  const merge = await ask("Should Connect and Stand be merged?");
  const drive = await ask("Which part of Connect does Huy drive?");
  const price = await ask("What do we charge?");
  const gone = await ask("Who books the room?");
  db.endMeeting(m1.id, null);
  await tick();
  const m2 = db.startMeeting(room.id);
  const one = db.addNote(m2.id, null, { kind: "decision", text: "Build what Stand needs into Stand", owner: null }, null);
  const old = db.addNote(m2.id, null, { kind: "decision", text: "Port Connect one to one", owner: null }, null);
  db.endMeeting(m2.id, null);
  db.addOutsideMeeting(room.id, { kind: "context", text: "Conxt is frozen", owner: null, itemId: null }, "Huy");
  // Replaced decisions and closed questions aren't read.
  db.addLink(room.id, one.id, old.id, "replaces", "Huy");
  db.setTaskState(room.id, gone.id, { state: "dropped", by: "Joe" });
  return { db, room, merge, drive, price, one };
}

test("a sweep proposes which open questions a decision answers or nobody needs, and changes nothing", async () => {
  const { db, room, merge, drive, price, one } = await space();
  let calls = 0;
  let seen: SweepInput | null = null;
  const agent = Object.assign(new HeuristicAgent(), {
    sweepQuestions: async (_space: unknown, input: SweepInput): Promise<SweepRow[]> => {
      calls++;
      seen = input;
      const q = (text: string) => input.questions.find((x) => x.text === text)?.key ?? "gone";
      return [
        { key: q(merge.text), how: "answered", by: input.decisions[0].key, why: "Decided: build in Stand" },
        { key: q(drive.text), how: "drop", by: null, why: "  Conxt is frozen,\n so nobody drives a part of it " },
        // An answer that names no decision the space has, and a key it wasn't given, are no proposals.
        { key: q(price.text), how: "answered", by: "D9", why: "Made up" },
        { key: "Q99", how: "drop", by: null, why: "Not a question" },
      ];
    },
  });
  // Two people ask at once: one read.
  const [proposals, same] = await Promise.all([sweepQuestions(db, agent, room.id), sweepQuestions(db, agent, room.id)]);
  assert.equal(same, proposals);
  assert.deepEqual(
    [seen!.questions.map((x) => x.text), seen!.decisions.map((d) => d.text), seen!.context],
    [[merge.text, drive.text, price.text], [one.text], ["Conxt is frozen"]],
  );
  assert.deepEqual(
    proposals?.map((p) => [p.id, p.how, p.decision?.id ?? null, p.why]),
    [
      [merge.id, "answered", one.id, "Decided: build in Stand"],
      [drive.id, "drop", null, "Conxt is frozen, so nobody drives a part of it"],
    ],
  );
  assert.equal(db.getNote(merge.id)?.state ?? null, null, "nothing closes until someone confirms");
  // Nothing changed: the same list, without asking again. A question closing asks again.
  await sweepQuestions(db, agent, room.id);
  assert.equal(calls, 1);
  db.setTaskState(room.id, drive.id, { state: "dropped", by: "Joe" });
  await sweepQuestions(db, agent, room.id);
  assert.equal(calls, 2);
});

test("a sweep without a model, or one that fails, says so", async () => {
  const { db, room } = await space();
  assert.equal(await sweepQuestions(db, new HeuristicAgent(), room.id), null);
  const failing = Object.assign(new HeuristicAgent(), { sweepQuestions: async () => null });
  assert.equal(await sweepQuestions(db, failing, room.id), null);
});

test("a sweep's Claude call is kept with its space and no meeting", async () => {
  const { db, room } = await space();
  const rows: UsageRow[] = [];
  setUsageSink((r) => rows.push(r));
  try {
    const agent = Object.assign(new HeuristicAgent(), { sweepQuestions: async (): Promise<SweepRow[]> => (recordUsage("claude-sonnet-5-5", { input_tokens: 1, output_tokens: 1 }), []) });
    await sweepQuestions(db, agent, room.id);
  } finally {
    setUsageSink(null);
  }
  assert.deepEqual(rows.map((r) => [r.meetingId, r.roomId, r.task]), [[null, room.id, "sweepQuestions"]]);
});
