import assert from "node:assert/strict";
import { test } from "node:test";
import { type ListAnswer, ListKeeper, type ListModel } from "./liveList.ts";
import type { Segment } from "../shared/protocol.ts";

const T0 = Date.UTC(2026, 9, 23, 10);
const S = 1000;
const say = (n: number, at: number, text = `line ${n}`): Segment =>
  ({ id: `s${n}`, meetingId: "m", itemId: "i1", speakerId: "u", speakerName: "Joe Liang", kind: "speech", text, ts: T0 + at }) as Segment;
const answer = (a: Partial<ListAnswer> = {}): ListAnswer => ({ add: [], change: [], close: [], ...a });

/** A model that answers from a script, and records what it was asked. */
function scripted(answers: ListAnswer[]) {
  const asked: string[] = [];
  const model: ListModel = {
    async liveList(_context, talk) {
      asked.push(talk);
      return answers.shift() ?? answer();
    },
  };
  return { model, asked };
}
const run = (k: ListKeeper, talk: Segment[], now: number) => k.run(talk, ["Joe Liang", "Huy Ngo"], () => "i1", T0 + now);

test("lines are added once, from the new talk, and keep their id and words", async () => {
  const { model, asked } = scripted([
    answer({ add: [{ kind: "todo", who: "Huy Ngo", text: "Make the transcript an MD file", line: 2 }] }),
    answer({ add: [{ kind: "todo", who: "Huy", text: "Make the transcript an MD file", line: 3 }, { kind: "decided", who: "Joe", text: "Task is the one primitive", line: 3 }] }),
  ]);
  const k = new ListKeeper(model, T0);
  const talk = [say(1, 10 * S), say(2, 20 * S, "I'll make it an MD file")];
  assert.equal(await run(k, talk, 25 * S), true);
  assert.match(asked[0], /NEW \[2\] \[0:20\] Joe Liang: I'll make it an MD file/);
  const [todo] = k.notes("m");
  assert.deepEqual([todo.id, todo.kind, todo.owner, todo.ts], ["li_1", "action", "Huy", T0 + 20 * S]);

  talk.push(say(3, 40 * S));
  assert.equal(await run(k, talk, 45 * S), true);
  // The same to-do in the same words isn't added twice; a decision gets no owner.
  assert.deepEqual(k.notes("m").map((n) => [n.id, n.kind, n.owner, n.text]), [
    ["li_1", "action", "Huy", "Make the transcript an MD file"],
    ["li_2", "decision", null, "Task is the one primitive"],
  ]);
  // The list it was shown has the earlier line with its id; only line 3 is new.
  assert.match(asked[1], /\[li_1\] todo \(Huy\): Make the transcript an MD file/);
  assert.doesNotMatch(asked[1], /NEW \[2\]/);
  assert.match(asked[1], /NEW \[3\]/);
  // Nothing new said: no run.
  assert.equal(k.due(talk), false);
  assert.equal(await run(k, talk, 50 * S), false);
  assert.equal(asked.length, 2);
});

test("an answer Stand hears waits under its question until someone confirms it; done, dropped and wrong close lines", async () => {
  const { model, asked } = scripted([
    answer({ add: [{ kind: "open", who: null, text: "Should we move off Railway?", line: 1 }, { kind: "todo", who: "Joe", text: "Fix the API keys", line: 1 }] }),
    answer({ close: [{ id: "li_1", how: "answered", decision: "Move off Railway" }, { id: "li_2", how: "done", decision: null }] }),
    answer({ close: [{ id: "li_1", how: "answered", decision: "Move to Fly.io" }] }),
  ]);
  const k = new ListKeeper(model, T0);
  const talk = [say(1, 5 * S)];
  await run(k, talk, 10 * S);
  talk.push(say(2, 30 * S));
  await run(k, talk, 35 * S);
  let notes = k.notes("m");
  // Stand doesn't decide: the question stays open, and the decision it heard is only heard.
  assert.equal(notes.find((n) => n.id === "li_1")!.closed, null);
  assert.equal(notes.find((n) => n.id === "li_2")!.doneAt, T0 + 35 * S);
  // The decision is added even though it shares its words with the question it answers.
  const d = notes.find((n) => n.kind === "decision")!;
  assert.deepEqual([d.text, d.answers, d.heard], ["Move off Railway", "li_1", true]);

  // While one answer waits, the model is told so and a second one isn't added.
  talk.push(say(3, 50 * S));
  await run(k, talk, 55 * S);
  assert.match(asked[2], /\[li_1\] open: Should we move off Railway\? \(answer heard, waiting for someone to confirm\)/);
  assert.equal(k.notes("m").filter((n) => n.kind === "decision").length, 1);

  // A click confirms it: it's decided, and the question closes as answered.
  assert.equal(k.dismiss("li_2"), null);
  assert.ok(k.confirm(d.id, "Andy Li"));
  notes = k.notes("m");
  assert.equal(notes.find((n) => n.id === d.id)!.heard, false);
  assert.equal(notes.find((n) => n.id === "li_1")!.closed?.how, "answered");
  assert.equal(k.confirm(d.id, "Andy Li"), null);

  // The host takes a line off, and puts it back with Undo; someone ticks a to-do back on.
  assert.ok(k.remove(d.id));
  assert.equal(k.notes("m").some((n) => n.id === d.id), false);
  assert.ok(k.restore(d.id));
  assert.ok(k.notes("m").some((n) => n.id === d.id));
  assert.equal(k.setDone("li_2", null)?.doneAt, null);
  assert.equal(k.setDone("li_2", "Huy")?.doneBy, "Huy");
  // Only to-dos tick.
  assert.equal(k.setDone(d.id, "Huy"), null);
});

test("a decision heard in passing stays heard until a click, and Not yet keeps it off for good", async () => {
  const { model } = scripted([
    answer({ add: [{ kind: "decided", who: null, text: "Ask the agent by push-to-talk", line: 1 }, { kind: "open", who: null, text: "Which model should the agent use?", line: 1 }] }),
    answer({ close: [{ id: "li_2", how: "answered", decision: "Use Sonnet for the agent" }] }),
    answer({ add: [{ kind: "decided", who: null, text: "Use Sonnet for the agent", line: 3 }] }),
  ]);
  const k = new ListKeeper(model, T0);
  const talk = [say(1, 5 * S)];
  await run(k, talk, 10 * S);
  assert.equal(k.notes("m").find((n) => n.id === "li_1")!.heard, true);
  talk.push(say(2, 20 * S));
  await run(k, talk, 25 * S);
  // Someone says the heard answer isn't one: it goes, the question stays open, and it isn't heard again.
  assert.ok(k.dismiss("li_3"));
  talk.push(say(3, 40 * S));
  await run(k, talk, 45 * S);
  const notes = k.notes("m");
  assert.equal(notes.some((n) => n.id === "li_3"), false);
  assert.equal(notes.find((n) => n.id === "li_2")!.closed, null);
  assert.equal(notes.filter((n) => n.kind === "decision").length, 1);
  // A decision picked by hand (an option's Decide) is decided straight away.
  const picked = k.addByHand("decided", null, "Host Stand on Fly.io", "i1", "li_2");
  assert.equal(picked?.heard, undefined);
  assert.equal(k.notes("m").find((n) => n.id === "li_2")!.closed?.how, "answered");
});

test("a saved list picks up where it was", async () => {
  const { model } = scripted([answer({ add: [{ kind: "decided", who: null, text: "Ship the running list", line: 1 }] }), answer({ add: [{ kind: "decided", who: null, text: "Glow new lines", line: 2 }] })]);
  const k = new ListKeeper(model, T0);
  const talk = [say(1, 5 * S)];
  await run(k, talk, 10 * S);
  const again = new ListKeeper(model, T0, k.saved());
  assert.equal(again.due(talk), false);
  talk.push(say(2, 20 * S));
  await run(again, talk, 25 * S);
  assert.deepEqual(again.notes("m").map((n) => n.id), ["li_1", "li_2"]);
});

test("a carried task someone calls finished is heard, by its id, and never added to the list", async () => {
  const { model, asked } = scripted([answer({ said_done: [{ id: "t2", line: 1 }, { id: "t9", line: 1 }] })]);
  const k = new ListKeeper(model, T0);
  const talk = [say(1, 5 * S, "The docs are done, I pushed them")];
  await k.run(talk, ["Joe Liang"], () => "i1", T0 + 10 * S, [
    { id: "n1", who: "Joe", text: "Fix the deploy" },
    { id: "n2", who: "Huy", text: "Write the docs" },
  ]);
  assert.match(asked[0], /\[t2\] \(Huy\) Write the docs/);
  // t9 isn't a carried task: ignored.
  assert.deepEqual(k.heardDone.map((h) => [h.id, h.segment.id]), [["n2", "s1"]]);
  assert.deepEqual(k.notes("m"), []);
});
