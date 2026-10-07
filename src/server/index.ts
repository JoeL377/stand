import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import type { DeckDraft, DeckHistory, DeckTheme, ItemHistory, MeetingRecap, SlideLayout } from "../shared/protocol.ts";
import { authRoutes, requireUser, userFromRequest } from "./auth.ts";
import { capabilities, config } from "./config.ts";
import { openDb } from "./db.ts";
import { briefToMarkdown, buildBrief, buildFollowUps, followUpsToMarkdown } from "./brief.ts";
import {
  MAX_DECK_BYTES,
  MAX_IMAGE_BYTES,
  deckFile,
  deckImageFile,
  deckTitle,
  imageType,
  looksLikePdf,
  parseDeck,
  saveDeckFile,
  saveDeckImage,
} from "./decks.ts";
import { newId } from "./ids.ts";
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
    capabilities().transcription !== "browser" ? (r) => startLiveKitTranscriber(roomId, r) : undefined,
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

// For the host's health check: up and able to read the database.
app.get("/api/health", (_req, res) => {
  db.getRoom("health");
  res.json({ ok: true });
});

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
      decks: db.listDecks(room.id),
      meetings: db.listMeetings(room.id),
      followUps: db.roomFollowUps(room.id).filter((f) => !f.doneAt),
      liveMeetingId: live && !live.ended ? live.meetingId : null,
      // Who is in the call now, for the lobby's avatars.
      people: live && !live.ended ? live.state().participants.map(({ name, picture }) => ({ name, picture })) : [],
    });
  }),
);

/** An agenda item in this room that decks can sit under (not a slide itself). */
const parentFor = (roomId: string, id: unknown): string | null => {
  const item = id ? db.getItem(String(id)) : null;
  return item && item.roomId === roomId && !item.deckId && db.listItems(roomId).some((i) => i.id === item.id) ? item.id : null;
};

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

// A deck is uploaded as the raw PDF body; its name comes in ?name=.
app.post(
  "/api/rooms/:id/decks",
  express.raw({ type: () => true, limit: MAX_DECK_BYTES }),
  route(async (req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    const pdf = new Uint8Array(req.body as Buffer);
    if (!looksLikePdf(pdf)) return res.status(400).json({ error: "That isn't a PDF. Export the deck as PDF and try again." });
    let slides;
    try {
      slides = await parseDeck(pdf);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message || "Couldn't read that PDF." });
    }
    if (!slides.length) return res.status(400).json({ error: "That PDF has no pages." });
    const deck = db.createDeck(room.id, deckTitle(req.query.name as string | undefined, "Slides"), slides.length);
    saveDeckFile(deck.id, pdf);
    db.addItems(
      room.id,
      slides.map((s, i) => ({
        source: "slide",
        externalId: null,
        title: s.title,
        url: null,
        description: s.text || null,
        deckId: deck.id,
        slideNo: i + 1,
      })),
    );
    const parent = parentFor(room.id, req.query.parent);
    if (parent) db.setDeckParent(deck.id, parent);
    res.json({ deck: db.getDeck(deck.id), items: afterItemsChange(room.id) });
  }),
);

const THEMES: DeckTheme[] = ["paper", "night", "ocean", "sunset"];
const LAYOUTS: SlideLayout[] = ["title", "bullets", "section", "image", "quote"];
const text = (v: unknown, max: number) => String(v ?? "").slice(0, max);

/** Checks and trims a deck sent by the editor. */
function readDraft(body: unknown): DeckDraft | null {
  const b = body as Partial<DeckDraft> | undefined;
  if (!b || !Array.isArray(b.slides) || !b.slides.length) return null;
  const seen = new Set<string>();
  return {
    title: text(b.title, 100).trim() || "Untitled deck",
    theme: THEMES.includes(b.theme as DeckTheme) ? (b.theme as DeckTheme) : "paper",
    slides: b.slides.slice(0, 200).map((sl) => {
      let id = String(sl?.id ?? "");
      if (!/^[a-z0-9]{6,24}$/.test(id) || seen.has(id)) id = newId();
      seen.add(id);
      const image = String(sl?.image ?? "");
      const layout = LAYOUTS.includes(sl?.layout as SlideLayout) ? (sl.layout as SlideLayout) : "bullets";
      const body = text(sl?.body, 2000);
      // Every slide needs a name in the agenda; an unattributed quote goes by its words.
      const firstLine = body.trim().split("\n")[0].slice(0, 60);
      const fallback = layout === "quote" && firstLine ? `“${firstLine}”` : firstLine || "Untitled slide";
      return {
        id,
        title: text(sl?.title, 140).trim() || fallback,
        layout,
        body,
        image: /^[a-z0-9]+\.(png|jpg|gif|webp)$/.test(image) ? image : null,
        notes: text(sl?.notes, 4000),
      };
    }),
  };
}

