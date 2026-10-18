import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardAnswer, type BoardDrift, type BoardEdits, BoardKeeper, type BoardModel } from "./board.ts";
import type { Segment } from "../shared/protocol.ts";

const T0 = Date.UTC(2026, 9, 16, 10);
const S = 1000;
const card = (summary: string) => ({ summary: [summary], positions: [], items: [], now: "Joe: a point" });
const edits = (e: Partial<BoardEdits> = {}): BoardEdits => ({ sentences: [], dropSentences: [], positions: [], add: [], change: [], remove: [], now: "Joe: a point", ...e });
const say = (n: number, at: number, itemId: string | null = null): Segment => ({
  id: `s${n}`,
  meetingId: "m",
  itemId,
  speakerId: "u",
  speakerName: "Joe Liang",
  kind: "speech",
  text: `line ${n}`,
  ts: T0 + at,
} as Segment);

/** A model that answers from a script, and records what it was asked. */
function scripted(answers: Array<Partial<BoardAnswer>>, drifts: BoardDrift[] = []) {
  const asked: string[] = [];
  const driftAsked: string[] = [];
  const model: BoardModel = {
    async boardCard(_context, talk) {
      asked.push(talk);
      const a = answers.shift() ?? {};
      return { current: edits(), retitle: null, shift: null, ...a };
    },
    async boardDrift(_context, talk) {
      driftAsked.push(talk);
      return drifts.shift() ?? { verdict: "same", title: null };
    },
  };
  return { model, asked, driftAsked };
}
const shift = (title: string): BoardAnswer["shift"] => ({ kind: "new", returnTo: null, title, card: card(`about ${title}`) });

test("the first thread shows at once; a move shows only when it holds for two answers", async () => {
  const { model } = scripted([{ shift: shift("Audio bug") }, { shift: shift("Notes churn") }, {}, { shift: shift("Notes churn") }, { shift: shift("Notes churn") }]);
  const k = new BoardKeeper(model, T0);
  const talk: Segment[] = [];
  const step = async (n: number) => {
    talk.push(say(n * 2, n * 30 * S), say(n * 2 + 1, n * 30 * S + 5 * S));
    await k.run(talk, [], ["Joe Liang"], null, T0 + n * 30 * S + 10 * S);
    const b = k.board();
    return b.threads.find((t) => t.id === b.currentId)?.title;
  };
  assert.equal(await step(0), "Audio bug");
  // A one-off: proposed once, then the talk comes back.
  assert.equal(await step(1), "Audio bug");
  assert.equal(await step(2), "Audio bug");
  assert.equal(await step(3), "Audio bug");
  assert.equal(await step(4), "Notes churn");
  assert.equal(k.board().threads.length, 2);
  // The new thread's stretch starts where the move was first proposed.
  assert.equal(k.board().threads[1].spans[0][0], T0 + 3 * 30 * S);
});

test("the title can be sharpened once while the thread is young, never after", async () => {
  const { model } = scripted([{ shift: shift("Audio") }, { retitle: "First-join audio bug" }, { retitle: "Something else" }]);
  const k = new BoardKeeper(model, T0);
  const talk = [say(1, 0), say(2, 5 * S)];
  await k.run(talk, [], [], null, T0 + 10 * S);
  talk.push(say(3, 40 * S), say(4, 45 * S));
  await k.run(talk, [], [], null, T0 + 50 * S);
  assert.equal(k.board().threads[0].title, "First-join audio bug");
  talk.push(say(5, 70 * S), say(6, 75 * S));
  await k.run(talk, [], [], null, T0 + 80 * S);
  assert.equal(k.board().threads[0].title, "First-join audio bug");
});

