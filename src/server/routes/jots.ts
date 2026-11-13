// Notes: a line saved straight to a space from the Mac's bar.
import type { Express } from "express";
import type { Jot } from "../../shared/protocol.ts";
import { cleanJot, itemIn, saveJot } from "../captures.ts";
import { removeSnapFile, type SnapRow } from "../snaps.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";
import { SNAP_UNDO_MS } from "./snaps.ts";

export function jotRoutes(app: Express, ctx: Services) {
  const { db, agent, live } = ctx;
  /** Notes by the key their save carried, for a while: a retry of one that got through gets the same note back. */
  const jotKeys = new Map<string, string>();

  // {text, itemId?, at?, key?}. With no item, the agent suggests one once it has read it.
  app.post(
    "/api/rooms/:id/jots",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res, "Space not found");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = cleanJot(body.text);
      if (!text) return res.status(400).json({ error: "Write something to save." });
      const key = typeof body.key === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.key) ? `${req.user!.id}:${body.key}` : null;
      const already = key ? jotKeys.get(key) : undefined;
      const again = already ? db.getJot(already) : null;
      if (again) return res.json(again);
      db.touchMembership(room.id, req.user!.id);
      const id = saveJot(
        db,
        agent,
        { roomId: room.id, text, at: Number(body.at) || Date.now(), byId: req.user!.id, by: req.user!.name, itemId: itemIn(db, room.id, body.itemId) },
        () => live(room.id)?.snapsChanged(),
      );
      // A meeting going on in the space sees it in its suggested agenda.
      live(room.id)?.snapsChanged();
      if (key) {
        jotKeys.set(key, id);
        setTimeout(() => jotKeys.delete(key), 10 * 60_000).unref?.();
      }
      res.json(db.getJot(id));
    }),
  );

  // Its text (whoever wrote it) and its item (anyone in the space; that confirms an item the agent suggested).
  app.patch(
    "/api/jots/:id",
    route((req, res) => {
      const jot = db.getJot(req.params.id);
      if (!jot || !db.isMember(jot.roomId, req.user!.id)) return notFound(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if ("text" in body && jot.byId !== req.user!.id) return res.status(403).json({ error: "Only whoever wrote it can change what it says." });
      const text = "text" in body ? cleanJot(body.text) : undefined;
      if (text === null) return res.status(400).json({ error: "A note needs some text. Delete it instead." });
      let itemId: string | null | undefined;
      if ("itemId" in body) {
        itemId = body.itemId === null ? null : itemIn(db, jot.roomId, body.itemId);
        if (body.itemId !== null && !itemId) return res.status(400).json({ error: "That item isn't in this space any more." });
      }
      if (text) db.setJotText(jot.id, text);
      if (itemId !== undefined) db.setJotItem(jot.id, itemId);
      live(jot.roomId)?.snapsChanged();
      res.json(db.getJot(jot.id));
    }),
  );

  const deletedJots = new Map<string, { jot: Jot; snaps: SnapRow[]; timer: ReturnType<typeof setTimeout> }>();

  app.delete(
    "/api/jots/:id",
    route((req, res) => {
      const jot = db.getJot(req.params.id);
      if (!jot || !db.isMember(jot.roomId, req.user!.id)) return notFound(res);
      if (jot.byId !== req.user!.id) return res.status(403).json({ error: "Only whoever wrote it can delete it." });
      const snaps = db.jotSnaps(jot.id);
      db.deleteJot(jot.id);
      // Its pictures stay for a minute, so Undo can bring the note back whole.
      const timer = setTimeout(() => {
        deletedJots.delete(jot.id);
        for (const s of snaps) removeSnapFile(s.id, s.ext);
      }, SNAP_UNDO_MS);
      timer.unref?.();
      deletedJots.set(jot.id, { jot, snaps, timer });
      live(jot.roomId)?.snapsChanged();
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/jots/:id/restore",
    route((req, res) => {
      const deleted = deletedJots.get(req.params.id);
      if (!deleted || deleted.jot.byId !== req.user!.id) return res.status(404).json({ error: "It's been too long to bring it back." });
      clearTimeout(deleted.timer);
      deletedJots.delete(req.params.id);
      db.addJot(deleted.jot);
      for (const { version: _version, caption, ...row } of deleted.snaps) {
        db.addSnap(row);
        if (caption) db.setSnapCaption(row.id, caption);
      }
      live(deleted.jot.roomId)?.snapsChanged();
      res.json({ ok: true });
    }),
  );
}
