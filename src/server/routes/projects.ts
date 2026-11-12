// A space's projects (shared/projects.ts): making, changing and deleting them, and what is in each,
// and the to-do a task is a part of, whose project it follows. Anyone in the space can do all of it,
// as with the topic label before.
import type { Express, Response } from "express";
import { ParentError, ProjectError } from "../db.ts";
import { SUGGEST_AFTER_PROJECT_MS } from "../projectSuggest.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function projectRoutes(app: Express, ctx: Services) {
  const { db, sessions, afterItemsChange, projectSuggester } = ctx;
  /** Runs a change and turns a mistake in what was asked into a 400 with its words. */
  const attempt = (res: Response, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ProjectError || err instanceof ParentError) return void res.status(400).json({ error: err.message });
      throw err;
    }
  };
  const changed = (roomId: string) => sessions.get(roomId)?.followUpsChanged();

  app.get(
    "/api/rooms/:id/projects",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (room) res.json(db.listProjects(room.id));
    }),
  );

  // { name, goal?, fromItemId? }: fromItemId is "Make project" on an agenda line, which links it too.
  app.post(
    "/api/rooms/:id/projects",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      attempt(res, () => {
        const fromItemId = typeof req.body?.fromItemId === "string" ? req.body.fromItemId : null;
        const project = db.createProject(room.id, { name: req.body?.name, goal: req.body?.goal, fromItemId }, req.user!.name);
        if (fromItemId) afterItemsChange(room.id);
        changed(room.id);
        projectSuggester.schedule(room.id, SUGGEST_AFTER_PROJECT_MS);
        res.status(201).json(project);
      });
    }),
  );

  // { name?, goal?, position?, archived? }
  app.patch(
    "/api/rooms/:id/projects/:projectId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      attempt(res, () => {
        const { name, goal, position, archived } = req.body ?? {};
        const project = db.updateProject(room.id, req.params.projectId, { name, goal, position, archived });
        if (!project) return notFound(res, "No such project in this space");
        changed(room.id);
        // A new name or goal, or back from the archive: Stand reads what nobody filed again.
        if (name !== undefined || goal !== undefined || archived === false) projectSuggester.schedule(room.id, SUGGEST_AFTER_PROJECT_MS);
        res.json(project);
      });
    }),
  );

  app.delete(
    "/api/rooms/:id/projects/:projectId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!db.deleteProject(room.id, req.params.projectId)) return notFound(res, "No such project in this space");
      afterItemsChange(room.id);
      changed(room.id);
      res.json({ ok: true });
    }),
  );

  // A to-do's, question's or decision's project: { projectId: id } sets it, { projectId: null } sets
  // Unassigned, { auto: true } goes back to the rules.
  app.patch(
    "/api/rooms/:id/notes/:noteId/project",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const body = req.body ?? {};
      if (body.auto !== true && body.projectId !== null && typeof body.projectId !== "string")
        return void res.status(400).json({ error: "Give projectId (a project's id, or null for Unassigned) or auto: true." });
      attempt(res, () => {
        const note = db.setNoteProject(room.id, req.params.noteId, body.auto === true ? { auto: true } : { projectId: body.projectId, by: req.user!.name });
        if (!note) return notFound(res);
        changed(room.id);
        res.json(db.withProjects(room.id, [note])[0]);
      });
    }),
  );

  // The to-do a to-do or open question is a part of: { parentId: id } sets it, { parentId: null } takes it off.
  app.patch(
    "/api/rooms/:id/notes/:noteId/parent",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const parentId = req.body?.parentId;
      if (parentId !== null && typeof parentId !== "string") return void res.status(400).json({ error: "Give parentId: a to-do's id, or null." });
      attempt(res, () => {
        const note = db.setNoteParent(room.id, req.params.noteId, parentId);
        if (!note) return notFound(res);
        changed(room.id);
        res.json(db.withProjects(room.id, [note])[0]);
      });
    }),
  );

  // Links an agenda item to a project ({ projectId }) or takes the link off ({ projectId: null }).
  app.patch(
    "/api/rooms/:id/items/:itemId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const projectId = req.body?.projectId;
      if (projectId !== null && typeof projectId !== "string") return void res.status(400).json({ error: "Give projectId: a project's id, or null." });
      attempt(res, () => {
        const item = db.setItemProject(room.id, req.params.itemId, projectId);
        if (!item) return notFound(res);
        changed(room.id);
        res.json(afterItemsChange(room.id));
      });
    }),
  );
}
