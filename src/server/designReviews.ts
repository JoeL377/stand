// Design reviews: a call where the team goes through a spec and leaves with a verdict on it.
//
// A spec joins the space's next design review only when someone asks (the Request review button
// on a plan, or the MCP's request_design_review). The review shares the product review's tables:
// it is a review of kind "design", and each spec waiting on it is one slide, its overview.
//
// A question for the team is an open comment thread on the spec (planReview.ts); there is no new
// primitive, and the code calls one on the deck a point. The author's questions come with the
// request as threads, reviewers comment on passages as they do anywhere, and Stand's suggestions
// become threads only when the author accepts them. What each slide says is the spec's brief
// (planBrief.ts).

import type { Actor } from "../shared/actors.ts";
import {
  DESIGN_QUESTIONS_MAX, POINT_OUTCOMES, VERDICTS, linesShown, pointsOnDeck, specAuthor,
  designOutcomeLabel,
  type BriefChange, type DesignCaught, type DesignOutcome, type DesignPoint, type DesignReviewRan, type DesignReviewRecord, type DesignReviewState, type DesignReviewSummary,
  type DesignReviewView, type DesignSlideInfo, type DesignSpec, type LastDesignReview, type PlanBrief, type Verdict,
} from "../shared/designReview.ts";
import type { Passage, PlanThread } from "../shared/planReview.ts";
import { TASK_COMMENT_MAX, type Item, type Note, type SlideContent } from "../shared/protocol.ts";
import type { DB, ReviewRow, ReviewSlideRow } from "./db.ts";
import { newId } from "./ids.ts";
import { slideGroups, type PlanBriefs } from "./planBrief.ts";
import { changeReview, logThreadChange, passageAround, planBlocks, planSections, quotePassage, reviewFor } from "./planReview.ts";

const MAX_SPECS = 20;
const QUOTE_MAX = 600;

export class DesignReviewError extends Error {}

type Task = Note & { roomId: string };
/** Who did it: the person, and their agent's connection when it came over the MCP. */
export interface By {
  userId: string;
  userName: string;
  client: string | null;
  actor?: Actor | null;
}
const nameOf = (by: By) => (by.client ? `${by.userName} via ${by.client}` : by.userName);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (ts: number) => new Date(ts).toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });

/** Whether this person prepares the spec for its review: they own the to-do, or wrote its latest plan. */
export function isAuthor(db: DB, note: Note, user: { id: string; name: string }): boolean {
  const plan = db.notePlan(note.id);
  return specAuthor({ owner: note.owner ?? null, planBy: plan?.by ?? "", planById: plan?.actor?.personId ?? null }, user);
}

const overviewIn = (db: DB, review: ReviewRow | null, noteId: string) =>
  (review && db.reviewSlides(review.id).find((s) => s.role === "overview" && s.noteId === noteId)) ?? null;

/** The last design review that ran on a to-do's plan: its verdict, and whether the plan has changed since. */
export function lastReviewOf(db: DB, noteId: string): LastDesignReview | null {
  const verdict = db.lastDesignVerdict(noteId);
  if (!verdict) return null;
  const latest = db.planVersions(noteId).at(-1)?.id;
  return { reviewId: verdict.reviewId, at: verdict.startedAt, verdict: (verdict.outcome as Verdict | null) ?? null, changed: !!latest && !!verdict.planVersion && latest !== verdict.planVersion };
}

/** The spec's place on the design review in a call, else on the next one, if it has one. */
function queued(db: DB, roomId: string, noteId: string): ReviewSlideRow | null {
  return overviewIn(db, db.reviewIn(roomId, ["live"], "design"), noteId) ?? overviewIn(db, db.reviewIn(roomId, ["draft"], "design"), noteId);
}

/** The open threads on a to-do's latest plan, in the plan's order; ones whose passage is gone come last. */
export function pointsOf(db: DB, noteId: string): DesignPoint[] {
  const review = reviewFor(db, noteId);
  if (!review) return [];
  const sections = planSections(review.plan.text);
  const at = (p: Passage | null) => p?.start ?? Infinity;
  return review.threads
    .filter((t) => !t.resolved)
    .sort((a, b) => at(a.placement) - at(b.placement))
    .map((t) => ({
      threadId: t.id,
      quote: clip(t.placement ? review.plan.text.slice(t.placement.start, t.placement.end) : t.original.quote, QUOTE_MAX),
      text: t.messages[0]?.text ?? "",
      by: t.messages[0]?.by ?? "",
      section: t.placement ? (sections.find((s) => s.start <= t.placement!.start && t.placement!.start < s.end)?.heading ?? null) : null,
      off: !!t.offDeck,
      placed: !!t.placement,
    }));
}

const emptyBrief = (version: string): PlanBrief => ({ version, status: "none", summary: "", summaryEdited: false, sections: [], suggestions: [], editedBy: null, at: 0 });

function specOf(db: DB, briefs: PlanBriefs | null, slide: ReviewSlideRow, user: { id: string; name: string } | null): DesignSpec | null {
  const note = slide.noteId ? db.getNote(slide.noteId) : null;
  const plan = note && db.planVersions(note.id).at(-1);
  if (!note || !plan) return null;
  let brief = briefs?.current(note.id) ?? null;
  // No brief for this version yet, or a restart cut its writing off: write it now.
  if (briefs && (!brief || brief.status === "writing")) {
    void briefs.ensure(note).catch(() => {});
    brief = briefs.current(note.id);
  }
  return {
    taskId: note.id,
    title: note.text,
    owner: note.owner ?? null,
    requestedBy: slide.addedBy,
    requestedAt: slide.createdAt,
    planVersion: plan.id,
    planBy: plan.by,
    mine: !!user && isAuthor(db, note, user),
    brief: brief ?? emptyBrief(plan.id),
    groups: slideGroups(briefFor(db, briefs, note.id, plan), plan.text),
    points: pointsOf(db, note.id),
    last: lastReviewOf(db, note.id),
  };
}