// A deck made in Stand: starts as one title slide and is edited at /decks/:id/edit.
app.post(
  "/api/rooms/:id/decks/new",
  route(async (req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    const brief = text(req.body?.brief, 20000).trim();
    const title = text(req.body?.title, 100).trim() || "Untitled deck";
    const drafted = brief ? await agent.draftDeck(brief).catch(() => []) : [];
    const deck = db.createDeck(room.id, title, 1, "native");
    const slides = drafted.length ? drafted : [{ title, layout: "title" as const, body: "", image: null, notes: "" }];
    const saved = db.saveDeck(deck, { title, theme: "paper", slides: slides.map((sl) => ({ ...sl, id: newId() })) });
    const parent = parentFor(room.id, req.body?.parentItemId);
    if (parent) db.setDeckParent(deck.id, parent);
    afterItemsChange(room.id);
    res.json({ ...saved, deck: db.getDeck(deck.id) });
  }),
);

app.get(
  "/api/decks/:deckId",
  route((req, res) => {
    const deck = db.getDeck(req.params.deckId);
    if (!deck) return notFound(res);
    res.json({ deck, room: db.getRoom(deck.roomId), slides: db.liveSlides(deck.id) });
  }),
);

app.put(
  "/api/decks/:deckId",
  route((req, res) => {
    const deck = db.getDeck(req.params.deckId);
    if (!deck || deck.kind !== "native") return notFound(res);
    const draft = readDraft(req.body);
    if (!draft) return res.status(400).json({ error: "A deck needs at least one slide." });
    const saved = db.saveDeck(deck, draft);
    afterItemsChange(deck.roomId);
    res.json(saved);
  }),
);

// Slides from an outline or a brief, for the editor to insert; nothing is saved.
app.post(
  "/api/decks/:deckId/draft",
  route(async (req, res) => {
    if (!db.getDeck(req.params.deckId)) return notFound(res);
    const brief = text(req.body?.brief, 20000).trim();
    if (!brief) return res.status(400).json({ error: "Write or paste something to make slides from." });
    res.json({ slides: await agent.draftDeck(brief) });
  }),
);

app.post(
  "/api/decks/:deckId/images",
  express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  route((req, res) => {
    const deck = db.getDeck(req.params.deckId);
    if (!deck || deck.kind !== "native") return notFound(res);
    const buf = req.body as Buffer;
    const ext = Buffer.isBuffer(buf) ? imageType(buf) : null;
    if (!ext) return res.status(400).json({ error: "Use a PNG, JPEG, GIF or WebP image." });
    res.json({ image: saveDeckImage(deck.id, newId(), ext, buf) });
  }),
);

app.get(
  "/api/decks/:deckId/images/:image",
  route((req, res) => {
    const file = deckImageFile(req.params.deckId, req.params.image);
    if (!file) return notFound(res);
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    res.sendFile(file);
  }),
);

// Moves a deck under an agenda item, or back on its own with parentItemId: null.
app.patch(
  "/api/decks/:deckId",
  route((req, res) => {
    const deck = db.getDeck(req.params.deckId);
    if (!deck) return notFound(res);
    const want = req.body?.parentItemId;
    const parent = want == null ? null : parentFor(deck.roomId, want);
    if (want != null && !parent) return res.status(400).json({ error: "That agenda item isn't in this room." });
    db.setDeckParent(deck.id, parent);
    res.json(afterItemsChange(deck.roomId));
  }),
);

app.delete(
  "/api/rooms/:id/decks/:deckId",
  route((req, res) => {
    const deck = db.getDeck(req.params.deckId);
    if (!deck || deck.roomId !== req.params.id) return notFound(res);
    db.archiveDeck(deck.id);
    res.json(afterItemsChange(deck.roomId));
  }),
);

app.get(
  "/api/decks/:deckId/file",
  route((req, res) => {
    const file = db.getDeck(req.params.deckId) && deckFile(req.params.deckId);
    if (!file) return notFound(res);
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    res.type("application/pdf").sendFile(file);
  }),
);

