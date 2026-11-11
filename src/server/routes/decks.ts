// Decks: uploaded PDFs and decks made in Stand's editor.
import express, { type Express } from "express";
import type { DeckDraft, DeckHistory, DeckTheme, SlideLayout } from "../../shared/protocol.ts";
import { deckFile, deckImageFile, deckTitle, imageType, looksLikePdf, MAX_DECK_BYTES, MAX_IMAGE_BYTES, parseDeck, saveDeckFile, saveDeckImage } from "../decks.ts";
import { newId } from "../ids.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function deckRoutes(app: Express, ctx: Services) {
  const { db, agent, afterItemsChange, parentFor } = ctx;
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
      if (deck.reviewId) return res.status(400).json({ error: "A product review's slides come from the work they show, so they aren't edited here." });
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
}
