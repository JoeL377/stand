import assert from "node:assert/strict";
import { test } from "node:test";
import { linesShown, pointsOnDeck } from "../shared/designReview.ts";
import { spaceFeed } from "./captures.ts";
import { openDb } from "./db.ts";
import {
  DesignReviewError, authorMay, designReviewOfMeeting, designReviewRecord, designReviewState, designReviewView, designReviewsRan, finishDesignReview, isAuthor, lastReviewOf,
  planChanged, prepare, removeSpec, requestReview, setDesignOutcome, specChanged, startDesignReview, writeBackReview,
} from "./designReviews.ts";
import type { Agent } from "./llm.ts";
import { PlanBriefs, slideGroups } from "./planBrief.ts";
import { changeReview, planDiagrams, planSections, reviewFor } from "./planReview.ts";
import { addSlide, refilePrompt, refileReview, reviewView, startReview } from "./reviews.ts";

const SPEC = [
  "# Rollout of server capture",
  "",
  "Browser capture drops words when a tab sleeps.",
  "",
  "## Why",
  "",
  "People lose what was said while the tab slept.",
  "",
  "## Steps",
  "",
  "- Run capture on the server for ten percent of meetings",
  "- Keep the browser fallback for a week",
  "",
  "### Order",
  "",
  "Flip the flag last.",
  "",
  "## How to verify",
  "",
  "Compare the two transcripts.",
].join("\n");

type Draft = NonNullable<Awaited<ReturnType<NonNullable<Agent["taskBrief"]>>>>;
const DRAFT: Draft = {
  summary: "Moves capture to the server so a sleeping tab loses nothing.",
  sections: [
    { heading: "Why", lines: ["Tabs that sleep drop words"] },
    { heading: "## steps", lines: ["Ten percent first", "Fallback stays a week", "  ", "Flag goes last", "Line five", "Line six"] },
    { heading: "Pricing", lines: ["Not a section of this spec"] },
  ],
  questions: [
    { quote: "Keep the browser fallback for a week", question: "Is a week enough for mobile?" },
    { quote: "Charge for it", question: "The spec never says this" },
  ],
};

function space() {
  const db = openDb(":memory:");
  const sam = db.upsertUser({ googleSub: "g-sam", email: "sam@example.com", name: "Sam Hill", picture: null });
  const ann = db.upsertUser({ googleSub: "g-ann", email: "ann@example.com", name: "Ann Lee", picture: null });
  const room = db.createRoom("Capture", sam.id, "");
  const task = (text: string, owner: string | null = "Sam", spec: string | null = SPEC) => {
    const note = db.addTask(room.id, { text, owner, itemId: null }, "Sam Hill");
    if (spec) db.addPlan(room.id, note.id, spec, "Sam Hill");
    return db.getNote(note.id)!;
  };
  const by = (u: { id: string; name: string }) => ({ userId: u.id, userName: u.name, client: null });
  return { db, sam, ann, room, task, by };
}

