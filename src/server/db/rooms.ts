// Spaces, and the rows people archived off a space's page (archive.ts).
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../ids.ts";
import type { Row } from "./rows.ts";

export function roomsStore(db: DatabaseSync) {
  return {
    createRoom(name: string, createdBy: string | null = null, purpose = "") {
      const id = newId(8);
      db.prepare("INSERT INTO rooms (id, name, created_at, created_by, purpose) VALUES (?, ?, ?, ?, ?)").run(
        id,
        name,
        Date.now(),
        createdBy,
        purpose,
      );
      return { id, name, createdBy, purpose };
    },
    getRoom(id: string) {
      const r = db.prepare("SELECT id, name, created_by, purpose, synthesis_instructions FROM rooms WHERE id = ?").get(id) as
        | Row
        | undefined;
      return r
        ? {
            id: r.id as string,
            name: r.name as string,
            createdBy: (r.created_by as string) ?? null,
            purpose: (r.purpose as string) ?? "",
            synthesisInstructions: (r.synthesis_instructions as string) ?? "",
          }
        : null;
    },
    updateRoom(id: string, patch: { name?: string; purpose?: string; synthesisInstructions?: string }) {
      if (patch.name !== undefined) db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(patch.name, id);
      if (patch.purpose !== undefined) db.prepare("UPDATE rooms SET purpose = ? WHERE id = ?").run(patch.purpose, id);
      if (patch.synthesisInstructions !== undefined)
        db.prepare("UPDATE rooms SET synthesis_instructions = ? WHERE id = ?").run(patch.synthesisInstructions, id);
    },
    /** The spaces this user is in (spaces are invite only: you get in by link),
     *  with what the home page shows about each, from what's already recorded. */
    spaceRows(userId: string) {
      const rooms = db
        .prepare(
          `SELECT r.id, r.name, r.purpose, r.synthesis_instructions, r.created_by, r.created_at,
             (SELECT MAX(COALESCE(m.ended_at, m.started_at)) FROM meetings m WHERE m.room_id = r.id) AS met_at,
             (SELECT MAX(last_joined_at) FROM room_members x WHERE x.room_id = r.id) AS joined_at,
             (SELECT MAX(ts) FROM snaps s WHERE s.room_id = r.id AND s.meeting_id IS NULL) AS captured_at,
             EXISTS (SELECT 1 FROM room_members x WHERE x.room_id = r.id AND x.user_id = ?) AS following,
             EXISTS (SELECT 1 FROM room_members x WHERE x.room_id = r.id AND x.user_id = ? AND x.role = 'admin') AS admin
           FROM rooms r
           WHERE EXISTS (SELECT 1 FROM room_members x WHERE x.room_id = r.id AND x.user_id = ?)`,
        )
        .all(userId, userId, userId) as Row[];
      const people = db.prepare(
        "SELECT u.name FROM room_members x JOIN users u ON u.id = x.user_id WHERE x.room_id = ? ORDER BY x.last_joined_at DESC",
      );
      const notes = db.prepare(
        `SELECT n.kind, n.text, n.owner, n.done_at, n.ts, n.meeting_id FROM notes n JOIN meetings m ON m.id = n.meeting_id
         WHERE m.room_id = ? AND n.kind IN ('decision', 'question', 'action') ORDER BY n.ts DESC, n.rowid DESC LIMIT 300`,
      );
      return rooms.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        purpose: (r.purpose as string) ?? "",
        synthesisInstructions: (r.synthesis_instructions as string) ?? "",
        createdBy: (r.created_by as string) ?? null,
        activeAt: Math.max((r.created_at as number) ?? 0, (r.met_at as number) ?? 0, (r.joined_at as number) ?? 0, (r.captured_at as number) ?? 0),
        following: Boolean(r.following),
        admin: Boolean(r.admin),
        people: (people.all(r.id as string) as Row[]).map((p) => p.name as string),
        notes: (notes.all(r.id as string) as Row[]).map((n) => ({
          kind: n.kind as "decision" | "question" | "action",
          text: n.text as string,
          owner: (n.owner as string) ?? null,
          done: n.done_at != null,
          ts: n.ts as number,
          meetingId: n.meeting_id as string,
        })),
      }));
    },
    /** What was archived off a space's page, newest first. */
    listArchived(roomId: string): Array<{ ref: string; title: string; ts: number; at: number; by: string; extra: string[] }> {
      return (db.prepare("SELECT * FROM space_archived WHERE room_id = ? ORDER BY at DESC").all(roomId) as Row[]).map((r) => ({
        ref: r.ref as string,
        title: r.title as string,
        ts: r.ts as number,
        at: r.at as number,
        by: r.by_name as string,
        extra: r.extra_json ? JSON.parse(r.extra_json as string) : [],
      }));
    },
    putArchived(roomId: string, a: { ref: string; title: string; ts: number; by: string; extra?: string[] }) {
      db.prepare(
        `INSERT INTO space_archived (room_id, ref, title, ts, at, by_name, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id, ref) DO UPDATE SET title = excluded.title, ts = excluded.ts, at = excluded.at, by_name = excluded.by_name, extra_json = excluded.extra_json`,
      ).run(roomId, a.ref, a.title, a.ts, Date.now(), a.by, a.extra?.length ? JSON.stringify(a.extra) : null);
    },
    dropArchived(roomId: string, ref: string) {
      db.prepare("DELETE FROM space_archived WHERE room_id = ? AND ref = ?").run(roomId, ref);
    },
  };
}