app.get(
  "/api/decks/:deckId/history",
  route((req, res) => {
    const deck = db.getDeck(req.params.deckId);
    if (!deck) return notFound(res);
    const { segments, notes } = db.deckActivity(deck.id);
    const discussions = db.deckDiscussions(deck.id);
    const body: DeckHistory = {
      deck,
      room: db.getRoom(deck.roomId),
      slides: db.deckSlides(deck.id).map((item) => ({
        item,
        segments: segments.filter((s) => s.itemId === item.id),
        notes: notes.filter((n) => n.itemId === item.id),
        discussions: discussions.filter((d) => d.itemId === item.id),
      })),
    };
    res.json(body);
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
    const body: ItemHistory = { item, deck: item.deckId ? db.getDeck(item.deckId) : null, meetings: db.itemHistory(item.id) };
    res.json({ ...body, room: db.getRoom(item.roomId) });
  }),
);

/** A meeting's segments and notes grouped by agenda item, in agenda order. */
function meetingGroups(m: { id: string; roomId: string }) {
  const segments = db.meetingSegments(m.id);
  const notes = db.meetingNotes(m.id);
  const discussions = db.meetingDiscussions(m.id);
  const ids = [...new Set([...segments.map((s) => s.itemId), ...notes.map((n) => n.itemId)])];
  const items = db.listItems(m.roomId);
  ids.sort((a, b) => (items.find((i) => i.id === a)?.position ?? 1e9) - (items.find((i) => i.id === b)?.position ?? 1e9));
  return ids.map((id) => ({
    item: id ? db.getItem(id) : null,
    segments: segments.filter((s) => s.itemId === id),
    notes: notes.filter((n) => n.itemId === id),
    discussions: discussions.filter((d) => d.itemId === id),
  }));
}

app.get(
  "/api/meetings/:id",
  route((req, res) => {
    const m = db.getMeeting(req.params.id);
    if (!m) return notFound(res);
    const room = db.getRoom(m.roomId)!;
    const body: MeetingRecap = {
      meetingId: m.id,
      roomId: m.roomId,
      roomName: room.name,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      summary: m.summary,
      items: meetingGroups(m),
    };
    res.json(body);
  }),
);

// The meeting brief for follow-up: /brief.json for agents and tools,
// /brief.md for pasting. Add ?transcript=1 to include what was said.
app.get(
  "/api/meetings/:id/brief.:format",
  route((req, res) => {
    const m = db.getMeeting(req.params.id);
    if (!m || !["json", "md"].includes(req.params.format)) return notFound(res);
    const brief = buildBrief({
      meeting: m,
      roomName: db.getRoom(m.roomId)!.name,
      groups: meetingGroups(m),
      decks: db.listDecks(m.roomId),
      baseUrl: `${req.protocol}://${req.get("host")}`,
      followUps: db.roomFollowUps(m.roomId),
      itemById: (id) => db.getItem(id),
      discussionById: (id) => db.getDiscussion(id),
      withTranscript: req.query.transcript === "1",
    });
    if (req.params.format === "json") return void res.json(brief);
    res.type("text/markdown; charset=utf-8").send(briefToMarkdown(brief));
  }),
);

// The room's follow-ups across meetings: the standing to-do list for people
// and agents. ?status=open (default), done or all; .json or .md.
app.get(
  "/api/rooms/:id/followups.:format",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room || !["json", "md"].includes(req.params.format)) return notFound(res);
    const status = (["open", "done", "all"] as const).find((s) => s === req.query.status) ?? "open";
    const feed = buildFollowUps({
      room,
      followUps: db.roomFollowUps(room.id),
      itemById: (id) => db.getItem(id),
      decks: db.listDecks(room.id),
      baseUrl: `${req.protocol}://${req.get("host")}`,
      status,
      discussionById: (id) => db.getDiscussion(id),
    });
    if (req.params.format === "json") return void res.json(feed);
    res.type("text/markdown; charset=utf-8").send(followUpsToMarkdown(feed));
  }),
);

// Check an action item off ({ done: true }) or reopen it.
app.patch(
  "/api/rooms/:id/followups/:noteId",
  route((req, res) => {
    const note = db.setActionDone(req.params.id, req.params.noteId, req.body?.done ? req.user!.name : null);
    if (!note) return notFound(res);
    sessions.get(req.params.id)?.followUpsChanged();
    res.json(note);
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