/** The design review in a call, else the space's next one, as its page shows it to this person; null
 *  when no spec waits on it. */
export function designReviewView(db: DB, briefs: PlanBriefs | null, roomId: string, user: { id: string; name: string } | null): DesignReviewView | null {
  for (const review of [db.reviewIn(roomId, ["live"], "design"), db.reviewIn(roomId, ["draft"], "design")]) {
    if (!review) continue;
    const specs = db.reviewSlides(review.id).filter((s) => s.role === "overview").flatMap((s) => specOf(db, briefs, s, user) ?? []);
    if (specs.length) return { id: review.id, status: review.status, specs };
  }
  return null;
}

/** The next design review in a line, for the Tasks tab. */
export function designReviewSummary(db: DB, roomId: string): DesignReviewSummary | null {
  const view = designReviewView(db, null, roomId, null);
  if (!view) return null;
  return { specs: view.specs.length, points: view.specs.reduce((n, s) => n + pointsOnDeck(s.points).length, 0), titles: view.specs.map((s) => s.title), live: view.status === "live" };
}

/** Whether a to-do's spec waits on the next design review, and with how many points. */
export function designReviewState(db: DB, note: Task): DesignReviewState {
  const live = !!liveWith(db, note.roomId, note.id);
  const last = lastReviewOf(db, note.id);
  return { queued: !!queued(db, note.roomId, note.id), points: pointsOnDeck(pointsOf(db, note.id)).length, ...(live && { live }), ...(last && { last }) };
}

export interface DesignQuestion {
  /** The passage it is about, copied from the plan. Left out, it is about the whole spec. */
  quote?: string;
  text: string;
}

/** A question as a thread on the plan. One the plan already carries (same passage, same words, still open) isn't asked twice. */
function ask(db: DB, note: Task, by: By, version: string, passage: Passage, text: string, origin: PlanThread["origin"], as = nameOf(by)): PlanThread | null {
  const same = reviewFor(db, note.id)?.threads.find(
    (t) => !t.resolved && t.placement?.start === passage.start && t.placement.end === passage.end && t.messages[0]?.text.trim() === text.trim(),
  );
  if (same) return null;
  const thread = changeReview(db, note.id, as, { action: "create", version, text, ...passage }, origin);
  if (!thread) throw new DesignReviewError("That question or its passage is too long.");
  logThreadChange(db, note, thread, "create", by);
  return thread;
}

/** Puts a to-do's spec on the space's next design review, with the author's questions as points.
 *  Asking again for a spec that is already there only adds the questions. */
export function requestReview(db: DB, briefs: PlanBriefs | null, note: Task, by: By, questions: DesignQuestion[] = []): { added: boolean; questions: number } {
  if (note.kind !== "action") throw new DesignReviewError("A design review is of a to-do's plan (stand:action/...).");
  const review = reviewFor(db, note.id);
  if (!review) throw new DesignReviewError("This to-do has no plan yet. Attach one, then ask for its review.");
  if (questions.length > DESIGN_QUESTIONS_MAX) throw new DesignReviewError(`A request takes up to ${DESIGN_QUESTIONS_MAX} questions. Ask the ones the team has to decide.`);
  const spec = review.plan.text;
  // Every question is checked before anything is written, so a bad quote leaves nothing half done.
  const asked = questions.map((q, i) => {
    const text = typeof q.text === "string" ? q.text.trim() : "";
    const n = questions.length > 1 ? `Question ${i + 1}: ` : "";
    if (!text || text.length > TASK_COMMENT_MAX) throw new DesignReviewError(`${n}Say what the question is, in up to ${TASK_COMMENT_MAX} characters.`);
    // A question about the whole spec sits on its first line.
    const passage = q.quote?.trim() ? quotePassage(spec, q.quote) : (planBlocks(spec)[0] ?? "missing");
    if (passage === "missing") throw new DesignReviewError(`${n}That quote isn't in the latest plan. Copy the passage exactly as get_plan_review returns it.`);
    if (passage === "ambiguous") throw new DesignReviewError(`${n}The plan says that more than once. Quote more of the passage so it is the only one.`);
    return { text, passage };
  });
  const draft = db.reviewIn(note.roomId, ["draft"], "design") ?? db.createReview(note.roomId, "design");
  const slides = db.reviewSlides(draft.id);
  const had = slides.find((s) => s.role === "overview" && s.noteId === note.id);
  if (!had && slides.length >= MAX_SPECS) throw new DesignReviewError(`The next design review already has ${MAX_SPECS} specs. Take one off first.`);
  if (had) db.updateReviewSlide(had.id, { planVersion: review.plan.id });
  else db.addReviewSlide(draft.id, { title: note.text, body: "", noteId: note.id, owner: note.owner ?? null, addedBy: nameOf(by), pr: null, role: "overview", planVersion: review.plan.id });
  let made = 0;
  for (const q of asked) if (ask(db, note, by, review.plan.id, q.passage, q.text, { review: draft.id, source: "author" })) made++;
  if (!had) {
    const last = lastReviewOf(db, note.id);
    const since = last
      ? ` ${last.changed ? "Changed" : "Not changed"} since the last review${last.at ? ` on ${day(last.at)}` : ""}${last.verdict ? ` (${designOutcomeLabel(last.verdict)})` : ""}.`
      : "";
    db.addUpdate({
      roomId: note.roomId, itemId: note.itemId, noteId: note.id, noteText: note.text, ...by,
      status: "comment", text: `Review requested: the plan is on the next design review.${since}`, links: [],
    });
  }
  void briefs?.ensure(note).catch(() => {});
  return { added: !had, questions: made };
}

