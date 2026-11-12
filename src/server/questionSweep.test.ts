import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { HeuristicAgent, type SweepInput, type SweepRow } from "./llm.ts";
import { QuestionSweeper, SWEEP_AFTER_NEW, SWEEP_STALE_MS, currentSweep, keepOpen, sweepQuestions } from "./questionSweep.ts";
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
  const name = await ask("What do we call it?");
  const host = await ask("Where does it run?");
  const ship = await ask("When do we ship?");
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
  /** Something new in the space: a line of context. */
  const learn = (text: string) => db.addOutsideMeeting(room.id, { kind: "context", text, owner: null, itemId: null }, "Huy");
  return { db, room, merge, drive, price, name, host, ship, one, old, learn };
}

/** A model that proposes the same two closes each time it is asked, and counts the asks. */
function scripted(s: Awaited<ReturnType<typeof space>>) {
  const model = { calls: 0, seen: null as SweepInput | null };
  const agent = Object.assign(new HeuristicAgent(), {
    sweepQuestions: async (_space: unknown, input: SweepInput): Promise<SweepRow[]> => {
      model.calls++;
      model.seen = input;
      const q = (text: string) => input.questions.find((x) => x.text === text)?.key ?? "gone";
      return [
        { key: q(s.merge.text), how: "answered", by: input.decisions[0].key, why: "Decided: build in Stand" },
        { key: q(s.drive.text), how: "drop", by: null, why: "  Conxt is frozen,\n so nobody drives a part of it " },
        // An answer that names no decision the space has, and a key it wasn't given, are no proposals.
        { key: q(s.price.text), how: "answered", by: "D9", why: "Made up" },
        { key: "Q99", how: "drop", by: null, why: "Not a question" },
      ];
    },
  });
  return { model, agent };
}

test("a sweep keeps which open questions a decision answers or nobody needs, and changes nothing", async () => {
  const s = await space();
  const { db, room, merge, drive, price, name, host, ship, one } = s;
  const { model, agent } = scripted(s);
  assert.equal(currentSweep(db, room.id), null, "nothing to show before the first sweep");
  assert.deepEqual(await sweepQuestions(db, agent, room.id), { swept: true, proposed: 2 });
  assert.deepEqual(
    [model.seen!.questions.map((x) => x.text), model.seen!.decisions.map((d) => d.text), model.seen!.context],
    [[merge.text, drive.text, price.text, name.text, host.text, ship.text], [one.text], ["Conxt is frozen"]],
  );
  assert.deepEqual(
    currentSweep(db, room.id)?.proposals.map((p) => [p.id, p.text, p.how, p.decision?.id ?? null, p.why]),
    [
      [merge.id, merge.text, "answered", one.id, "Decided: build in Stand"],
      [drive.id, drive.text, "drop", null, "Conxt is frozen, so nobody drives a part of it"],
    ],
  );
  assert.equal(db.getNote(merge.id)?.state ?? null, null, "nothing closes until someone confirms");
});

test("the next sweep waits for enough new questions, decisions or context", async () => {
  const s = await space();
  const { db, room, drive, learn } = s;
  const { model, agent } = scripted(s);
  const at = Date.now();
  await sweepQuestions(db, agent, room.id, at);
  // Nothing changed, however often it is asked for: the model isn't asked again.
  assert.deepEqual(await sweepQuestions(db, agent, room.id), { swept: false, proposed: 0 });
  // A question closing is nothing new to read, and a few new lines aren't enough.
  db.setTaskState(room.id, drive.id, { state: "dropped", by: "Joe" });
  for (let i = 1; i < SWEEP_AFTER_NEW; i++) learn(`Fact ${i}`);
  await sweepQuestions(db, agent, room.id, at + 1000);
  assert.equal(model.calls, 1);
  assert.equal(currentSweep(db, room.id)?.at, at, "the page still shows the last sweep");
  learn(`Fact ${SWEEP_AFTER_NEW}`);
  assert.deepEqual(await sweepQuestions(db, agent, room.id, at + 2000), { swept: true, proposed: 1 });
  assert.equal(model.calls, 2);
  assert.equal(currentSweep(db, room.id)?.at, at + 2000);
  // What it just read isn't new the next time.
  await sweepQuestions(db, agent, room.id, at + 3000);
  assert.equal(model.calls, 2);
});

test("a little that is new still gets a sweep once the last one is old", async () => {
  const s = await space();
  const { db, room, learn } = s;
  const { model, agent } = scripted(s);
  const at = Date.now();
  await sweepQuestions(db, agent, room.id, at);
  // Old, and nothing new: no sweep.
  await sweepQuestions(db, agent, room.id, at + SWEEP_STALE_MS);
  assert.equal(model.calls, 1);
  learn("Conxt moved to the new cluster");
  await sweepQuestions(db, agent, room.id, at + SWEEP_STALE_MS - 1);
  assert.equal(model.calls, 1, "one new line, and the last sweep is recent");
  await sweepQuestions(db, agent, room.id, at + SWEEP_STALE_MS);
  assert.equal(model.calls, 2);
});

test("a space with only a few open questions isn't swept", async () => {
  const s = await space();
  const { db, room, host, ship } = s;
  const { model, agent } = scripted(s);
  for (const q of [host, ship]) db.setTaskState(room.id, q.id, { state: "done", by: "Joe" });
  assert.deepEqual(await sweepQuestions(db, agent, room.id), { swept: false, proposed: 0 });
  assert.equal(model.calls, 0);
  assert.equal(currentSweep(db, room.id), null);
});

