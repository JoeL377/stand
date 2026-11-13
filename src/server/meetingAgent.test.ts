import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_MAX_RUNS, AgentKeeper, answerPrompt, AskCapture, costOf, draftOf, optionsPrompt, readPartial, SAY_EVERY_MS, SAY_MAX_CARDS, type SpaceHistory, toAnswer, toCard, typedAgentAsk, typedAsk } from "./meetingAgent.ts";
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

test("push-to-talk: only what's said while the button is down, a little before it too, is the question", () => {
  const asks = new AskCapture();
  assert.equal(asks.start("p1", "ag_1", T0), true);
  assert.equal(asks.start("p1", "ag_2", T0 + 100), false, "one hold at a time");
  asks.hear("p1", "earlier remark", T0 - 5_000);
  asks.hear("p1", "Stand, what does", T0 - 500);
  asks.hear("p2", "someone else talking", T0 + 1_000);
  asks.hear("p1", " Fly.io cost  for one instance?", T0 + 2_000);
  assert.equal(asks.end("p1", T0 + 4_000), "ag_1");
  assert.equal(asks.end("p1", T0 + 4_100), null, "ends once");
  // The last words' transcript lands after the button is up, with the time they were said.
  asks.hear("p1", "Thanks.", T0 + 3_900);
  asks.hear("p1", "Anyway, back to the board", T0 + 6_000);
  assert.deepEqual(asks.take("p1"), { cardId: "ag_1", question: "Stand, what does Fly.io cost for one instance? Thanks." });
  assert.equal(asks.take("p1"), null);
  assert.equal(asks.asking("p1"), false);
});

test("answers: listen, then answer or fail; follow-ups carry the last answers; a next step is taken once as a to-do", () => {
  const k = new AgentKeeper();
  const a = k.ask("Joe Liang", "p1", null, T0);
  assert.deepEqual([a.kind, a.status], ["answer", "listening"]);
  assert.equal(k.onQuestion("p1"), undefined, "an answer isn't an options card");
  assert.ok(k.heard(a.id, "What does Fly.io cost?"));
  assert.equal(a.status, "working");
  assert.equal(k.takeTodo(a.id, "Andy"), null, "nothing to take while it works");
  k.finishAnswer(a.id, { fields: { note: "About $2 a month for one small machine.", sources: [], todo: "Price out Fly.io for Stand", fromSpace: [] }, follows: null, model: "claude-sonnet-5-5", costUsd: 0.04 }, T0 + 15_000);
  assert.equal(a.status, "ready");
  assert.equal(k.pick(a.id, 0, "decision", "Andy"), null, "an answer is never picked as a decision");
  assert.ok(k.takeTodo(a.id, "Andy"));
  assert.equal(k.takeTodo(a.id, "Janesh"), null, "taken once");

  assert.deepEqual(k.followUp(T0 + 60_000).map((c) => c.id), [a.id]);
  assert.deepEqual(k.followUp(T0 + 20 * 60_000), [], "too long ago to follow up");

  const silent = k.ask("Janesh", "p2", null, T0);
  k.heard(silent.id, "");
  assert.equal(silent.status, "failed");
  const typed = k.ask("Andy", "p3", "which plan has SSO?", T0);
  assert.equal(typed.status, "working");

  const held = k.ask("Joe", "p1", null, T0);
  const again = new AgentKeeper(k.all());
  assert.equal(again.get(held.id)?.status, "failed", "a hold cut off by a restart doesn't hang");
});

test("@stand in the chat is a question for Stand", () => {
  assert.equal(typedAsk("@stand which Railway plan do we need?"), "which Railway plan do we need?");
  assert.equal(typedAsk("@Stand, what's Fly.io cost"), "what's Fly.io cost");
  assert.equal(typedAsk("@stand"), null);
  assert.equal(typedAsk("we should stand up a server"), null);
  assert.equal(typedAsk("@standup notes"), null);
});

test("@agent in the chat asks your own agent; alone it asks with no words", () => {
  assert.equal(typedAgentAsk("@agent which plan has SSO?"), "which plan has SSO?");
  assert.equal(typedAgentAsk("@Agent: read the spec"), "read the spec");
  assert.equal(typedAgentAsk("@agent"), "");
  assert.equal(typedAgentAsk("@agents are cool"), null);
  assert.equal(typedAgentAsk("ask the @agent"), null);
});

