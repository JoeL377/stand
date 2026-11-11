// Decks: their slides on the agenda, and the "Done since last time" deck.
import type { DatabaseSync } from "node:sqlite";
import type { Deck, DeckDraft, DeckTheme, DoneDeck, Item, SlideContent } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import { type Row, toDeck, toItem, toNote, toSegment } from "./rows.ts";
import type { agendaStore } from "./agenda.ts";

export function decksStore(db: DatabaseSync, { agenda }: { agenda: ReturnType<typeof agendaStore> }) {
  return {
    createDeck(roomId: string, title: string, pageCount: number, kind: Deck["kind"] = "pdf", theme: DeckTheme = "paper"): Deck {
      const id = newId(10);
      db.prepare("INSERT INTO decks (id, room_id, title, page_count, created_at, kind, theme) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        roomId,
        title,
        pageCount,
        Date.now(),
        kind,
        theme,
      );
      return { id, roomId, title, pageCount, kind, theme, parentItemId: null };
    },
    /** Puts a deck under an agenda item (or back on its own with null). Its
     *  slides move to sit right after the item and the item's other decks. */
    setDeckParent(deckId: string, parentItemId: string | null) {
      const deck = this.getDeck(deckId);
      if (!deck) return;
      db.prepare("UPDATE decks SET parent_item_id = ? WHERE id = ?").run(parentItemId, deckId);
      if (!parentItemId) return;
      const items = agenda.listItems(deck.roomId);
      const mine = items.filter((it) => it.deckId === deckId).map((it) => it.id);
      const others = items.filter((it) => it.deckId !== deckId);
      let at = others.findIndex((it) => it.id === parentItemId);
      if (at < 0) return;
      const siblings = new Set(
        (db.prepare("SELECT id FROM decks WHERE parent_item_id = ? AND id != ?").all(parentItemId, deckId) as Row[]).map(
          (r) => r.id as string,
        ),
      );
      while (at + 1 < others.length && others[at + 1].deckId && siblings.has(others[at + 1].deckId!)) at++;
      const ids = others.map((it) => it.id);
      agenda.reorderItems(deck.roomId, [...ids.slice(0, at + 1), ...mine, ...ids.slice(at + 1)]);
    },
    /** Slides currently in the deck (removed ones keep their history but drop out). */
    liveSlides(deckId: string): Item[] {
      return (db.prepare("SELECT * FROM items WHERE deck_id = ? AND archived = 0 ORDER BY slide_no").all(deckId) as Row[]).map(toItem);
    },
    /** Saves an edited deck: updates slides by id, adds new ones (keeping the
     *  editor's id so later saves match), archives removed ones, and keeps the
     *  deck together in the agenda where it was. */
    saveDeck(deck: Deck, draft: DeckDraft) {
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE decks SET title = ?, theme = ?, page_count = ? WHERE id = ?").run(
          draft.title,
          draft.theme,
          draft.slides.length,
          deck.id,
        );
        const before = agenda.listItems(deck.roomId);
        const owner = db.prepare("SELECT deck_id FROM items WHERE id = ?");
        const update = db.prepare("UPDATE items SET title = ?, description = ?, slide_json = ?, slide_no = ?, archived = 0 WHERE id = ?");
        const insert = db.prepare(
          "INSERT INTO items (id, room_id, source, external_id, title, url, description, position, deck_id, slide_no, slide_json, created_at) VALUES (?, ?, 'slide', NULL, ?, NULL, ?, 0, ?, ?, ?, ?)",
        );
        const ids: string[] = [];
        draft.slides.forEach((sl, i) => {
          const { id, title, ...content } = sl;
          const description = [content.body, content.notes].filter(Boolean).join("\n\n") || null;
          const json = JSON.stringify(content);
          const row = owner.get(id) as Row | undefined;
          let useId = id;
          if (row && row.deck_id === deck.id) update.run(title, description, json, i + 1, id);
          else {
            if (row) useId = newId();
            insert.run(useId, deck.roomId, title, description, deck.id, i + 1, json, Date.now());
          }
          ids.push(useId);
        });
        const keep = new Set(ids);
        db.prepare(`UPDATE items SET archived = 1 WHERE deck_id = ? AND id NOT IN (${ids.map(() => "?").join(",") || "''"})`).run(
          deck.id,
          ...ids,
        );
        // Re-lay the agenda with the deck as one block where its first slide was.
        const others = before.filter((it) => it.deckId !== deck.id && !keep.has(it.id)).map((it) => it.id);
        const at = before.findIndex((it) => it.deckId === deck.id);
        const anchor = at < 0 ? others.length : before.slice(0, at).filter((it) => it.deckId !== deck.id).length;
        agenda.reorderItems(deck.roomId, [...others.slice(0, anchor), ...ids, ...others.slice(anchor)]);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { deck: this.getDeck(deck.id)!, slides: this.liveSlides(deck.id) };
    },
    getDeck(id: string): Deck | null {
      const r = db.prepare("SELECT * FROM decks WHERE id = ?").get(id) as Row | undefined;
      return r ? toDeck(r) : null;
    },
    /** Decks with at least one slide still on the agenda. */
    listDecks(roomId: string): Deck[] {
      return (
        db
          .prepare(
            "SELECT * FROM decks d WHERE room_id = ? AND EXISTS (SELECT 1 FROM items i WHERE i.deck_id = d.id AND i.archived = 0) ORDER BY created_at",
          )
          .all(roomId) as Row[]
      ).map(toDeck);
    },
    /** Every slide the deck has had: current ones in order, then removed ones. */
    deckSlides(deckId: string): Item[] {
      return (db.prepare("SELECT * FROM items WHERE deck_id = ? ORDER BY archived, slide_no").all(deckId) as Row[]).map(toItem);
    },
    archiveDeck(deckId: string) {
      db.prepare("UPDATE items SET archived = 1 WHERE deck_id = ?").run(deckId);
    },
    /** Everything said and noted on any slide of the deck, across meetings. */
    deckActivity(deckId: string) {
      const segments = (
        db.prepare("SELECT s.* FROM segments s JOIN items i ON i.id = s.item_id WHERE i.deck_id = ? ORDER BY s.ts").all(deckId) as Row[]
      ).map(toSegment);
      const notes = (
        db
          .prepare("SELECT n.* FROM notes n JOIN items i ON i.id = n.item_id WHERE i.deck_id = ? ORDER BY n.ts, n.rowid")
          .all(deckId) as Row[]
      ).map(toNote);
      return { segments, notes };
    },
    /** A deck's slides that are still on the agenda. */
    deckItemIds(deckId: string): string[] {
      return (db.prepare("SELECT id FROM items WHERE deck_id = ? AND archived = 0").all(deckId) as Row[]).map((r) => r.id as string);
    },
    setDeckReview(deckId: string, reviewId: string) {
      db.prepare("UPDATE decks SET review_id = ? WHERE id = ?").run(reviewId, deckId);
    },
    /** A slide's content, rewritten in place (a review slide's outcome). */
    setSlideContent(itemId: string, slide: SlideContent) {
      db.prepare("UPDATE items SET slide_json = ? WHERE id = ?").run(JSON.stringify(slide), itemId);
    },
    getDoneDeck(roomId: string): (DoneDeck & { basis: string }) | null {
      const r = db.prepare("SELECT basis, deck_json FROM space_done WHERE room_id = ?").get(roomId) as Row | undefined;
      return r ? { ...(JSON.parse(r.deck_json as string) as DoneDeck), basis: r.basis as string } : null;
    },
    saveDoneDeck(roomId: string, deck: DoneDeck, basis: string) {
      db.prepare(
        "INSERT INTO space_done (room_id, since, basis, deck_json) VALUES (?, ?, ?, ?) ON CONFLICT (room_id) DO UPDATE SET since = excluded.since, basis = excluded.basis, deck_json = excluded.deck_json",
      ).run(roomId, deck.since, basis, JSON.stringify(deck));
    },
  };
}
