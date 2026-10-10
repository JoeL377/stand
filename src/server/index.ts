import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import type { DeckDraft, DeckHistory, DeckTheme, ItemHistory, MeetingRecap, SlideLayout } from "../shared/protocol.ts";
import { MAX_SYNTHESIS_INSTRUCTIONS } from "../shared/protocol.ts";
import { agentApi, AgentError, parseRef } from "./agents.ts";
import { agentFromRequest, authRoutes, origin, requireUser, userFromRequest } from "./auth.ts";
import { handleMcp } from "./mcp.ts";
import { oauthRoutes } from "./oauth.ts";
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
import { MAX_SNAP_BYTES, linkSnaps, removeSnapFile, saveSnapFile, snapFile } from "./snaps.ts";
import { toSpaceSummary } from "./spaces.ts";
import { UpNextPolisher, upNextView } from "./upNextPolish.ts";

const db = openDb(path.join(config.dataDir, "standup.db"));
const agent = createAgent();
const sessions = new Map<string, RoomSession>();
const live = (roomId: string) => {
  const s = sessions.get(roomId);
  return s && !s.ended ? s : null;
};
const polisher = new UpNextPolisher(
  db,
  agent,
  (roomId) => live(roomId)?.meetingStartedAt ?? null,
  (roomId) => live(roomId)?.upNextChanged(),
);

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
    polisher,
  );
  sessions.set(roomId, s);
  return s;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

