// What people and agents post on a to-do: updates, comments, screenshots, and the mentions in them.
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../../shared/actors.ts";
import type { ItemUpdate, WorkShot } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import { actorOfUpdate, type Row, toUpdate, toWorkShot } from "./rows.ts";

export function updatesStore(db: DatabaseSync) {
  return {
    addUpdate(u: Omit<ItemUpdate, "id" | "ts" | "actor"> & { userId: string; actor?: Actor | null }): ItemUpdate {
      const update: ItemUpdate = {
        id: newId(12),
        roomId: u.roomId,
        itemId: u.itemId,
        noteId: u.noteId,
        noteText: u.noteText,
        userName: u.userName,
        client: u.client,
        actor: u.actor ?? actorOfUpdate(u.userName, u.client, u.userId),
        status: u.status,
        text: u.text,
        links: u.links,
        ts: Date.now(),
      };
      db.prepare(
        "INSERT INTO updates (id, room_id, item_id, note_id, note_text, user_id, user_name, client, actor_json, status, text, links_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        update.id,
        update.roomId,
        update.itemId,
        update.noteId,
        update.noteText,
        u.userId,
        update.userName,
        update.client,
        JSON.stringify(update.actor),
        update.status,
        update.text,
        JSON.stringify(update.links),
        update.ts,
      );
      return update;
    },
    /** Updates in a space since a time, newest first. */
    roomUpdates(roomId: string, since = 0, limit = 200): ItemUpdate[] {
      return (
        db.prepare("SELECT * FROM updates WHERE room_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?").all(roomId, since, limit) as Row[]
      ).map(toUpdate);
    },
    itemUpdates(itemId: string, limit = 50): ItemUpdate[] {
      return (db.prepare("SELECT * FROM updates WHERE item_id = ? ORDER BY ts DESC LIMIT ?").all(itemId, limit) as Row[]).map(toUpdate);
    },
    /** Every update on these to-dos, oldest first. */
    notesUpdates(noteIds: string[]): ItemUpdate[] {
      if (!noteIds.length) return [];
      return (
        db.prepare(`SELECT * FROM updates WHERE note_id IN (${noteIds.map(() => "?").join(",")}) ORDER BY ts ASC, rowid ASC`).all(...noteIds) as Row[]
      ).map(toUpdate);
    },
    addWorkShot(s: Omit<WorkShot, "id" | "ts" | "updateId"> & { roomId: string; userId: string }): WorkShot {
      const shot: WorkShot = { id: newId(14), noteId: s.noteId, updateId: null, userName: s.userName, client: s.client, caption: s.caption, ext: s.ext, ts: Date.now() };
      db.prepare(
        "INSERT INTO work_shots (id, room_id, note_id, update_id, user_id, user_name, client, caption, ext, ts) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
      ).run(shot.id, s.roomId, shot.noteId, s.userId, shot.userName, shot.client, shot.caption, shot.ext, shot.ts);
      return shot;
    },
    getWorkShot(id: string): (WorkShot & { roomId: string }) | null {
      const r = db.prepare("SELECT * FROM work_shots WHERE id = ?").get(id) as Row | undefined;
      return r ? { ...toWorkShot(r), roomId: r.room_id as string } : null;
    },
    /** Screenshots someone's agent attached to a to-do that no update has picked up yet join this one. */
    claimWorkShots(noteId: string, userId: string, updateId: string) {
      db.prepare("UPDATE work_shots SET update_id = ? WHERE note_id = ? AND user_id = ? AND update_id IS NULL").run(updateId, noteId, userId);
    },
    noteWorkShots(noteIds: string[]): WorkShot[] {
      if (!noteIds.length) return [];
      return (
        db.prepare(`SELECT * FROM work_shots WHERE note_id IN (${noteIds.map(() => "?").join(",")}) ORDER BY ts ASC`).all(...noteIds) as Row[]
      ).map(toWorkShot);
    },
    /** To-dos still open whose last word is "ready" (finished, waiting to ship), with who said so. */
    readyToShip(): Array<ItemUpdate & { userId: string }> {
      return (
        db
          .prepare(
            `SELECT u.* FROM updates u JOIN notes n ON n.id = u.note_id
             WHERE n.kind = 'action' AND n.done_at IS NULL AND u.status = 'ready'
             AND u.rowid = (SELECT rowid FROM updates WHERE note_id = u.note_id AND status NOT IN ('plan', 'linked', 'comment') ORDER BY ts DESC, rowid DESC LIMIT 1)
             ORDER BY u.ts LIMIT 100`,
          )
          .all() as Row[]
      ).map((r) => ({ ...toUpdate(r), userId: r.user_id as string }));
    },
    noteUpdates(noteId: string): ItemUpdate[] {
      return (db.prepare("SELECT * FROM updates WHERE note_id = ? ORDER BY ts DESC, rowid DESC LIMIT 50").all(noteId) as Row[]).map(toUpdate);
    },
    addMentions(u: Pick<ItemUpdate, "id" | "roomId" | "noteId" | "ts">, userIds: string[]) {
      if (!u.noteId) return;
      const st = db.prepare("INSERT OR IGNORE INTO mentions (update_id, user_id, room_id, note_id, ts) VALUES (?, ?, ?, ?, ?)");
      for (const id of userIds) st.run(u.id, id, u.roomId, u.noteId, u.ts);
    },
    /** The comments that tag this person and still wait on them, newest first: on tasks still open. */
    openMentions(userId: string, roomId?: string): Array<ItemUpdate & { noteId: string }> {
      return (
        db
          .prepare(
            `SELECT u.* FROM mentions x JOIN updates u ON u.id = x.update_id JOIN notes n ON n.id = x.note_id
             WHERE x.user_id = ? AND x.cleared_at IS NULL AND n.done_at IS NULL ${roomId ? "AND x.room_id = ?" : ""}
             ORDER BY x.ts DESC LIMIT 200`,
          )
          .all(...(roomId ? [userId, roomId] : [userId])) as Row[]
      ).map((r) => toUpdate(r) as ItemUpdate & { noteId: string });
    },
    /** This person has seen to the mentions on a task: they replied, or dismissed them. */
    clearMentions(noteId: string, userId: string): number {
      return db.prepare("UPDATE mentions SET cleared_at = ? WHERE note_id = ? AND user_id = ? AND cleared_at IS NULL").run(Date.now(), noteId, userId).changes as number;
    },
  };
}