test("an ask to someone's own agent: a card at once, filled by its answer, failed when late, and filled late too", () => {
  const k = new AgentKeeper();
  const joe = { kind: "agent" as const, person: "Joe Liang", personId: "p1", agent: "opencode", connection: "tok1", model: "claude-fable-5-2" };
  const a = k.askAgent("Joe Liang", "p1", joe, "which plan has SSO?", T0);
  assert.deepEqual([a.kind, a.status, a.question, a.agent?.agent, a.to], ["answer", "working", "which plan has SSO?", "opencode", { personId: "p1", connection: "tok1" }]);
  assert.equal(k.canRun(), true);
  assert.deepEqual(k.openAsks("p1").map((c) => c.id), [a.id]);
  // Answering it is not a card of its own: no wait of 5 seconds, and it isn't counted.
  assert.equal(k.sayRefusal(joe, T0 + 1), null);
  assert.match(String(k.answerAsk(a.id, { ...joe, personId: "p2" }, { text: "Hi" })), /No ask of yours/);
  const filled = k.answerAsk(a.id, joe, { text: "Enterprise has SSO.", detail: "## Plans" }, T0 + 20_000);
  assert.notEqual(typeof filled, "string");
  assert.deepEqual([a.status, a.note, a.detail, a.readyAt], ["ready", "Enterprise has SSO.", "## Plans", T0 + 20_000]);
  assert.match(String(k.answerAsk(a.id, joe, { text: "Again" })), /answer already/);
  assert.equal(k.expireAsk(a.id), null, "an answered ask doesn't fail");
  assert.deepEqual(k.followUp(T0 + 30_000), [], "Stand doesn't follow up an agent's answer");

  const late = k.askAgent("Joe Liang", "p1", joe, "", T0);
  assert.ok(k.expireAsk(late.id, T0 + 180_000));
  assert.deepEqual([late.status, late.note], ["failed", "Joe's agent didn't answer. Is it still attached?"]);
  assert.deepEqual(k.openAsks("p1"), []);
  assert.notEqual(typeof k.answerAsk(late.id, joe, { text: "Sorry, here it is." }), "string");
  assert.equal(late.status, "ready");

  const cut = k.askAgent("Joe Liang", "p1", joe, "and Pro?", T0);
  const again = new AgentKeeper(k.all());
  assert.deepEqual([again.get(cut.id)?.status, again.get(cut.id)?.note], ["failed", "Stand restarted before the agent answered. Ask again."]);
  assert.equal(again.get(a.id)?.status, "ready");
});

test("an answer's prompt carries the asker, the question and what it follows up on", () => {
  const h = { name: "Conxt 1.0", purpose: "", decisions: [{ text: "Host on Railway for now", ts: T0 - 86_400_000 }], tasks: [], questions: [], notes: [] };
  const p = answerPrompt("and for two instances?", "Joe Liang", [say(1, 0, "we're on Railway")], T0 + MIN, h, [{ by: "Joe Liang", question: "What does Fly.io cost?", answer: "About $2 a month." }]);
  assert.match(p, /Joe Liang asks you: and for two instances\?/);
  assert.match(p, /You answered: About \$2 a month\./);
  assert.match(p, /D1 \(.*\) decided: Host on Railway for now/);
  const card = toAnswer({ answer: " About $4. ", sources: [{ url: "https://fly.io/pricing", title: "Fly pricing" }, { url: "not a link", title: "x" }], todo: " ", from_space: [{ key: "d1", line: "We chose Railway for now" }] }, h);
  assert.deepEqual(card, { note: "About $4.", sources: [{ url: "https://fly.io/pricing", title: "Fly pricing" }], todo: null, fromSpace: [{ text: "We chose Railway for now", when: T0 - 86_400_000 }] });
});