test("a proposal goes when its question closes or its decision is replaced", async () => {
  const s = await space();
  const { db, room, merge, drive, one } = s;
  const { agent } = scripted(s);
  await sweepQuestions(db, agent, room.id);
  db.setTaskState(room.id, drive.id, { state: "dropped", by: "Joe" });
  assert.deepEqual(currentSweep(db, room.id)?.proposals.map((p) => p.id), [merge.id]);
  db.setTaskState(room.id, drive.id, { state: "open", by: "Joe" });
  assert.deepEqual(currentSweep(db, room.id)?.proposals.map((p) => p.id), [merge.id, drive.id], "opened again, it is proposed again");
  const later = db.addOutsideMeeting(room.id, { kind: "decision", text: "Keep Connect and Stand apart", owner: null, itemId: null }, "Huy");
  db.addLink(room.id, later.id, one.id, "replaces", "Huy");
  assert.deepEqual(currentSweep(db, room.id)?.proposals.map((p) => p.id), [drive.id], "the decision that answered it no longer stands");
});

test("a proposal someone unticked stays open and isn't proposed or read again", async () => {
  const s = await space();
  const { db, room, merge, drive, price, learn } = s;
  const { model, agent } = scripted(s);
  await sweepQuestions(db, agent, room.id);
  // Only what Stand proposed can be kept.
  keepOpen(db, room.id, [drive.id, price.id, "nope"]);
  assert.deepEqual(db.getQuestionSweep(room.id)?.kept, [drive.id]);
  assert.deepEqual(currentSweep(db, room.id)?.proposals.map((p) => p.id), [merge.id]);
  for (let i = 1; i <= SWEEP_AFTER_NEW; i++) learn(`Fact ${i}`);
  await sweepQuestions(db, agent, room.id);
  assert.equal(model.calls, 2);
  assert.ok(!model.seen!.questions.some((q) => q.text === drive.text), "the next sweep leaves it out");
  assert.deepEqual(currentSweep(db, room.id)?.proposals.map((p) => p.id), [merge.id]);
  // Kept everything: nothing left to show.
  keepOpen(db, room.id, [merge.id]);
  assert.equal(currentSweep(db, room.id), null);
});

test("a question kept open while the model reads isn't proposed", async () => {
  const s = await space();
  const { db, room, merge, drive, learn } = s;
  const { agent } = scripted(s);
  await sweepQuestions(db, agent, room.id);
  for (let i = 1; i <= SWEEP_AFTER_NEW; i++) learn(`Fact ${i}`);
  const slow = Object.assign(new HeuristicAgent(), {
    sweepQuestions: async (space: unknown, input: SweepInput) => {
      keepOpen(db, room.id, [drive.id]);
      return agent.sweepQuestions(space, input);
    },
  });
  await sweepQuestions(db, slow, room.id);
  assert.deepEqual(currentSweep(db, room.id)?.proposals.map((p) => p.id), [merge.id]);
  assert.deepEqual(db.getQuestionSweep(room.id)?.kept, [drive.id]);
});

test("a sweep without a model, or one that fails, keeps nothing and is tried again", async () => {
  const s = await space();
  const { db, room } = s;
  assert.deepEqual(await sweepQuestions(db, new HeuristicAgent(), room.id), { swept: false, proposed: 0 });
  const failing = Object.assign(new HeuristicAgent(), { sweepQuestions: async () => null });
  assert.deepEqual(await sweepQuestions(db, failing, room.id), { swept: false, proposed: 0 });
  assert.equal(db.getQuestionSweep(room.id), null);
  const { model, agent } = scripted(s);
  await sweepQuestions(db, agent, room.id);
  assert.equal(model.calls, 1);
});

test("the sweeper reads a space once when two things ask at once, and not at all without a model", async () => {
  const s = await space();
  const { db, room } = s;
  const { model, agent } = scripted(s);
  const sweeper = new QuestionSweeper(db, agent);
  assert.deepEqual(db.roomsWithQuestions(6), [room.id]);
  assert.deepEqual(db.roomsWithQuestions(7), []);
  await Promise.all([sweeper.run(room.id), sweeper.run(room.id)]);
  assert.equal(model.calls, 1);
  assert.equal(currentSweep(db, room.id)?.proposals.length, 2);
  // A change in the space asks for a look after a wait; the look asks the model only when a sweep is due.
  for (let i = 1; i <= SWEEP_AFTER_NEW; i++) s.learn(`Fact ${i}`);
  sweeper.schedule(room.id, 0);
  sweeper.schedule(room.id, 0);
  for (let i = 0; i < 100 && model.calls < 2; i++) await tick();
  assert.equal(model.calls, 2);
  sweeper.schedule(room.id, 0);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(model.calls, 2);
  sweeper.start();
  sweeper.stop();
  const before = db.getQuestionSweep(room.id);
  for (let i = 1; i <= SWEEP_AFTER_NEW; i++) s.learn(`More ${i}`);
  const none = new QuestionSweeper(db, new HeuristicAgent());
  none.schedule(room.id, 0);
  none.start();
  await none.run(room.id);
  await tick();
  assert.deepEqual(db.getQuestionSweep(room.id), before);
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
