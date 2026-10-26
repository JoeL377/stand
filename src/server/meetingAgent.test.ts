import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_MAX_RUNS, AgentKeeper, costOf, optionsPrompt, type SpaceHistory, toCard } from "./meetingAgent.ts";
import { type ListAnswer, ListKeeper } from "./liveList.ts";
import type { Segment } from "../shared/protocol.ts";

const T0 = Date.UTC(2026, 9, 25, 22);
const MIN = 60_000;
const say = (n: number, at: number, text: string): Segment =>
  ({ id: `s${n}`, meetingId: "m", itemId: "i1", speakerId: "u", speakerName: "Joe Liang", kind: "speech", text, ts: T0 + at }) as Segment;

const history: SpaceHistory = {
  name: "Conxt 1.0",
  purpose: "Ship Conxt 1.0",
  decisions: [{ text: "Keep the API on one instance for now", ts: Date.UTC(2026, 9, 17) }],
  tasks: [{ text: "Give Huy Railway access", owner: "Andy", ts: Date.UTC(2026, 9, 22) }],
  questions: [],
  notes: [{ text: "Railway bill was $40 last month", by: "Joe", ts: Date.UTC(2026, 9, 20) }],
};

test("the prompt carries the question, recent talk only, and the history with keys and dates", () => {
  const p = optionsPrompt("Where do we migrate off Railway?", [say(1, 0, "old talk"), say(2, 9 * MIN, "we should migrate off Railway")], T0 + 10 * MIN, history);
  assert.match(p, /Open question on the board: Where do we migrate off Railway\?/);
  assert.match(p, /we should migrate off Railway/);
  assert.doesNotMatch(p, /old talk/);
  assert.match(p, /D1 \(2026-10-17\) decided: Keep the API on one instance/);
  assert.match(p, /T1 \(2026-10-22\) open to-do \(Andy\): Give Huy Railway access/);
  assert.match(p, /N1 \(2026-10-20\) note by Joe: Railway bill/);
});

test("an answer becomes card fields: at most 4 options, real links only, history keys back to dated lines", () => {
  const card = toCard(
    {
      options: [
        { title: "Move hosting to Fly.io", why: "Cheap, close to Railway", source_url: "https://fly.io/pricing", source_title: "Fly pricing" },
        { title: "Move hosting to Render", why: "Simple", source_url: "not a url", source_title: null },
        { title: "Stay on Railway", why: "No work", source_url: null, source_title: null },
        { title: "Move to AWS", why: "Most control", source_url: null, source_title: null },
        { title: "Fifth", why: "Too many", source_url: null, source_title: null },
      ],
      from_space: [
        { key: "n1", line: "Railway cost $40 last month" },
        { key: "N1", line: "duplicate" },
        { key: "X9", line: "made up" },
      ],
      note: null,
    },
    history,
  );
  assert.equal(card.options.length, 4);
  assert.deepEqual(card.options[0].source, { title: "Fly pricing", url: "https://fly.io/pricing" });
  assert.equal(card.options[1].source, null);
  assert.deepEqual(card.fromSpace, [{ text: "Railway cost $40 last month", when: Date.UTC(2026, 9, 20) }]);
  assert.equal(card.note, null);
});

test("cost counts tokens and searches on known models only", () => {
  assert.equal(costOf("claude-sonnet-5-5", { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0, searches: 3 }), 0.06);
  assert.equal(costOf("some-other-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, searches: 0 }), null);
});

test("cards: one live card per question, picked once, capped per meeting, kept across a restart", () => {
  const k = new AgentKeeper();
  const c = k.start("li_1", "Where to host?", "Janesh");
  assert.equal(k.onQuestion("li_1")?.id, c.id);
  assert.equal(k.pick(c.id, 0, "decision", "Joe"), null, "nothing to pick while it's working");
  k.finish(c.id, { fields: { options: [{ title: "Move hosting to Fly.io", why: "x", source: null }], fromSpace: [], note: null }, model: "claude-sonnet-5-5", costUsd: 0.05 });
  assert.equal(c.status, "ready");
  assert.equal(k.pick(c.id, 3, "decision", "Joe"), null, "no such option");
  assert.ok(k.pick(c.id, 0, "decision", "Joe"));
  assert.equal(k.pick(c.id, 0, "task", "Huy"), null, "already picked");

  const failed = k.start("li_2", "Who?", "Huy");
  k.finish(failed.id, { fields: { options: [], fromSpace: [], note: null }, model: "m", costUsd: null });
  assert.equal(failed.status, "failed");
  assert.equal(k.onQuestion("li_2"), undefined, "a failed card can be tried again");

  const again = new AgentKeeper(k.all());
  assert.equal(again.start("li_3", "Q", "Joe").id, "ag_3");
  while (again.canRun()) again.start("li_x", "Q", "Joe");
  assert.equal(again.all().length, AGENT_MAX_RUNS);
});

test("a picked decision answers its open question on the list", async () => {
  const model = { liveList: async (): Promise<ListAnswer> => ({ add: [{ kind: "open", who: null, text: "Where do we migrate off Railway?", line: 1 }], change: [], close: [] }) };
  const list = new ListKeeper(model, T0);
  await list.run([say(1, 0, "where do we even move to")], ["Joe"], () => "i1", T0 + MIN);
  const q = list.saved()[0];
  const d = list.addByHand("decided", null, "Move hosting to Fly.io", "i1", q.id);
  assert.ok(d);
  assert.equal(d.answers, q.id);
  assert.equal(list.get(q.id)?.closed?.how, "answered");
  assert.equal(list.addByHand("decided", null, "Move hosting to Fly.io", "i1"), null, "not twice");
});
