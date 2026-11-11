// Snaps (pictures of the screen) and jots (lines saved from the Mac's bar).
import type { DatabaseSync } from "node:sqlite";
import type { Jot } from "../../shared/protocol.ts";
import type { SnapRow } from "../snaps.ts";
import { type Row, toJot, toSnapRow } from "./rows.ts";

export function capturesStore(db: DatabaseSync) {
  return {
    addSnap(
      s: Omit<SnapRow, "version" | "caption" | "itemSuggested" | "line" | "screenText" | "jotId"> &
        Partial<Pick<SnapRow, "itemSuggested" | "line" | "screenText" | "jotId">>,
    ): void {
      db.prepare(
        `INSERT INTO snaps (id, room_id, meeting_id, item_id, item_suggested, ts, ext, width, height, source, taken_by_id, taken_by,
           sharer_id, sharer_name, note_id, line, screen_text, jot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        s.roomId,
        s.meetingId,
        s.itemId,
        s.itemSuggested ? 1 : 0,
        s.ts,
        s.ext,
        s.width,
        s.height,
        s.source,
        s.takenById,
        s.takenBy,
        s.sharerId,
        s.sharerName,
        s.noteId,
        s.line ?? null,
        s.screenText ?? null,
        s.jotId ?? null,
      );
    },
    getSnap(id: string): SnapRow | null {
      const r = db.prepare("SELECT * FROM snaps WHERE id = ?").get(id) as Row | undefined;
      return r ? toSnapRow(r) : null;
    },
    meetingSnaps(meetingId: string): SnapRow[] {
      return (db.prepare("SELECT * FROM snaps WHERE meeting_id = ? ORDER BY ts").all(meetingId) as Row[]).map(toSnapRow);
    },
    /** An item's snaps, in meetings or saved to the space, newest first. */
    itemSnaps(itemId: string, limit = 20): SnapRow[] {
      return (db.prepare("SELECT * FROM snaps WHERE item_id = ? ORDER BY ts DESC LIMIT ?").all(itemId, limit) as Row[]).map(toSnapRow);
    },
    /** Snaps saved to a space between meetings on their own (not pinned to a note), newest first. */
    spaceSnaps(roomId: string, since = 0, limit = 100): SnapRow[] {
      return (
        db
          .prepare("SELECT * FROM snaps WHERE room_id = ? AND meeting_id IS NULL AND jot_id IS NULL AND ts >= ? ORDER BY ts DESC LIMIT ?")
          .all(roomId, since, limit) as Row[]
      ).map(toSnapRow);
    },
    /** The snaps pinned to a note, oldest first. */
    jotSnaps(jotId: string): SnapRow[] {
      return (db.prepare("SELECT * FROM snaps WHERE jot_id = ? ORDER BY ts").all(jotId) as Row[]).map(toSnapRow);
    },
    /** A person picked the item (or none), or the agent suggested one (suggested). */
    setSnapItem(id: string, itemId: string | null, suggested = false) {
      db.prepare("UPDATE snaps SET item_id = ?, item_suggested = ? WHERE id = ?").run(itemId, suggested ? 1 : 0, id);
    },
    setSnapLine(id: string, line: string | null) {
      db.prepare("UPDATE snaps SET line = ? WHERE id = ?").run(line, id);
    },
    setSnapText(id: string, text: string | null) {
      db.prepare("UPDATE snaps SET screen_text = ? WHERE id = ?").run(text, id);
    },
    /** Where the recap put a snap: under the note it backs, or the topic it was discussed in. */
    placeSnap(id: string, place: { noteId: string | null; discussionId: string | null; caption: string }) {
      db.prepare("UPDATE snaps SET note_id = ?, discussion_id = ?, caption = ? WHERE id = ?").run(
        place.noteId,
        place.discussionId,
        place.caption,
        id,
      );
    },
    setSnapCaption(id: string, caption: string) {
      db.prepare("UPDATE snaps SET caption = ? WHERE id = ?").run(caption, id);
    },
    /** After a crop: the new image replaces the old one. */
    setSnapImage(id: string, ext: string, width: number, height: number) {
      db.prepare("UPDATE snaps SET ext = ?, width = ?, height = ?, version = version + 1 WHERE id = ?").run(ext, width, height, id);
    },
    deleteSnap(id: string) {
      db.prepare("DELETE FROM snaps WHERE id = ?").run(id);
    },
    addJot(j: Omit<Jot, "itemSuggested"> & { itemSuggested?: boolean }): void {
      db.prepare("INSERT INTO jots (id, room_id, item_id, item_suggested, text, by_id, by_name, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        j.id,
        j.roomId,
        j.itemId,
        j.itemSuggested ? 1 : 0,
        j.text,
        j.byId,
        j.by,
        j.ts,
      );
    },
    getJot(id: string): Jot | null {
      const r = db.prepare("SELECT * FROM jots WHERE id = ?").get(id) as Row | undefined;
      return r ? toJot(r) : null;
    },
    /** Notes filed under an item, newest first. */
    itemJots(itemId: string, limit = 20): Jot[] {
      return (db.prepare("SELECT * FROM jots WHERE item_id = ? ORDER BY ts DESC LIMIT ?").all(itemId, limit) as Row[]).map(toJot);
    },
    /** Notes saved to a space, newest first. */
    spaceJots(roomId: string, since = 0, limit = 100): Jot[] {
      return (db.prepare("SELECT * FROM jots WHERE room_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?").all(roomId, since, limit) as Row[]).map(toJot);
    },
    /** A person picked the item (or none), or the agent suggested one (suggested). Its snaps go with it. */
    setJotItem(id: string, itemId: string | null, suggested = false) {
      db.prepare("UPDATE jots SET item_id = ?, item_suggested = ? WHERE id = ?").run(itemId, suggested ? 1 : 0, id);
      db.prepare("UPDATE snaps SET item_id = ?, item_suggested = ? WHERE jot_id = ?").run(itemId, suggested ? 1 : 0, id);
    },
    setJotText(id: string, text: string) {
      db.prepare("UPDATE jots SET text = ? WHERE id = ?").run(text, id);
    },
    /** Deletes a note and the snaps pinned to it. */
    deleteJot(id: string) {
      db.prepare("DELETE FROM snaps WHERE jot_id = ?").run(id);
      db.prepare("DELETE FROM jots WHERE id = ?").run(id);
    },
  };
}