/** Takes a spec off the next design review. Its threads stay on the plan. One in a call stays. */
export function removeSpec(db: DB, note: Task, by: By): boolean {
  const slide = overviewIn(db, db.reviewIn(note.roomId, ["draft"], "design"), note.id);
  if (!slide) return false;
  db.removeReviewSlide(slide.id);
  db.addUpdate({
    roomId: note.roomId, itemId: note.itemId, noteId: note.id, noteText: note.text, ...by,
    status: "comment", text: "Took the plan off the next design review.", links: [],
  });
  return true;
}

/** Whether this person asked for the spec's review, so they can take it back. */
export function requested(db: DB, note: Task, user: { name: string }): boolean {
  const by = queued(db, note.roomId, note.id)?.addedBy;
  return !!by && (by === user.name || by.startsWith(`${user.name} via `));
}

/** A new version of a plan was attached: a spec waiting on a review is reviewed at its latest version. */
export function planChanged(db: DB, briefs: PlanBriefs | null, note: Task) {
  const slide = queued(db, note.roomId, note.id);
  const plan = db.planVersions(note.id).at(-1);
  if (!slide || !plan) return;
  for (const s of db.reviewSlides(slide.reviewId)) if (s.noteId === note.id) db.updateReviewSlide(s.id, { planVersion: plan.id });
  void briefs?.ensure(note).catch(() => {});
}

/** One change by the author while preparing the spec. Throws DesignReviewError when it can't be made. */
export function prepare(db: DB, briefs: PlanBriefs, note: Task, by: By, change: BriefChange) {
  const review = reviewFor(db, note.id);
  if (!review) throw new DesignReviewError("This to-do has no plan.");
  const spec = review.plan.text;
  const origin = (source: "author" | "stand") => ({ review: db.reviewIn(note.roomId, ["draft"], "design")?.id ?? null, source });
  const gone = () => new DesignReviewError("That isn't on this plan any more. Load the page again.");
  if ("summary" in change) {
    if (typeof change.summary !== "string" || !briefs.setSummary(note, change.summary, by.userName)) throw gone();
  } else if ("question" in change) {
    const text = typeof change.question === "string" ? change.question.trim() : "";
    if (!text || text.length > TASK_COMMENT_MAX) throw new DesignReviewError(`Write a question of 1 to ${TASK_COMMENT_MAX} characters.`);
    const section = change.section ? planSections(spec).find((s) => s.heading === change.section) : null;
    if (change.section && !section) throw gone();
    const passage = section ? { start: section.start, end: section.headingEnd } : planBlocks(spec)[0];
    if (!passage) throw gone();
    ask(db, note, by, review.plan.id, passage, text, origin("author"));
  } else if ("section" in change) {
    const lines = Array.isArray(change.lines) ? change.lines.filter((l): l is string => typeof l === "string") : undefined;
    const off = typeof change.off === "boolean" ? change.off : undefined;
    const join = typeof change.join === "boolean" ? change.join : undefined;
    if (typeof change.section !== "string" || !briefs.setSection(note, change.section, { lines, off, join }, by.userName)) throw gone();
  } else if ("regroup" in change) {
    if (!briefs.regroup(note, by.userName)) throw gone();
  } else if ("suggestion" in change) {
    const s = briefs.closeSuggestion(note, String(change.suggestion), change.accept ? "accepted" : "dismissed");
    if (!s) throw gone();
    if (change.accept) {
      const passage = passageAround(spec, spec.indexOf(s.quote), s.quote.length);
      if (!passage) throw gone();
      // Stand asked it; the author put it in front of the team.
      ask(db, note, by, review.plan.id, passage, s.text, origin("stand"), "Stand");
    }
  } else if ("point" in change) {
    const thread = db.planThreads(note.id).find((t) => t.id === change.point);
    if (!thread) throw gone();
    const { offDeck: _o, ...rest } = thread;
    db.savePlanThread(note.id, change.off ? { ...rest, offDeck: true } : rest);
  } else if ("rewrite" in change) {
    void briefs.ensure(note, true).catch(() => {});
  } else {
    throw new DesignReviewError("Nothing to change.");
  }
}

/** One spec as the review page shows it, whether or not it waits on a review. */
export function specView(db: DB, briefs: PlanBriefs, note: Task, user: { id: string; name: string }): DesignSpec | null {
  const slide = queued(db, note.roomId, note.id);
  return slide ? specOf(db, briefs, slide, user) : null;
}

// ---- the call -------------------------------------------------------------------------------------
//
// Starting a design review turns each spec into slides: its Overview, its sections on at most
// SECTION_SLIDES_MAX slides (planBrief.ts slideGroups), and its Verdict. Each question is a step on
// the slide of its section: a row and an agenda item of its own, right after that slide, so what's
// said while it is up is filed under the question. The rows in review_slides hold the order; what
// a slide says is read from the plan, its brief and its threads each time the deck is laid out again.

