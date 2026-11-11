import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { ReviewError, addSlide, finishReview, isReviewSlide, lastReview, removeSlide, reviewOfMeeting, reviewPage, reviewView, reviewsDone, setOutcome, slideShotKey, startReview } from "./reviews.ts";

const tick = () => new Promise((r) => setTimeout(r, 3));

/** A space whose last meeting caught three to-dos. */
async function space() {
  const db = openDb(":memory:");
  const room = db.createRoom("Conxt 1.0", null, "");
  const m = db.startMeeting(room.id);
  for (const p of ["Joe Liang", "Huy Ngo"]) db.addSegment({ meetingId: m.id, itemId: null, speakerId: p, speakerName: p, kind: "speech", text: "hi", ts: Date.now() });
  const notes = ["Add the mic picker", "Rejoin catch-up pill", "Ask Andy for Railway access"].map((text) => db.addNote(m.id, null, { kind: "action", text, owner: "Joe Liang" }, null));
  await tick();
  db.endMeeting(m.id, null);
  await tick();
  return { db, room, notes };
}

const report = (db: ReturnType<typeof openDb>, roomId: string, note: { id: string; text: string }, status: "ready" | "done", text: string, links: string[] = []) =>
  db.addUpdate({ roomId, itemId: null, noteId: note.id, noteText: note.text, userId: "u1", userName: "Joe Liang", client: "Claude Code", status, text, links });

test("the next review holds the slides agents added plus finished work nobody made a slide for", async () => {
  const { db, room, notes } = await space();
  assert.equal(reviewView(db, room.id), null);

  // Done with a merged PR, ready to ship, and dropped: the first two are worth showing.
  report(db, room.id, notes[0], "done", "Pick your mic before you join.");
  db.setActionDone(room.id, notes[0].id, "Joe Liang via GitHub", "pr:https://github.com/JoeL377/stand/pull/41");
  report(db, room.id, notes[1], "ready", "A pill catches you up when you rejoin.", ["https://github.com/JoeL377/stand/pull/99"]);
  db.setTaskState(room.id, notes[2].id, { state: "dropped", by: "Huy Ngo", reason: "Got it another way" });

  let view = reviewView(db, room.id)!;
  assert.deepEqual(view.slides.map((s) => [s.title, s.addedBy]), [
    ["Add the mic picker", "Stand"],
    ["Rejoin catch-up pill", "Stand"],
  ]);
  assert.equal(view.slides[0].body, "Pick your mic before you join.");
  assert.equal(view.slides[0].pr, "https://github.com/JoeL377/stand/pull/41");
  assert.equal(view.slides[1].pr, "https://github.com/JoeL377/stand/pull/99");

  // An agent's slide for the same to-do takes its place, and adding it again rewrites it.
  const first = addSlide(db, room.id, { title: "Mic picker", summary: "v1", note: notes[0], addedBy: "Joe Liang via Claude Code" });
  const again = addSlide(db, room.id, { title: "Pick your mic before joining", summary: "Choose a mic on the way in.", note: notes[0], addedBy: "Joe Liang via Claude Code" });
  assert.equal(again.updated, true);
  assert.equal(again.slide.id, first.slide.id);
  // A slide can show something with no to-do.
  const loose = addSlide(db, room.id, { title: "New landing page", summary: "", addedBy: "Huy Ngo via Cursor", owner: "Huy Ngo" });
  db.addWorkShot({ roomId: room.id, noteId: slideShotKey(loose.slide.id), userId: "u2", userName: "Huy Ngo", client: "Cursor", caption: "The hero", ext: "png" });
  db.addWorkShot({ roomId: room.id, noteId: notes[0].id, userId: "u1", userName: "Joe Liang", client: "Claude Code", caption: "The picker", ext: "png" });

  view = reviewView(db, room.id)!;
  assert.deepEqual(view.slides.map((s) => s.title), ["Pick your mic before joining", "New landing page", "Rejoin catch-up pill"]);
  assert.deepEqual(view.slides.map((s) => s.shots.map((x) => x.caption)), [["The picker"], ["The hero"], []]);
  assert.throws(() => addSlide(db, room.id, { title: "  ", summary: "", addedBy: "x" }), ReviewError);

  assert.equal(removeSlide(db, room.id, loose.slide.id), true);
  assert.equal(reviewView(db, room.id)!.slides.length, 2);
});

