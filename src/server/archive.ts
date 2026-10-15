// Archiving rows off a space's page: a meeting, a snap or note from the bar, a to-do, decision or
// question, or something on Up next. The page stops showing it and lists it under Archived, where it
// can be restored. Meeting records and recaps don't change. Agenda items, decks and the agent's
// suggestions also come off the agenda (the same as removing or dismissing them there), and come
// back when restored.

import type { ArchivedKind, ArchivedRow } from "../shared/protocol.ts";
import type { DB } from "./db.ts";

const KINDS: ArchivedKind[] = ["meeting", "snap", "jot", "todo", "decision", "question", "item", "deck", "suggestion"];
const NOTE_KIND = {
  todo: "action",
  decision: "decision",
  question: "question",
} as const;

export function parseRef(ref: unknown): { kind: ArchivedKind; id: string } | null {
  if (typeof ref !== "string" || ref.length > 300) return null;
  const at = ref.indexOf(":");
  const kind = ref.slice(0, at) as ArchivedKind;
  const id = ref.slice(at + 1);
  return at > 0 && id && KINDS.includes(kind) ? { kind, id } : null;
}

const firstLine = (s: string) => s.split("\n")[0].trim().slice(0, 200);

/**
 * Archives one row of the space. A suggestion is the agent's, not stored, so the page sends its
 * title and the keys folded into it. Returns false when the row isn't in this space.
 */
export function archiveRow(db: DB, roomId: string, ref: string, by: string, suggestion?: { title: string; keys: string[] }): boolean {
  const r = parseRef(ref);
  if (!r) return false;
  const put = (title: string, ts: number, extra?: string[]) => {
    db.putArchived(roomId, { ref, title, ts, by, extra });
    return true;
  };
  switch (r.kind) {
    case "meeting": {
      const m = db.getMeeting(r.id);
      return !!m && m.roomId === roomId && put("Meeting", m.endedAt ?? m.startedAt);
    }
    case "snap": {
      const s = db.getSnap(r.id);
      return !!s && s.roomId === roomId && put(firstLine(s.line ?? s.caption ?? "Snap") || "Snap", s.ts);
    }
    case "jot": {
      const j = db.getJot(r.id);
      return !!j && j.roomId === roomId && put(firstLine(j.text) || "Note", j.ts);
    }
    case "todo":
    case "decision":
    case "question": {
      const n = db.getNote(r.id);
      return !!n && n.roomId === roomId && n.kind === NOTE_KIND[r.kind] && put(n.text, n.ts);
    }
    case "item": {
      const it = db.getItem(r.id);
      if (!it || it.roomId !== roomId) return false;
      db.archiveItem(it.id);
      // Off the agenda, the agent would suggest it again: that's waved off too.
      db.dismissUpNext(roomId, ref);
      return put(it.title, Date.now());
    }
    case "deck": {
      const d = db.getDeck(r.id);
      if (!d || d.roomId !== roomId) return false;
      const ids = db.deckItemIds(d.id);
      db.archiveDeck(d.id);
      return put(d.title, Date.now(), ids);
    }
    case "suggestion": {
      const keys = [...new Set([r.id, ...(suggestion?.keys ?? [])])].filter((k) => typeof k === "string" && k.length < 300).slice(0, 50);
      for (const key of keys) db.dismissUpNext(roomId, key);
      return put(firstLine(suggestion?.title ?? "") || "Suggestion", Date.now(), keys);
    }
  }
}

/** Puts an archived row back where it was. */
export function restoreRow(db: DB, roomId: string, ref: string): boolean {
  const r = parseRef(ref);
  const row = r && db.listArchived(roomId).find((a) => a.ref === ref);
  if (!r || !row) return false;
  if (r.kind === "item") {
    db.unarchiveItems(roomId, [r.id]);
    db.undismissUpNext(roomId, ref);
  }
  if (r.kind === "deck") db.unarchiveItems(roomId, row.extra);
  if (r.kind === "suggestion") for (const key of row.extra) db.undismissUpNext(roomId, key);
  db.dropArchived(roomId, ref);
  return true;
}

export function archivedRows(db: DB, roomId: string): ArchivedRow[] {
  return db.listArchived(roomId).flatMap(({ extra: _, ...a }) => {
    const r = parseRef(a.ref);
    return r ? [{ ...a, kind: r.kind }] : [];
  });
}
