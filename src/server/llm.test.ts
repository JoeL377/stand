import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { ClaudeAgent, NotesTrouble, notesPrompt, turnNumbers } from "./llm.ts";
import type { Segment } from "../shared/protocol.ts";

const said = (n: number): Segment[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    meetingId: "m",
    itemId: null,
    speakerId: i % 2 ? "u1" : "u2",
    speakerName: i % 2 ? "Joe" : "Andy",
    kind: "speech" as const,
    text: `Remark number ${i + 1} about the conflict page`,
    ts: i * 1000,
  }));

/** A ClaudeAgent whose API calls land here instead. */
function withApi(answer: (body: Anthropic.Beta.MessageCreateParams, opts?: { timeout?: number }) => unknown) {
  const agent = new ClaudeAgent("test-key");
  const calls: Array<{ body: Anthropic.Beta.MessageCreateParams; opts?: { timeout?: number } }> = [];
  (agent as unknown as { client: unknown }).client = {
    beta: {
      messages: {
        parse: async (body: Anthropic.Beta.MessageCreateParams, opts?: { timeout?: number }) => {
          calls.push({ body, opts });
          return answer(body, opts);
        },
      },
    },
  };
  return { agent, calls };
}

const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const noteReply = {
  stop_reason: "end_turn",
  usage,
  parsed_output: {
    summary: "",
    discussions: [
      {
        topic: "Conflict page",
        turns: [1, 2, 70],
        positions: [],
        outcome: "action",
        continues: null,
        decisions: [],
        action_items: [{ text: "Make the Keep button stand out", owner: "Joe", same_as: null }],
        open_questions: [],
      },
    ],
  },
};

test("the notes prompt keeps a long transcript in blocks by line number, cached up to the last one talk moved past", () => {
  const line = (n: number) => ({ n, text: `[${n}] Joe: line ${n}` });
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
  const early = notesPrompt("Item: General", lines(1, 120), "Already captured: A1");
  assert.equal(early.length, 5); // head, 1-50, 51-100, 101-120, what changes run to run
  assert.equal(early[2].cache_control?.type, "ephemeral");
  assert.ok(early[2].text.endsWith("line 100"));
  assert.equal(early.filter((b) => b.cache_control).length, 1);
  // Later in the meeting: everything up to the cached block is the same, so the next run reads it back.
  const later = notesPrompt("Item: General", lines(1, 149), "Already captured: A1, A2");
  assert.deepEqual(later.slice(0, 3), early.slice(0, 3));
  // A short transcript is too small to cache.
  assert.equal(notesPrompt("Item", lines(1, 10), "").filter((b) => b.cache_control).length, 0);
});

test("lines of a topic that went quiet drop out without renumbering the rest, so earlier blocks stay cached", () => {
  const line = (n: number) => ({ n, text: `[${n}] Joe: line ${n}` });
  const all = Array.from({ length: 160 }, (_, i) => line(i + 1));
  const before = notesPrompt("Item: General", all, "");
  // Lines 60-80 settle: blocks 1-50 and the head are untouched, and later lines keep their numbers.
  const after = notesPrompt("Item: General", all.filter((l) => l.n < 60 || l.n > 80), "Topics that have gone quiet: ...");
  assert.deepEqual(after.slice(0, 2).map((b) => b.text), before.slice(0, 2).map((b) => b.text));
  assert.match(after[3].text, /^\[101\] Joe: line 101/);
  assert.ok(after[3].cache_control, "the last block talk moved past");
  // A block left empty is skipped.
  const gone = notesPrompt("Item: General", all.filter((l) => l.n > 100), "");
  assert.match(gone[1].text, /^\[101\]/);
});

test("by default a notes run isn't shown the last run's topics", async () => {
  const { agent, calls } = withApi(() => noteReply);
  await agent.notesFor(null, said(5), [], [], undefined, { lastTopics: [{ topic: "Keep button", lines: [1, 2] }] });
  const blocks = calls[0].body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.doesNotMatch(blocks.map((b) => b.text).join("\n"), /Topics so far|Keep button/);
  assert.doesNotMatch(JSON.stringify(calls[0].body.system), /short aside/);
});

test("a notes run lists the last run's topics after the transcript (NOTES_LAST_TOPICS=on), and reads lines back by their numbers", async (t) => {
  config.notesLastTopics = true;
  t.after(() => (config.notesLastTopics = false));
  const { agent, calls } = withApi(() => noteReply);
  const segments = said(120).slice(30);
  const draft = await agent.notesFor(null, segments, [], [], undefined, {
    lineNumbers: segments.map((_, i) => i + 31),
    lastTopics: [
      { topic: "Keep button", lines: [31, 32, 33, 40] },
      { topic: "Settled already", lines: [5, 6] },
    ],
  });
  const blocks = calls[0].body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.match(blocks[1].text, /^\[31\] /);
  assert.match(blocks.at(-1)!.text, /Topics so far.*"Keep button": lines 31-33, 40/s);
  assert.doesNotMatch(blocks.at(-1)!.text, /Settled already/);
  // The reply's lines 1 and 2 weren't sent; its line 70 is the 40th line sent.
  assert.deepEqual(draft.discussions[0].segmentIndexes, [39]);
});

test("a notes run has room to think and to list a long meeting's lines, and a time limit", async () => {
  const { agent, calls } = withApi(() => noteReply);
  const draft = await agent.notesFor(null, said(120), [], [{ key: "A1", kind: "action", text: "Close the app", owner: "Andy" }]);
  const { body, opts } = calls[0];
  assert.equal(body.max_tokens, 16_000);
  assert.equal(opts?.timeout, 120_000);
  const blocks = body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.match(blocks.at(-1)!.text, /Already captured.*A1 action item: Close the app/s);
  assert.deepEqual(draft.discussions[0].segmentIndexes, [0, 1, 69]);
  assert.equal(draft.notes[0].text, "Make the Keep button stand out");
});