test("a plan's sections are its ## headings, in its order", () => {
  const sections = planSections(`${SPEC}\n\n## Why\n\nAgain.`);
  assert.deepEqual(sections.map((s) => s.heading), ["Why", "Steps", "How to verify", "Why (2)"]);
  const steps = sections[1];
  assert.match(SPEC.slice(steps.start, steps.end), /^## Steps[\s\S]*Flip the flag last\.\s*$/);
  assert.equal(SPEC.slice(steps.start, steps.headingEnd), "## Steps");
  assert.deepEqual(planSections("Just a paragraph.\n\n### Small heading"), []);
});

test("Stand writes a brief once for a plan version and keeps it: the spec gives the sections, Stand only their lines", async () => {
  const { db, task } = space();
  const note = task("Move capture to the server");
  let calls = 0;
  const agent = { taskBrief: async (prompt: string) => { calls++; assert.deepEqual(JSON.parse(prompt).sections, ["Why", "Steps", "How to verify"]); return DRAFT; } };
  const briefs = new PlanBriefs(db, agent);
  const [a, b] = await Promise.all([briefs.ensure(note), briefs.ensure(note)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a!.status, "ready");
  assert.equal(a!.summary, DRAFT.summary);
  // A heading the spec doesn't have is dropped, a section caps at four lines, and one Stand skipped has none.
  assert.deepEqual(a!.sections.map((s) => [s.heading, s.lines]), [
    ["Why", ["Tabs that sleep drop words"]],
    ["Steps", ["Ten percent first", "Fallback stays a week", "Flag goes last", "Line five"]],
    ["How to verify", []],
  ]);
  // A question that doesn't quote the spec is dropped.
  assert.deepEqual(a!.suggestions.map((s) => [s.text, s.state]), [["Is a week enough for mobile?", "open"]]);
  // It is saved: after a deploy nothing is written again.
  const after = new PlanBriefs(db, { taskBrief: async () => { throw new Error("not asked"); } });
  assert.deepEqual(await after.ensure(note), a);
  assert.deepEqual(after.current(note.id), a);
});

test("without a model, or when the model fails, the brief still has the spec's sections", async () => {
  const { db, task } = space();
  const note = task("Move capture to the server");
  const none = await new PlanBriefs(db, {}).ensure(note);
  assert.equal(none!.status, "none");
  assert.deepEqual(none!.sections.map((s) => s.heading), ["Why", "Steps", "How to verify"]);
  assert.equal(await new PlanBriefs(db, {}).ensure(task("No spec", "Sam", null)), null);

  const other = task("Second spec");
  let calls = 0;
  const briefs = new PlanBriefs(db, { taskBrief: async () => { if (++calls === 1) throw new Error("down"); return DRAFT; } });
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal((await briefs.ensure(other))!.status, "failed");
  } finally {
    console.error = error;
  }
  // A failed run isn't retried by a reader; someone asks for it.
  assert.equal((await briefs.ensure(other))!.status, "failed");
  assert.equal((await briefs.ensure(other, true))!.status, "ready");
  assert.equal(calls, 2);
});

test("what the author wrote stays: over Stand's draft, and onto the next version of the plan", async () => {
  const { db, room, task } = space();
  const note = task("Move capture to the server");
  let release = () => {};
  const briefs = new PlanBriefs(db, { taskBrief: () => new Promise<Draft>((done) => { release = () => done(DRAFT); }) });
  const run = briefs.ensure(note);
  assert.equal(briefs.current(note.id)!.status, "writing");
  // The author edits while Stand is still writing.
  briefs.setSection(note, "Why", { lines: ["People lose words", "", "x".repeat(300)] }, "Sam Hill");
  briefs.setSection(note, "How to verify", { off: true }, "Sam Hill");
  assert.equal(briefs.setSection(note, "Pricing", { off: true }, "Sam Hill"), null);
  release();
  const first = (await run)!;
  assert.deepEqual(first.sections[0].lines.map((l) => l.length), [17, 200]);
  assert.equal(first.sections[0].edited, true);
  assert.equal(first.sections[1].edited, false);
  assert.equal(first.sections[2].off, true);
  assert.equal(first.editedBy, "Sam Hill");
  briefs.setSummary(note, "  Capture moves to the server.  ", "Sam Hill");

  // A new version: the Why section's text changed, Steps didn't.
  db.addPlan(room.id, note.id, SPEC.replace("while the tab slept", "while the laptop slept"), "Sam Hill");
  const next = briefs.ensure(note);
  release();
  const second = (await next)!;
  assert.notEqual(second.version, first.version);
  assert.equal(second.summary, "Capture moves to the server.");
  assert.equal(second.summaryChanged, true);
  assert.deepEqual([second.sections[0].lines[0], second.sections[0].edited, second.sections[0].changed], ["People lose words", true, true]);
  assert.deepEqual([second.sections[1].lines.length, second.sections[1].edited, second.sections[1].changed], [4, false, undefined]);
  assert.equal(second.sections[2].off, true);
  // Rewriting the lines says the author has seen the change.
  assert.equal(briefs.setSection(note, "Why", { lines: ["People lose words"] }, "Sam Hill")!.sections[0].changed, undefined);
});

test("a spec joins the next design review only when someone asks, with the author's questions as points", () => {
  const { db, sam, room, task, by } = space();
  const note = task("Move capture to the server");
  assert.equal(designReviewView(db, null, room.id, sam), null);
  assert.equal(spaceFeed(db, room.id).designReview, null);
  assert.throws(() => requestReview(db, null, task("No spec", "Sam", null), by(sam)), /no plan yet/);

  // A quote that isn't in the plan stops the whole request.
  assert.throws(
    () => requestReview(db, null, note, by(sam), [{ quote: "fallback for a week", text: "Is a week enough?" }, { quote: "Charge for it", text: "How much?" }]),
    (e: Error) => e instanceof DesignReviewError && /Question 2: That quote isn't in the latest plan/.test(e.message),
  );
  assert.deepEqual(designReviewState(db, note), { queued: false, points: 0 });
  assert.equal(db.planThreads(note.id).length, 0);

  const asked = requestReview(db, null, note, by(sam), [{ quote: "fallback for a week", text: "Is a week enough?" }, { text: "Is this the right quarter for it?" }]);
  assert.deepEqual(asked, { added: true, questions: 2 });
  const view = designReviewView(db, null, room.id, sam)!;
  assert.equal(view.specs.length, 1);
  assert.equal(view.specs[0].requestedBy, "Sam Hill");
  // In the plan's order: the question about the whole spec sits on its first line.
  assert.deepEqual(view.specs[0].points.map((p) => [p.quote, p.section, p.text]), [
    ["# Rollout of server capture", null, "Is this the right quarter for it?"],
    ["- Keep the browser fallback for a week", "Steps", "Is a week enough?"],
  ]);
  assert.deepEqual(db.planThreads(note.id).map((t) => t.origin), [{ review: view.id, source: "author" }, { review: view.id, source: "author" }]);
  const log = db.noteUpdates(note.id).map((u) => `${u.status}: ${u.text}`);
  assert.ok(log.includes("comment: Review requested: the plan is on the next design review."));
  assert.equal(log.filter((l) => l.startsWith("comment: Commented on the plan")).length, 2);

  // Asking again adds only what is new.
  assert.deepEqual(requestReview(db, null, note, by(sam), [{ quote: "fallback for a week", text: "Is a week enough?" }, { quote: "ten percent", text: "Why ten?" }]), { added: false, questions: 1 });
  assert.equal(designReviewView(db, null, room.id, sam)!.specs.length, 1);
  assert.equal(db.noteUpdates(note.id).filter((u) => u.text.startsWith("Review requested")).length, 1);
  assert.deepEqual(spaceFeed(db, room.id).designReview, { specs: 1, points: 3, titles: ["Move capture to the server"], live: false });

  // The product review knows nothing of it.
  assert.equal(reviewView(db, room.id), null);
  addSlide(db, room.id, { title: "Dark mode", summary: "", addedBy: "x" });
  startReview(db, room.id);
  assert.equal(reviewView(db, room.id)!.slides.length, 1);
  assert.equal(designReviewView(db, null, room.id, sam)!.specs.length, 1);
});

test("a reviewer's comment is a point, the author takes points off the call, and a new version moves the review along", () => {
  const { db, sam, ann, room, task, by } = space();
  const note = task("Move capture to the server");
  requestReview(db, null, note, by(sam));
  const plan = reviewFor(db, note.id)!.plan;
  const at = (s: string) => ({ start: plan.text.indexOf(s), end: plan.text.indexOf(s) + s.length });
  const comment = changeReview(db, note.id, "Ann Lee", { action: "create", version: plan.id, text: "Whose transcript wins?", ...at("Compare the two transcripts.") })!;
  const gone = changeReview(db, note.id, "Ann Lee", { action: "create", version: plan.id, text: "Why last?", ...at("Flip the flag last.") })!;
  const done = changeReview(db, note.id, "Ann Lee", { action: "create", version: plan.id, text: "Typo", ...at("## Why") })!;
  changeReview(db, note.id, "Sam Hill", { action: "resolve", thread: done.id });
  assert.deepEqual(designReviewState(db, note), { queued: true, points: 2 });

  // Only the author prepares the spec; taking a point off leaves its thread open.
  assert.equal(isAuthor(db, note, sam), true);
  assert.equal(isAuthor(db, note, ann), false);
  const briefs = new PlanBriefs(db, {});
  prepare(db, briefs, note, by(sam), { point: comment.id, off: true });
  let spec = designReviewView(db, briefs, room.id, ann)!.specs[0];
  assert.equal(spec.mine, false);
  assert.deepEqual(spec.points.map((p) => [p.text, p.off]), [["Why last?", false], ["Whose transcript wins?", true]]);
  assert.equal(db.planThreads(note.id).find((t) => t.id === comment.id)!.resolved, false);
  prepare(db, briefs, note, by(sam), { point: comment.id, off: false });
  assert.equal(designReviewState(db, note).points, 2);

  // The author asks about a section: the point sits on its heading.
  prepare(db, briefs, note, by(sam), { question: "Is a week of both worth the cost?", section: "Steps" });
  assert.throws(() => prepare(db, briefs, note, by(sam), { question: "?", section: "Pricing" }), DesignReviewError);
  spec = designReviewView(db, briefs, room.id, sam)!.specs[0];
  assert.deepEqual(spec.points.find((p) => p.text.startsWith("Is a week of both"))!.quote, "## Steps");

  // A new version drops a passage: that thread has no slide, and the review is of the new version.
  db.addPlan(room.id, note.id, SPEC.replace("### Order\n\nFlip the flag last.\n\n", ""), "Sam Hill");
  planChanged(db, briefs, note);
  spec = designReviewView(db, briefs, room.id, sam)!.specs[0];
  assert.notEqual(spec.planVersion, plan.id);
  assert.deepEqual(spec.points.find((p) => p.threadId === gone.id), { threadId: gone.id, quote: "Flip the flag last.", text: "Why last?", by: "Ann Lee", section: null, off: false, placed: false });
  assert.equal(pointsOnDeck(spec.points).length, 2);
  assert.equal(spec.brief.version, spec.planVersion);

  assert.equal(removeSpec(db, note, by(sam)), true);
  assert.equal(removeSpec(db, note, by(sam)), false);
  assert.equal(designReviewView(db, briefs, room.id, sam), null);
  assert.equal(db.planThreads(note.id).length, 4);
});

test("a Stand suggestion is a point only after the author accepts it", async () => {
  const { db, sam, room, task, by } = space();
  const note = task("Move capture to the server");
  const briefs = new PlanBriefs(db, { taskBrief: async () => ({ ...DRAFT, questions: [...DRAFT.questions, { quote: "ten percent of meetings", question: "Which ten percent?" }] }) });
  requestReview(db, briefs, note, by(sam));
  await briefs.ensure(note);
  let spec = designReviewView(db, briefs, room.id, sam)!.specs[0];
  assert.equal(spec.points.length, 0);
  const [week, ten] = spec.brief.suggestions;

  prepare(db, briefs, note, by(sam), { suggestion: week.id, accept: true });
  prepare(db, briefs, note, by(sam), { suggestion: ten.id, accept: false });
  assert.throws(() => prepare(db, briefs, note, by(sam), { suggestion: week.id, accept: true }), DesignReviewError);
  spec = designReviewView(db, briefs, room.id, sam)!.specs[0];
  assert.deepEqual(spec.brief.suggestions.map((s) => s.state), ["accepted", "dismissed"]);
  assert.deepEqual(spec.points.map((p) => [p.quote, p.text, p.by]), [["- Keep the browser fallback for a week", "Is a week enough for mobile?", "Stand"]]);
  assert.equal(db.planThreads(note.id)[0].origin?.source, "stand");
  // Stand writing again leaves what the author decided.
  const again = (await briefs.ensure(note, true))!;
  assert.deepEqual(again.suggestions.map((s) => s.state), ["accepted", "dismissed"]);
});

/** The review's slides on the agenda, as "role: title". */
const deckOf = (db: ReturnType<typeof openDb>, roomId: string) =>
  db.listItems(roomId).filter((it) => it.slide?.layout === "design").map((it) => `${it.slide!.design!.role}: ${it.title}`);

test("starting a design review lays each spec out as slides: overview, sections with their points, verdict", async () => {
  const { db, sam, room, task, by } = space();
  const [agenda] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Standing item", url: null, description: null }]);
  const briefs = new PlanBriefs(db, { taskBrief: async () => DRAFT });
  assert.throws(() => startDesignReview(db, briefs, room.id), /No spec is waiting/);
  const capture = task("Move capture to the server");
  const billing = task("Design the billing export", "Sam", "# Billing export\n\nOne CSV a month.");
  requestReview(db, briefs, capture, by(sam), [{ quote: "fallback for a week", text: "Is a week enough?" }, { text: "Is this the right quarter?" }, { quote: "Compare the two", text: "Whose transcript wins?" }]);
  requestReview(db, briefs, billing, by(sam));
  await briefs.ensure(capture);
  // The author takes a section and a point off the call.
  prepare(db, briefs, capture, by(sam), { section: "How to verify", off: true });
  prepare(db, briefs, capture, by(sam), { point: db.planThreads(capture.id).find((t) => t.messages[0].text === "Whose transcript wins?")!.id, off: true });

  const started = startDesignReview(db, briefs, room.id);
  assert.equal(started.started, true);
  assert.deepEqual(deckOf(db, room.id), [
    "overview: Move capture to the server",
    "point: Is this the right quarter?",
    "section: Why",
    "section: Steps",
    "point: Is a week enough?",
    "verdict: Verdict: Move capture to the server",
    "overview: Design the billing export",
    "verdict: Verdict: Design the billing export",
  ]);
  // The review leads the agenda, and each slide is an agenda item the notes agent can read.
  const items = db.listItems(room.id);
  assert.equal(items.at(-1)!.id, agenda.id);
  assert.equal(items[0].id, started.firstItemId);
  const [overview, , why, steps, point] = items;
  assert.equal(overview.slide!.body, DRAFT.summary);
  assert.deepEqual(overview.slide!.design!.sections, ["Why", "Steps"]);
  assert.equal(overview.slide!.design!.stand, true);
  assert.equal(why.slide!.body, "Tabs that sleep drop words");
  assert.match(why.description ?? "", /People lose what was said while the tab slept/);
  assert.equal(steps.slide!.design!.name, "Steps");
  assert.deepEqual([point.slide!.design!.name, point.slide!.design!.quote, point.slide!.design!.section], ["Question 2", "- Keep the browser fallback for a week", "Steps"]);
  assert.match(point.description ?? "", /Is a week enough\?[\s\S]*Keep the browser fallback for a week/);
  // Starting again joins the one running, and the page shows it as on now.
  assert.deepEqual(startDesignReview(db, briefs, room.id), { review: started.review, firstItemId: started.firstItemId, started: false });
  assert.equal(designReviewView(db, briefs, room.id, sam)!.status, "live");
  assert.equal(designReviewState(db, capture).live, true);
  assert.equal(removeSpec(db, capture, by(sam)), false);

  // A point ends Settled or Still open; a spec gets a verdict; other slides have no outcome.
  const verdict = items[5];
  assert.equal(setDesignOutcome(db, briefs, point.id, "approve", "Ann Lee"), null);
  assert.equal(setDesignOutcome(db, briefs, why.id, "settled", "Ann Lee"), null);
  assert.equal(setDesignOutcome(db, briefs, agenda.id, "settled", "Ann Lee"), null);
  assert.deepEqual([setDesignOutcome(db, briefs, point.id, "settled", "Ann Lee")!.slide!.design!.outcome, db.getItem(point.id)!.slide!.design!.outcomeBy], ["settled", "Ann Lee"]);
  assert.equal(setDesignOutcome(db, briefs, verdict.id, "changes", "Sam Hill")!.slide!.design!.outcome, "changes");
  assert.equal(setDesignOutcome(db, briefs, point.id, null, "Ann Lee")!.slide!.design!.outcome, null);

  const m = db.startMeeting(room.id);
  const done = finishDesignReview(db, room.id, m.id)!;
  assert.deepEqual([done.status, done.meetingId], ["done", m.id]);
  assert.deepEqual(db.listItems(room.id).map((it) => it.id), [agenda.id]);
  assert.equal(designReviewView(db, briefs, room.id, sam), null);
  assert.equal(setDesignOutcome(db, briefs, point.id, "settled", "Ann Lee"), null);
});

test("in the call a new comment is a question on the slide of its section, and the author's changes re-lay the deck", () => {
  const { db, sam, ann, room, task, by } = space();
  const briefs = new PlanBriefs(db, {});
  const capture = task("Move capture to the server");
  const other = task("Design the billing export", "Ann", "# Billing export\n\n## Format\n\nOne CSV a month.");
  requestReview(db, briefs, other, by(ann));

  // Present task: a review of that one spec, asked for now; the other keeps waiting.
  const started = startDesignReview(db, briefs, room.id, { only: capture, by: by(sam) });
  assert.deepEqual(deckOf(db, room.id), ["overview: Move capture to the server", "section: Why", "section: Steps", "section: How to verify", "verdict: Verdict: Move capture to the server"]);
  assert.ok(db.noteUpdates(capture.id).some((u) => u.text.startsWith("Review requested")));
  assert.deepEqual(db.reviewSlides(db.reviewIn(room.id, ["draft"], "design")!.id).map((r) => r.noteId), [other.id]);

  // A comment on a passage of Steps, whatever slide is on screen: it is a question on the Steps slide.
  const plan = reviewFor(db, capture.id)!.plan;
  const why = db.listItems(room.id)[1];
  const at = (s: string) => ({ start: plan.text.indexOf(s), end: plan.text.indexOf(s) + s.length });
  const thread = changeReview(db, capture.id, "Ann Lee", { action: "create", version: plan.id, text: "Why ten percent?", ...at("- Run capture on the server for ten percent of meetings") })!;
  assert.equal(specChanged(db, briefs, capture), true);
  assert.deepEqual(deckOf(db, room.id).slice(1, 5), ["section: Why", "section: Steps", "point: Why ten percent?", "section: How to verify"]);
  changeReview(db, capture.id, "Ann Lee", { action: "create", version: plan.id, text: "How do we compare?", ...at("Compare the two transcripts.") });
  specChanged(db, briefs, capture);
  assert.deepEqual(deckOf(db, room.id).slice(-3), ["section: How to verify", "point: How do we compare?", "verdict: Verdict: Move capture to the server"]);
  // The slides that were there keep their agenda items, so what was said on them stays with them.
  assert.equal(db.listItems(room.id)[1].id, why.id);
  assert.equal(specChanged(db, briefs, other), false);

  // The author takes a section off mid-call: its slide goes, its point stays, after the section before it.
  prepare(db, briefs, capture, by(sam), { section: "How to verify", off: true });
  specChanged(db, briefs, capture);
  assert.deepEqual(deckOf(db, room.id).slice(-4), ["section: Steps", "point: Why ten percent?", "point: How do we compare?", "verdict: Verdict: Move capture to the server"]);
  // A point the team called keeps its slide when the author takes it off; one nobody called goes.
  const point = db.listItems(room.id).find((it) => it.title === "Why ten percent?")!;
  setDesignOutcome(db, briefs, point.id, "open", "Ann Lee");
  prepare(db, briefs, capture, by(sam), { point: thread.id, off: true });
  prepare(db, briefs, capture, by(sam), { point: db.planThreads(capture.id)[1].id, off: true });
  specChanged(db, briefs, capture);
  assert.deepEqual(deckOf(db, room.id), ["overview: Move capture to the server", "section: Why", "section: Steps", "point: Why ten percent?", "verdict: Verdict: Move capture to the server"]);

  // Presenting the other spec while this review runs: it joins after it.
  const joined = startDesignReview(db, briefs, room.id, { only: other, by: by(ann) });
  assert.equal(joined.started, false);
  assert.equal(joined.review.id, started.review.id);
  assert.deepEqual(deckOf(db, room.id).slice(-3), ["overview: Design the billing export", "section: Format", "verdict: Verdict: Design the billing export"]);
  assert.equal(db.getItem(joined.firstItemId)!.title, "Design the billing export");

  // A comment whose passage a newer version dropped has no slide: the Verdict lists it.
  const format = reviewFor(db, other.id)!.plan;
  const lostAt = format.text.indexOf("One CSV a month.");
  changeReview(db, other.id, "Sam Hill", { action: "create", version: format.id, text: "Why monthly?", start: lostAt, end: lostAt + "One CSV a month.".length });
  db.addPlan(room.id, other.id, "# Billing export\n\n## Format\n\nA CSV on request.", "Ann Lee");
  planChanged(db, briefs, other);
  specChanged(db, briefs, other);
  assert.deepEqual(db.listItems(room.id).at(-1)!.slide!.design!.lost, [{ quote: "One CSV a month.", text: "Why monthly?", by: "Sam Hill" }]);
  assert.equal(deckOf(db, room.id).filter((t) => t.startsWith("point:")).length, 1);

  // An author moves between the slides of their own spec, and nowhere else.
  const slides = db.listItems(room.id);
  assert.equal(authorMay(db, room.id, slides[0].id, slides[3].id, sam), true);
  assert.equal(authorMay(db, room.id, slides[0].id, slides[3].id, ann), false);
  assert.equal(authorMay(db, room.id, slides[0].id, slides[5].id, sam), false);
  assert.equal(authorMay(db, room.id, slides[5].id, slides[6].id, ann), true);
  assert.equal(authorMay(db, room.id, null, slides[0].id, sam), false);
});

test("what the review decides goes back: onto each point's thread, the spec's to-do and what it waits on", () => {
  const { db, sam, room, task, by } = space();
  const briefs = new PlanBriefs(db, {});
  const capture = task("Move capture to the server");
  requestReview(db, briefs, capture, by(sam), [{ quote: "fallback for a week", text: "Is a week enough?" }, { quote: "ten percent", text: "Why ten percent?" }]);
  const started = startDesignReview(db, briefs, room.id);
  const m = db.startMeeting(room.id);
  const slides = db.listItems(room.id).filter((it) => it.slide?.layout === "design");
  const [week, ten] = ["Is a week enough?", "Why ten percent?"].map((q) => slides.find((it) => it.title === q)!);
  const steps = slides.find((it) => it.title === "Steps")!;
  const thread = (q: string) => db.planThreads(capture.id).find((t) => t.messages[0].text === q)!;
  db.replaceNotes(m.id, week.id, [
    { kind: "decision", text: "Keep the fallback for two weeks", owner: null },
    { kind: "action", text: "Change the plan to two weeks", owner: "Sam" },
  ]);
  db.replaceNotes(m.id, ten.id, [{ kind: "question", text: "Can we start at one percent?", owner: null }]);

  // Settled resolves the thread, with the decision caught on its slide; a second click takes that back.
  setDesignOutcome(db, briefs, week.id, "settled", "Ann Lee", m.id);
  let t = thread("Is a week enough?");
  assert.equal(t.resolved, true);
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[1].by, "Stand");
  assert.match(t.messages[1].text, /^Settled in the design review on \d+ \w+, by Ann Lee\.\nDecided:\n- Keep the fallback for two weeks\nTo do:\n- Change the plan to two weeks \(Sam\)$/);
  setDesignOutcome(db, briefs, week.id, null, "Ann Lee", m.id);
  t = thread("Is a week enough?");
  assert.deepEqual([t.resolved, t.messages.length], [false, 1]);
  // Still open leaves the thread open, with the questions and to-dos.
  setDesignOutcome(db, briefs, ten.id, "open", "Sam Hill", m.id);
  t = thread("Why ten percent?");
  assert.equal(t.resolved, false);
  assert.match(t.messages[1].text, /^Still open after the design review on \d+ \w+, by Sam Hill\.\nOpen questions:\n- Can we start at one percent\?$/);
  setDesignOutcome(db, briefs, week.id, "settled", "Ann Lee", m.id);
  setDesignOutcome(db, briefs, slides.at(-1)!.id, "changes", "Ann Lee", m.id);

  // The meeting ends, and its notes are tidied: one more to-do on a section slide, another decision on the point.
  finishDesignReview(db, room.id, m.id);
  db.replaceNotes(m.id, week.id, [
    { kind: "decision", text: "Keep the fallback for two weeks", owner: null },
    { kind: "decision", text: "Mobile clients get a banner", owner: null },
    { kind: "action", text: "Change the plan to two weeks", owner: "Sam" },
  ]);
  db.replaceNotes(m.id, steps.id, [{ kind: "action", text: "Write the flag removal checklist", owner: null }]);
  const general = db.replaceNotes(m.id, null, [{ kind: "action", text: "Book the offsite", owner: null }]);
  assert.deepEqual(writeBackReview(db, m.id), { specs: 1, links: 2 });

  // Stand's line on the thread is rewritten in place with everything caught.
  t = thread("Is a week enough?");
  assert.equal(t.messages.length, 2);
  assert.match(t.messages[1].text, /Decided:\n- Keep the fallback for two weeks\n- Mobile clients get a banner\nTo do:/);
  assert.equal(t.resolved, true);
  // The spec's to-do: one line with the verdict, and it waits on the to-dos from its slides only.
  const log = db.noteUpdates(capture.id).map((u) => u.text);
  assert.ok(log.some((l) => /^Design review, \d+ \w+: Approve with changes\. 1 question settled, 1 open\. 2 to-dos came out of it; this to-do waits on them\.$/.test(l)), log.join(" | "));
  const todos = db.meetingNotes(m.id).filter((n) => n.kind === "action");
  const waits = db.roomLinks(room.id, "depends_on").filter((l) => l.fromId === capture.id).map((l) => todos.find((n) => n.id === l.toId)?.text).sort();
  assert.deepEqual(waits, ["Change the plan to two weeks", "Write the flag removal checklist"]);
  assert.equal(db.roomLinks(room.id, "depends_on").some((l) => l.toId === general[0].id), false);
  // Writing back again adds no second link.
  assert.equal(writeBackReview(db, m.id).links, 0);

  // The review keeps a record: the verdict, each point with how it ended and what was raised on it.
  const record = designReviewRecord(db, room.id, started.review.id)!;
  assert.deepEqual([record.specs[0].title, record.specs[0].verdict, record.specs[0].verdictBy], ["Move capture to the server", "changes", "Ann Lee"]);
  const points = record.specs[0].slides.filter((x) => x.role === "point");
  assert.deepEqual(points.map((x) => [x.title, x.outcome, x.caught.length]), [["Why ten percent?", "open", 1], ["Is a week enough?", "settled", 3]]);
  assert.deepEqual(record.general.map((c) => c.text), ["Book the offsite"]);
  assert.deepEqual(designReviewsRan(db, room.id).map((r) => [r.titles, r.verdicts]), [[["Move capture to the server"], { approve: 0, changes: 1, not_yet: 0 }]]);
  assert.equal(designReviewOfMeeting(db, m.id)!.id, record.id);
  assert.equal(designReviewRecord(db, "other-room", record.id), null);
  assert.deepEqual(spaceFeed(db, room.id).designReviews!.map((r) => r.id), [record.id]);

  // The plan viewer knows the version that was reviewed, and a new request says the plan changed since.
  assert.deepEqual([lastReviewOf(db, capture.id)!.verdict, lastReviewOf(db, capture.id)!.changed], ["changes", false]);
  db.addPlan(room.id, capture.id, SPEC.replace("for a week", "for two weeks"), "Sam Hill");
  assert.equal(designReviewState(db, capture).last!.changed, true);
  requestReview(db, briefs, capture, by(sam));
  assert.ok(db.noteUpdates(capture.id).some((u) => /^Review requested: the plan is on the next design review\. Changed since the last review on \d+ \w+ \(Approve with changes\)\.$/.test(u.text)));
  assert.equal(designReviewView(db, briefs, room.id, sam)!.specs[0].last!.reviewId, record.id);
  // The point settled last time is resolved, so it isn't a point again; the open one is.
  assert.deepEqual(designReviewView(db, briefs, room.id, sam)!.specs[0].points.map((p) => p.text), ["Why ten percent?"]);
});