test("going back to an earlier thread brings back its card, not a new one", async () => {
  const back: BoardAnswer["shift"] = { kind: "return", returnTo: "t1", title: "Audio bug", card: null };
  const { model } = scripted([{ shift: shift("Audio bug") }, { shift: shift("Pricing") }, { shift: shift("Pricing") }, { shift: back }, { shift: back }]);
  const k = new BoardKeeper(model, T0);
  const talk: Segment[] = [];
  for (let n = 0; n < 5; n++) {
    talk.push(say(n * 2, n * 30 * S), say(n * 2 + 1, n * 30 * S + 5 * S));
    await k.run(talk, [], [], null, T0 + n * 30 * S + 10 * S);
  }
  const b = k.board();
  assert.equal(b.threads.length, 2);
  assert.equal(b.currentId, "t1");
  assert.deepEqual(b.threads[0].card.summary, ["about Audio bug"]);
  assert.equal(b.threads[0].spans.length, 2);
});

test("after the host moves to another agenda item, the next thread there shows without waiting", async () => {
  const { model, asked } = scripted([{ shift: shift("Audio bug") }, {}, { shift: shift("Pricing toggle") }]);
  const k = new BoardKeeper(model, T0);
  const talk = [say(1, 0, "a"), say(2, 5 * S, "a")];
  await k.run(talk, [], [], "a", T0 + 10 * S);
  k.focused("b", T0 + 20 * S);
  // Nothing said on the new item yet: the old thread stays put but isn't updated.
  talk.push(say(3, 15 * S, "a"));
  await k.run(talk, [], [], "b", T0 + 25 * S);
  assert.equal(k.board().threads.length, 1);
  assert.deepEqual(k.board().threads[0].card.summary, ["about Audio bug"]);
  talk.push(say(4, 40 * S, "b"));
  await k.run(talk, [], [], "b", T0 + 45 * S);
  const b = k.board();
  assert.equal(b.threads.length, 2);
  assert.equal(b.threads[1].itemId, "b");
  assert.equal(b.currentId, b.threads[1].id);
  assert.match(asked[1], /host just moved the meeting/);
});

test("the drift check reads only the title and the talk, and a move it finds is put to the card model", async () => {
  const { model, asked, driftAsked } = scripted(
    [{ shift: shift("Recap page review") }, {}, {}, {}, { shift: shift("Can an agent catch drift?") }, { shift: shift("Can an agent catch drift?") }],
    [{ verdict: "moved", title: "Can an agent catch drift?" }],
  );
  const k = new BoardKeeper(model, T0);
  const talk: Segment[] = [];
  for (let n = 0; n < 6; n++) {
    talk.push(say(n * 2, n * 30 * S), say(n * 2 + 1, n * 30 * S + 5 * S));
    await k.run(talk, [], [], null, T0 + n * 30 * S + 10 * S);
  }
  assert.equal(driftAsked.length, 1);
  assert.doesNotMatch(driftAsked[0], /Summary:/);
  assert.match(asked[4], /moved off the title on screen, to: "Can an agent catch drift\?"/);
  assert.equal(k.board().threads.at(-1)!.title, "Can an agent catch drift?");
});

test("a run needs new talk, and a card skips a lone line", async () => {
  const { model, asked } = scripted([{ shift: shift("Audio bug") }]);
  const k = new BoardKeeper(model, T0);
  const talk = [say(1, 0)];
  assert.equal(k.due(talk), true);
  await k.run(talk, [], [], null, T0 + 10 * S);
  assert.equal(k.due(talk), false);
  talk.push(say(2, 20 * S));
  assert.equal(k.due(talk), false);
  talk.push(say(3, 25 * S));
  assert.equal(k.due(talk), true);
  assert.equal(asked.length, 1);
});

test("a saved board carries on after a restart", async () => {
  const { model } = scripted([{ shift: shift("Audio bug") }]);
  const k = new BoardKeeper(model, T0);
  await k.run([say(1, 0), say(2, 5 * S)], [], [], null, T0 + 10 * S);
  const again = new BoardKeeper(scripted([]).model, T0, JSON.parse(JSON.stringify(k.board())));
  assert.equal(again.board().currentId, "t1");
  assert.equal(again.due([say(1, 0), say(2, 5 * S)]), false);
});

