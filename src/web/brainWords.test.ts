import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainNode } from "../shared/protocol.ts";
import { brainWords, centerOut } from "./brainWords.ts";

const node = (id: string, label: string, more: Partial<BrainNode> = {}): BrainNode => ({ id, parent: null, label, detail: null, by: null, ts: Number(id.slice(1)), quote: null, points: [], caught: [], ...more });

test("words are counted across names, details, points and quotes; a name counts most", () => {
  const words = brainWords([
    node("d1", "Guest checkout"),
    node("i2", "One-page checkout", { parent: "d1", detail: "Checkout on a single page", points: [{ text: "Fewer steps", by: "Joe", ts: 3, quote: { segmentId: "s", ts: 3, speaker: "Joe", text: "the checkout is the thing" } }] }),
  ]);
  const checkout = words[0];
  // 3 + 3 for two names, 2 for the detail, 1 for the quote.
  assert.deepEqual([checkout.word, checkout.count, checkout.nodes], ["checkout", 9, ["d1", "i2"]]);
  assert.deepEqual(words.find((w) => w.word === "guest")?.nodes, ["d1"]);
});

test("filler words and short ones are left out; a plural joins its singular", () => {
  const words = brainWords([node("d1", "The cards and the card that we want to save"), node("d2", "Saved cards for it")]);
  assert.deepEqual(
    words.map((w) => [w.word, w.count]),
    [
      ["cards", 9],
      ["save", 3],
      ["saved", 3],
    ],
  );
});

test("the cloud is cut to the words made most of, and the biggest sits in the middle", () => {
  const many = Array.from({ length: 80 }, (_, i) => node(`d${i + 1}`, `word${i} shared`));
  const words = brainWords(many, 10);
  assert.equal(words.length, 10);
  assert.equal(words[0].word, "shared");
  assert.deepEqual(centerOut([1, 2, 3, 4, 5]), [4, 2, 1, 3, 5]);
});