const TITLE_MAX = 140;
const NAME_MAX = 32;
const PASSAGE_MAX = 1500;
const mine = (rows: ReviewSlideRow[], noteId: string) => rows.filter((r) => r.noteId === noteId);

/** The brief the slides read: the saved one, else the spec's headings with nothing under them. */
function briefFor(db: DB, briefs: PlanBriefs | null, noteId: string, plan: { id: string; text: string }): PlanBrief {
  return (
    briefs?.current(noteId) ??
    db.planBrief(noteId, plan.id) ?? { ...emptyBrief(plan.id), sections: planSections(plan.text).map((s) => ({ heading: s.heading, lines: [], edited: false, off: false })) }
  );
}

/** Makes one spec's rows match what should be on the deck now: a row for each section slide and for
 *  each point, in the plan's order. A section slide's row carries the heading of its first section.
 *  A point that already has a row keeps its place; a new one goes after the points of the slide its
 *  section is on. Only what the author took off the call leaves, and never a point the team has
 *  already called. */
function layOut(db: DB, briefs: PlanBriefs | null, review: ReviewRow, noteId: string) {
  const note = db.getNote(noteId);
  const plan = db.planVersions(noteId).at(-1);
  const all = db.reviewSlides(review.id);
  const rows = mine(all, noteId);
  const overview = rows.find((r) => r.role === "overview");
  if (!note || !plan || !overview) {
    rows.forEach((r) => db.removeReviewSlide(r.id));
    return;
  }
  const brief = briefFor(db, briefs, noteId, plan);
  const points = pointsOf(db, noteId);
  const added = new Set<string>();
  const add = (s: Partial<ReviewSlideRow> & { role: ReviewSlideRow["role"]; title: string }) => {
    const row = db.addReviewSlide(review.id, { body: "", noteId, owner: note.owner ?? null, addedBy: null, pr: null, planVersion: plan.id, ...s });
    added.add(row.id);
    return row;
  };
  const verdict = rows.find((r) => r.role === "verdict") ?? add({ role: "verdict", title: "Verdict" });
  // Section slides: one for each group of sections on the call. A heading that no longer leads a slide loses its row.
  const groups = slideGroups(brief, plan.text);
  const leadOf = new Map(groups.flatMap((g) => g.map((h) => [h, g[0]] as const)));
  const on = groups.map((g) => g[0]);
  for (const row of rows.filter((r) => r.role === "section" && !on.includes(r.section!))) db.removeReviewSlide(row.id);
  const newSections = on.filter((h) => !rows.some((r) => r.role === "section" && r.section === h)).map((h) => add({ role: "section", title: h, section: h }));
  // Points: every open one on the deck has a slide. One taken off the call loses its slide unless the team called it.
  const had = new Map(rows.filter((r) => r.role === "point").map((r) => [r.threadId!, r]));
  const newPoints: ReviewSlideRow[] = [];
  for (const p of points) {
    const row = had.get(p.threadId);
    if (row && p.off && !row.outcome) db.removeReviewSlide(row.id);
    else if (!row && !p.off && p.placed) newPoints.push(add({ role: "point", title: "Question", threadId: p.threadId, section: p.section }));
  }
  // Order. The slides that were there keep their places; a new one finds its own.
  const before = db.reviewSlides(review.id);
  const byId = new Map(before.map((r) => [r.id, r]));
  const order = mine(before, noteId).filter((r) => !added.has(r.id) && r.role !== "overview" && r.role !== "verdict").map((r) => r.id);
  order.unshift(overview.id);
  const isPoint = (id: string | undefined) => !!id && byId.get(id)?.role === "point";
  /** Where a block led by this slide ends: after the points that follow it. */
  const endOf = (lead: string) => {
    let at = order.indexOf(lead) + 1;
    while (isPoint(order[at])) at++;
    return at;
  };
  /** The heading that leads the slide a section is on or, for one off the call, the slide it comes
   *  after. Null is the overview. */
  const homeOf = (heading: string | null | undefined): string | null => {
    for (let i = heading ? brief.sections.findIndex((x) => x.heading === heading) : -1; i >= 0; i--) {
      const lead = leadOf.get(brief.sections[i].heading);
      if (lead) return lead;
    }
    return null;
  };
  const rowOf = (lead: string | null) => (lead && order.find((id) => byId.get(id)?.role === "section" && byId.get(id)?.section === lead)) || overview.id;
  // A section slide goes after the one before it in the plan, past that slide's own points.
  for (const row of newSections) {
    const prev = homeOf(brief.sections[brief.sections.findIndex((x) => x.heading === row.section) - 1]?.heading);
    let at = order.indexOf(rowOf(prev)) + 1;
    while (isPoint(order[at]) && homeOf(byId.get(order[at])!.section) === prev) at++;
    order.splice(at, 0, row.id);
  }
  // A point goes on the slide of its section, after the points that slide has.
  for (const row of newPoints) order.splice(endOf(rowOf(homeOf(row.section))), 0, row.id);
  order.push(verdict.id);
  // The spec's slides stay one block, where its overview is among the other specs.
  const others = before.filter((r) => r.noteId !== noteId).map((r) => r.id);
  const lead = before.findIndex((r) => r.id === overview.id);
  const ahead = before.slice(0, Math.max(0, lead)).filter((r) => r.noteId !== noteId).length;
  db.orderReviewSlides(review.id, [...others.slice(0, ahead), ...order, ...others.slice(ahead)]);
}

