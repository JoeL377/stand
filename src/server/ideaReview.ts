// Idea reviews: a call where the team goes back through what a brainstorm came up with, one idea
// per slide, and says what to do with each: Pursue, Explore or Not now.
//
// It is a review like a product review (reviews.ts), kept in the same tables and shown on the same
// stage, so the meeting engine needs nothing new: each slide is an agenda item, what's said while
// an idea is on screen is filed under it, and anyone sets how it ended. Two things differ. Its
// slides come from a brainstorm's map, every idea on it, the starred ones first; nothing joins on
// its own. And when it ends, an idea the team chose to pursue becomes a to-do and one to explore
// becomes an open question, unless the talk on that slide already caught one, so the brainstorm's
// page can show what became of each idea.

import { IDEA_OUTCOMES } from "../shared/protocol.ts";
import type { BrainNode, BrainstormView, IdeaOutcome, IdeaReviewSummary, ReviewView } from "../shared/protocol.ts";
import type { BrainstormRow } from "./brainstorm.ts";
import type { DB, IdeaSlideSaved, ReviewRow } from "./db.ts";
import { newId } from "./ids.ts";
import { REVIEW_NAME_MAX, REVIEW_TITLE_MAX, ReviewError, contentOf, toView } from "./reviews.ts";

/** A call gets through about this many ideas; the rest of a big map stays on the map. */
export const IDEA_SLIDES_MAX = 40;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const day = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weightOf = (n: BrainNode) => n.points.length + n.caught.length;

/** The ideas of a brainstorm in the order a review goes through them: starred first, then the ones
 *  the talk made most of, then as they were raised. The star orders; it leaves nothing out. */
export function ideasInOrder(b: Pick<BrainstormRow, "nodes" | "starred">): BrainNode[] {
  const starred = new Set(b.starred);
  return b.nodes
    .filter((n) => n.parent && !n.removed)
    .sort((x, y) => Number(starred.has(y.id)) - Number(starred.has(x.id)) || weightOf(y) - weightOf(x) || x.ts - y.ts);
}

/** Sets up the idea review of a brainstorm: one slide per idea. Setting it up again before it has
 *  started rebuilds it from the map as it is now (new stars, ideas taken off). `only` keeps it to
 *  the ideas named, by id or by label. */
export function setUpIdeaReview(db: DB, roomId: string, brainstormId: string, by: string, only?: string[]): { review: ReviewRow; slides: number; left: number; updated: boolean } {
  const b = db.getBrainstorm(brainstormId);
  if (!b || b.roomId !== roomId || b.kind !== "map") throw new ReviewError("That brainstorm isn't in this space.");
  const wanted = only?.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const all = ideasInOrder(b).filter((n) => !wanted?.length || wanted.includes(n.id.toLowerCase()) || wanted.includes(n.label.toLowerCase()));
  if (!all.length) throw new ReviewError(wanted?.length ? "None of those ideas are on this brainstorm's map." : "This brainstorm has no ideas on its map yet.");
  const ideas = all.slice(0, IDEA_SLIDES_MAX);
  const mine = db.ideaReviewsOf(b.id);
  if (mine.some((r) => r.status === "live")) throw new ReviewError("This brainstorm's idea review is running in a call now.");
  const draft = mine.find((r) => r.status === "draft");
  const review = draft ?? db.createReview(roomId, "ideas", { title: b.prompt, sourceId: b.id });
  if (draft) db.clearReviewSlides(draft.id);
  const starred = new Set(b.starred);
  for (const n of ideas) {
    const slide = db.addReviewSlide(review.id, {
      title: clip(n.label, REVIEW_TITLE_MAX),
      name: clip(n.label, REVIEW_NAME_MAX),
      body: n.detail ?? "",
      noteId: null,
      owner: null,
      addedBy: by,
      pr: null,
    });
    const idea: IdeaSlideSaved = {
      brainstormId: b.id,
      nodeId: n.id,
      direction: b.nodes.find((d) => d.id === n.parent)?.label ?? null,
      by: n.by,
      starred: starred.has(n.id),
      points: n.points.map((p) => ({ text: p.text, by: p.by })),
      caught: n.caught,
    };
    db.setSlideIdea(slide.id, idea);
  }
  return { review, slides: ideas.length, left: all.length - ideas.length, updated: !!draft };
}

/** Starts an idea review: its slides become a deck at the top of the agenda, and the first idea is
 *  where the call opens. One review runs at a time. Given no id, the newest one waiting starts. */
