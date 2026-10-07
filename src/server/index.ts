import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import type { ItemHistory, MeetingRecap } from "../shared/protocol.ts";
import { authRoutes, requireUser, userFromRequest } from "./auth.ts";
import { capabilities, config } from "./config.ts";
import { openDb } from "./db.ts";
import { importFromLinear, sampleSprint } from "./linear.ts";
import { participantToken, startLiveKitTranscriber } from "./livekit.ts";
import { createAgent } from "./llm.ts";
import { RoomSession } from "./room.ts";

const db = openDb(path.join(config.dataDir, "standup.db"));
const agent = createAgent();
const sessions = new Map<string, RoomSession>();

function session(roomId: string): RoomSession | null {
  const existing = sessions.get(roomId);
  if (existing && !existing.ended) return existing;
  const room = db.getRoom(roomId);
  if (!room) return null;
  const s = new RoomSession(
    db,
    agent,
    room,
    (closed) => {
      if (sessions.get(roomId) === closed) sessions.delete(roomId);
    },
    capabilities().transcription === "deepgram" ? (r) => startLiveKitTranscriber(roomId, r) : undefined,
  );
  sessions.set(roomId, s);
  return s;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

type Params = Record<string, string>;
type Handler = (req: Request<Params>, res: Response) => unknown;
const route = (fn: Handler) => (req: Request<Params>, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

const notFound = (res: Response, what = "Not found") => res.status(404).json({ error: what });

app.get("/api/config", (_req, res) => {
  res.json(capabilities());
});
app.use("/api/auth", authRoutes(db));
// Everything else needs a signed-in user.
app.use("/api", requireUser(db));

app.get(
  "/api/my/rooms",
  route((req, res) => {
    res.json(db.userRooms(req.user!.id));
  }),
);

app.post(
  "/api/rooms",
  route((req, res) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 80) || "Standup";
    const room = db.createRoom(name, req.user!.id);
    db.touchMembership(room.id, req.user!.id);
    res.json(room);
  }),
);

app.get(
  "/api/rooms/:id",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res, "Room not found");
    const live = sessions.get(room.id);
    res.json({
      ...room,
      items: db.listItems(room.id),
      meetings: db.listMeetings(room.id),
      liveMeetingId: live && !live.ended ? live.meetingId : null,
    });
  }),
);

const afterItemsChange = (roomId: string) => {
  sessions.get(roomId)?.itemsChanged();
  return db.listItems(roomId);
};

app.post(
  "/api/rooms/:id/items",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    const lines: string[] = (Array.isArray(req.body?.titles) ? req.body.titles : [])
      .map((t: unknown) => String(t).trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 100);
    db.addItems(
      room.id,
      lines.map((title) => ({ source: "agenda", externalId: null, title, url: null, description: null })),
    );
    res.json(afterItemsChange(room.id));
  }),
);

app.post(
  "/api/rooms/:id/items/linear",
  route(async (req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    try {
      const items = await importFromLinear(String(req.body?.input ?? ""));
      if (!items.length) return res.status(400).json({ error: "No open issues found there." });
      db.addItems(room.id, items);
      res.json(afterItemsChange(room.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }),
);

app.post(
  "/api/rooms/:id/items/sample",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    db.addItems(room.id, sampleSprint());
    res.json(afterItemsChange(room.id));
  }),
);

app.post(
  "/api/rooms/:id/items/reorder",
  route((req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    db.reorderItems(req.params.id, ids);
    res.json(afterItemsChange(req.params.id));
  }),
);

app.patch(
  "/api/rooms/:id/items/:itemId",
  route((req, res) => {
    const item = db.getItem(req.params.itemId);
    if (!item || item.roomId !== req.params.id) return notFound(res);
    const title = String(req.body?.title ?? "").trim().slice(0, 300);
    if (title) db.updateItem(item.id, { title });
    res.json(afterItemsChange(item.roomId));
  }),
);

app.delete(
  "/api/rooms/:id/items/:itemId",
  route((req, res) => {
    const item = db.getItem(req.params.itemId);
    if (!item || item.roomId !== req.params.id) return notFound(res);
    db.archiveItem(item.id);
    res.json(afterItemsChange(item.roomId));
  }),
);

app.get(
  "/api/items/:itemId/history",
  route((req, res) => {
    const item = db.getItem(req.params.itemId);
    if (!item) return notFound(res);
    const body: ItemHistory = { item, meetings: db.itemHistory(item.id) };
    res.json({ ...body, room: db.getRoom(item.roomId) });
  }),
);

app.get(
  "/api/meetings/:id",
  route((req, res) => {
    const m = db.getMeeting(req.params.id);
    if (!m) return notFound(res);
    const room = db.getRoom(m.roomId)!;
    const segments = db.meetingSegments(m.id);
    const notes = db.meetingNotes(m.id);
    const ids = [...new Set([...segments.map((s) => s.itemId), ...notes.map((n) => n.itemId)])];
    const items = db.listItems(m.roomId);
    ids.sort((a, b) => (items.find((i) => i.id === a)?.position ?? 1e9) - (items.find((i) => i.id === b)?.position ?? 1e9));
    const body: MeetingRecap = {
      meetingId: m.id,
      roomId: m.roomId,
      roomName: room.name,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      summary: m.summary,
      items: ids.map((id) => ({
        item: id ? db.getItem(id) : null,
        segments: segments.filter((s) => s.itemId === id),
        notes: notes.filter((n) => n.itemId === id),
      })),
    };
    res.json(body);
  }),
);

app.post(
  "/api/rooms/:id/token",
  route(async (req, res) => {
    if (!capabilities().livekit) return res.json({ url: null, token: null });
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    const user = req.user!;
    res.json({ url: config.livekit.url, token: await participantToken(room.id, user.id, user.name) });
  }),
);

// Serve the built web app in production.
const dist = path.resolve("dist");
if (config.production && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = req.url?.match(/^\/ws\/rooms\/([a-z0-9]+)$/);
  const user = userFromRequest(db, req);
  const s = m && user ? session(m[1]) : null;
  if (!s || !user) {
    socket.write(user ? "HTTP/1.1 404 Not Found\r\n\r\n" : "HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  db.touchMembership(s.roomId, user.id);
  wss.handleUpgrade(req, socket, head, (ws) => s.attach(ws, user));
});

server.listen(config.port, () => {
  const c = capabilities();
  console.log(`standup server on http://localhost:${config.port}`);
  console.log(
    `  audio: ${c.livekit ? "LiveKit" : "off (mock mode)"} · transcription: ${c.transcription} · notes: ${c.llm ? config.anthropicModel : "heuristic"} · Linear: ${c.linear ? "on" : "off"}`,
  );
});
