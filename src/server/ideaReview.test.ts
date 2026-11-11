import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainNode } from "../shared/protocol.ts";
import { brainstormPage, finishBrainstorm, starIdea, startBrainstorm } from "./brainstorm.ts";
import { openDb } from "./db.ts";
import { finishIdeaReview, ideaReviewsOf, setUpIdeaReview, startIdeaReview } from "./ideaReview.ts";
import { reviewPage, reviewView, setOutcome } from "./reviews.ts";

const T0 = 1_760_000_000_000;
const node = (id: string, parent: string | null, label: string, extra: Partial<BrainNode> = {}): BrainNode => ({ id, parent, label, detail: `${label} in a sentence.`, by: "Joe", ts: T0 + Number(id.slice(1)), quote: null, points: [], caught: [], ...extra });

function brainstormed() {
  const db = openDb(":memory:");
  const room = db.createRoom("Conxt 1.0", null, "");
  const b = startBrainstorm(db, room.id, "Experiences we should support", "Joe Liang", T0);
  db.saveBrainstormMap(b.id, [
    node("d1", null, "Reviews"),
    node("i1", "d1", "Retro meeting"),
    node("i2", "d1", "Company review", { points: [{ text: "Gives a reason to move more workflow here", by: "Joe", ts: T0, quote: null }] }),
    node("i3", "d1", "Interviews"),
    node("i4", "d1", "Taken off", { removed: true }),
  ]);
  const m = db.startMeeting(room.id);
  finishBrainstorm(db, room.id, m.id, T0 + 99);
  db.endMeeting(m.id, "Brainstormed.", null, T0 + 100, []);
  return { db, room, b };
}

test("an idea review holds every idea of a brainstorm, the starred ones first", () => {
  const { db, room, b } = brainstormed();
  const other = db.createRoom("Elsewhere", null, "");
  assert.throws(() => setUpIdeaReview(db, other.id, b.id, "Joe Liang"), /isn't in this space/);
  starIdea(db, room.id, b.id, "i3", true);
  const made = setUpIdeaReview(db, room.id, b.id, "Joe Liang");
  assert.deepEqual([made.slides, made.left, made.updated], [3, 0, false]);
  // Starred, then the one the talk built on, then as raised. A star leaves nothing out.
  const page = reviewPage(db, room.id, made.review.id)!;
  assert.deepEqual([page.kind, page.title, page.brainstormId, page.status], ["ideas", "Experiences we should support", b.id, "draft"]);
  assert.deepEqual(page.slides.map((s) => s.title), ["Interviews", "Company review", "Retro meeting"]);
  assert.deepEqual(page.slides.map((s) => s.idea!.starred), [true, false, false]);
  assert.equal(page.slides[1].idea!.direction, "Reviews");
  // It is not the space's product review, and nothing joins it on its own.
  assert.equal(reviewView(db, room.id), null);
  // Setting it up again rebuilds the one waiting from the map as it is now.
  starIdea(db, room.id, b.id, "i1", true);
  const again = setUpIdeaReview(db, room.id, b.id, "Joe Liang");
  assert.deepEqual([again.review.id, again.updated], [made.review.id, true]);
  assert.deepEqual(reviewPage(db, room.id, made.review.id)!.slides.map((s) => s.title), ["Retro meeting", "Interviews", "Company review"]);
  assert.deepEqual(setUpIdeaReview(db, room.id, b.id, "Joe Liang", ["company review"]).slides, 1);
  assert.throws(() => setUpIdeaReview(db, room.id, b.id, "Joe Liang", ["nope"]), /None of those ideas/);
  assert.deepEqual(ideaReviewsOf(db, room.id).map((r) => [r.status, r.slides]), [["draft", 1]]);
  assert.deepEqual(brainstormPage(db, room.id, b.id)!.ideaReview, { id: made.review.id, status: "draft" });
});

test("an idea review ends each idea Pursue, Explore or Not now, and leaves what carries it on", () => {
  const { db, room, b } = brainstormed();
  assert.throws(() => startIdeaReview(db, room.id), /No idea review is waiting/);
  const made = setUpIdeaReview(db, room.id, b.id, "Joe Liang");
  const m = db.startMeeting(room.id);
  const started = startIdeaReview(db, room.id, made.review.id, T0 + 200);
  assert.equal(started.started, true);
  assert.equal(startIdeaReview(db, room.id).started, false);
  assert.throws(() => setUpIdeaReview(db, room.id, b.id, "Joe Liang"), /running in a call/);
  const items = db.reviewSlides(made.review.id).map((s) => s.itemId!);
  assert.equal(db.getItem(items[0])!.slide!.review!.idea!.nodeId, "i2");
  // Its own words only: a product review's outcome doesn't stick, and null takes one back.
  assert.equal(setOutcome(db, items[0], "ship", "Joe Liang")!.slide!.review!.idea!.outcome, null);
  assert.equal(setOutcome(db, items[0], "pursue", "Joe Liang")!.slide!.review!.idea!.outcome, "pursue");
  setOutcome(db, items[1], "explore", "Janesh Chhabra");
  setOutcome(db, items[2], "not_now", "Janesh Chhabra");
  // A to-do the talk caught on the slide is the one that carries the idea on.
  const said = db.addNote(m.id, items[0], { kind: "action", text: "Draft the company review flow", owner: "Janesh Chhabra" }, null);
  const done = finishIdeaReview(db, room.id, m.id, T0 + 900)!;
  assert.deepEqual([done.status, done.meetingId], ["done", m.id]);
  assert.equal(finishIdeaReview(db, room.id, m.id), null);
  const page = brainstormPage(db, room.id, b.id)!;
  assert.deepEqual(page.ideaReview, { id: made.review.id, status: "done" });
  assert.deepEqual(page.reviewed!.i2, { outcome: "pursue", became: { kind: "action", id: said.id } });
  assert.equal(page.reviewed!.i1.outcome, "explore");
  assert.equal(page.reviewed!.i3.became, null);
  const question = db.meetingNotes(m.id).find((n) => n.id === page.reviewed!.i1.became!.id)!;
  assert.deepEqual([question.kind, question.text, question.itemId], ["question", "Is this worth doing: Retro meeting?", items[1]]);
  assert.equal(db.meetingNotes(m.id).filter((n) => n.kind === "action").length, 1);
  // Its page keeps how each idea ended and what was raised on it.
  const ran = reviewPage(db, room.id, made.review.id)!;
  assert.deepEqual(ran.slides.map((s) => s.idea!.outcome), ["pursue", "explore", "not_now"]);
  assert.deepEqual(ran.slides[0].caught!.map((c) => c.text), ["Draft the company review flow"]);
  assert.deepEqual(ideaReviewsOf(db, room.id)[0].outcomes, { pursue: 1, explore: 1, not_now: 1 });
});