test("after a design review each capture goes under the slide it was about, before what was caught goes back to the spec", async () => {
  const { db, sam, room, task, by } = space();
  const briefs = new PlanBriefs(db, {});
  const [standing] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Standing item", url: null, description: null }]);
  const capture = task("Move capture to the server");
  requestReview(db, briefs, capture, by(sam), [{ quote: "fallback for a week", text: "Is a week enough?" }]);
  startDesignReview(db, briefs, room.id);
  const m = db.startMeeting(room.id);
  const slides = db.listItems(room.id).filter((it) => it.slide?.layout === "design");
  const week = slides.find((it) => it.title === "Is a week enough?")!;
  const steps = slides.find((it) => it.title === "Steps")!;
  // The answer to the question was said after the author moved on to the next section.
  const [late] = db.replaceNotes(m.id, steps.id, [{ kind: "decision", text: "Keep the fallback for two weeks", owner: null }]);
  const [kept] = db.replaceNotes(m.id, standing.id, [{ kind: "action", text: "Book the offsite", owner: null }]);
  setDesignOutcome(db, briefs, week.id, "settled", "Ann Lee", m.id);
  finishDesignReview(db, room.id, m.id);

  const { text, noteOf, slideOf } = refilePrompt(db.reviewSlides(db.reviewByMeeting(m.id, "design")!.id), db.meetingNotes(m.id), (id) => db.getItem(id));
  const keyOf = (itemId: string) => [...slideOf].find(([, s]) => s.itemId === itemId)![0];
  assert.match(text, new RegExp(`${keyOf(week.id)} "Question 1" \\(question for the team of the spec "Move capture to the server"\\): Is a week enough\\?`));
  assert.match(text, /About this passage of the spec: "[^"]*fallback for a week/);
  assert.match(text, new RegExp(`${keyOf(steps.id)} "Steps" \\(section of the spec`));
  const key = (id: string) => [...noteOf].find(([, n]) => n.id === id)![0];

  const done = await refileReview(db, m.id, async () => [
    { note: key(late.id), to: keyOf(week.id) },
    // One under another agenda item that no slide is about stays there.
    { note: key(kept.id), to: "none" },
  ]);
  assert.deepEqual(done, { moved: 1, dropped: 0 });
  assert.equal(db.meetingNotes(m.id).find((n) => n.id === kept.id)!.itemId, standing.id);
  writeBackReview(db, m.id);
  const thread = db.planThreads(capture.id).find((t) => t.messages[0].text === "Is a week enough?")!;
  assert.match(thread.messages.at(-1)!.text, /Decided:\n- Keep the fallback for two weeks/);
});

