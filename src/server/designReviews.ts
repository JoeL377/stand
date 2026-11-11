// Design reviews: a call where the team goes through a spec and leaves with a verdict on it.
//
// A spec joins the space's next design review only when someone asks (the Request review button
// on a plan, or the MCP's request_design_review). The review shares the product review's tables:
// it is a review of kind "design", and each spec waiting on it is one slide, its overview.
//
// A point is an open comment thread on the spec (planReview.ts); there is no new primitive. The
// author's questions come with the request as threads, reviewers comment on passages as they do
// anywhere, and Stand's suggestions become threads only when the author accepts them. What each
// slide says is the spec's brief (planBrief.ts).

import type { Actor } from "../shared/actors.ts";
import {
  DESIGN_QUESTIONS_MAX, pointsOnDeck,
  type BriefChange, type DesignPoint, type DesignReviewState, type DesignReviewSummary, type DesignReviewView, type DesignSpec, type PlanBrief,
} from "../shared/designReview.ts";
import type { Passage, PlanThread } from "../shared/planReview.ts";
import { TASK_COMMENT_MAX, type Note } from "../shared/protocol.ts";
import type { DB, ReviewSlideRow } from "./db.ts";
import type { PlanBriefs } from "./planBrief.ts";
import { changeReview, logThreadChange, passageAround, planBlocks, planSections, quotePassage, reviewFor } from "./planReview.ts";
import { ownedBy } from "./spaces.ts";

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

/** Whether this person prepares the spec for its review: they own the to-do, or wrote its latest plan. */
export function isAuthor(db: DB, note: Note, user: { id: string; name: string }): boolean {
  if (ownedBy(note.owner, user.name)) return true;
  const plan = db.notePlan(note.id);
  return !!plan && (plan.actor?.personId === user.id || plan.by === user.name || plan.by.startsWith(`${user.name} via `));
}

/** The spec's place on the space's next design review, if it has one. */
function queued(db: DB, roomId: string, noteId: string): ReviewSlideRow | null {
  const draft = db.reviewIn(roomId, ["draft"], "design");
  return (draft && db.reviewSlides(draft.id).find((s) => s.role === "overview" && s.noteId === noteId)) ?? null;
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
    points: pointsOf(db, note.id),
  };
}

/** The space's next design review as its page shows it to this person; null when no spec waits on it. */
export function designReviewView(db: DB, briefs: PlanBriefs | null, roomId: string, user: { id: string; name: string } | null): DesignReviewView | null {
  const draft = db.reviewIn(roomId, ["draft"], "design");
  if (!draft) return null;
  const specs = db.reviewSlides(draft.id).filter((s) => s.role === "overview").flatMap((s) => specOf(db, briefs, s, user) ?? []);
  return specs.length ? { id: draft.id, status: draft.status, specs } : null;
}

/** The next design review in a line, for the Tasks tab. */
export function designReviewSummary(db: DB, roomId: string): DesignReviewSummary | null {
  const view = designReviewView(db, null, roomId, null);
  if (!view) return null;
  return { specs: view.specs.length, points: view.specs.reduce((n, s) => n + pointsOnDeck(s.points).length, 0), titles: view.specs.map((s) => s.title) };
}

/** Whether a to-do's spec waits on the next design review, and with how many points. */
export function designReviewState(db: DB, note: Task): DesignReviewState {
  return { queued: !!queued(db, note.roomId, note.id), points: pointsOnDeck(pointsOf(db, note.id)).length };
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
    db.addUpdate({
      roomId: note.roomId, itemId: note.itemId, noteId: note.id, noteText: note.text, ...by,
      status: "comment", text: "Review requested: the plan is on the next design review.", links: [],
    });
  }
  void briefs?.ensure(note).catch(() => {});
  return { added: !had, questions: made };
}

/** Takes a spec off the next design review. Its threads stay on the plan. */
export function removeSpec(db: DB, note: Task, by: By): boolean {
  const slide = queued(db, note.roomId, note.id);
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
  db.updateReviewSlide(slide.id, { planVersion: plan.id });
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
    if (typeof change.section !== "string" || !briefs.setSection(note, change.section, { lines, off }, by.userName)) throw gone();
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
