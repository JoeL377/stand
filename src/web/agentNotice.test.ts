import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCard } from "../shared/protocol.ts";
import { NOTICE_MS, saidLine, saidNotice } from "./agentNotice.ts";

const said = (id: string, at: number, extra: Partial<AgentCard> = {}): AgentCard =>
  ({
    id, kind: "answer", status: "ready", question: "", by: "Janesh Chhabra", at, readyAt: at, note: `**${id}** is the answer\nmore`, options: [], fromSpace: [], dismissed: null, costUsd: null, model: null,
    agent: { personId: "u1", agent: "opencode", model: "opus" },
    ...extra,
  }) as AgentCard;

test("a card from an agent that this screen hasn't seen comes up as a notice for a minute, the newest with how many more", () => {
  const cards = [said("a", 1), said("b", 2), said("c", 3)];
  const arrived = new Map([["a", 1000], ["b", 2000], ["c", 3000]]);
  const n = saidNotice(cards, new Set(["a"]), arrived, 5000);
  assert.equal(n.unseen, 2);
  assert.equal(n.card?.id, "c");
  assert.equal(n.more, 1);
  assert.equal(n.ends, 3000 + NOTICE_MS);
  // After a minute the notice goes; the cards stay unseen, for the Board tab's mark.
  const later = saidNotice(cards, new Set(["a"]), arrived, 3000 + NOTICE_MS);
  assert.equal(later.card, null);
  assert.equal(later.unseen, 2);
  // × on the notice: it goes at once, and the cards still count as unseen.
  const closed = saidNotice(cards, new Set(["a"]), arrived, 5000, new Set(["b", "c"]));
  assert.equal(closed.card, null);
  assert.equal(closed.unseen, 2);
});

test("only what an agent said by itself and is still on the board counts: not Stand's answers, not dismissed ones", () => {
  const cards = [
    said("asked", 1, { question: "which plan?" }),
    said("stand", 2, { agent: undefined }),
    said("gone", 3, { dismissed: { by: "Joe", at: 3 } }),
    said("writing", 4, { status: "working" }),
    said("ok", 5),
  ];
  const n = saidNotice(cards, new Set(), new Map(), 10);
  assert.equal(n.unseen, 1);
  assert.equal(n.card?.id, "ok");
  assert.equal(n.more, 0);
  assert.equal(saidNotice(cards, new Set(["ok"]), new Map(), 10).card, null);
});

test("the notice's line is the first line of the card without its markdown", () => {
  assert.equal(saidLine(said("x", 1)), "x is the answer");
  assert.equal(saidLine(said("x", 1, { note: "# " + "y".repeat(100) }), 10), "yyyyyyyyy…");
});
