// Snaps: stills of the shared screen, or pictures saved to a space.
import express, { type Express } from "express";
import { cleanLine, cleanScreenText, itemIn, saveCapture } from "../captures.ts";
import type { DB } from "../db.ts";
import { imageType } from "../decks.ts";
import { linkSnaps, MAX_SNAP_BYTES, removeSnapFile, saveSnapFile } from "../snaps.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

/** A deleted snap's image is kept this long, so Undo can bring it back. */
export const SNAP_UNDO_MS = 60_000;

export function snapRoutes(app: Express, ctx: Services) {
  const { db, agent, live } = ctx;
  /** Snaps by the key their upload carried, for a while: a retry of one that got through gets the same snap back. */
  const snapKeys = new Map<string, string>();
  const deletedSnaps = new Map<string, { snap: NonNullable<ReturnType<DB["getSnap"]>>; timer: ReturnType<typeof setTimeout> }>();

  /** Who can crop or delete a snap: whoever took it, whoever's screen it is, and the host. */
  const canChangeSnap = (userId: string, snap: { roomId: string; takenById: string | null; sharerId: string | null }) =>
    snap.takenById === userId || snap.sharerId === userId || Boolean(live(snap.roomId)?.hosts(userId));

  // Taken in the meeting: the image is the raw body, at the size it was shared.
  // ?pasted=1 for a screenshot someone pasted or dropped in, which is nobody's shared screen.
  // ?to=space saves it straight to the space instead, between meetings, on ?item when given, or
  // pinned to ?jot, a note of yours in the space (saved first, from the Mac's bar).
  app.post(
    "/api/rooms/:id/snaps",
    express.raw({ type: () => true, limit: MAX_SNAP_BYTES }),
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res, "Space not found");
      const toSpace = req.query.to === "space";
      const s = live(room.id);
      if (!toSpace && (!s || !s.has(req.user!.id))) return res.status(409).json({ error: "Snaps are taken in a live meeting." });
      const buf = req.body as Buffer;
      const ext = Buffer.isBuffer(buf) ? imageType(buf) : null;
      if (!ext || ext === "gif") return res.status(400).json({ error: "Send a PNG, JPEG or WebP image." });
      const size = (v: unknown) => Math.max(0, Math.min(20000, Math.round(Number(v) || 0)));
      const key = typeof req.query.key === "string" && /^[A-Za-z0-9-]{8,64}$/.test(req.query.key) ? `${req.user!.id}:${req.query.key}` : null;
      const already = key ? snapKeys.get(key) : undefined;
      if (already && db.getSnap(already)) return res.json({ id: already, itemId: db.getSnap(already)?.itemId ?? null });
      const shot = {
        buf,
        ext,
        width: size(req.query.w),
        height: size(req.query.h),
        at: Number(req.query.at) || Date.now(),
        takenById: req.user!.id,
        takenBy: req.user!.name,
        line: null,
      };
      const jot = toSpace && typeof req.query.jot === "string" ? db.getJot(req.query.jot) : null;
      if (toSpace && req.query.jot && (!jot || jot.roomId !== room.id || jot.byId !== req.user!.id))
        return res.status(400).json({ error: "That note isn't yours in this space." });
      let id: string;
      if (jot) {
        db.touchMembership(room.id, req.user!.id);
        id = saveCapture(db, agent, { ...shot, roomId: room.id, itemId: jot.itemId, jotId: jot.id }, () => live(room.id)?.snapsChanged());
        live(room.id)?.snapsChanged();
      } else if (toSpace) {
        db.touchMembership(room.id, req.user!.id);
        // A meeting going on in the space sees it in its suggested agenda.
        id = saveCapture(db, agent, { ...shot, roomId: room.id, itemId: itemIn(db, room.id, req.query.item) }, () => live(room.id)?.snapsChanged());
        live(room.id)?.snapsChanged();
      } else id = s!.addSnap({ ...shot, pasted: req.query.pasted === "1" });
      if (key) {
        snapKeys.set(key, id);
        setTimeout(() => snapKeys.delete(key), 10 * 60_000).unref?.();
      }
      // Which item it landed on: the one in focus when it was taken, which may not be the one now.
      res.json({ id, itemId: db.getSnap(id)?.itemId ?? null });
    }),
  );

  // A crop replaces the image.
  app.put(
    "/api/snaps/:id/image",
    express.raw({ type: () => true, limit: MAX_SNAP_BYTES }),
    route((req, res) => {
      const snap = db.getSnap(req.params.id);
      if (!snap || !db.isMember(snap.roomId, req.user!.id)) return notFound(res);
      if (!canChangeSnap(req.user!.id, snap))
        return res.status(403).json({ error: "Only whoever took it, the sharer or the host can crop it." });
      const buf = req.body as Buffer;
      const ext = Buffer.isBuffer(buf) ? imageType(buf) : null;
      if (!ext || ext === "gif") return res.status(400).json({ error: "Send a PNG, JPEG or WebP image." });
      const size = (v: unknown) => Math.max(0, Math.min(20000, Math.round(Number(v) || 0)));
      removeSnapFile(snap.id, snap.ext);
      saveSnapFile(snap.id, ext, buf);
      db.setSnapImage(snap.id, ext, size(req.query.w), size(req.query.h));
      live(snap.roomId)?.snapsChanged();
      res.json({ ok: true });
    }),
  );

  // What a snap says and where it sits: the line typed with it and the text read off it (whoever
  // took it), and its item (anyone in the space; that confirms an item the agent suggested).
  app.patch(
    "/api/snaps/:id",
    route((req, res) => {
      const snap = db.getSnap(req.params.id);
      if (!snap || !db.isMember(snap.roomId, req.user!.id)) return notFound(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (("line" in body || "screenText" in body) && snap.takenById !== req.user!.id)
        return res.status(403).json({ error: "Only whoever took it can change what it says." });
      let itemId: string | null | undefined;
      if ("itemId" in body) {
        itemId = body.itemId === null ? null : itemIn(db, snap.roomId, body.itemId);
        if (body.itemId !== null && !itemId) return res.status(400).json({ error: "That item isn't in this space any more." });
      }
      if ("line" in body) db.setSnapLine(snap.id, cleanLine(body.line));
      if ("screenText" in body) db.setSnapText(snap.id, cleanScreenText(body.screenText));
      if (itemId !== undefined) db.setSnapItem(snap.id, itemId);
      live(snap.roomId)?.snapsChanged();
      res.json(linkSnaps([db.getSnap(snap.id)!], [], [])[0]);
    }),
  );

  app.delete(
    "/api/snaps/:id",
    route((req, res) => {
      const snap = db.getSnap(req.params.id);
      if (!snap || !db.isMember(snap.roomId, req.user!.id)) return notFound(res);
      if (!canChangeSnap(req.user!.id, snap))
        return res.status(403).json({ error: "Only whoever took it, the sharer or the host can delete it." });
      db.deleteSnap(snap.id);
      // The image stays for a minute, so Undo can bring the snap back.
      const timer = setTimeout(() => {
        deletedSnaps.delete(snap.id);
        removeSnapFile(snap.id, snap.ext);
      }, SNAP_UNDO_MS);
      timer.unref?.();
      deletedSnaps.set(snap.id, { snap, timer });
      live(snap.roomId)?.snapsChanged();
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/snaps/:id/restore",
    route((req, res) => {
      const deleted = deletedSnaps.get(req.params.id);
      if (!deleted || !db.isMember(deleted.snap.roomId, req.user!.id)) return res.status(404).json({ error: "It's been too long to bring it back." });
      clearTimeout(deleted.timer);
      deletedSnaps.delete(req.params.id);
      const { version: _version, caption, ...row } = deleted.snap;
      db.addSnap(row);
      if (caption) db.setSnapCaption(row.id, caption);
      live(row.roomId)?.snapsChanged();
      res.json({ ok: true });
    }),
  );
}
