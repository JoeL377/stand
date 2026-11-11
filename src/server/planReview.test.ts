import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorPassage, carryPassage } from "../shared/planReview.ts";
import { openDb } from "./db.ts";
import { changeReview, quotePassage, reviewFor } from "./planReview.ts";

const quote = "Keep the old endpoint for a week.";

test("revision matching follows moved passages and declines ambiguous or edited text", () => {
  const text = `# Rollout\n\n${quote}\n\nNotify the team.`;
  const start = text.indexOf(quote);
  const anchor = anchorPassage({ id: "v1", text, by: "Sam", ts: 0 }, { start, end: start + quote.length })!;
  for (const target of [`New intro\n\n${text}`, `# Appendix\n\n${quote}`]) {
    const at = target.indexOf(quote);
    assert.deepEqual(carryPassage(anchor, text, target), { start: at, end: at + quote.length });
  }
  assert.equal(carryPassage(anchor, text, `${quote}\n\n${quote}`), null);
  assert.equal(carryPassage(anchor, text, text.replace("a week", "two weeks")), null);
  assert.equal(carryPassage(anchor, text, text.replace(quote, "")), null);
});

test("threads keep their original version when plans change or a reviewer reattaches them", () => {
  const db = openDb(":memory:");
  const user = db.upsertUser({ googleSub: "sam", email: "sam@example.com", name: "Sam", picture: null });
  const room = db.createRoom("Review", user.id);
  const task = "task";
  db.addPlan(room.id, task, quote, "Sam");
  const original = reviewFor(db, task)!.plan;
  db.addPlan(room.id, task, "Keep both endpoints for two weeks.", "Sam");
  const latest = reviewFor(db, task)!.plan;
  // The composer was opened before the new version arrived.
  const thread = changeReview(db, task, "Sam", {
    action: "create", version: original.id, start: 0, end: quote.length, text: "Which clients need this?",
  })!;
  assert.equal(reviewFor(db, task)!.threads[0].placement, null);
  assert.equal(changeReview(db, "other-task", "Sam", { action: "reply", thread: thread.id, text: "Answer" }), null);
  changeReview(db, task, "Sam", { action: "reattach", thread: thread.id, version: latest.id, start: 0, end: latest.text.length });
  changeReview(db, task, "Sam", { action: "reply", thread: thread.id, text: "Desktop clients." });
  changeReview(db, task, "Sam", { action: "resolve", thread: thread.id });
  const reviewed = reviewFor(db, task)!.threads[0];
  assert.equal(reviewed.original.quote, quote);
  assert.deepEqual(reviewed.placement, { start: 0, end: latest.text.length });
  assert.equal(reviewed.messages.length, 2);
  assert.equal(reviewed.resolved, true);
  assert.deepEqual(reviewFor(db, task, original.id)!.threads[0].placement, { start: 0, end: quote.length });
  db.raw.close();
});

test("a quote from a plan lands on whole passages, as a selection in the plan viewer does", () => {
  const text = [
    "# Rollout",
    "",
    "Keep the old endpoint",
    "for a week.",
    "",
    "- Notify the team",
    "  - Post in the channel",
    "- Remove the flag",
    "",
    "| Step | Owner |",
    "|---|---|",
    "| Flip | Sam |",
    "",
    "Notify the team first, then flip.",
  ].join("\n");
  const at = (s: string) => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });
  // Part of a paragraph is its whole paragraph; part of a list item is that item, with what's nested in it.
  assert.deepEqual(quotePassage(text, "old endpoint"), at("Keep the old endpoint\nfor a week."));
  assert.deepEqual(quotePassage(text, "Post in"), at("- Post in the channel"));
  assert.deepEqual(quotePassage(text, "Remove the flag"), at("- Remove the flag"));
  // A row is its table, and a quote across passages runs from the first to the last.
  assert.deepEqual(quotePassage(text, "Flip | Sam"), at("| Step | Owner |\n|---|---|\n| Flip | Sam |"));
  assert.deepEqual(quotePassage(text, "for a week.\n\n- Notify the team\n  - Post"), {
    start: text.indexOf("Keep"), end: at("- Post in the channel").end,
  });
  assert.equal(quotePassage(text, "Notify the team"), "ambiguous");
  assert.equal(quotePassage(text, "Keep both endpoints"), "missing");
  assert.equal(quotePassage(text, "  "), "missing");
});