export function startIdeaReview(db: DB, roomId: string, reviewId?: string | null, now = Date.now()): { review: ReviewRow; deckId: string; firstItemId: string; started: boolean } {
  const live = db.reviewIn(roomId, ["live"], "ideas");
  if (live?.deckId && (!reviewId || reviewId === live.id)) {
    const first = db.liveSlides(live.deckId)[0];
    if (first) return { review: live, deckId: live.deckId, firstItemId: first.id, started: false };
    db.setReview(live.id, { status: "done", endedAt: now });
  } else if (live) throw new ReviewError("Another idea review is running. Finish it first.");
  if (db.reviewIn(roomId, ["live"], "product") || db.reviewIn(roomId, ["live"], "design")) throw new ReviewError("A review is running in this space. Finish it first.");
  const asked = reviewId ? db.getReview(reviewId) : db.reviewIn(roomId, ["draft"], "ideas");
  const draft = asked && asked.roomId === roomId && asked.kind === "ideas" && asked.status === "draft" ? asked : null;
  const slides = draft ? db.reviewSlides(draft.id) : [];
  if (!draft || !slides.length) throw new ReviewError("No idea review is waiting. Set one up from a brainstorm's page.");
  const title = `Idea review · ${day(now)}`;
  const deck = db.createDeck(roomId, title, slides.length, "native");
  db.setDeckReview(deck.id, draft.id);
  const ids = slides.map(() => newId());
  db.saveDeck(deck, { title, theme: "paper", slides: slides.map((s, i) => ({ id: ids[i], title: s.title, ...contentOf(db, s) })) });
  slides.forEach((s, i) => db.updateReviewSlide(s.id, { itemId: ids[i] }));
  const rest = db.listItems(roomId).filter((it) => it.deckId !== deck.id).map((it) => it.id);
  db.reorderItems(roomId, [...ids, ...rest]);
  db.setReview(draft.id, { status: "live", deckId: deck.id, startedAt: now });
  return { review: db.getReview(draft.id)!, deckId: deck.id, firstItemId: ids[0], started: true };
}

/** The idea review running in this space is over (its meeting ended, or the host finished it): it
 *  is done, its slides leave the agenda, and each idea the team chose to pursue or explore gets
 *  the to-do or open question that carries it on. */
export function finishIdeaReview(db: DB, roomId: string, meetingId: string, now = Date.now()): ReviewRow | null {
  const live = db.reviewIn(roomId, ["live"], "ideas");
  if (!live) return null;
  const notes = db.meetingNotes(meetingId);
  for (const s of db.reviewSlides(live.id)) {
    if (!s.idea || !s.itemId) continue;
    const kind = s.outcome === "pursue" ? "action" : s.outcome === "explore" ? "question" : null;
    if (!kind) continue;
    // The talk on the slide usually says it better than a line Stand would write: keep what was caught.
    const said = notes.find((n) => n.itemId === s.itemId && n.kind === kind);
    const note = said ?? db.addNote(meetingId, s.itemId, { kind, text: kind === "action" ? `Pursue the idea: ${s.title}` : `Is this worth doing: ${s.title}?`, owner: null }, "Stand");
    db.setSlideIdea(s.id, { ...s.idea, became: { kind, id: note.id } });
  }
  db.setReview(live.id, { status: "done", meetingId, endedAt: now });
  if (live.deckId) db.archiveDeck(live.deckId);
  return db.getReview(live.id);
}

const summaryOf = (db: DB, r: ReviewRow): IdeaReviewSummary => {
  const slides = db.reviewSlides(r.id);
  const outcomes: Record<IdeaOutcome, number> = { pursue: 0, explore: 0, not_now: 0 };
  for (const s of slides) if (s.outcome && s.outcome in outcomes) outcomes[s.outcome as IdeaOutcome]++;
  return { id: r.id, title: r.title ?? "Ideas", brainstormId: r.sourceId, status: r.status, startedAt: r.startedAt, meetingId: r.meetingId, slides: slides.length, outcomes };
};

/** The space's idea reviews: the one in a call and the ones waiting first, then the ones that ran. */
export function ideaReviewsOf(db: DB, roomId: string): IdeaReviewSummary[] {
  const order = { live: 0, draft: 1, done: 2 };
  return db
    .ideaReviews(roomId)
    .map((r) => summaryOf(db, r))
    .filter((r) => r.slides > 0)
    .sort((a, b) => order[a.status] - order[b.status]);
}

/** The idea review that ran in a meeting, for its recap. */
export function ideaReviewOfMeeting(db: DB, meetingId: string): IdeaReviewSummary | null {
  const r = db.reviewByMeeting(meetingId, "ideas");
  return r ? summaryOf(db, r) : null;
}

/** One idea review as a view, for the MCP. */
export function ideaReviewView(db: DB, reviewId: string, baseUrl = ""): ReviewView | null {
  const r = db.getReview(reviewId);
  return r?.kind === "ideas" ? toView(db, r, db.reviewSlides(r.id), [], baseUrl) : null;
}

/** What the brainstorm's page shows of its idea review: the newest one, and what the reviews that
 *  ran made of each idea (a later review's word replaces an earlier one's). */
export function reviewedIdeas(db: DB, brainstormId: string): Pick<BrainstormView, "ideaReview" | "reviewed"> {
  const all = db.ideaReviewsOf(brainstormId);
  if (!all.length) return {};
  const reviewed: NonNullable<BrainstormView["reviewed"]> = {};
  for (const r of [...all].reverse()) {
    if (r.status === "draft") continue;
    for (const s of db.reviewSlides(r.id)) {
      if (s.idea && s.outcome && IDEA_OUTCOMES.some((o) => o.id === s.outcome)) reviewed[s.idea.nodeId] = { outcome: s.outcome as IdeaOutcome, became: s.idea.became ?? null };
    }
  }
  const newest = all[0];
  return { ideaReview: { id: newest.id, status: newest.status }, ...(Object.keys(reviewed).length ? { reviewed } : {}) };
}
