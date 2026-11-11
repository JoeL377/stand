import assert from "node:assert/strict";
import { test } from "node:test";
import { pointsOnDeck } from "../shared/designReview.ts";
import { spaceFeed } from "./captures.ts";
import { openDb } from "./db.ts";
import {
  DesignReviewError, authorMay, designReviewState, designReviewView, finishDesignReview, isAuthor, planChanged, prepare, removeSpec, requestReview, setDesignOutcome,
  specChanged, startDesignReview,
} from "./designReviews.ts";
import type { Agent } from "./llm.ts";
import { PlanBriefs } from "./planBrief.ts";
import { changeReview, planSections, reviewFor } from "./planReview.ts";
import { addSlide, reviewView, startReview } from "./reviews.ts";

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
  assert.deepEqual([point.slide!.design!.name, point.slide!.design!.quote, point.slide!.design!.section], ["Point 2", "- Keep the browser fallback for a week", "Steps"]);
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

test("in the call a new comment gets a slide after the one on screen, and the author's changes re-lay the deck", () => {
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

  // A comment on a passage of Steps, made while the Why slide is on screen: its slide follows Why.
  const plan = reviewFor(db, capture.id)!.plan;
  const why = db.listItems(room.id)[1];
  const at = (s: string) => ({ start: plan.text.indexOf(s), end: plan.text.indexOf(s) + s.length });
  const thread = changeReview(db, capture.id, "Ann Lee", { action: "create", version: plan.id, text: "Why ten percent?", ...at("- Run capture on the server for ten percent of meetings") })!;
  assert.equal(specChanged(db, briefs, capture, why.id), true);
  assert.deepEqual(deckOf(db, room.id).slice(1, 4), ["section: Why", "point: Why ten percent?", "section: Steps"]);
  // With nothing of this spec on screen, a new point goes under its section.
  changeReview(db, capture.id, "Ann Lee", { action: "create", version: plan.id, text: "How do we compare?", ...at("Compare the two transcripts.") });
  specChanged(db, briefs, capture);
  assert.deepEqual(deckOf(db, room.id).slice(-3), ["section: How to verify", "point: How do we compare?", "verdict: Verdict: Move capture to the server"]);
  // The slides that were there keep their agenda items, so what was said on them stays with them.
  assert.equal(db.listItems(room.id)[1].id, why.id);
  assert.equal(specChanged(db, briefs, other), false);

  // The author takes a section off mid-call: its slide goes, its point stays, after the section before it.
  prepare(db, briefs, capture, by(sam), { section: "How to verify", off: true });
  specChanged(db, briefs, capture);
  assert.deepEqual(deckOf(db, room.id).slice(-3), ["section: Steps", "point: How do we compare?", "verdict: Verdict: Move capture to the server"]);
  // A point the team called keeps its slide when the author takes it off; one nobody called goes.
  const point = db.listItems(room.id).find((it) => it.title === "Why ten percent?")!;
  setDesignOutcome(db, briefs, point.id, "open", "Ann Lee");
  prepare(db, briefs, capture, by(sam), { point: thread.id, off: true });
  prepare(db, briefs, capture, by(sam), { point: db.planThreads(capture.id)[1].id, off: true });
  specChanged(db, briefs, capture);
  assert.deepEqual(deckOf(db, room.id), ["overview: Move capture to the server", "section: Why", "point: Why ten percent?", "section: Steps", "verdict: Verdict: Move capture to the server"]);

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