/** What each slide of a live review says, written to its deck again. */
function syncDeck(db: DB, briefs: PlanBriefs | null, review: ReviewRow): Item[] {
  const deck = review.deckId ? db.getDeck(review.deckId) : null;
  if (!deck) return [];
  const rows = db.reviewSlides(review.id);
  const specs = new Map<string, ReturnType<typeof specContext>>();
  const slides = rows.flatMap((row) => {
    if (!row.noteId) return [];
    if (!specs.has(row.noteId)) specs.set(row.noteId, specContext(db, briefs, mine(rows, row.noteId), row.noteId));
    const made = specs.get(row.noteId)?.(row);
    return made ? [{ id: row.itemId ?? newId(), row, ...made }] : [];
  });
  const saved = db.saveDeck(deck, { title: deck.title, theme: deck.theme, slides: slides.map(({ row: _r, ...slide }) => slide) });
  slides.forEach((s, i) => {
    if (s.row.itemId !== saved.slides[i]?.id) db.updateReviewSlide(s.row.id, { itemId: saved.slides[i]?.id ?? null });
  });
  return saved.slides;
}

/** Reads a spec once, and returns what turns one of its rows into a slide. */
function specContext(db: DB, briefs: PlanBriefs | null, rows: ReviewSlideRow[], noteId: string) {
  const note = db.getNote(noteId);
  const plan = db.planVersions(noteId).at(-1);
  if (!note || !plan) return null;
  const written = db.notePlan(noteId);
  const brief = briefFor(db, briefs, noteId, plan);
  const sections = planSections(plan.text);
  const points = pointsOf(db, noteId);
  const threads = new Map((reviewFor(db, noteId)?.threads ?? []).map((t) => [t.id, t]));
  const numbered = rows.filter((r) => r.role === "point").map((r) => r.id);
  const groups = slideGroups(brief, plan.text);
  const titleOf = (group: string[]) => group.join(" · ");
  const base = { taskId: note.id, spec: note.text, owner: note.owner ?? null, planBy: written?.by ?? plan.by, planById: written?.actor?.personId ?? null };
  return (row: ReviewSlideRow): ({ title: string } & SlideContent) | null => {
    const info = (i: Omit<DesignSlideInfo, keyof typeof base | "outcome" | "outcomeBy">): DesignSlideInfo => ({
      ...base, ...i, outcome: (row.outcome as DesignOutcome | null) ?? null, outcomeBy: row.outcomeBy,
    });
    const slide = (title: string, body: string, notes: string, design: DesignSlideInfo) => ({ title: clip(title, TITLE_MAX), layout: "design" as const, body, image: null, notes, design });
    switch (row.role) {
      case "overview":
        return slide(note.text, brief.summary, `The spec begins:\n${clip(plan.text, 1200)}`, info({
          role: "overview",
          name: "Overview",
          stand: !!brief.summary && !brief.summaryEdited,
          sections: rows.filter((r) => r.role === "section").map((r) => titleOf(groups.find((g) => g[0] === r.section) ?? [r.section!])),
          suggestions: brief.suggestions.filter((s) => s.state === "open"),
        }));
      case "section": {
        const group = (groups.find((g) => g[0] === row.section) ?? []).flatMap((h) => sections.find((x) => x.heading === h) ?? []);
        if (!group.length) return null;
        const shown = linesShown(group.length);
        const parts = group.map((section) => {
          const written = brief.sections.find((x) => x.heading === section.heading);
          return { heading: section.heading, lines: (written?.lines ?? []).slice(0, shown), stand: !!written?.lines.length && !written.edited };
        });
        const one = group.length === 1;
        const under = group.map((x) => `${one ? "" : `${x.heading}\n`}${clip(plan.text.slice(x.headingEnd, x.end).trim(), Math.floor(PASSAGE_MAX / group.length))}`).join("\n\n");
        return slide(titleOf(group.map((x) => x.heading)), parts.flatMap((p) => p.lines).join("\n"), `${one ? "This section" : "These sections"} of the spec:\n${under}`, info({
          role: "section",
          name: one ? clip(group[0].heading, NAME_MAX) : `${clip(group[0].heading, NAME_MAX - 3)} +${group.length - 1}`,
          section: group[0].heading,
          parts,
          stand: parts.some((p) => p.stand),
          passage: { start: group[0].start, end: group[0].headingEnd },
        }));
      }
      case "point": {
        const thread = threads.get(row.threadId ?? "");
        if (!thread) return null;
        const quote = clip(thread.placement ? plan.text.slice(thread.placement.start, thread.placement.end) : thread.original.quote, PASSAGE_MAX);
        const question = thread.messages[0]?.text ?? "";
        return slide(question.split("\n")[0], clip(question, QUOTE_MAX), `It is about this passage of the spec:\n${quote}`, info({
          role: "point",
          name: `Question ${numbered.indexOf(row.id) + 1}`,
          section: row.section,
          threadId: thread.id,
          quote,
          by: thread.messages[0]?.by ?? "",
          passage: thread.placement,
        }));
      }
      case "verdict":
        return slide(`Verdict: ${note.text}`, "", "", info({
          role: "verdict",
          name: "Verdict",
          // One that got a row before its passage went is already among the questions.
          lost: points.filter((p) => !p.placed && !p.off && !rows.some((r) => r.threadId === p.threadId)).map((p) => ({ quote: p.quote, text: p.text, by: p.by })),
        }));
      default:
        return null;
    }
  };
}

