import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeAgent, NotesTrouble, notesPrompt } from "./llm.ts";
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

test("the notes prompt keeps a long transcript in fixed chunks, cached up to the last whole one", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `[${i + 1}] Joe: line ${i + 1}`);
  const early = notesPrompt("Item: General", lines(120), "Already captured: A1");
  assert.equal(early.length, 5); // head, 1-50, 51-100, 101-120, what changes run to run
  assert.equal(early[2].cache_control?.type, "ephemeral");
  assert.ok(early[2].text.endsWith("line 100"));
  assert.equal(early.filter((b) => b.cache_control).length, 1);
  // Later in the meeting: everything up to the cached chunk is the same, so the next run reads it back.
  const later = notesPrompt("Item: General", lines(149), "Already captured: A1, A2");
  assert.deepEqual(later.slice(0, 3), early.slice(0, 3));
  // A short transcript is too small to cache.
  assert.equal(notesPrompt("Item", lines(10), "").filter((b) => b.cache_control).length, 0);
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

test("settled topics go before the transcript as lines with their notes, and the model can go back to one", async () => {
  const { agent, calls } = withApi(() => ({
    ...noteReply,
    parsed_output: {
      ...noteReply.parsed_output,
      discussions: [{ ...noteReply.parsed_output.discussions[0], turns: [1], picks_up: "T1" }, { ...noteReply.parsed_output.discussions[0], turns: [2], picks_up: "T9" }],
    },
  }));
  const settled = [{ key: "T1", topic: "Conflict page", outcome: "action" as const, notes: [{ kind: "action" as const, text: "Make Keep stand out", owner: "Joe" }] }];
  const draft = await agent.notesFor(null, said(3), [], [], [], { settled });
  const { body, opts } = calls[0];
  const blocks = body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.match(blocks[0].text, /gone quiet.*\n- T1 \(action\) Conflict page\n  To do: Make Keep stand out \(Joe\)\n\nWhat was said since/s);
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
  const draft = await agent.notesFor(null, said(3), [], [], [], { settled });
  const blocks = calls[0].body.messages[0].content as Anthropic.Beta.BetaTextBlockParam[];
  assert.match(blocks[0].text, /still going.*\n- T1 \(open\) Pricing\n  Huy: Per seat is simplest\n  Open: Per seat or per space\?\n\nWhat was said since/s);
  assert.doesNotMatch(blocks[0].text, /gone quiet/);
  assert.equal(draft.discussions[0].picksUp, "T1");
});

test("the run as the meeting ends reads more carefully and has longer", async () => {
  const { agent, calls } = withApi(() => noteReply);
  await agent.notesFor(null, said(3), [], [], [], { tidy: true });
  assert.equal(calls[0].body.output_config?.effort, "medium");
  assert.equal(calls[0].opts?.timeout, 240_000);
});
