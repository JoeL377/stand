// Captures: what people save straight to a space between meetings, from the Mac's bar: a note,
// typed or dictated, with any snaps of the screen pinned to it (each with the text the Mac read
// off it), or snaps on their own. Everyone in the space sees it once it's saved. The agent captions a snap and, when
// nobody picked an item, suggests one, marked ✦ until someone confirms it. A capture never
// becomes a to-do or decision by itself.

import type { SpaceFeed } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import type { Agent } from "./llm.ts";
import { newId } from "./ids.ts";
import { linkSnaps, saveSnapFile } from "./snaps.ts";

/** What the feed shows of the space's history. */
const FEED_CAPTURES = 100;
const FEED_UPDATES = 60;
/** The typed line, and the text read off a screen: enough for a paragraph of an error, not a novel. */
export const MAX_LINE = 300;
/** A note: a few sentences said or typed in one go. */
export const MAX_JOT = 2000;
export const MAX_SCREEN_TEXT = 8000;

export const cleanLine = (v: unknown) => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_LINE) : "";
  return t || null;
};
export const cleanJot = (v: unknown) => {
  const t = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_JOT) : "";
  return t || null;
};
export const cleanScreenText = (v: unknown) => {
  const t = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_SCREEN_TEXT) : "";
  return t || null;
};

/** An item someone can pin a capture to: on this space's agenda (not a slide), or null. */
export function itemIn(db: DB, roomId: string, itemId: unknown): string | null {
  if (typeof itemId !== "string" || !itemId) return null;
  const item = db.getItem(itemId);
  return item && item.roomId === roomId && !item.deckId ? item.id : null;
}

export function saveCapture(
  db: DB,
  agent: Agent,
  c: {
    roomId: string;
    buf: Buffer;
    ext: string;
    width: number;
    height: number;
    at: number;
    takenById: string;
    takenBy: string;
    itemId: string | null;
    line: string | null;
    /** The note it's pinned to: it takes the note's item rather than the agent picking one. */
    jotId?: string | null;
  },
  /** Called once the agent has captioned it or picked an item. */
  changed: () => void = () => {},
): string {
  const id = newId(12);
  saveSnapFile(id, c.ext, c.buf);
  db.addSnap({
    id,
    roomId: c.roomId,
    meetingId: null,
    itemId: c.itemId,
    ts: Math.min(c.at || Date.now(), Date.now()),
    ext: c.ext,
    width: c.width,
    height: c.height,
    source: "person",
    takenById: c.takenById,
    takenBy: c.takenBy,
    sharerId: null,
    sharerName: null,
    noteId: null,
    line: c.line,
    jotId: c.jotId ?? null,
    itemSuggested: c.jotId ? (db.getJot(c.jotId)?.itemSuggested ?? false) : false,
  });
  void describe(db, agent, id, c.buf, c.ext).then((did) => did && changed());
  return id;
}

/** Saves a note to the space; the agent suggests its item afterwards when nobody picked one. */
export function saveJot(
  db: DB,
  agent: Agent,
  j: { roomId: string; text: string; at: number; byId: string; by: string; itemId: string | null },
  /** Called once the agent has picked an item. */
  changed: () => void = () => {},
): string {
  const id = newId(12);
  db.addJot({ id, roomId: j.roomId, itemId: j.itemId, text: j.text, byId: j.byId, by: j.by, ts: Math.min(j.at || Date.now(), Date.now()) });
  if (!j.itemId) void fileJot(db, agent, id).then((did) => did && changed());
  return id;
}

async function fileJot(db: DB, agent: Agent, id: string): Promise<boolean> {
  try {
    const jot = db.getJot(id);
    const room = jot && db.getRoom(jot.roomId);
    if (!jot || !room) return false;
    const items = db.listItems(room.id).filter((i) => !i.deckId);
    const itemId = await agent.pickItem(room, items, jot.text);
    // Someone may have deleted it, or picked an item, while the agent was reading.
    const now = db.getJot(id);
    if (!itemId || !now || now.itemId) return false;
    db.setJotItem(id, itemId, true);
    return true;
  } catch (err) {
    console.error("[agent] note filing failed:", err);
    return false;
  }
}

async function describe(db: DB, agent: Agent, id: string, buf: Buffer, ext: string): Promise<boolean> {
  if (buf.length > 5 * 1024 * 1024) return false;
  try {
    const snap = db.getSnap(id);
    const room = snap && db.getRoom(snap.roomId);
    if (!snap || !room) return false;
    const items = db.listItems(room.id).filter((i) => !i.deckId);
    const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    // Pinned to a note, what the note says is what was written about it.
    const said = snap.line ?? (snap.jotId ? (db.getJot(snap.jotId)?.text ?? null) : null);
    const out = await agent.describeCapture({ data: buf.toString("base64"), mediaType }, room, items, said);
    // Someone may have deleted it, or picked an item, while the agent was looking.
    const now = db.getSnap(id);
    if (!out || !now) return false;
    if (out.caption) db.setSnapCaption(id, out.caption);
    // Pinned to a note, it goes where the note goes.
    const pick = out.itemId && !now.itemId && !now.jotId;
    if (pick) db.setSnapItem(id, out.itemId, true);
    return Boolean(out.caption || pick);
  } catch (err) {
    console.error("[agent] capture caption failed:", err);
    return false;
  }
}

export function spaceFeed(db: DB, roomId: string, baseUrl = ""): SpaceFeed {
  const meetings = db.feedMeetings(roomId);
  const latest = meetings.find((m) => m.todos + m.decided + m.open > 0);
  return {
    captures: linkSnaps(db.spaceSnaps(roomId, 0, FEED_CAPTURES), [], [], baseUrl),
    jots: db.spaceJots(roomId, 0, FEED_CAPTURES).map((j) => ({ ...j, snaps: linkSnaps(db.jotSnaps(j.id), [], [], baseUrl) })),
    meetings,
    updates: db.roomUpdates(roomId, 0, FEED_UPDATES),
    decided: db.spaceNotes(roomId, "decision", 20),
    open: latest ? db.meetingNotes(latest.id).filter((n) => n.kind === "question") : [],
  };
}