/** Starts the space's next design review: each spec waiting on it becomes slides at the top of the
 *  agenda. With `only`, it is a review of that one spec (asked for now if nobody had), and the rest
 *  keep waiting; if a review is already running, the spec joins it. Returns the slide to open on. */
export function startDesignReview(
  db: DB, briefs: PlanBriefs | null, roomId: string, opts: { only?: Task; by?: By } = {}, now = Date.now(),
): { review: ReviewRow; firstItemId: string; started: boolean } {
  const { only, by } = opts;
  if (only && !overviewIn(db, db.reviewIn(roomId, ["live"], "design"), only.id)) {
    if (!by) throw new DesignReviewError("Say who is asking for the review.");
    requestReview(db, briefs, only, by);
  }
  const live = db.reviewIn(roomId, ["live"], "design");
  const running = live?.deckId ? db.liveSlides(live.deckId) : [];
  if (live && running.length) {
    if (!only) return { review: live, firstItemId: running[0].id, started: false };
    let overview = overviewIn(db, live, only.id);
    if (!overview) {
      // Asked for while a review is running: the spec joins it, after the others.
      const waiting = overviewIn(db, db.reviewIn(roomId, ["draft"], "design"), only.id)!;
      db.orderReviewSlides(live.id, [...db.reviewSlides(live.id).map((r) => r.id), waiting.id]);
      layOut(db, briefs, live, only.id);
      syncDeck(db, briefs, live);
      overview = overviewIn(db, live, only.id)!;
    }
    return { review: live, firstItemId: overview.itemId!, started: false };
  }
  // Its slides were taken off the agenda: close it and start over.
  if (live) db.setReview(live.id, { status: "done", endedAt: now });
  const draft = db.reviewIn(roomId, ["draft"], "design");
  let review = draft;
  if (only) {
    review = db.createReview(roomId, "design");
    db.orderReviewSlides(review.id, [overviewIn(db, draft, only.id)!.id]);
  }
  const specs = review ? db.reviewSlides(review.id).filter((r) => r.role === "overview" && r.noteId) : [];
  if (!review || !specs.length) throw new DesignReviewError("No spec is waiting for a review. Open a to-do's plan and click Request review.");
  for (const spec of specs) layOut(db, briefs, review, spec.noteId!);
  const count = db.reviewSlides(review.id).length;
  if (!count) throw new DesignReviewError("The specs waiting for a review have no plan any more.");
  const deck = db.createDeck(roomId, `Design review · ${day(now)}`, count, "native");
  db.setDeckReview(deck.id, review.id);
  db.setReview(review.id, { status: "live", deckId: deck.id, startedAt: now });
  review = db.getReview(review.id)!;
  const ids = syncDeck(db, briefs, review).map((it) => it.id);
  // The review leads the agenda while it runs.
  db.reorderItems(roomId, [...ids, ...db.listItems(roomId).filter((it) => it.deckId !== deck.id).map((it) => it.id)]);
  return { review, firstItemId: ids[0], started: true };
}

/** The live design review a spec is in, if it is in one. */
function liveWith(db: DB, roomId: string, noteId: string): ReviewRow | null {
  const live = db.reviewIn(roomId, ["live"], "design");
  return live && overviewIn(db, live, noteId) ? live : null;
}

/** Something about a spec changed while its review runs (a new comment, the author's edit, a brief
 *  Stand finished writing): its slides are laid out again. True when the spec is in a running review. */
export function specChanged(db: DB, briefs: PlanBriefs | null, note: Task): boolean {
  const live = liveWith(db, note.roomId, note.id);
  if (!live) return false;
  layOut(db, briefs, live, note.id);
  syncDeck(db, briefs, live);
  return true;
}

/** Lays the spec's slides out again once Stand has written its brief, then says so. */
export function whenBriefed(db: DB, briefs: PlanBriefs | null, note: Task, done: () => void) {
  if (!briefs || briefs.current(note.id)?.status !== "writing") return;
  void briefs.ensure(note).then(() => { if (specChanged(db, briefs, note)) done(); }).catch(() => {});
}

/** How a point ended, or the verdict on a spec, by anyone's click; null takes it back. Returns the
 *  slide's item, or null when it isn't a slide of a running design review that takes that outcome. */
export function setDesignOutcome(db: DB, briefs: PlanBriefs | null, itemId: string, outcome: DesignOutcome | null, by: string, meetingId?: string, now = Date.now()): Item | null {
  const slide = db.reviewSlideByItem(itemId);
  const review = slide && db.getReview(slide.reviewId);
  if (!slide || review?.kind !== "design" || review.status !== "live") return null;
  const allowed: Array<{ id: DesignOutcome }> = slide.role === "point" ? POINT_OUTCOMES : slide.role === "verdict" ? VERDICTS : [];
  if (outcome ? !allowed.some((o) => o.id === outcome) : !allowed.length) return null;
  db.updateReviewSlide(slide.id, { outcome, outcomeBy: outcome ? by : null, outcomeAt: outcome ? now : null });
  // A point's call goes on its thread at once; the meeting's end writes it again with everything caught.
  if (slide.role === "point") writePoint(db, db.getReviewSlide(slide.id)!, meetingId ? db.meetingNotes(meetingId) : [], review.startedAt ?? now);
  syncDeck(db, briefs, review);
  return db.getItem(itemId);
}

