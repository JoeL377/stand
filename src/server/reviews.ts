// Product reviews: a call where the team looks at what shipped, one feature per slide.
//
// A space has one review being put together at a time (the draft). Agents add a slide when they
// finish something (the MCP's add_review_slide), and anything closed or ready to ship since the last
// review that nobody made a slide for is added when the review starts, so the deck is complete and
// ready before anyone talks.
//
// Starting a review turns its slides into a deck made in Stand. Each slide is an agenda item, so the
// meeting engine needs nothing new: what's said while a slide is on screen is filed under it, and the
// notes agent writes that slide's to-dos, decisions and open questions as it does for any item. A
// slide ends with an outcome anyone can click: Ship, Ship with fixes, or Not yet.

import type { ItemUpdate, Note, ReviewOutcome, ReviewShot, ReviewSlideInfo, ReviewView, SlideContent } from "../shared/protocol.ts";
import type { DB, ReviewRow, ReviewSlideRow } from "./db.ts";
import { newId } from "./ids.ts";
import { prOf, shotUrl } from "./workLog.ts";

/** With no review or meeting to count from, a first review looks this far back. */
const FIRST_LOOKBACK_MS = 14 * 24 * 3_600_000;
export const REVIEW_TITLE_MAX = 140;
export const REVIEW_BODY_MAX = 600;
const MAX_SLIDES = 40;