test("a topic's lines can come back as ranges, and nonsense in them is skipped", () => {
  assert.deepEqual(turnNumbers([4, 2]), [4, 2]);
  assert.deepEqual(turnNumbers("3-5, 9,[11]-[12]; 20"), [3, 4, 5, 9, 11, 12, 20]);
  assert.deepEqual(turnNumbers("7-5, lines, 2"), [2]);
});

test("live notes think first unless that's turned off; the run as the meeting ends always does", async () => {
  const { agent, calls } = withApi(() => noteReply);
  await agent.notesFor(null, said(3));
  assert.deepEqual((calls[0].body as { thinking?: unknown }).thinking, config.notesThinking ? undefined : { type: "disabled" });
  await agent.notesFor(null, said(3), [], [], {}, { tidy: true });
  assert.equal((calls[1].body as { thinking?: unknown }).thinking, undefined);
});

test("live notes run on the small model, the run as the meeting ends on the bigger one", async () => {
  if (!process.env.NOTES_MODEL) assert.equal(config.notesModel, "claude-haiku-5-5");
  if (!process.env.NOTES_TIDY_MODEL) assert.equal(config.notesTidyModel, "claude-sonnet-5-5");
  const { agent, calls } = withApi(() => noteReply);
  await agent.notesFor(null, said(3));
  await agent.notesFor(null, said(3), [], [], {}, { tidy: true });
  const [live, tidy] = calls.map((c) => c.body as Anthropic.Beta.MessageCreateParams & { fallbacks?: unknown });
  assert.equal(live.model, config.notesModel);
  assert.equal(tidy.model, config.notesTidyModel);
  // Haiku has no server-side fallback, and asking for one is refused.
  if (config.notesModel.startsWith("claude-haiku")) assert.equal(live.fallbacks, undefined);
});

test("a declined notes run fails instead of wiping the notes", async () => {
  const { agent } = withApi(() => ({ stop_reason: "refusal", usage, parsed_output: null }));
  await assert.rejects(agent.notesFor(null, said(3)), /declined/);
});

test("a rate limit or an empty account says so, so notes can wait or ask for a top-up", async () => {
  const limited = withApi(() => {
    throw new Anthropic.RateLimitError(429, undefined, "rate_limit_error", new Headers({ "retry-after": "20" }));
  });
  await assert.rejects(limited.agent.notesFor(null, said(3)), (err) => err instanceof NotesTrouble && err.reason === "busy" && err.retryAfterMs === 20_000);
  const broke = withApi(() => {
    throw new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", new Headers());
  });
  await assert.rejects(broke.agent.notesFor(null, said(3)), (err) => err instanceof NotesTrouble && err.reason === "credit");
  const other = withApi(() => {
    throw new Error("socket hang up");
  });
  await assert.rejects(other.agent.notesFor(null, said(3)), (err) => !(err instanceof NotesTrouble));
});

test("settled topics go after the transcript as lines with their notes, and the model can go back to one", async () => {
  const { agent, calls } = withApi(() => ({
    ...noteReply,
    parsed_output: {
      ...noteReply.parsed_output,
      discussions: [{ ...noteReply.parsed_output.discussions[0], turns: [1], picks_up: "T1" }, { ...noteReply.parsed_output.discussions[0], turns: [2], picks_up: "T9" }],
    },
  }));
  const settled = [{ key: "T1", topic: "Conflict page", outcome: "action" as const, notes: [{ kind: "action" as const, text: "Make Keep stand out", owner: "Joe" }] }];
  const draft = await agent.notesFor(null, said(3), [], [], {}, { settled });
  const { body, opts } = calls[0];
  const blocks = body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.match(blocks.at(-1)!.text, /gone quiet.*\n- T1 \(action\) Conflict page\n  To do: Make Keep stand out \(Joe\)/s);
  assert.doesNotMatch(blocks[0].text, /gone quiet/, "the head stays the same run to run, for the cache");
  assert.deepEqual(draft.discussions.map((d) => d.picksUp), ["T1", null], "an unknown key is ignored");
  assert.equal(body.output_config?.effort, "low");
  assert.equal(opts?.timeout, 120_000);
});

test("a long topic still going shows where it stood, positions and all, and is carried on", async () => {
  const { agent, calls } = withApi(() => ({
    ...noteReply,
    parsed_output: { ...noteReply.parsed_output, discussions: [{ ...noteReply.parsed_output.discussions[0], turns: [1, 2], picks_up: "T1" }] },
  }));
  const settled = [
    {
      key: "T1",
      topic: "Pricing",
      outcome: "open" as const,
      going: true,
      positions: [{ speaker: "Huy", position: "Per seat is simplest" }],
      notes: [{ kind: "question" as const, text: "Per seat or per space?", owner: null }],
    },
  ];
  const draft = await agent.notesFor(null, said(3), [], [], {}, { settled });
  const blocks = calls[0].body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.match(blocks.at(-1)!.text, /still going.*\n- T1 \(open\) Pricing\n  Huy: Per seat is simplest\n  Open: Per seat or per space\?/s);
  assert.doesNotMatch(blocks.at(-1)!.text, /gone quiet/);
  assert.equal(draft.discussions[0].picksUp, "T1");
});

test("the run as the meeting ends reads more carefully and has longer", async () => {
  const { agent, calls } = withApi(() => noteReply);
  await agent.notesFor(null, said(3), [], [], {}, { tidy: true });
  assert.equal(calls[0].body.output_config?.effort, "medium");
  assert.equal(calls[0].opts?.timeout, 240_000);
});