/** Whether this person may move the call from one slide to another: both are slides of one spec in
 *  the running design review, and the spec is theirs. */
export function authorMay(db: DB, roomId: string, fromItemId: string | null, toItemId: string, user: { id: string; name: string }): boolean {
  const from = fromItemId ? db.reviewSlideByItem(fromItemId) : null;
  const to = db.reviewSlideByItem(toItemId);
  const review = from && db.getReview(from.reviewId);
  if (!from || !to || !from.noteId || review?.kind !== "design" || review.status !== "live" || review.roomId !== roomId) return false;
  if (to.reviewId !== from.reviewId || to.noteId !== from.noteId) return false;
  const note = db.getNote(from.noteId);
  return !!note && isAuthor(db, note, user);
}

/** The meeting a design review ran in has ended: the review is done and its slides leave the agenda,
 *  with what was said on them kept. One where no point and no verdict was called goes back to waiting. */
export function finishDesignReview(db: DB, roomId: string, meetingId: string, now = Date.now()): ReviewRow | null {
  const live = db.reviewIn(roomId, ["live"], "design");
  if (!live) return null;
  if (live.deckId) db.archiveDeck(live.deckId);
  const rows = db.reviewSlides(live.id);
  if (!rows.some((r) => r.outcome)) {
    // Nothing was called, so it wasn't a review (started by mistake, or the call ended early): its
    // specs wait on the next one again, as if it never started.
    for (const r of rows) {
      if (r.role === "overview") db.updateReviewSlide(r.id, { itemId: null });
      else db.removeReviewSlide(r.id);
    }
    const specs = rows.filter((r) => r.role === "overview");
    const draft = db.reviewIn(roomId, ["draft"], "design");
    if (!draft) {
      db.setReview(live.id, { status: "draft", deckId: null, startedAt: null });
      return db.getReview(live.id);
    }
    // Others were asked for meanwhile: these go ahead of them, since they were asked for first.
    const waiting = db.reviewSlides(draft.id);
    const back = specs.filter((r) => !waiting.some((w) => w.role === "overview" && w.noteId === r.noteId));
    for (const r of specs) if (!back.includes(r)) db.removeReviewSlide(r.id);
    db.orderReviewSlides(draft.id, [...back.map((r) => r.id), ...waiting.map((w) => w.id)]);
    db.deleteReview(live.id);
    return db.getReview(draft.id);
  }
  db.setReview(live.id, { status: "done", meetingId, endedAt: now });
  return db.getReview(live.id);
}

// ---- what a review leaves behind --------------------------------------------------------------
//
// A point's call goes back onto its thread: Settled resolves it with the decisions caught on its
// slide, Still open leaves it open with the to-dos and questions. When the meeting ends, each spec's
// to-do gets one line with the verdict, and waits on the to-dos that came out of its review. The
// open threads and those to-dos are the change list the author and their agent read.

const STAND: By = { userId: "stand", userName: "Stand", client: null, actor: { kind: "stand", person: null } };
const CAUGHT = ["action", "decision", "question"];
const caughtOf = (n: Note): DesignCaught => ({ id: n.id, kind: n.kind as DesignCaught["kind"], text: n.text, owner: n.owner ?? null, done: !!n.doneAt });

/** What Stand says on a point's thread: how it ended, and what the team said on its slide. */
function pointReply(slide: ReviewSlideRow, caught: Note[], at: number): string {
  const list = (title: string, kind: Note["kind"]) => {
    const lines = caught.filter((n) => n.kind === kind).map((n) => `- ${n.text.replace(/\s+/g, " ")}${kind === "action" && n.owner ? ` (${n.owner})` : ""}`);
    return lines.length ? [`${title}:`, ...lines] : [];
  };
  const who = slide.outcomeBy ? `, by ${slide.outcomeBy}` : "";
  if (slide.outcome === "settled") {
    const decided = list("Decided", "decision");
    return [`Settled in the design review on ${day(at)}${who}.`, ...(decided.length ? decided : ["Stand caught no decision on this question."]), ...list("To do", "action")].join("\n");
  }
  return [`Still open after the design review on ${day(at)}${who}.`, ...list("To do", "action"), ...list("Open questions", "question")].join("\n");
}

/** Puts a point's call on its thread, or takes it back off. Stand's line there is rewritten in place. */
function writePoint(db: DB, slide: ReviewSlideRow, notes: Note[], at: number) {
  const thread = slide.noteId && db.planThreads(slide.noteId).find((t) => t.id === slide.threadId);
  if (!slide.noteId || !thread) return;
  const was = thread.messages.find((m) => m.slide === slide.id);
  if (slide.outcome !== "settled" && slide.outcome !== "open") {
    // Taken back: the thread is as it was before the call, open.
    if (was) db.savePlanThread(slide.noteId, { ...thread, messages: thread.messages.filter((m) => m !== was), resolved: false });
    return;
  }
  const text = pointReply(slide, notes.filter((n) => n.itemId === slide.itemId && CAUGHT.includes(n.kind)), at);
  const message = { id: was?.id ?? newId(12), by: "Stand", text, ts: was?.ts ?? Date.now(), slide: slide.id };
  const messages = was ? thread.messages.map((m) => (m === was ? message : m)) : [...thread.messages, message];
  db.savePlanThread(slide.noteId, { ...thread, messages, resolved: slide.outcome === "settled" });
}