test("a streaming run's draft: the words so far, options as they come, searches kept", async () => {
  const answer = draftOf("answer", ["stripe checkout pricing"], readPartial('{"answer":"Stripe charges 2.9% plus 30'));
  assert.deepEqual(answer, { searches: ["stripe checkout pricing"], pages: [], text: "Stripe charges 2.9% plus 30", options: [] });
  const opts = draftOf("options", [], readPartial('{"options":[{"title":"Move to Fly.io","why":"Cheaper, but"},{"title":"Stay on'));
  assert.deepEqual(opts.options, [
    { title: "Move to Fly.io", why: "Cheaper, but" },
    { title: "Stay on", why: "" },
  ]);
  assert.equal(opts.text, null);
  // A half-written escape at the end is left off until it's whole.
  assert.deepEqual(readPartial('{"answer":"Say \\"hi\\'), { answer: 'Say "hi' });
  // Before any words: just the searches.
  assert.deepEqual(draftOf("answer", ["q"], null, ["stripe.com"]), { searches: ["q"], pages: ["stripe.com"], text: null, options: [] });
  // Once it's done the card drops its draft.
  const keeper = new AgentKeeper(null);
  const card = keeper.start("n1", "Where do we host?", "Joe", T0);
  keeper.draft(card.id, opts);
  assert.equal(keeper.get(card.id)?.draft?.options.length, 2);
  keeper.finish(card.id, { fields: { options: [], fromSpace: [], note: "Stay on Railway" }, model: "m", costUsd: 0 });
  assert.equal(keeper.get(card.id)?.draft, null);
});

test("a card from someone's own agent: ready at once, under their name, outside Stand's cap and its follow-ups", () => {
  const k = new AgentKeeper();
  const fable = { kind: "agent" as const, person: "Janesh Chhabra", personId: "u1", agent: "opencode", connection: "tok1", model: "claude-fable-5-2" };
  const other = { ...fable, person: "Joe Liang", personId: "u2", connection: "tok2" };

  const card = k.say(fable, { text: "The design misses retries.", detail: "## Why\nNo queue.", todo: "Add a retry queue", sources: [{ title: "fly.io", url: "https://fly.io/docs" }] }, 1_000);
  assert.equal(card.kind, "answer");
  assert.equal(card.status, "ready");
  assert.equal(card.by, "Janesh Chhabra");
  assert.equal(card.about, "u1");
  assert.equal(card.question, "");
  assert.equal(card.note, "The design misses retries.");
  assert.equal(card.detail, "## Why\nNo queue.");
  assert.deepEqual(card.agent, fable);
  assert.equal(card.model, "claude-fable-5-2");
  assert.equal(card.costUsd, null);

  // One card every few seconds from one agent; another person's agent isn't held back by it.
  assert.match(k.sayRefusal(fable, 1_000 + SAY_EVERY_MS - 1) ?? "", /every 5 seconds/);
  assert.equal(k.sayRefusal(other, 1_001), null);
  assert.equal(k.sayRefusal(fable, 1_000 + SAY_EVERY_MS), null);

  // Stand doesn't follow up what the agent said, and a question typed on its card starts a card of its own.
  assert.deepEqual(k.followUp(1_500), []);
  assert.equal(k.ask("Joe", "u2", "And for two?", 2_000, card.id).follows, null);

  // Anyone takes its next step, or dismisses it, as with Stand's cards.
  assert.equal(k.takeTodo(card.id, "Joe", 3_000)?.picked?.by, "Joe");
  assert.equal(k.dismiss(card.id, "Joe", 4_000)?.dismissed?.by, "Joe");

  // Stand ran no model for these, so they leave its runs alone; each agent has its own count.
  const busy = new AgentKeeper();
  for (let i = 0; i < SAY_MAX_CARDS; i++) busy.say(fable, { text: `Point ${i}` }, i * SAY_EVERY_MS);
  assert.equal(busy.canRun(), true);
  assert.match(busy.sayRefusal(fable, SAY_MAX_CARDS * SAY_EVERY_MS) ?? "", /30 cards/);
  assert.equal(busy.sayRefusal(other, SAY_MAX_CARDS * SAY_EVERY_MS), null);
  for (let i = 0; i < AGENT_MAX_RUNS; i++) busy.ask("Joe", "u2", `Question ${i}`);
  assert.equal(busy.canRun(), false);

  // Kept with the meeting: it reads back as it was.
  assert.deepEqual(new AgentKeeper(JSON.parse(JSON.stringify(k.all()))).get(card.id)?.agent, fable);
});
