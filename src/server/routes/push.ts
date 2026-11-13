// Notifications on the iPhone app (push.ts): the app says which phone to reach, and each person
// picks which chat messages in a space reach them.
import type { Express } from "express";
import type { ApnsEnv, ChatNotify, NotifyStatus } from "../../shared/push.ts";
import type { Services } from "../services.ts";
import { memberRoom, route } from "./http.ts";

/** An APNs device token: 32 bytes or more, as hex. */
const TOKEN = /^[0-9a-f]{64,200}$/;

export function pushRoutes(app: Express, ctx: Services) {
  const { db, push } = ctx;

  // {token, env}: the app on this phone takes notifications for whoever is signed in. Sent on every
  // launch, since Apple can change a phone's token.
  app.post(
    "/api/push/devices",
    route((req, res) => {
      const token = String(req.body?.token ?? "").toLowerCase();
      const env: ApnsEnv = req.body?.env === "sandbox" ? "sandbox" : "production";
      if (!TOKEN.test(token)) return res.status(400).json({ error: "That isn't a phone's push token." });
      db.savePushDevice({ token, userId: req.user!.id, env });
      res.json({ ok: true, sending: push.enabled });
    }),
  );

  // {token}: signing out of the app, or turning its notifications off.
  app.delete(
    "/api/push/devices",
    route((req, res) => {
      db.removePushDevice(String(req.body?.token ?? "").toLowerCase(), req.user!.id);
      res.json({ ok: true });
    }),
  );

  // One notification to each of your phones, to see that it works.
  app.post(
    "/api/push/test",
    route(async (req, res) => {
      if (!push.enabled) return res.status(503).json({ error: "Notifications aren't set up on this server yet." });
      res.json({ sent: await push.test(req.user!.id) });
    }),
  );

  app.get(
    "/api/rooms/:id/notify",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const out: NotifyStatus = { devices: db.pushDevices(req.user!.id).length, level: db.chatNotify(room.id, req.user!.id) };
      res.json(out);
    }),
  );

  // {level: "all" | "mentions"}
  app.put(
    "/api/rooms/:id/notify",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const level: ChatNotify = req.body?.level === "mentions" ? "mentions" : "all";
      db.setChatNotify(room.id, req.user!.id, level);
      const out: NotifyStatus = { devices: db.pushDevices(req.user!.id).length, level };
      res.json(out);
    }),
  );
}
