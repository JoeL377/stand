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

import type { DesignRole } from "../shared/designReview.ts";
import { IDEA_OUTCOMES, REVIEW_OUTCOMES } from "../shared/protocol.ts";
import type { IdeaOutcome, Item, ItemUpdate, Note, ReviewCaught, ReviewOutcome, ReviewShot, ReviewSlideInfo, ReviewSummary, ReviewView, SlideContent } from "../shared/protocol.ts";
import type { DB, ReviewRow, ReviewSlideRow } from "./db.ts";
import { newId } from "./ids.ts";
import { prOf, shotUrl } from "./workLog.ts";

/** With no review or meeting to count from, a first review looks this far back. */
const FIRST_LOOKBACK_MS = 14 * 24 * 3_600_000;
export const REVIEW_TITLE_MAX = 140;
export const REVIEW_BODY_MAX = 600;
export const REVIEW_NAME_MAX = 32;
const MAX_SLIDES = 40;

export class ReviewError extends Error {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** What a slide is called where a deck slide would say "Slide 3": the name it was given, else the
 *  first few words of its title. */
export function slideName(s: { name?: string | null; title: string }): string {
  const given = s.name?.replace(/\s+/g, " ").trim();
  if (given) return clip(given, REVIEW_NAME_MAX);
  const words = s.title.replace(/\s+/g, " ").trim().replace(/[:,.;]+$/, "").split(" ");
  let out = "";
  for (const w of words.slice(0, 4)) {
    if (out && `${out} ${w}`.length > REVIEW_NAME_MAX) break;
    out = out ? `${out} ${w}` : w;
  }
  // A name doesn't end on a joining word: "Pull fraud numbers", not "Pull fraud numbers for".
  const kept = out.split(" ");
  while (kept.length > 1 && /^(a|an|the|for|of|to|in|on|at|and|or|with|by|from|is|are|has|have|its|their)$/i.test(kept[kept.length - 1])) kept.pop();
  return clip(kept.join(" ").replace(/[:,.;]+$/, ""), REVIEW_NAME_MAX);
}

/** Where pictures uploaded straight to a slide are kept: work shots, filed under the slide instead of a to-do. */
export const slideShotKey = (slideId: string) => `review:${slideId}`;

/** A slide's pictures: the ones put on the slide itself, then the ones on its to-do's work log. */
function shotsOf(db: DB, slide: Pick<ReviewSlideRow, "id" | "noteId">, baseUrl = ""): ReviewShot[] {
  const keys = [slideShotKey(slide.id), ...(slide.noteId ? [slide.noteId] : [])];
  return db.noteWorkShots(keys).map((s) => ({ url: shotUrl(s, baseUrl), caption: s.caption }));
}

const infoOf = (db: DB, s: ReviewSlideRow, baseUrl = ""): ReviewSlideInfo => ({
  slideId: s.id,
  name: slideName(s),
  taskId: s.noteId,
  owner: s.owner,
  addedBy: s.addedBy,
  pr: s.pr,
  shots: shotsOf(db, s, baseUrl),
  // An idea review's slide (ideaReview.ts) ends in its own words, kept with the idea.
  outcome: s.idea ? null : (s.outcome as ReviewOutcome | null),
  outcomeBy: s.idea ? null : s.outcomeBy,
  ...(s.idea ? { idea: { ...s.idea, outcome: s.outcome as IdeaOutcome | null, outcomeBy: s.outcomeBy } } : {}),
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

export const toView = (db: DB, review: ReviewRow, slides: ReviewSlideRow[], pending: Pending[], baseUrl = ""): ReviewView => ({
  id: review.id,
  ...(review.kind === "ideas" ? { kind: "ideas" as const, title: review.title, brainstormId: review.sourceId } : {}),
  status: review.status,
  deckId: review.deckId,
  meetingId: review.meetingId,
  createdAt: review.createdAt,
  startedAt: review.startedAt,
  endedAt: review.endedAt,
  slides: [
    ...slides.map((s) => {
      const { slideId: _s, ...info } = infoOf(db, s, baseUrl);
      return { id: s.id, title: s.title, body: s.body, ...info };
    }),
    ...pending.map((p) => ({
      id: `task:${p.noteId}`,
      name: slideName(p),
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
  return toView(db, draft ?? { id: "", roomId, kind: "product", status: "draft", deckId: null, meetingId: null, createdAt: now, startedAt: null, endedAt: null, title: null, sourceId: null }, slides, pending, baseUrl);
}

/** The last review that finished, with how each slide ended. */
export function lastReview(db: DB, roomId: string, baseUrl = ""): ReviewView | null {
  const done = db.reviewIn(roomId, ["done"]);
  return done ? toView(db, done, db.reviewSlides(done.id), [], baseUrl) : null;
}

const CAUGHT = ["action", "decision", "question"];
const caughtOf = (n: Note): ReviewCaught => ({ id: n.id, kind: n.kind as ReviewCaught["kind"], text: n.text, owner: n.owner ?? null, done: !!n.doneAt });

/** One review as its own page shows it: "next" is the one being put together (or in a call), an id is
 *  one that ran, with what the team raised on each slide. Null when it isn't this space's. */
export function reviewPage(db: DB, roomId: string, idOrNext: string, baseUrl = "", now = Date.now()): ReviewView | null {
  if (idOrNext === "next") return reviewView(db, roomId, baseUrl, now);
  const review = db.getReview(idOrNext);
  if (!review || review.roomId !== roomId || review.kind === "design") return null;
  // An idea review has its own page from the moment it is set up.
  if (review.kind === "ideas" && review.status !== "done") return toView(db, review, db.reviewSlides(review.id), [], baseUrl);
  if (review.status !== "done") return reviewView(db, roomId, baseUrl, now);
  const rows = db.reviewSlides(review.id);
  const view = toView(db, review, rows, [], baseUrl);
  const notes = review.meetingId ? db.meetingNotes(review.meetingId).filter((n) => CAUGHT.includes(n.kind)) : [];
  view.slides.forEach((s, i) => {
    const itemId = rows[i].itemId;
    s.caught = itemId
      ? notes.filter((n) => n.itemId === itemId).map(caughtOf)
      : [];
  });
  const onSlide = new Set(rows.map((r) => r.itemId));
  view.general = notes.filter((n) => !onSlide.has(n.itemId)).map(caughtOf);
  return view;
}

export function summaryOfReview(db: DB, review: ReviewRow): ReviewSummary {
  const slides = db.reviewSlides(review.id);
  const outcomes = { ship: 0, fixes: 0, not_yet: 0 };
  for (const s of slides) if (s.outcome && s.outcome in outcomes) outcomes[s.outcome as ReviewOutcome]++;
  return { id: review.id, startedAt: review.startedAt, endedAt: review.endedAt, meetingId: review.meetingId, slides: slides.length, outcomes };
}

/** The space's reviews that ran, newest first. */
export const reviewsDone = (db: DB, roomId: string): ReviewSummary[] => db.reviewsDone(roomId).map((r) => summaryOfReview(db, r));

/** The review that ran in a meeting, if one did. */
export function reviewOfMeeting(db: DB, meetingId: string): ReviewSummary | null {
  const r = db.reviewByMeeting(meetingId);
  return r ? summaryOfReview(db, r) : null;
}

export interface NewSlide {
  title: string;
  /** What people will call it, in two or three words. */
  name?: string | null;
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
  const name = s.name?.replace(/\s+/g, " ").trim() ? clip(s.name.replace(/\s+/g, " ").trim(), REVIEW_NAME_MAX) : null;
  const review = db.reviewIn(roomId, ["draft"]) ?? db.createReview(roomId);
  const slides = db.reviewSlides(review.id);
  const same = s.note ? slides.find((x) => x.noteId === s.note!.id) : slides.find((x) => !x.noteId && x.title.toLowerCase() === title.toLowerCase());
  const owner = s.owner ?? s.note?.owner ?? null;
  const pr = s.pr ?? (s.note ? prIn(s.note, db.notesUpdates([s.note.id])) : null);
  if (same) {
    // A rewrite that gives no name keeps the one the slide had.
    db.updateReviewSlide(same.id, { title, body, owner, addedBy: s.addedBy, pr, ...(name ? { name } : {}) });
    return { slide: db.getReviewSlide(same.id)!, review, updated: true };
  }
  if (slides.length >= MAX_SLIDES) throw new ReviewError(`The next review already has ${MAX_SLIDES} slides. Start it, or take one off.`);
  return { slide: db.addReviewSlide(review.id, { title, name, body, noteId: s.note?.id ?? null, owner, addedBy: s.addedBy, pr }), review, updated: false };
}

/** Takes a slide off the next review. Only a review that hasn't started can change. */
export function removeSlide(db: DB, roomId: string, slideId: string): boolean {
  const slide = db.getReviewSlide(slideId);
  const review = slide && db.getReview(slide.reviewId);
  if (!slide || !review || review.roomId !== roomId || review.kind !== "product" || review.status !== "draft") return false;
  db.removeReviewSlide(slideId);
  return true;
}

export const contentOf = (db: DB, s: ReviewSlideRow): SlideContent => ({ layout: "review", body: s.body, image: null, notes: "", review: infoOf(db, s) });

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
export function setOutcome(db: DB, itemId: string, asked: string | null, by: string, now = Date.now()) {
  const slide = db.reviewSlideByItem(itemId);
  const review = slide && db.getReview(slide.reviewId);
  if (!slide || !review || review.kind === "design" || review.status !== "live") return null;
  // Each kind of review ends its slides in its own words; anything else takes the outcome back.
  const allowed: Array<{ id: string }> = review.kind === "ideas" ? IDEA_OUTCOMES : REVIEW_OUTCOMES;
  const outcome = (allowed.some((o) => o.id === asked) ? asked : null) as ReviewOutcome | IdeaOutcome | null;
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
/** A slide of a product review or of a design review: the topic card and the running list sit both out. */
export const isReviewDeck = (item: { slide: SlideContent | null } | null | undefined) => isReviewSlide(item) || item?.slide?.layout === "design";

// ---- after the call: each capture goes under the slide it was about -----------------------------
//
// During a review, what's said is filed under the slide on screen. People talk past a flip, open
// with something general, or come back to an earlier feature, so once the meeting's notes are tidy
// one pass reads every to-do, decision and open question against the slides and says where each
// belongs. It only moves notes; it writes none. A design review's slides (a spec's overview,
// sections, questions and verdict) go through the same pass, before what was caught on them goes
// back to the spec.

export interface Refile {
  note: string;
  /** A slide's key ("S3"), "none" when it isn't about one slide, or "echo" when it only repeats
   *  what the slide itself says and nobody raised it. */
  to: string;
}

const KIND_WORD: Record<string, string> = { action: "to-do", decision: "decision", question: "open question" };

const DESIGN_ROLE: Record<DesignRole, string> = { overview: "overview", section: "section", point: "question for the team", verdict: "verdict" };

/** One slide as the filing pass reads it. A design review's slide says it from its agenda item:
 *  which spec, what part of it, and the passage a question is about. */
function slideLine(key: string, s: ReviewSlideRow, item: Item | null): string {
  const flat = (t: string) => t.replace(/\s*\n\s*/g, " / ");
  const design = item?.slide?.design;
  if (!design) return `${key} "${slideName(s)}": ${s.title}${s.body ? `\n   On the slide: ${flat(s.body)}` : ""}`;
  const body = item!.slide!.body;
  return [
    `${key} "${design.name}" (${DESIGN_ROLE[design.role]} of the spec "${design.spec}"): ${item!.title}`,
    ...(body ? [`   On the slide: ${flat(body)}`] : []),
    ...(design.quote ? [`   About this passage of the spec: "${clip(flat(design.quote), 300)}"`] : []),
  ].join("\n");
}

/** What the filing pass reads: the slides, then every capture with where it sits now. Empty when
 *  there is nothing to file. `itemOf` finds a slide's agenda item, which is what a design review's
 *  slide says. */
export function refilePrompt(
  slides: ReviewSlideRow[], notes: Note[], itemOf: (id: string) => Item | null = () => null,
): { text: string; noteOf: Map<string, Note>; slideOf: Map<string, ReviewSlideRow> } {
  const live = slides.filter((s) => s.itemId);
  const slideOf = new Map(live.map((s, i) => [`S${i + 1}`, s]));
  const keyOfItem = new Map([...slideOf].map(([k, s]) => [s.itemId!, k]));
  const caught = notes.filter((n) => CAUGHT.includes(n.kind));
  const noteOf = new Map(caught.map((n, i) => [`N${i + 1}`, n]));
  if (!live.length || !caught.length) return { text: "", noteOf, slideOf };
  const text = [
    "Slides of the review, in the order they were shown:",
    ...[...slideOf].map(([k, s]) => slideLine(k, s, itemOf(s.itemId!))),
    "",
    "What was caught, with the slide that was on screen at the time:",
    ...[...noteOf].map(([k, n]) => {
      const at = n.itemId ? (keyOfItem.get(n.itemId) ?? "none") : "none";
      const said = n.quote?.text ? ` (${n.quote.speaker}: "${clip(n.quote.text, 200)}")` : " (no quote)";
      return `${k} [${at}] ${KIND_WORD[n.kind]}: ${n.text}${n.owner ? ` (owner ${n.owner})` : ""}${said}`;
    }),
  ].join("\n");
  return { text, noteOf, slideOf };
}

/** Applies the pass's answers. Returns how many notes moved and how many echoes came off. Answers
 *  that name a note or slide that isn't there are skipped. */
export function applyRefile(db: DB, moves: Refile[], noteOf: Map<string, Note>, slideOf: Map<string, ReviewSlideRow>): { moved: number; dropped: number } {
  let moved = 0;
  let dropped = 0;
  const seen = new Set<string>();
  const onSlide = new Set([...slideOf.values()].map((s) => s.itemId));
  for (const m of moves) {
    const note = noteOf.get(m.note);
    if (!note || seen.has(m.note)) continue;
    seen.add(m.note);
    if (m.to === "echo") {
      // Only a question nobody is quoted asking can be the slide talking to itself.
      if (note.kind === "question" && !note.quote?.text) {
        db.removeNote(note.id);
        dropped++;
      }
      continue;
    }
    // One under another agenda item of the meeting, not about a slide, stays under that item.
    if (m.to === "none" && note.itemId && !onSlide.has(note.itemId)) continue;
    const target = m.to === "none" ? null : slideOf.get(m.to)?.itemId;
    if (target === undefined || target === note.itemId) continue;
    db.moveNote(note.id, target);
    moved++;
  }
  return { moved, dropped };
}

/** Files the captures of the reviews a meeting ran (product, design or both) under the slides they
 *  were about. `ask` is the model call (Agent.refileReview); it returning null leaves everything
 *  where it was. */
export async function refileReview(db: DB, meetingId: string, ask: (prompt: string) => Promise<Refile[] | null>): Promise<{ moved: number; dropped: number }> {
  const reviews = [db.reviewByMeeting(meetingId), db.reviewByMeeting(meetingId, "design")]
    .filter((r): r is ReviewRow => !!r)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  if (!reviews.length) return { moved: 0, dropped: 0 };
  const slides = reviews.flatMap((r) => db.reviewSlides(r.id));
  const { text, noteOf, slideOf } = refilePrompt(slides, db.meetingNotes(meetingId), (id) => db.getItem(id));
  if (!text) return { moved: 0, dropped: 0 };
  const moves = await ask(text);
  return moves ? applyRefile(db, moves, noteOf, slideOf) : { moved: 0, dropped: 0 };
}
