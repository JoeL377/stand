// Product reviews and idea reviews: a call that goes through slides, one per feature or idea.
import type { Express } from "express";
import { setUpIdeaReview, startIdeaReview } from "../ideaReview.ts";
import { removeSlide, ReviewError, reviewPage, reviewsDone, reviewView, startReview } from "../reviews.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function reviewRoutes(app: Express, ctx: Services) {
  const { db, sessions } = ctx;
  // The space's next review, as its page shows it.
  app.get(
    "/api/rooms/:id/review",
    route((req, res) => {
      if (!db.isMember(req.params.id, req.user!.id)) return notFound(res, "Space not found");
      res.json({ review: reviewView(db, req.params.id) });
    }),
  );

  // One review's own page: "next", or the id of one that ran.
  app.get(
    "/api/rooms/:id/reviews/:reviewId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const review = reviewPage(db, room.id, req.params.reviewId);
      res.json({ roomName: room.name, review, reviews: reviewsDone(db, room.id) });
    }),
  );

  // Starts it: the slides become a deck at the top of the agenda, and a call that's running goes to the first one.
  app.post(
    "/api/rooms/:id/review/start",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      try {
        const started = startReview(db, room.id);
        const s = sessions.get(room.id);
        if (s) {
          s.itemsChanged();
          s.setFocus(started.firstItemId, req.user!.name, "manual");
        }
        res.json({ review: reviewView(db, room.id), firstItemId: started.firstItemId });
      } catch (err) {
        if (err instanceof ReviewError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );


  // Sets one up from a brainstorm, or rebuilds the one waiting from the map as it is now.
  app.post(
    "/api/rooms/:id/brainstorms/:brainstormId/review",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      try {
        const made = setUpIdeaReview(db, room.id, req.params.brainstormId, req.user!.name);
        sessions.get(room.id)?.itemsChanged();
        res.json({ reviewId: made.review.id, slides: made.slides });
      } catch (err) {
        if (err instanceof ReviewError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  // Starts one: its ideas become a deck at the top of the agenda, and a call that's running goes to the first.
  app.post(
    "/api/rooms/:id/idea-review/start",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      try {
        const started = startIdeaReview(db, room.id, typeof req.body?.review === "string" ? req.body.review : null);
        const s = sessions.get(room.id);
        if (s) {
          s.itemsChanged();
          s.setFocus(started.firstItemId, req.user!.name, "manual");
        }
        res.json({ reviewId: started.review.id, firstItemId: started.firstItemId });
      } catch (err) {
        if (err instanceof ReviewError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  // Takes a slide off a review that hasn't started.
  app.delete(
    "/api/rooms/:id/review/slides/:slideId",
    route((req, res) => {
      if (!db.isMember(req.params.id, req.user!.id)) return notFound(res, "Space not found");
      if (!removeSlide(db, req.params.id, req.params.slideId)) return notFound(res);
      res.json({ review: reviewView(db, req.params.id) });
    }),
  );
}