type Params = Record<string, string>;
type Handler = (req: Request<Params>, res: Response) => unknown;
const route = (fn: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

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
// Sign-in for agents that connect with just the /mcp URL (Claude custom connectors).
app.use(oauthRoutes(db));

// ---- agents: the Stand MCP and the Copy for agent button ---------------------

const agents = agentApi({
  db,
  notify: (roomId, what) => {
    const s = live(roomId);
    if (s) what === "updates" ? s.updatesChanged() : s.followUpsChanged();
    // Between meetings, let reports settle, then tidy the next agenda.
    else polisher.schedule(roomId, 60_000);
  },
  suggested: (roomId) => upNextView(db, roomId, live(roomId)?.meetingStartedAt ?? null, polisher.busy(roomId)),
  brief: (meetingId, baseUrl, transcript) => {
    const m = db.getMeeting(meetingId)!;
    return buildBrief({
      meeting: m,
      roomName: db.getRoom(m.roomId)!.name,
      synthesisInstructions: db.getRoom(m.roomId)!.synthesisInstructions,
      groups: meetingGroups(m, baseUrl),
      decks: db.listDecks(m.roomId),
      baseUrl,
      followUps: db.roomFollowUps(m.roomId),
      itemById: (id) => db.getItem(id),
      discussionById: (id) => db.getDiscussion(id),
      withTranscript: transcript,
    });
  },
});

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

// Everything else needs a signed-in user.
app.use("/api", requireUser(db));

// ---- snaps: stills of the shared screen ------------------------------------

/** Who can crop or delete a snap: whoever took it, whoever's screen it is, and the host. */
const canChangeSnap = (userId: string, snap: { roomId: string; takenById: string | null; sharerId: string | null }) =>
  snap.takenById === userId || snap.sharerId === userId || Boolean(live(snap.roomId)?.hosts(userId));

// Taken in the meeting: the image is the raw body, at the size it was shared.
// ?pasted=1 for a screenshot someone pasted or dropped in, which is nobody's shared screen.
app.post(
  "/api/rooms/:id/snaps",
  express.raw({ type: () => true, limit: MAX_SNAP_BYTES }),
  route((req, res) => {
    const s = live(req.params.id);
    if (!s || !s.has(req.user!.id)) return res.status(409).json({ error: "Snaps are taken in a live meeting." });
    const buf = req.body as Buffer;
    const ext = Buffer.isBuffer(buf) ? imageType(buf) : null;
    if (!ext || ext === "gif") return res.status(400).json({ error: "Send a PNG, JPEG or WebP image." });
    const size = (v: unknown) => Math.max(0, Math.min(20000, Math.round(Number(v) || 0)));
    const id = s.addSnap({
      buf,
      ext,
      width: size(req.query.w),
      height: size(req.query.h),
      at: Number(req.query.at) || Date.now(),
      takenById: req.user!.id,
      takenBy: req.user!.name,
      pasted: req.query.pasted === "1",
    });
    res.json({ id });
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

app.delete(
  "/api/snaps/:id",
  route((req, res) => {
    const snap = db.getSnap(req.params.id);
    if (!snap || !db.isMember(snap.roomId, req.user!.id)) return notFound(res);
    if (!canChangeSnap(req.user!.id, snap))
      return res.status(403).json({ error: "Only whoever took it, the sharer or the host can delete it." });
    db.deleteSnap(snap.id);
    removeSnapFile(snap.id, snap.ext);
    live(snap.roomId)?.snapsChanged();
    res.json({ ok: true });
  }),
);

app.get(
  "/api/tokens",
  route((req, res) => {
    res.json(db.listTokens(req.user!.id));
  }),
);

/** A new agent token. The secret is in this response only. */
app.post(
  "/api/tokens",
  route((req, res) => {
    const label =
      String(req.body?.label ?? "")
        .trim()
        .slice(0, 60) || "My agent";
    const scope = req.body?.scope === "read" ? "read" : "write";
    if (db.listTokens(req.user!.id).length >= 20)
      return void res.status(400).json({ error: "You have 20 agent tokens. Revoke one first." });
    res.json(db.createToken(req.user!.id, label, scope));
  }),
);

app.delete(
  "/api/tokens/:id",
  route((req, res) => {
    if (!db.revokeToken(req.user!.id, req.params.id)) return notFound(res);
    res.json({ ok: true });
  }),
);

const asWebCaller = (req: Request) => ({ user: req.user!, token: null });
const agentErrors = (res: Response, err: unknown) => {
  if (err instanceof AgentError) return void res.status(404).json({ error: err.message });
  throw err;
};

/** Where a stand:kind/id reference lives, for /ref/... links. */
app.get(
  "/api/refs/:kind/:id",
  route((req, res) => {
    if (!parseRef(`${req.params.kind}/${req.params.id}`)) return notFound(res);
    try {
      res.json(agents.locate(asWebCaller(req), req.params.kind, req.params.id));
    } catch (err) {
      agentErrors(res, err);
    }
  }),
);

/** The short prompt the Copy for agent button puts on the clipboard. */
app.get(
  "/api/refs/:kind/:id/prompt",
  route((req, res) => {
    try {
      res.json({ text: agents.prompt(asWebCaller(req), `stand:${req.params.kind}/${req.params.id}`, origin(req)) });
    } catch (err) {
      agentErrors(res, err);
    }
  }),
);

app.get(
  "/api/my/rooms",
  route((req, res) => {
    res.json(db.userRooms(req.user!.id));
  }),
);

// The spaces you're in. Spaces are invite only: opening one from its link
// adds you, and only then does it show on your home page.
app.get(
  "/api/spaces",
  route((req, res) => {
    const user = req.user!;
    const spaces = db.spaceRows(user.id).map((row) => {
      const live = sessions.get(row.id);
      const state = live && !live.ended ? live.state() : null;
      const on = state && state.participants.length > 0;
      return toSpaceSummary(
        row,
        user,
        on
          ? {
              people: state.participants.map(({ name, picture }) => ({ name, picture })),
              focusTitle: state.items.find((i) => i.id === state.focusItemId)?.title ?? null,
              since: state.meetingStartedAt,
            }
          : null,
      );
    });
    res.json(spaces.sort((a, b) => b.activeAt - a.activeAt));
  }),
);

/** Rename a space or change its purpose: only whoever created it (or anyone, for
 *  older spaces with no creator). Anyone in the space can change its synthesis instructions. */
app.patch(
  "/api/rooms/:id",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res, "Space not found");
    const name = req.body?.name === undefined ? undefined : String(req.body.name).trim().slice(0, 80);
    const purpose = req.body?.purpose === undefined ? undefined : String(req.body.purpose).trim().slice(0, 200);
    const synthesisInstructions =
      req.body?.synthesisInstructions === undefined ? undefined : String(req.body.synthesisInstructions).trim().slice(0, MAX_SYNTHESIS_INSTRUCTIONS);
    const creatorOnly = name !== undefined || purpose !== undefined;
    if (creatorOnly && room.createdBy && room.createdBy !== req.user!.id)
      return void res.status(403).json({ error: "Only the person who created this space can change it" });
    if (!creatorOnly && !db.isMember(room.id, req.user!.id)) return notFound(res, "Space not found");
    if (name === "") return void res.status(400).json({ error: "A space needs a name" });
    db.updateRoom(room.id, { name, purpose, synthesisInstructions });
    if (name) sessions.get(room.id)?.renamed(name);
    res.json(db.getRoom(room.id));
  }),
);

app.post(
  "/api/rooms",
  route((req, res) => {
    const name =
      String(req.body?.name ?? "")
        .trim()
        .slice(0, 80) || "New space";
    const purpose = String(req.body?.purpose ?? "")
      .trim()
      .slice(0, 200);
    const room = db.createRoom(name, req.user!.id, purpose);
    db.touchMembership(room.id, req.user!.id);
    res.json(room);
  }),
);

app.get(
  "/api/rooms/:id",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res, "Space not found");
    db.touchMembership(room.id, req.user!.id);
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
    const title = String(req.body?.title ?? "")
      .trim()
      .slice(0, 300);
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
function meetingGroups(m: { id: string; roomId: string }, baseUrl = "") {
  const segments = db.meetingSegments(m.id);
  const notes = db.meetingNotes(m.id);
  const discussions = db.meetingDiscussions(m.id);
  const snaps = linkSnaps(db.meetingSnaps(m.id), segments, discussions, baseUrl);
  const ids = [...new Set([...segments.map((s) => s.itemId), ...notes.map((n) => n.itemId), ...snaps.map((s) => s.itemId)])];
  const items = db.listItems(m.roomId);
  ids.sort((a, b) => (items.find((i) => i.id === a)?.position ?? 1e9) - (items.find((i) => i.id === b)?.position ?? 1e9));
  return ids.map((id) => ({
    item: id ? db.getItem(id) : null,
    segments: segments.filter((s) => s.itemId === id),
    notes: notes.filter((n) => n.itemId === id),
    discussions: discussions.filter((d) => d.itemId === id),
    snaps: snaps.filter((s) => s.itemId === id),
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
      synthesis: m.synthesis,
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
      synthesisInstructions: db.getRoom(m.roomId)!.synthesisInstructions,
      groups: meetingGroups(m, `${req.protocol}://${req.get("host")}`),
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

// The agent's suggested agenda for the space: what's open from earlier
// meetings and what changed since, ranked, each with a reason.
app.get(
  "/api/rooms/:id/suggested.json",
  route((req, res) => {
    const room = db.getRoom(req.params.id);
    if (!room) return notFound(res);
    res.json({
      schema: "stand.suggested-agenda/v1",
      space: { id: room.id, name: room.name },
      ...upNextView(db, room.id, live(room.id)?.meetingStartedAt ?? null, polisher.busy(room.id)),
    });
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
    `  audio: ${c.livekit ? "LiveKit" : "off (mock mode)"} · transcription: ${c.transcription} · notes: ${c.llm ? config.notesModel : "heuristic"} · Linear: ${c.linear ? "on" : "off"}`,
  );
});