test("an update changes only what it names: lines keep their ids and places", async () => {
  const first = { kind: "new" as const, returnTo: null, title: "Pricing toggle", card: { summary: ["Sam ships the toggle.", "Jordan worries about copy."], positions: [{ who: "Sam", text: "ship it" }, { who: "Jordan", text: "fix the copy first" }], items: [{ kind: "open" as const, who: null, text: "20 or 17 percent?" }], now: "Sam: it's in review" } };
  const { model } = scripted([
    { shift: first },
    { current: edits({ sentences: [{ n: 2, text: "Jordan found billing gives 17 percent." }], positions: [{ who: "Jordan Lee", text: "copy must say 17 percent" }], add: [{ kind: "todo", who: "Sam", text: "Change the copy" }] }) },
    { current: edits({ remove: ["d3"], add: [{ kind: "decided", who: null, text: "Copy says 17 percent" }] }) },
  ]);
  const k = new BoardKeeper(model, T0);
  const talk = [say(1, 0), say(2, 5 * S)];
  await k.run(talk, [], [], null, T0 + 10 * S);
  const before = k.board().threads[0].card;
  assert.deepEqual(before.details.map((d) => d.id), ["d1", "d2", "d3"]);
  talk.push(say(3, 40 * S), say(4, 45 * S));
  await k.run(talk, [], [], null, T0 + 50 * S);
  let c = k.board().threads[0].card;
  assert.deepEqual(c.summary, ["Sam ships the toggle.", "Jordan found billing gives 17 percent."]);
  assert.deepEqual(c.details.map((d) => [d.id, d.kind, d.text]), [
    ["d1", "position", "ship it"],
    ["d2", "position", "copy must say 17 percent"],
    ["d3", "open", "20 or 17 percent?"],
    ["d4", "todo", "Change the copy"],
  ]);
  // The first line is the same object: nothing about it changed.
  assert.equal(c.details[0], before.details[0]);
  talk.push(say(5, 70 * S), say(6, 75 * S));
  await k.run(talk, [], [], null, T0 + 80 * S);
  c = k.board().threads[0].card;
  assert.deepEqual(c.details.map((d) => d.id), ["d1", "d2", "d4", "d5"]);
});

test("a card saved in the old shape is read as sentences and lines with ids", () => {
  const old = { threads: [{ id: "t1", title: "Audio", itemId: null, spans: [[T0, T0 + 5 * S]], card: { summary: "One thing. Another thing.", now: "Joe: x", details: [{ kind: "position", who: "Joe", text: "a" }, { kind: "ref", who: null, text: "b" }, { kind: "open", who: null, text: "c" }] } }], currentId: "t1", switchedAt: T0, busy: false };
  const k = new BoardKeeper(scripted([]).model, T0, old as never);
  const c = k.board().threads[0].card;
  assert.deepEqual(c.summary, ["One thing.", "Another thing."]);
  assert.deepEqual(c.details.map((d) => [d.id, d.kind]), [["d1", "position"], ["d2", "open"]]);
});

test("a move waiting to be confirmed shows on the board, and accepting it switches at once", async () => {
  const { model } = scripted([{ shift: shift("Audio bug") }, { shift: shift("Pricing") }]);
  const k = new BoardKeeper(model, T0);
  const talk = [say(1, 0), say(2, 5 * S)];
  await k.run(talk, [], [], null, T0 + 10 * S);
  assert.equal(k.board().pending, null);
  talk.push(say(3, 40 * S), say(4, 45 * S));
  await k.run(talk, [], [], null, T0 + 50 * S);
  assert.deepEqual(k.board().pending, { kind: "new", title: "Pricing" });
  assert.equal(k.accept("Something else", T0 + 55 * S), false);
  assert.equal(k.accept("Pricing", T0 + 55 * S), true);
  const b = k.board();
  assert.equal(b.threads.find((t) => t.id === b.currentId)?.title, "Pricing");
  assert.equal(b.pending, null);
  assert.equal(b.threads[1].spans[0][0], T0 + 40 * S);
});
