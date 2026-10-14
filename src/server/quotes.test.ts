import assert from "node:assert/strict";
import { test } from "node:test";
import type { Segment } from "../shared/protocol.ts";
import { excerpt, findQuote } from "./quotes.ts";

const seg = (id: string, speakerName: string, text: string, ts = 0): Segment => ({ id, meetingId: "m", itemId: null, speakerId: speakerName, speakerName, kind: "speech", text, ts });

test("an excerpt is the transcript's own text, matched word for word whatever the case and punctuation", () => {
  const text = "So, I think — the logic that's shared sits beneath Stand. It's not a queue inside Connect.";
  assert.equal(excerpt(text, "the logic that's shared sits beneath stand"), "the logic that's shared sits beneath Stand");
  assert.equal(excerpt(text, "logic that is shared sits beneath Stand"), null, "not a paraphrase");
  assert.equal(excerpt(text, "sits beneath"), null, "too short to mean anything");
});

test("a quote is kept only where the person said it: the line given, else one of theirs nearby", () => {
  const lines = [
    seg("a", "Huy Ngo", "Stand is the review queue, and Connect is the engine underneath it.", 1000),
    seg("b", "Andy Li", "So Stand is like a review queue within Connect?", 2000),
    seg("c", "Huy Ngo", "No, I mean the shared logic sits beneath Stand.", 3000),
  ];
  const at = (n: number) => lines[n - 1];
  // Right line.
  assert.deepEqual(findQuote({ line: 3, words: "the shared logic sits beneath Stand" }, at, "Huy", lines), {
    segmentId: "c",
    ts: 3000,
    speaker: "Huy Ngo",
    text: "the shared logic sits beneath Stand",
  });
  // Wrong line number: found in another line of his.
  assert.equal(findQuote({ line: 2, words: "Connect is the engine underneath it" }, at, "Huy Ngo", lines)?.segmentId, "a");
  // Andy's words aren't Huy's.
  assert.equal(findQuote({ line: 2, words: "a review queue within Connect" }, at, "Huy", lines), null);
  // A decision can be anyone's words.
  assert.equal(findQuote({ line: 2, words: "a review queue within Connect" }, at, null, lines)?.speaker, "Andy Li");
  // Words nobody said.
  assert.equal(findQuote({ line: 3, words: "Stand should sit on top of Connect" }, at, null, lines), null);
  assert.equal(findQuote(null, at, null, lines), null);
});
