// A space's project: the GitHub repos it links.
import type { Express } from "express";
import type { ProjectsStatus } from "../../shared/protocol.ts";
import { ProjectError } from "../projects.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function projectRoutes(app: Express, ctx: Services) {
  const { db, githubApp, projects } = ctx;
  /** Only the space's creator links repos (anyone, for older spaces with no creator), as with renaming it. */
  const managesSpace = (room: { createdBy: string | null }, userId: string) => !room.createdBy || room.createdBy === userId;
  const projectsStatus = async (roomId: string, userId: string, canManage: boolean): Promise<ProjectsStatus> => {
    let linkable: ProjectsStatus["linkable"] = null;
    let linkableError: string | null = null;
    if (canManage && githubApp)
      linkable = await projects.linkable(userId).catch((e: Error) => {
        linkableError = e.message;
        return null;
      });
    return { available: !!githubApp, canManage, projects: projects.list(roomId), linkable, linkableError };
  };
  app.get(
    "/api/rooms/:id/projects",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      res.json(await projectsStatus(room.id, req.user!.id, managesSpace(room, req.user!.id)));
    }),
  );
  app.post(
    "/api/rooms/:id/projects",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only the person who created this space can link a repo" });
      try {
        await projects.link(room.id, req.user!.id, String(req.body?.repo ?? ""));
      } catch (e) {
        if (e instanceof ProjectError) return void res.status(400).json({ error: e.message });
        throw e;
      }
      res.json(await projectsStatus(room.id, req.user!.id, true));
    }),
  );
  app.post(
    "/api/rooms/:id/projects/:owner/:repo/pull",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only the person who created this space can do that" });
      await projects.pull(room.id, req.params.owner, req.params.repo);
      res.json(await projectsStatus(room.id, req.user!.id, true));
    }),
  );
  app.delete(
    "/api/rooms/:id/projects/:owner/:repo",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only the person who created this space can unlink a repo" });
      if (!projects.unlink(room.id, req.params.owner, req.params.repo)) return notFound(res, "That repo isn't linked to this space");
      res.json(await projectsStatus(room.id, req.user!.id, true));
    }),
  );
}