/** A spec of twelve sections, some long and some short. Section 4's text can be quoted. */
const SIZES = [10, 500, 20, 30, 400, 15, 600, 25, 35, 700, 12, 18];
const BIG = ["# Big spec", "", "Why this is big.", "", ...SIZES.flatMap((n, i) => [`## S${i + 1}`, "", `Body ${i + 1}: ${"x".repeat(n)}`, ""])].join("\n");

test("a spec gets at most eight section slides: short sections that follow each other share one, and the author can regroup", async () => {
  const { db, task } = space();
  const note = task("Big spec", "Sam", BIG);
  const briefs = new PlanBriefs(db, {});
  let brief = (await briefs.ensure(note))!;
  // The two adjacent slides with the least text join, until eight are left. The order is the spec's.
  const stand = [["S1"], ["S2"], ["S3", "S4"], ["S5", "S6"], ["S7"], ["S8", "S9"], ["S10"], ["S11", "S12"]];
  assert.deepEqual(slideGroups(brief, BIG), stand);
  // A spec of few sections keeps one slide for each.
  const small = task("Small spec");
  assert.deepEqual(slideGroups((await briefs.ensure(small))!, SPEC), [["Why"], ["Steps"], ["How to verify"]]);
  // A section off the call leaves room: the deck is regrouped around what is left.
  brief = briefs.setSection(note, "S2", { off: true }, "Sam Hill")!;
  assert.deepEqual(slideGroups(brief, BIG), [["S1", "S3"], ["S4"], ["S5"], ["S6"], ["S7"], ["S8", "S9"], ["S10"], ["S11", "S12"]]);
  brief = briefs.setSection(note, "S2", { off: false }, "Sam Hill")!;

  // The author gives S4 its own slide: the slides Stand made become the author's, with that one change.
  brief = briefs.setSection(note, "S4", { join: false }, "Sam Hill")!;
  assert.equal(brief.grouped, true);
  assert.deepEqual(slideGroups(brief, BIG), [["S1"], ["S2"], ["S3"], ["S4"], ["S5", "S6"], ["S7"], ["S8", "S9"], ["S10"], ["S11", "S12"]]);
  brief = briefs.setSection(note, "S2", { join: true }, "Sam Hill")!;
  assert.deepEqual(slideGroups(brief, BIG).slice(0, 2), [["S1", "S2"], ["S3"]]);
  // The first section has no slide above it to join.
  assert.deepEqual(slideGroups(briefs.setSection(note, "S1", { join: true }, "Sam Hill")!, BIG)[0], ["S1", "S2"]);
  // Taking the first section of a shared slide off the call leaves the rest of that slide together.
  brief = briefs.setSection(note, "S5", { off: true }, "Sam Hill")!;
  brief = briefs.setSection(note, "S8", { off: true }, "Sam Hill")!;
  assert.deepEqual(slideGroups(brief, BIG).slice(2), [["S4"], ["S6"], ["S7"], ["S9"], ["S10"], ["S11", "S12"]]);

  // A new version of the plan keeps the author's grouping; a section that is new has its own slide.
  db.addPlan(note.roomId, note.id, BIG.replace("## S7", "## S6b\n\nNew.\n\n## S7"), "Sam Hill");
  const next = (await briefs.ensure(note))!;
  assert.equal(next.grouped, true);
  assert.deepEqual(slideGroups(next, db.planVersions(note.id).at(-1)!.text), [["S1", "S2"], ["S3"], ["S4"], ["S6"], ["S6b"], ["S7"], ["S9"], ["S10"], ["S11", "S12"]]);
  // Handing it back to Stand: eight slides again, of the sections on the call.
  brief = briefs.regroup(note, "Sam Hill")!;
  assert.equal(brief.grouped, undefined);
  assert.equal(slideGroups(brief, db.planVersions(note.id).at(-1)!.text).length, 8);
});