test("starting a review makes its slides the top of the agenda, and outcomes and the end are kept", async () => {
  const { db, room, notes } = await space();
  assert.throws(() => startReview(db, room.id), /Nothing to review yet/);
  db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Hiring", url: null, description: null }]);
  report(db, room.id, notes[0], "done", "Pick your mic before you join.");
  db.setActionDone(room.id, notes[0].id, "Joe Liang");
  addSlide(db, room.id, { title: "New landing page", summary: "Bigger hero.", addedBy: "Huy Ngo via Cursor", owner: "Huy Ngo" });

  const started = startReview(db, room.id);
  assert.equal(started.started, true);
  const items = db.listItems(room.id);
  assert.deepEqual(items.map((i) => i.title), ["New landing page", "Add the mic picker", "Hiring"]);
  assert.equal(items[0].id, started.firstItemId);
  assert.ok(isReviewSlide(items[0]) && isReviewSlide(items[1]) && !isReviewSlide(items[2]));
  assert.equal(items[1].slide?.review?.taskId, notes[0].id);
  assert.equal(db.getDeck(started.deckId)?.reviewId, started.review.id);
  // Starting again while it runs changes nothing.
  assert.equal(startReview(db, room.id).started, false);
  assert.equal(reviewView(db, room.id)!.status, "live");
  // A running review can't lose slides, and what's added now waits for the next one.
  assert.equal(removeSlide(db, room.id, reviewView(db, room.id)!.slides[0].id), false);
  addSlide(db, room.id, { title: "Dark mode", summary: "", addedBy: "x" });
  assert.equal(reviewView(db, room.id)!.slides.length, 2);

  assert.equal(setOutcome(db, items[2].id, "ship", "Joe Liang"), null);
  const after = setOutcome(db, items[1].id, "fixes", "Huy Ngo")!;
  assert.equal(after.slide?.review?.outcome, "fixes");
  assert.equal(after.slide?.review?.outcomeBy, "Huy Ngo");
  assert.equal(setOutcome(db, items[1].id, null, "Huy Ngo")!.slide?.review?.outcome, null);
  setOutcome(db, items[0].id, "ship", "Joe Liang");

  const m = db.startMeeting(room.id);
  await tick();
  finishReview(db, room.id, m.id);
  assert.deepEqual(db.listItems(room.id).map((i) => i.title), ["Hiring"]);
  const last = lastReview(db, room.id)!;
  assert.equal(last.meetingId, m.id);
  assert.deepEqual(last.slides.map((s) => s.outcome), ["ship", null]);
  // The next review starts fresh: the slide added during the call, and nothing already reviewed.
  assert.deepEqual(reviewView(db, room.id)!.slides.map((s) => s.title), ["Dark mode"]);
});

test("a review that ran keeps a page: its slides, how each ended, and what was raised on it", async () => {
  const { db, room } = await space();
  const other = db.createRoom("Elsewhere", null, "");
  addSlide(db, room.id, { title: "New landing page", summary: "Bigger hero.", addedBy: "Huy Ngo via Cursor", owner: "Huy Ngo" });
  addSlide(db, room.id, { title: "Dark mode", summary: "", addedBy: "x" });
  // Before it starts, "next" is the one being put together.
  assert.deepEqual(reviewPage(db, room.id, "next")!.slides.map((s) => s.title), ["New landing page", "Dark mode"]);
  assert.deepEqual(reviewsDone(db, room.id), []);

  const started = startReview(db, room.id);
  const m = db.startMeeting(room.id);
  const [first, second] = db.listItems(room.id);
  db.addNote(m.id, first.id, { kind: "action", text: "Shrink the hero on phones", owner: "Huy Ngo" }, null);
  db.addNote(m.id, first.id, { kind: "question", text: "Keep the old pricing table?", owner: null }, null);
  db.addNote(m.id, second.id, { kind: "decision", text: "Dark mode ships behind a setting", owner: null }, null);
  db.addNote(m.id, null, { kind: "action", text: "Book the offsite", owner: null }, null);
  setOutcome(db, first.id, "fixes", "Joe Liang");
  await tick();
  finishReview(db, room.id, m.id);

  const page = reviewPage(db, room.id, started.review.id)!;
  assert.equal(page.status, "done");
  assert.equal(page.meetingId, m.id);
  assert.deepEqual(page.slides.map((s) => [s.title, s.outcome, s.caught!.map((c) => `${c.kind}: ${c.text}`)]), [
    ["New landing page", "fixes", ["action: Shrink the hero on phones", "question: Keep the old pricing table?"]],
    ["Dark mode", null, ["decision: Dark mode ships behind a setting"]],
  ]);
  // Only its own space can open it.
  assert.equal(reviewPage(db, other.id, started.review.id), null);
  assert.equal(reviewPage(db, room.id, "nope"), null);
  // It stays listed once the next one is being put together, and its meeting knows it.
  addSlide(db, room.id, { title: "Search", summary: "", addedBy: "x" });
  assert.deepEqual(reviewsDone(db, room.id).map((r) => [r.id, r.slides, r.outcomes]), [[started.review.id, 2, { ship: 0, fixes: 1, not_yet: 0 }]]);
  assert.equal(reviewOfMeeting(db, m.id)!.id, started.review.id);
  assert.deepEqual(reviewPage(db, room.id, "next")!.slides.map((s) => s.title), ["Search"]);
});