export class ReviewError extends Error {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Where pictures uploaded straight to a slide are kept: work shots, filed under the slide instead of a to-do. */
export const slideShotKey = (slideId: string) => `review:${slideId}`;

/** A slide's pictures: the ones put on the slide itself, then the ones on its to-do's work log. */
function shotsOf(db: DB, slide: Pick<ReviewSlideRow, "id" | "noteId">, baseUrl = ""): ReviewShot[] {
  const keys = [slideShotKey(slide.id), ...(slide.noteId ? [slide.noteId] : [])];
  return db.noteWorkShots(keys).map((s) => ({ url: shotUrl(s, baseUrl), caption: s.caption }));
}

const infoOf = (db: DB, s: ReviewSlideRow, baseUrl = ""): ReviewSlideInfo => ({
  slideId: s.id,
  taskId: s.noteId,
  owner: s.owner,
  addedBy: s.addedBy,
  pr: s.pr,
  shots: shotsOf(db, s, baseUrl),
  outcome: s.outcome,
  outcomeBy: s.outcomeBy,
});

/** What the next review counts from: when the last one started, else the last real meeting, else two weeks. */
function since(db: DB, roomId: string, now: number) {
  const last = db.reviewIn(roomId, ["done", "live"]);
  return last?.startedAt ?? db.lastRealMeeting(roomId)?.endedAt ?? now - FIRST_LOOKBACK_MS;
}

/** The last thing said about a to-do that tells people what was done. */
function summaryOf(updates: ItemUpdate[]): string {
  const told = updates.filter((u) => u.text.trim() && u.status !== "plan" && u.status !== "linked" && u.status !== "comment");
  const best = [...told].reverse().find((u) => u.status === "done" || u.status === "ready") ?? told.at(-1);
  return best ? clip(best.text.trim(), REVIEW_BODY_MAX) : "";
}
const prIn = (note: Note, updates: ItemUpdate[]) =>
  (note.closedBy?.startsWith("pr:") ? note.closedBy.slice(3) : null) ?? [...updates].reverse().flatMap((u) => u.links).find((l) => prOf(l)) ?? null;

type Pending = Pick<ReviewSlideRow, "title" | "body" | "noteId" | "owner" | "addedBy" | "pr">;

/** Work that has no slide yet: to-dos finished since the last review, and ones ready to ship. */
export function pendingSlides(db: DB, roomId: string, have: ReviewSlideRow[], now = Date.now()): Pending[] {
  const from = since(db, roomId, now);
  // On a slide of the next review already, or shown in one before.
  const onSlide = new Set([...have.map((s) => s.noteId).filter(Boolean), ...db.reviewedNoteIds(roomId)]);
  const closed = db.closedTasksSince(roomId, from).filter((n) => n.kind === "action" && n.state !== "dropped" && !n.dropReason);
  const ready = db.notesByIds([...new Set(db.readyToShip().map((u) => u.noteId).filter((id): id is string => !!id))]).filter((n) => {
    const m = db.getMeeting(n.meetingId);
    return m?.roomId === roomId && !n.doneAt && n.state !== "dropped";
  });
  const notes = [...closed, ...ready].filter((n, i, all) => !onSlide.has(n.id) && all.findIndex((x) => x.id === n.id) === i);
  const updates = db.notesUpdates(notes.map((n) => n.id));
  return notes.slice(0, MAX_SLIDES).map((n) => {
    const mine = updates.filter((u) => u.noteId === n.id);
    return { title: clip(n.text, REVIEW_TITLE_MAX), body: summaryOf(mine), noteId: n.id, owner: n.owner, addedBy: "Stand", pr: prIn(n, mine) };
  });
}

const toView = (db: DB, review: ReviewRow, slides: ReviewSlideRow[], pending: Pending[], baseUrl = ""): ReviewView => ({
  id: review.id,
  status: review.status,
  deckId: review.deckId,
  meetingId: review.meetingId,
  createdAt: review.createdAt,
  startedAt: review.startedAt,
  slides: [
    ...slides.map((s) => {
      const { slideId: _s, ...info } = infoOf(db, s, baseUrl);
      return { id: s.id, title: s.title, body: s.body, ...info };
    }),
    ...pending.map((p) => ({
      id: `task:${p.noteId}`,
      title: p.title,
      body: p.body,
      taskId: p.noteId,
      owner: p.owner,
      addedBy: p.addedBy,
      pr: p.pr,
      shots: p.noteId ? shotsOf(db, { id: "-", noteId: p.noteId }, baseUrl) : [],
      outcome: null,
      outcomeBy: null,
    })),
  ],
});

/** The review people see on the space page: the one in a call, else the next one with what a start would add.
 *  Null when there is nothing to review yet. */
export function reviewView(db: DB, roomId: string, baseUrl = "", now = Date.now()): ReviewView | null {
  const live = db.reviewIn(roomId, ["live"]);
  if (live) return toView(db, live, db.reviewSlides(live.id), [], baseUrl);
  const draft = db.reviewIn(roomId, ["draft"]);
  const slides = draft ? db.reviewSlides(draft.id) : [];
  const pending = pendingSlides(db, roomId, slides, now);
  if (!slides.length && !pending.length) return null;
  return toView(db, draft ?? { id: "", roomId, status: "draft", deckId: null, meetingId: null, createdAt: now, startedAt: null, endedAt: null }, slides, pending, baseUrl);
}

/** The last review that finished, with how each slide ended. */
export function lastReview(db: DB, roomId: string, baseUrl = ""): ReviewView | null {
  const done = db.reviewIn(roomId, ["done"]);
  return done ? toView(db, done, db.reviewSlides(done.id), [], baseUrl) : null;
}

export interface NewSlide {
  title: string;
  summary: string;
  /** The to-do it shows: its pictures and PR come along. */
  note?: Note | null;
  owner?: string | null;
  addedBy: string;
  pr?: string | null;
}

/** Adds a slide to the space's next review, or rewrites the one already there for the same to-do. */
export function addSlide(db: DB, roomId: string, s: NewSlide): { slide: ReviewSlideRow; review: ReviewRow; updated: boolean } {
  const title = clip(s.title.replace(/\s+/g, " ").trim(), REVIEW_TITLE_MAX);
  if (!title) throw new ReviewError("A slide needs a title: the feature, in a line.");
  const body = clip(s.summary.trim(), REVIEW_BODY_MAX);
  const review = db.reviewIn(roomId, ["draft"]) ?? db.createReview(roomId);
  const slides = db.reviewSlides(review.id);
  const same = s.note ? slides.find((x) => x.noteId === s.note!.id) : slides.find((x) => !x.noteId && x.title.toLowerCase() === title.toLowerCase());
  const owner = s.owner ?? s.note?.owner ?? null;
  const pr = s.pr ?? (s.note ? prIn(s.note, db.notesUpdates([s.note.id])) : null);
  if (same) {
    db.updateReviewSlide(same.id, { title, body, owner, addedBy: s.addedBy, pr });
    return { slide: db.getReviewSlide(same.id)!, review, updated: true };
  }
  if (slides.length >= MAX_SLIDES) throw new ReviewError(`The next review already has ${MAX_SLIDES} slides. Start it, or take one off.`);
  return { slide: db.addReviewSlide(review.id, { title, body, noteId: s.note?.id ?? null, owner, addedBy: s.addedBy, pr }), review, updated: false };
}

/** Takes a slide off the next review. Only a review that hasn't started can change. */
export function removeSlide(db: DB, roomId: string, slideId: string): boolean {
  const slide = db.getReviewSlide(slideId);
  const review = slide && db.getReview(slide.reviewId);
  if (!slide || !review || review.roomId !== roomId || review.status !== "draft") return false;
  db.removeReviewSlide(slideId);
  return true;
}

const contentOf = (db: DB, s: ReviewSlideRow): SlideContent => ({ layout: "review", body: s.body, image: null, notes: "", review: infoOf(db, s) });

/** Starts the space's next review: finished work with no slide joins it, the slides become a deck at
 *  the top of the agenda, and the first slide is where the call opens. A review already running is
 *  returned as it is. */
export function startReview(db: DB, roomId: string, now = Date.now()): { review: ReviewRow; deckId: string; firstItemId: string; started: boolean } {
  const live = db.reviewIn(roomId, ["live"]);
  if (live?.deckId) {
    const first = db.liveSlides(live.deckId)[0];
    if (first) return { review: live, deckId: live.deckId, firstItemId: first.id, started: false };
    // Its slides were taken off the agenda: close it and start over.
    db.setReview(live.id, { status: "done", endedAt: now });
  }
  const draft = db.reviewIn(roomId, ["draft"]) ?? db.createReview(roomId);
  for (const p of pendingSlides(db, roomId, db.reviewSlides(draft.id), now)) db.addReviewSlide(draft.id, p);
  const slides = db.reviewSlides(draft.id);
  if (!slides.length) throw new ReviewError("Nothing to review yet. Slides appear here as work is finished, or when an agent adds one.");
  const title = `Product review · ${day(now)}`;
  const deck = db.createDeck(roomId, title, slides.length, "native");
  db.setDeckReview(deck.id, draft.id);
  const ids = slides.map(() => newId());
  db.saveDeck(deck, { title, theme: "paper", slides: slides.map((s, i) => ({ id: ids[i], title: s.title, ...contentOf(db, s) })) });
  slides.forEach((s, i) => db.updateReviewSlide(s.id, { itemId: ids[i] }));
  // The review leads the agenda while it runs.
  const rest = db.listItems(roomId).filter((it) => it.deckId !== deck.id).map((it) => it.id);
  db.reorderItems(roomId, [...ids, ...rest]);
  db.setReview(draft.id, { status: "live", deckId: deck.id, startedAt: now });
  return { review: db.getReview(draft.id)!, deckId: deck.id, firstItemId: ids[0], started: true };
}

/** How a slide ended, by anyone's click; null takes it back. Returns the slide's item, or null if it isn't one in a running review. */
export function setOutcome(db: DB, itemId: string, outcome: ReviewOutcome | null, by: string, now = Date.now()) {
  const slide = db.reviewSlideByItem(itemId);
  const review = slide && db.getReview(slide.reviewId);
  if (!slide || review?.status !== "live") return null;
  db.updateReviewSlide(slide.id, { outcome, outcomeBy: outcome ? by : null, outcomeAt: outcome ? now : null });
  db.setSlideContent(itemId, contentOf(db, db.getReviewSlide(slide.id)!));
  return db.getItem(itemId);
}

/** The meeting a review ran in has ended: the review is done and its slides leave the agenda (their
 *  history stays, and what was caught on each slide stays filed under it). */
export function finishReview(db: DB, roomId: string, meetingId: string, now = Date.now()): ReviewRow | null {
  const live = db.reviewIn(roomId, ["live"]);
  if (!live) return null;
  db.setReview(live.id, { status: "done", meetingId, endedAt: now });
  if (live.deckId) db.archiveDeck(live.deckId);
  return db.getReview(live.id);
}

/** Whether an agenda item is a slide of the review running in this space. */
export const isReviewSlide = (item: { slide: SlideContent | null } | null | undefined) => item?.slide?.layout === "review";
