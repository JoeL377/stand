// What the suggested agenda reads (upNext.ts), and what it keeps between runs.
import type { DatabaseSync } from "node:sqlite";
import type { Settled } from "../spaceSettle.ts";
import type { Polish, UpNextInput } from "../upNext.ts";
import { type Row, toNote } from "./rows.ts";
import type { updatesStore } from "./updates.ts";
import type { capturesStore } from "./captures.ts";

export function upNextStore(db: DatabaseSync, { updates, captures }: { updates: ReturnType<typeof updatesStore>; captures: ReturnType<typeof capturesStore> }) {
  return {
    /** What the agent drafts the next agenda from (see upNext.ts). */
    upNextInput(roomId: string, currentStart: number | null): UpNextInput {
      const meetings = (db.prepare("SELECT id, started_at, ended_at, kind FROM meetings WHERE room_id = ?").all(roomId) as Row[]).map((m) => ({
        id: m.id as string,
        startedAt: m.started_at as number,
        endedAt: (m.ended_at as number) ?? null,
        // A chat session (chat.ts) is no meeting that passed either: like a to-do added by hand, it places its notes in time.
        added: m.kind === "added" || m.kind === "chat" || undefined,
      }));
      const notes = (
        db
          .prepare(
            `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE m.room_id = ? AND n.kind IN ('action', 'question') ORDER BY n.ts`,
          )
          .all(roomId) as Row[]
      ).map(toNote);
      const items = new Map(
        (db.prepare("SELECT id, title, archived, deck_id FROM items WHERE room_id = ?").all(roomId) as Row[]).map((r) => [
          r.id as string,
          { title: r.title as string, archived: !!r.archived, deck: !!r.deck_id },
        ]),
      );
      const dismissed = new Map(
        (db.prepare("SELECT key, at FROM upnext_dismissed WHERE room_id = ?").all(roomId) as Row[]).map((r) => [
          r.key as string,
          r.at as number,
        ]),
      );
      return {
        now: Date.now(),
        meetings,
        currentStart,
        notes,
        items,
        updates: updates.roomUpdates(roomId, 0, 500),
        dismissed,
        otherSpaces: meetings.some((m) => m.endedAt !== null) ? [] : this.sharedSpacesWithOpenWork(roomId),
        captures: [
          ...captures.spaceSnaps(roomId, 0, 50).map((s) => ({
            kind: "snap" as const,
            id: s.id,
            ts: s.ts,
            itemId: s.itemId,
            by: s.takenBy,
            line: s.line,
            caption: s.caption,
            screenText: s.screenText,
          })),
          ...captures.spaceJots(roomId, 0, 50).map((j) => ({
            kind: "jot" as const,
            id: j.id,
            ts: j.ts,
            itemId: j.itemId,
            by: j.by,
            line: j.text,
            caption: null,
            screenText: null,
          })),
        ].sort((a, b) => b.ts - a.ts),
      };
    },
    /** Other spaces with open to-dos that everyone in this space is also in,
     *  so offering them leaks nothing. Newest activity first, at most three. */
    sharedSpacesWithOpenWork(roomId: string): Array<{ id: string; name: string; open: number; lastAt: number }> {
      return (
        db
          .prepare(
            `SELECT r.id, r.name, COUNT(n.id) AS open, MAX(n.ts) AS last_at
             FROM rooms r JOIN meetings m ON m.room_id = r.id AND m.ended_at IS NOT NULL
             JOIN notes n ON n.meeting_id = m.id AND n.kind = 'action' AND n.done_at IS NULL
             WHERE r.id != ?
               AND EXISTS (SELECT 1 FROM room_members WHERE room_id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM room_members x WHERE x.room_id = ?
                   AND NOT EXISTS (SELECT 1 FROM room_members y WHERE y.room_id = r.id AND y.user_id = x.user_id))
             GROUP BY r.id ORDER BY last_at DESC LIMIT 3`,
          )
          .all(roomId, roomId, roomId) as Row[]
      ).map((r) => ({ id: r.id as string, name: r.name as string, open: r.open as number, lastAt: r.last_at as number }));
    },
    getSettled(roomId: string): Settled | null {
      const r = db.prepare("SELECT at, basis, rows_json FROM space_settled WHERE room_id = ?").get(roomId) as Row | undefined;
      return r ? { at: r.at as number, basis: r.basis as string, rows: JSON.parse(r.rows_json as string) } : null;
    },
    saveSettled(roomId: string, settled: Settled) {
      db.prepare(
        "INSERT INTO space_settled (room_id, at, basis, rows_json) VALUES (?, ?, ?, ?) ON CONFLICT (room_id) DO UPDATE SET at = excluded.at, basis = excluded.basis, rows_json = excluded.rows_json",
      ).run(roomId, settled.at, settled.basis, JSON.stringify(settled.rows));
    },
    getPolish(roomId: string): Polish | null {
      const r = db.prepare("SELECT at, rows_json FROM upnext_polish WHERE room_id = ?").get(roomId) as Row | undefined;
      return r ? { at: r.at as number, rows: JSON.parse(r.rows_json as string) } : null;
    },
    savePolish(roomId: string, polish: Polish) {
      db.prepare(
        "INSERT INTO upnext_polish (room_id, at, rows_json) VALUES (?, ?, ?) ON CONFLICT (room_id) DO UPDATE SET at = excluded.at, rows_json = excluded.rows_json",
      ).run(roomId, polish.at, JSON.stringify(polish.rows));
    },
    dismissUpNext(roomId: string, key: string) {
      db.prepare(
        "INSERT INTO upnext_dismissed (room_id, key, at) VALUES (?, ?, ?) ON CONFLICT (room_id, key) DO UPDATE SET at = excluded.at",
      ).run(roomId, key, Date.now());
    },
    /** Undoes dismissUpNext, for the host's Undo. */
    undismissUpNext(roomId: string, key: string) {
      db.prepare("DELETE FROM upnext_dismissed WHERE room_id = ? AND key = ?").run(roomId, key);
    },
  };
}
