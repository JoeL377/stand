// Product, idea and design reviews, and their slides (reviews.ts, ideaReview.ts, designReviews.ts).
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../ids.ts";
import { type IdeaSlideSaved, type ReviewKind, type ReviewRow, type ReviewSlideRow, type Row, toReview, toReviewSlide } from "./rows.ts";

export function reviewsStore(db: DatabaseSync) {
  return {
    /** The space's review of one kind in one of these states, newest first. */
    reviewIn(roomId: string, statuses: Array<ReviewRow["status"]>, kind: ReviewKind = "product"): ReviewRow | null {
      const r = db
        .prepare(`SELECT * FROM reviews WHERE room_id = ? AND kind = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(roomId, kind, ...statuses) as Row | undefined;
      return r ? toReview(r) : null;
    },
    /** The space's reviews that ran, newest first. */
    reviewsDone(roomId: string, limit = 30, kind: ReviewKind = "product"): ReviewRow[] {
      return (db.prepare("SELECT * FROM reviews WHERE room_id = ? AND kind = ? AND status = 'done' ORDER BY started_at DESC, rowid DESC LIMIT ?").all(roomId, kind, limit) as Row[]).map(toReview);
    },
    reviewByMeeting(meetingId: string, kind: ReviewKind = "product"): ReviewRow | null {
      const r = db.prepare("SELECT * FROM reviews WHERE meeting_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 1").get(meetingId, kind) as Row | undefined;
      return r ? toReview(r) : null;
    },
    getReview(id: string): ReviewRow | null {
      const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
      return r ? toReview(r) : null;
    },
    createReview(roomId: string, kind: ReviewKind = "product", named?: { title: string; sourceId: string }): ReviewRow {
      const id = newId();
      db.prepare("INSERT INTO reviews (id, room_id, status, created_at, kind, title, source_id) VALUES (?, ?, 'draft', ?, ?, ?, ?)").run(id, roomId, Date.now(), kind, named?.title ?? null, named?.sourceId ?? null);
      return this.getReview(id)!;
    },
    /** A space's idea reviews, newest first. */
    ideaReviews(roomId: string, limit = 30): ReviewRow[] {
      return (db.prepare("SELECT * FROM reviews WHERE room_id = ? AND kind = 'ideas' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(roomId, limit) as Row[]).map(toReview);
    },
    /** The idea reviews set up on one brainstorm, newest first. */
    ideaReviewsOf(brainstormId: string): ReviewRow[] {
      return (db.prepare("SELECT * FROM reviews WHERE source_id = ? AND kind = 'ideas' ORDER BY created_at DESC, rowid DESC").all(brainstormId) as Row[]).map(toReview);
    },
    clearReviewSlides(reviewId: string) {
      db.prepare("DELETE FROM review_slides WHERE review_id = ?").run(reviewId);
    },
    setSlideIdea(id: string, idea: IdeaSlideSaved) {
      db.prepare("UPDATE review_slides SET idea_json = ? WHERE id = ?").run(JSON.stringify(idea), id);
    },
    /** Removes a review with no slides left (one that went back to waiting). */
    deleteReview(id: string) {
      db.prepare("DELETE FROM reviews WHERE id = ? AND NOT EXISTS (SELECT 1 FROM review_slides WHERE review_id = ?)").run(id, id);
    },
    setReview(id: string, patch: Partial<Pick<ReviewRow, "status" | "deckId" | "meetingId" | "startedAt" | "endedAt">>) {
      const cols: Record<string, string> = { status: "status", deckId: "deck_id", meetingId: "meeting_id", startedAt: "started_at", endedAt: "ended_at" };
      for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE reviews SET ${cols[k]} = ? WHERE id = ?`).run(v ?? null, id);
    },
    reviewSlides(reviewId: string): ReviewSlideRow[] {
      return (db.prepare("SELECT * FROM review_slides WHERE review_id = ? ORDER BY position, rowid").all(reviewId) as Row[]).map(toReviewSlide);
    },
    getReviewSlide(id: string): ReviewSlideRow | null {
      const r = db.prepare("SELECT * FROM review_slides WHERE id = ?").get(id) as Row | undefined;
      return r ? toReviewSlide(r) : null;
    },
    /** To-dos a review of this space has already shown (one that ran, or is running). */
    reviewedNoteIds(roomId: string): string[] {
      return (
        db
          .prepare("SELECT s.note_id FROM review_slides s JOIN reviews r ON r.id = s.review_id WHERE r.room_id = ? AND r.kind = 'product' AND r.status != 'draft' AND s.note_id IS NOT NULL")
          .all(roomId) as Row[]
      ).map((r) => r.note_id as string);
    },
    reviewSlideByItem(itemId: string): ReviewSlideRow | null {
      const r = db.prepare("SELECT * FROM review_slides WHERE item_id = ?").get(itemId) as Row | undefined;
      return r ? toReviewSlide(r) : null;
    },
    addReviewSlide(
      reviewId: string,
      s: Pick<ReviewSlideRow, "title" | "body" | "noteId" | "owner" | "addedBy" | "pr"> &
        Partial<Pick<ReviewSlideRow, "name" | "role" | "planVersion" | "section" | "threadId">>,
    ): ReviewSlideRow {
      const id = newId();
      const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM review_slides WHERE review_id = ?").get(reviewId) as Row).p as number;
      db.prepare(
        "INSERT INTO review_slides (id, review_id, position, title, body, note_id, owner, added_by, pr, created_at, name, role, plan_version, section, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, reviewId, pos + 1, s.title, s.body, s.noteId, s.owner, s.addedBy, s.pr, Date.now(), s.name ?? null, s.role ?? null, s.planVersion ?? null, s.section ?? null, s.threadId ?? null);
      return this.getReviewSlide(id)!;
    },
    updateReviewSlide(id: string, patch: Partial<Pick<ReviewSlideRow, "title" | "name" | "body" | "owner" | "addedBy" | "pr" | "itemId" | "outcome" | "outcomeBy" | "outcomeAt" | "planVersion">>) {
      const cols: Record<string, string> = { title: "title", name: "name", body: "body", owner: "owner", addedBy: "added_by", pr: "pr", itemId: "item_id", outcome: "outcome", outcomeBy: "outcome_by", outcomeAt: "outcome_at", planVersion: "plan_version" };
      for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE review_slides SET ${cols[k]} = ? WHERE id = ?`).run(v ?? null, id);
    },
    removeReviewSlide(id: string) {
      db.prepare("DELETE FROM review_slides WHERE id = ?").run(id);
    },
    /** The verdict slide of the last design review that ran on a to-do's plan, with when it started. */
    lastDesignVerdict(noteId: string): (ReviewSlideRow & { startedAt: number | null }) | null {
      const r = db
        .prepare(
          "SELECT s.*, r.started_at AS review_started_at FROM review_slides s JOIN reviews r ON r.id = s.review_id WHERE s.note_id = ? AND s.role = 'verdict' AND r.kind = 'design' AND r.status = 'done' ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1",
        )
        .get(noteId) as Row | undefined;
      return r ? { ...toReviewSlide(r), startedAt: (r.review_started_at as number) ?? null } : null;
    },
    /** Puts a review's slides in this order; one from another review moves over. */
    orderReviewSlides(reviewId: string, ids: string[]) {
      const set = db.prepare("UPDATE review_slides SET review_id = ?, position = ? WHERE id = ?");
      ids.forEach((id, i) => set.run(reviewId, i, id));
    },
  };
}