/** After the meeting's notes are final: each called point's thread gets what was caught on it, each
 *  spec's to-do gets the verdict in a line, and waits on the to-dos its review raised. */
export function writeBackReview(db: DB, meetingId: string): { specs: number; links: number } {
  const review = db.reviewByMeeting(meetingId, "design");
  if (!review) return { specs: 0, links: 0 };
  const rows = db.reviewSlides(review.id);
  const notes = db.meetingNotes(meetingId);
  const at = review.startedAt ?? Date.now();
  for (const row of rows) if (row.role === "point" && row.outcome) writePoint(db, row, notes, at);
  let links = 0;
  const specs = rows.filter((r) => r.role === "overview" && r.noteId);
  for (const spec of specs) {
    const note = db.getNote(spec.noteId!);
    if (!note) continue;
    const slides = mine(rows, note.id);
    const points = slides.filter((r) => r.role === "point");
    const settled = points.filter((r) => r.outcome === "settled").length;
    const verdict = slides.find((r) => r.role === "verdict")?.outcome as Verdict | null | undefined;
    // The to-dos the team left under this spec's slides: its to-do waits on each.
    const on = new Set(slides.map((r) => r.itemId));
    const todos = notes.filter((n) => n.kind === "action" && n.itemId && on.has(n.itemId) && n.id !== note.id && n.state !== "dropped");
    const have = db.roomLinks(note.roomId, "depends_on");
    for (const todo of todos) {
      if (have.some((l) => (l.fromId === note.id && l.toId === todo.id) || (l.fromId === todo.id && l.toId === note.id))) continue;
      db.addLink(note.roomId, note.id, todo.id, "depends_on", "Stand", STAND.actor ?? null);
      links++;
    }
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
    const text = [
      `Design review, ${day(at)}: ${verdict ? designOutcomeLabel(verdict) : "no verdict"}.`,
      points.length ? `${count(settled, "question")} settled, ${points.length - settled} open.` : "",
      todos.length ? `${count(todos.length, "to-do")} came out of it; this to-do waits on ${todos.length === 1 ? "it" : "them"}.` : "",
    ].filter(Boolean).join(" ");
    db.addUpdate({ roomId: note.roomId, itemId: note.itemId, noteId: note.id, noteText: note.text, ...STAND, status: "comment", text, links: [] });
  }
  return { specs: specs.length, links };
}

function ranOf(db: DB, review: ReviewRow): DesignReviewRan {
  const rows = db.reviewSlides(review.id);
  const verdicts = { approve: 0, changes: 0, not_yet: 0 };
  for (const r of rows) if (r.role === "verdict" && r.outcome && r.outcome in verdicts) verdicts[r.outcome as Verdict]++;
  return { id: review.id, startedAt: review.startedAt, meetingId: review.meetingId, titles: rows.filter((r) => r.role === "overview").map((r) => r.title), verdicts };
}

/** The space's design reviews that ran, newest first. */
export const designReviewsRan = (db: DB, roomId: string): DesignReviewRan[] => db.reviewsDone(roomId, 30, "design").map((r) => ranOf(db, r));

/** The design review that ran in a meeting, if one did. */
export function designReviewOfMeeting(db: DB, meetingId: string): DesignReviewRan | null {
  const review = db.reviewByMeeting(meetingId, "design");
  return review ? ranOf(db, review) : null;
}

/** A design review that ran, as its page shows it: each slide as it stood when the meeting ended,
 *  with what the team raised on it. Null when it isn't a finished one of this space. */
export function designReviewRecord(db: DB, roomId: string, id: string): DesignReviewRecord | null {
  const review = db.getReview(id);
  if (!review || review.roomId !== roomId || review.kind !== "design" || review.status !== "done") return null;
  const rows = db.reviewSlides(review.id);
  const notes = review.meetingId ? db.meetingNotes(review.meetingId).filter((n) => CAUGHT.includes(n.kind)) : [];
  const onSlide = new Set(rows.map((r) => r.itemId));
  const specs = rows.filter((r) => r.role === "overview" && r.noteId).map((spec) => {
    const slides = mine(rows, spec.noteId!).flatMap((row) => {
      const item = row.itemId ? db.getItem(row.itemId) : null;
      const design = item?.slide?.design;
      if (!item || !design) return [];
      return [{
        id: row.id, role: design.role, name: design.name, title: item.title, body: item.slide!.body, quote: design.quote, by: design.by,
        outcome: design.outcome, outcomeBy: design.outcomeBy, lost: design.lost ?? [],
        caught: notes.filter((n) => n.itemId === item.id).map(caughtOf),
      }];
    });
    const verdict = slides.find((s) => s.role === "verdict");
    return {
      taskId: spec.noteId!,
      title: db.getNote(spec.noteId!)?.text ?? spec.title,
      owner: spec.owner,
      verdict: (verdict?.outcome as Verdict | null) ?? null,
      verdictBy: verdict?.outcomeBy ?? null,
      slides: slides.map(({ lost: _l, ...slide }) => slide),
      lost: verdict?.lost ?? [],
    };
  });
  return { id: review.id, startedAt: review.startedAt, endedAt: review.endedAt, meetingId: review.meetingId, specs, general: notes.filter((n) => !onSlide.has(n.itemId)).map(caughtOf) };
}
