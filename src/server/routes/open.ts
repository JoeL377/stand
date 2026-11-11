// Routes that come before sign-in: each one checks an agent token or a link's secret itself.
import express, { type Express } from "express";
import { agentFromRequest, origin, userFromRequest } from "../auth.ts";
import { imageType } from "../decks.ts";
import { handleMcp } from "../mcp.ts";
import { snapFile } from "../snaps.ts";
import { MAX_SHOT_BYTES, saveShotFile, shotFile } from "../workLog.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function openRoutes(app: Express, ctx: Services) {
  const { db, live, agents, uploadLinks } = ctx;
  // Agents connect here with "Authorization: Bearer stand_pat_…", either typed in
  // from the Connect an agent page or handed out by the sign-in flow in oauth.ts.
  app.all(
    "/mcp",
    route(async (req, res) => {
      const caller = agentFromRequest(db, req);
      if (!caller) {
        // Points apps at the sign-in flow, so a connector with just this URL can sign in.
        res.set("WWW-Authenticate", `Bearer realm="stand", resource_metadata="${origin(req)}/.well-known/oauth-protected-resource/mcp"`);
        return void res.status(401).json({ error: "Stand needs an agent token. Make one on the Connect an agent page in Stand." });
      }
      await handleMcp(req, res, agents, caller, origin(req));
    }),
  );

  // A snap's image, for people in its space and for their agents (with a token).
  app.get(
    "/api/snaps/:file",
    route((req, res) => {
      const user = userFromRequest(db, req) ?? agentFromRequest(db, req)?.user ?? null;
      if (!user) return res.status(401).json({ error: "Sign in first" });
      const m = /^([a-z0-9]+)\.(png|jpg|webp)$/.exec(req.params.file);
      const snap = m ? db.getSnap(m[1]) : null;
      const file = snap && snap.ext === m![2] ? snapFile(snap.id, snap.ext) : null;
      if (!snap || !file || !db.isMember(snap.roomId, user.id)) return notFound(res);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.sendFile(file);
    }),
  );


  // Screenshots an agent attaches to a to-do. The link (from the MCP's screenshot_upload_url) is
  // the permission, so an agent can curl a file here without its token. ?caption= says what it shows.
  app.post(
    "/api/work-uploads/:secret",
    express.raw({ type: () => true, limit: MAX_SHOT_BYTES }),
    route((req, res) => {
      const grant = uploadLinks.use(req.params.secret);
      if (!grant) return res.status(403).json({ error: "That upload link has expired or been used up. Ask Stand for a new one." });
      const buf = req.body as Buffer;
      const ext = Buffer.isBuffer(buf) ? imageType(buf) : null;
      if (!ext) return res.status(400).json({ error: "Send a PNG, JPEG, WebP or GIF image as the request body." });
      const caption = typeof req.query.caption === "string" ? req.query.caption.trim().slice(0, 300) || null : null;
      const shot = db.addWorkShot({ ...grant, caption, ext });
      saveShotFile(shot.id, ext, buf);
      live(grant.roomId)?.updatesChanged();
      const onSlide = grant.noteId.startsWith("review:");
      if (onSlide) live(grant.roomId)?.followUpsChanged();
      res.json({ ok: true, id: shot.id, joins: onSlide ? "the slide on the next product review" : "your next post_update or complete_action on this to-do" });
    }),
  );

  // A work-log screenshot, for people in its space and their agents.
  app.get(
    "/api/work-shots/:file",
    route((req, res) => {
      const user = userFromRequest(db, req) ?? agentFromRequest(db, req)?.user ?? null;
      if (!user) return res.status(401).json({ error: "Sign in first" });
      const m = /^([a-z0-9]+)\.(png|jpg|webp|gif)$/.exec(req.params.file);
      const shot = m ? db.getWorkShot(m[1]) : null;
      const file = shot && shot.ext === m![2] ? shotFile(shot.id, shot.ext) : null;
      if (!shot || !file || !db.isMember(shot.roomId, user.id)) return notFound(res);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.sendFile(file);
    }),
  );
}