test("in the call sections that share a slide are one slide, and a question is a step after the slide of its section", async () => {
  const { db, sam, room, task, by } = space();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`);
  const briefs = new PlanBriefs(db, { taskBrief: async () => ({ summary: "A big spec.", sections: SIZES.map((_, i) => ({ heading: `S${i + 1}`, lines: lines(4) })), questions: [] }) });
  const note = task("Big spec", "Sam", BIG);
  requestReview(db, briefs, note, by(sam), [{ quote: "Body 4:", text: "Is section four right?" }]);
  await briefs.ensure(note);
  assert.deepEqual(designReviewView(db, briefs, room.id, sam)!.specs[0].groups.length, 8);
  startDesignReview(db, briefs, room.id);
  assert.deepEqual(deckOf(db, room.id), [
    "overview: Big spec",
    "section: S1",
    "section: S2",
    "section: S3 · S4",
    "point: Is section four right?",
    "section: S5 · S6",
    "section: S7",
    "section: S8 · S9",
    "section: S10",
    "section: S11 · S12",
    "verdict: Verdict: Big spec",
  ]);
  const items = db.listItems(room.id);
  assert.deepEqual(items[0].slide!.design!.sections, ["S1", "S2", "S3 · S4", "S5 · S6", "S7", "S8 · S9", "S10", "S11 · S12"]);
  // A slide of one section shows its four lines; one that two share shows three of each.
  assert.deepEqual(items[1].slide!.design!.parts, [{ heading: "S1", lines: lines(4), stand: true }]);
  const shared = items[3].slide!.design!;
  assert.deepEqual([shared.name, shared.section, shared.parts!.map((p) => [p.heading, p.lines.length])], ["S3 +1", "S3", [["S3", 3], ["S4", 3]]]);
  assert.match(items[3].description ?? "", /These sections of the spec:\nS3\nBody 3: x+\n\nS4\nBody 4: x+/);
  assert.deepEqual([items[4].slide!.design!.name, items[4].slide!.design!.section], ["Question 1", "S4"]);

  // The author gives S4 its own slide mid-call: the question goes with it, and the slides that stay keep their items.
  prepare(db, briefs, note, by(sam), { section: "S4", join: false });
  specChanged(db, briefs, note);
  assert.deepEqual(deckOf(db, room.id).slice(3, 7), ["section: S3", "section: S4", "point: Is section four right?", "section: S5 · S6"]);
  assert.deepEqual([db.listItems(room.id)[3].id, db.listItems(room.id)[5].id], [items[3].id, items[4].id]);
  // Joined again, S4's slide goes and the question is a step on the shared slide.
  prepare(db, briefs, note, by(sam), { section: "S4", join: true });
  specChanged(db, briefs, note);
  assert.deepEqual(deckOf(db, room.id).slice(3, 6), ["section: S3 · S4", "point: Is section four right?", "section: S5 · S6"]);
  // Stand groups again when the author asks.
  prepare(db, briefs, note, by(sam), { regroup: true });
  specChanged(db, briefs, note);
  assert.equal(deckOf(db, room.id).filter((t) => t.startsWith("section:")).length, 8);
});

test("a section's slide shows the first mermaid diagram the spec has under it", () => {
  const { db, sam, room, task, by } = space();
  const flow = "flowchart LR\n  browser --> server\n  server --> notes";
  const spec = [
    "# Capture",
    "",
    "```mermaid",
    "flowchart LR\n  before --> headings",
    "```",
    "",
    "## Flow",
    "",
    "Capture moves to the server.",
    "",
    "```mermaid",
    flow,
    "```",
    "",
    "- A list with a second diagram:",
    "",
    "  ```Mermaid",
    "  sequenceDiagram\n    a->>b: hi",
    "  ```",
    "",
    "## Code",
    "",
    "```sql",
    "SELECT 1;",
    "```",
    "",
    "```mermaid",
    "```",
  ].join("\n");
  assert.deepEqual(planDiagrams(spec).map((d) => d.code.split("\n")[0]), ["flowchart LR", "flowchart LR", "sequenceDiagram"]);
  const note = task("Move capture to the server", "Sam", spec);
  const briefs = new PlanBriefs(db, {});
  requestReview(db, briefs, note, by(sam));
  // The review page knows which sections have one, and each slide carries its own.
  assert.deepEqual(designReviewView(db, briefs, room.id, sam)!.specs[0].diagrams, { Flow: flow });
  startDesignReview(db, briefs, room.id);
  const [, flowSlide, code] = db.listItems(room.id);
  assert.deepEqual(flowSlide.slide!.design!.parts, [{ heading: "Flow", lines: [], stand: false, diagram: flow }]);
  assert.deepEqual(code.slide!.design!.parts, [{ heading: "Code", lines: [], stand: false }]);
});

