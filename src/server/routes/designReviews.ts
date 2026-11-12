// Design reviews: a call that goes through a spec, one slide per section and per open comment.
import express, { type Express } from "express";
import { DesignReviewError, designReviewRecord, designReviewsRan, designReviewState, designReviewView, isAuthor, prepare, removeSpec, requested, requestReview, specView, startDesignReview, whenBriefed } from "../designReviews.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function designReviewRoutes(app: Express, ctx: Services) {
  const { db, planBriefs, sessions, specTouched } = ctx;
  // The space's next design review, as its page shows it.
  app.get(
    "/api/rooms/:id/design-review",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      res.json({ roomName: room.name, review: designReviewView(db, planBriefs, room.id, req.user!), reviews: designReviewsRan(db, room.id) });
    }),
  );

  // One that ran, as its page keeps it.
  app.get(
    "/api/rooms/:id/design-reviews/:reviewId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const review = designReviewRecord(db, room.id, req.params.reviewId);
      if (!review) return notFound(res, "Design review not found");
      res.json({ roomName: room.name, review, reviews: designReviewsRan(db, room.id) });
    }),
  );

  /** The to-do a design review route is about, when it is one this person can see. */
  const reviewedTask = (req: express.Request) => {
    const task = db.getNote(String(req.params.id));
    return task && task.kind === "action" && db.isMember(task.roomId, req.user!.id) ? task : null;
  };
  const personBy = (req: express.Request) => ({ userId: req.user!.id, userName: req.user!.name, client: null });
  const designError = (res: express.Response, err: unknown) => {
    if (err instanceof DesignReviewError) return res.status(400).json({ error: err.message });
    throw err;
  };

  // Starts it: each spec becomes slides at the top of the agenda, and a call that's running goes to the first one.
  app.post(
    "/api/rooms/:id/design-review/start",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      try {
        const started = startDesignReview(db, planBriefs, room.id);
        const s = sessions.get(room.id);
        if (s) {
          s.itemsChanged();
          s.startedBy(req.user!.id);
          s.setFocus(started.firstItemId, req.user!.name, "manual");
        }
        // A spec Stand is still writing the slides of: they fill in when it has.
        for (const spec of designReviewView(db, planBriefs, room.id, req.user!)?.specs ?? []) {
          const task = db.getNote(spec.taskId);
          if (task) whenBriefed(db, planBriefs, task, () => sessions.get(room.id)?.itemsChanged());
        }
        res.json({ review: designReviewView(db, planBriefs, room.id, req.user!), firstItemId: started.firstItemId });
      } catch (err) {
        designError(res, err);
      }
    }),
  );

  // Whether a to-do's plan waits on the next design review.
  app.get(
    "/api/tasks/:id/design-review",
    route((req, res) => {
      const task = reviewedTask(req);
      if (!task) return notFound(res);
      res.json(designReviewState(db, task));
    }),
  );

  // Request review: the plan joins the space's next design review.
  app.post(
    "/api/tasks/:id/design-review",
    route((req, res) => {
      const task = reviewedTask(req);
      if (!task) return notFound(res);
      try {
        requestReview(db, planBriefs, task, personBy(req));
        res.json(designReviewState(db, task));
      } catch (err) {
        designError(res, err);
      }
    }),
  );

  // Takes the plan off the next design review: its author, or whoever asked for the review.
  app.delete(
    "/api/tasks/:id/design-review",
    route((req, res) => {
      const task = reviewedTask(req);
      if (!task) return notFound(res);
      if (!isAuthor(db, task, req.user!) && !requested(db, task, req.user!)) return res.status(403).json({ error: "Only the spec's author takes it off the review." });
      if (!removeSpec(db, task, personBy(req))) return notFound(res);
      res.json(designReviewState(db, task));
    }),
  );

  // The author prepares the spec: what its slides say, which sections and points go to the call.
  app.patch(
    "/api/tasks/:id/design-review",
    route((req, res) => {
      const task = reviewedTask(req);
      if (!task) return notFound(res);
      if (!isAuthor(db, task, req.user!)) return res.status(403).json({ error: "Only the spec's author prepares it for the review." });
      try {
        prepare(db, planBriefs, task, personBy(req), req.body ?? {});
        specTouched(task);
        whenBriefed(db, planBriefs, task, () => sessions.get(task.roomId)?.itemsChanged());
        res.json({ spec: specView(db, planBriefs, task, req.user!) });
      } catch (err) {
        designError(res, err);
      }
    }),
  );
}
