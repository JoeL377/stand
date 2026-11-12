// A space's sources: the GitHub repos it links. Its creator and admins link, pull and unlink them.
import type { Express } from "express";
import type { SourcesStatus } from "../../shared/protocol.ts";
import { SourceError } from "../sources.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function sourceRoutes(app: Express, ctx: Services) {
  const { db, githubApp, sources } = ctx;
  const sourcesStatus = async (roomId: string, userId: string, canManage: boolean): Promise<SourcesStatus> => {
    let linkable: SourcesStatus["linkable"] = null;
    let linkableError: string | null = null;
    if (canManage && githubApp)
      linkable = await sources.linkable(userId).catch((e: Error) => {
        linkableError = e.message;
        return null;
      });
    return { available: !!githubApp, canManage, sources: sources.list(roomId), linkable, linkableError };
  };
  app.get(
    "/api/rooms/:id/sources",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      res.json(await sourcesStatus(room.id, req.user!.id, db.managesSpace(room, req.user!.id)));
    }),
  );
  app.post(
    "/api/rooms/:id/sources",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!db.managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only an admin of this space can link a repo" });
      try {
        await sources.link(room.id, req.user!.id, String(req.body?.repo ?? ""));
      } catch (e) {
        if (e instanceof SourceError) return void res.status(400).json({ error: e.message });
        throw e;
      }
      res.json(await sourcesStatus(room.id, req.user!.id, true));
    }),
  );
  app.post(
    "/api/rooms/:id/sources/:owner/:repo/pull",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!db.managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only an admin of this space can do that" });
      await sources.pull(room.id, req.params.owner, req.params.repo);
      res.json(await sourcesStatus(room.id, req.user!.id, true));
    }),
  );
  app.delete(
    "/api/rooms/:id/sources/:owner/:repo",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!db.managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only an admin of this space can unlink a repo" });
      if (!sources.unlink(room.id, req.params.owner, req.params.repo)) return notFound(res, "That repo isn't linked to this space");
      res.json(await sourcesStatus(room.id, req.user!.id, true));
    }),
  );
}