test("on a shared slide a diagram takes the room of a section, so each section shows fewer lines", async () => {
  // Alone on a slide a section keeps its four lines, with a diagram or not.
  assert.deepEqual([linesShown(1), linesShown(1, 1), linesShown(2), linesShown(2, 1), linesShown(2, 2), linesShown(3), linesShown(3, 1)], [4, 4, 3, 2, 1, 2, 1]);
  const { db, sam, room, task, by } = space();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`);
  const mermaid = (code: string) => ["```mermaid", code, "```"].join("\n");
  const spec = ["# Capture", "", "## Flow", "", mermaid("flowchart LR\n  a --> b"), "", "## States", "", mermaid("stateDiagram-v2\n  [*] --> On"), "", "## Cost", "", "Cheap.", "", "## Risks", "", "Few."].join("\n");
  const briefs = new PlanBriefs(db, { taskBrief: async () => ({ summary: "Capture.", sections: ["Flow", "States", "Cost", "Risks"].map((heading) => ({ heading, lines: lines(4) })), questions: [] }) });
  const note = task("Move capture to the server", "Sam", spec);
  requestReview(db, briefs, note, by(sam));
  await briefs.ensure(note);
  prepare(db, briefs, note, by(sam), { section: "States", join: true });
  prepare(db, briefs, note, by(sam), { section: "Risks", join: true });
  startDesignReview(db, briefs, room.id);
  const [, both, plain] = db.listItems(room.id);
  // Two sections and two diagrams: one line of each. Two sections and no diagram: three.
  assert.deepEqual(both.slide!.design!.parts!.map((p) => [p.heading, p.lines, !!p.diagram]), [["Flow", lines(1), true], ["States", lines(1), true]]);
  assert.deepEqual(plain.slide!.design!.parts!.map((p) => [p.heading, p.lines.length, !!p.diagram]), [["Cost", 3, false], ["Risks", 3, false]]);
});

test("a design review that ends with nothing called goes back to waiting and can start again", () => {
  const { db, sam, room, task, by } = space();
  const briefs = new PlanBriefs(db, { taskBrief: async () => DRAFT });
  const capture = task("Move capture to the server");
  requestReview(db, briefs, capture, by(sam));
  const first = startDesignReview(db, briefs, room.id);
  const m = db.startMeeting(room.id);
  const back = finishDesignReview(db, room.id, m.id)!;
  assert.deepEqual([back.status, back.meetingId, back.startedAt], ["draft", null, null]);
  assert.equal(designReviewsRan(db, room.id).length, 0);
  assert.equal(designReviewOfMeeting(db, m.id), null);
  const view = designReviewView(db, briefs, room.id, sam)!;
  assert.deepEqual([view.status, view.specs.map((s) => s.taskId)], ["draft", [capture.id]]);
  assert.deepEqual(designReviewState(db, capture), { queued: true, points: 0 });
  // Starting again lays the slides out afresh.
  const again = startDesignReview(db, briefs, room.id);
  assert.equal(again.started, true);
  assert.notEqual(again.firstItemId, first.firstItemId);
  assert.equal(db.listItems(room.id)[0].id, again.firstItemId);
});
