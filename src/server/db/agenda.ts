// A space's agenda items.
import type { DatabaseSync } from "node:sqlite";
import type { Item } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import { type NewItem, type Row, toItem } from "./rows.ts";

export function agendaStore(db: DatabaseSync) {
  return {
    listItems(roomId: string): Item[] {
      return (db.prepare("SELECT * FROM items WHERE room_id = ? AND archived = 0 ORDER BY position").all(roomId) as Row[]).map(toItem);
    },
    getItem(id: string): Item | null {
      const r = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
      return r ? toItem(r) : null;
    },
    /** Adds items to the end of the room's list. Linear issues already in the
     *  room are un-archived and refreshed rather than duplicated, so their
     *  history carries over. */
    addItems(roomId: string, items: NewItem[]): Item[] {
      const maxPos = (
        db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE room_id = ? AND archived = 0").get(roomId) as Row
      ).p as number;
      let pos = maxPos + 1;
      const findExisting = db.prepare("SELECT * FROM items WHERE room_id = ? AND source = ? AND external_id = ?");
      const revive = db.prepare("UPDATE items SET archived = 0, title = ?, url = ?, description = ?, position = ? WHERE id = ?");
      const insert = db.prepare(
        "INSERT INTO items (id, room_id, source, external_id, title, url, description, position, deck_id, slide_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const it of items) {
        const existing = it.externalId ? (findExisting.get(roomId, it.source, it.externalId) as Row | undefined) : undefined;
        if (existing) {
          const keepPos = existing.archived ? pos++ : (existing.position as number);
          revive.run(it.title, it.url, it.description, keepPos, existing.id as string);
        } else {
          insert.run(
            newId(),
            roomId,
            it.source,
            it.externalId,
            it.title,
            it.url,
            it.description,
            pos++,
            it.deckId ?? null,
            it.slideNo ?? null,
            Date.now(),
          );
        }
      }
      return this.listItems(roomId);
    },
    reorderItems(roomId: string, ids: string[]) {
      const st = db.prepare("UPDATE items SET position = ? WHERE id = ? AND room_id = ?");
      ids.forEach((id, i) => st.run(i, id, roomId));
    },
    /** Hides an item from the list; its history stays reachable. */
    archiveItem(id: string) {
      db.prepare("UPDATE items SET archived = 1 WHERE id = ?").run(id);
      // Its slides stay on the agenda, now on their own.
      db.prepare("UPDATE decks SET parent_item_id = NULL WHERE parent_item_id = ?").run(id);
    },
    /** The agenda item a presented to-do is talked through on, at the end of the list. One per to-do:
     *  presenting it again brings the same item back, so its history carries over. */
    taskItem(roomId: string, noteId: string, title: string, description: string | null): Item {
      const existing = db.prepare("SELECT * FROM items WHERE room_id = ? AND note_id = ?").get(roomId, noteId) as Row | undefined;
      const end = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE room_id = ? AND archived = 0").get(roomId) as Row).p as number;
      const id = (existing?.id as string) ?? newId();
      if (existing) {
        db.prepare("UPDATE items SET archived = 0, title = ?, description = ?, position = ? WHERE id = ?")
          .run(title, description, existing.archived ? end + 1 : (existing.position as number), id);
      } else {
        db.prepare("INSERT INTO items (id, room_id, source, title, description, position, note_id, created_at) VALUES (?, ?, 'agenda', ?, ?, ?, ?, ?)")
          .run(id, roomId, title, description, end + 1, noteId, Date.now());
      }
      return this.getItem(id)!;
    },
    /** The meeting is over: the to-dos presented in it leave the agenda, with what was said on them kept. */
    archiveTaskItems(roomId: string) {
      db.prepare("UPDATE items SET archived = 1 WHERE room_id = ? AND note_id IS NOT NULL").run(roomId);
    },
    /** Undoes archiveItem / archiveDeck for these items, in their old places. */
    unarchiveItems(roomId: string, ids: string[]): number {
      if (!ids.length) return 0;
      return db
        .prepare(`UPDATE items SET archived = 0 WHERE room_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
        .run(roomId, ...ids).changes as number;
    },
    /** Puts a task that came off the agenda back at the end of it. */
    restoreItem(roomId: string, itemId: string): boolean {
      const max = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE room_id = ? AND archived = 0").get(roomId) as Row)
        .p as number;
      return (
        db.prepare("UPDATE items SET archived = 0, position = ? WHERE id = ? AND room_id = ?").run(max + 1, itemId, roomId).changes > 0
      );
    },
  };
}
