import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Deck, DeckDraft, DeckTheme, Discussion, DiscussionOutcome, FollowUp, Item, ItemSource, Note, NoteKind, Segment, SegmentKind, User } from "../shared/protocol.ts";
import { newId } from "./ids.ts";

export type DB = ReturnType<typeof openDb>;

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  picture TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  last_joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Items belong to a room, not a meeting, so a recurring standup builds up
-- history per ticket across meetings.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  source TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  description TEXT,
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_external ON items(room_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  title TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT REFERENCES items(id),
  speaker_id TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_item ON segments(item_id, ts);
CREATE INDEX IF NOT EXISTS segments_meeting ON segments(meeting_id, ts);
CREATE TABLE IF NOT EXISTS focus_events (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  owner TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_item ON notes(item_id);
-- The agent's grouping of an item's talk into discussions, one per question.
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  topic TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  segment_ids_json TEXT NOT NULL,
  continues_id TEXT,
  position INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS discussions_item ON discussions(item_id);
CREATE INDEX IF NOT EXISTS discussions_meeting ON discussions(meeting_id);
`;

/** Reads a discussion with the earlier one it continues, if any. */
const DISCUSSION_SELECT = `SELECT d.*, c.meeting_id AS c_meeting_id, c.topic AS c_topic, cm.started_at AS c_started_at
  FROM discussions d LEFT JOIN discussions c ON c.id = d.continues_id LEFT JOIN meetings cm ON cm.id = c.meeting_id`;

export type DraftDiscussion = Pick<Discussion, "topic" | "positions" | "outcome" | "segmentIds"> & { continuesId: string | null };

type Row = Record<string, unknown>;

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const toUser = (r: Row): User => ({
  id: r.id as string,
  email: r.email as string,
  name: r.name as string,
  picture: (r.picture as string) ?? null,
});

const toItem = (r: Row): Item => ({
  id: r.id as string,
  roomId: r.room_id as string,
  source: r.source as ItemSource,
  externalId: (r.external_id as string) ?? null,
  title: r.title as string,
  url: (r.url as string) ?? null,
  description: (r.description as string) ?? null,
  position: r.position as number,
  deckId: (r.deck_id as string) ?? null,
  slideNo: (r.slide_no as number) ?? null,
  slide: r.slide_json ? JSON.parse(r.slide_json as string) : null,
});

const toDeck = (r: Row): Deck => ({
  id: r.id as string,
  roomId: r.room_id as string,
  title: r.title as string,
  pageCount: r.page_count as number,
  kind: ((r.kind as string) ?? "pdf") as Deck["kind"],
  theme: ((r.theme as string) ?? "paper") as DeckTheme,
  parentItemId: (r.parent_item_id as string) ?? null,
});

type NewItem = Pick<Item, "source" | "externalId" | "title" | "url" | "description"> & { deckId?: string; slideNo?: number };

const toSegment = (r: Row): Segment => ({
  id: r.id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  speakerId: r.speaker_id as string,
  speakerName: r.speaker_name as string,
  kind: r.kind as SegmentKind,
  text: r.text as string,
  ts: r.ts as number,
});

const toNote = (r: Row): Note => ({
  id: r.id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  kind: r.kind as NoteKind,
  text: r.text as string,
  owner: (r.owner as string) ?? null,
  ts: r.ts as number,
  doneAt: (r.done_at as number) ?? null,
  doneBy: (r.done_by as string) ?? null,
  discussionId: (r.discussion_id as string) ?? null,
});

const toDiscussion = (r: Row): Discussion => ({
  id: r.id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  topic: r.topic as string,
  positions: JSON.parse(r.positions_json as string),
  outcome: r.outcome as DiscussionOutcome,
  segmentIds: JSON.parse(r.segment_ids_json as string),
  continues: r.c_meeting_id
    ? { id: r.continues_id as string, meetingId: r.c_meeting_id as string, startedAt: r.c_started_at as number, topic: r.c_topic as string }
    : null,
  ts: r.ts as number,
});

export function openDb(file?: string) {
  if (file && file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file ?? ":memory:");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(schema);
  // Added after the first version; older databases lack it.
  const roomCols = (db.prepare("PRAGMA table_info(rooms)").all() as Row[]).map((c) => c.name);
  if (!roomCols.includes("created_by")) db.exec("ALTER TABLE rooms ADD COLUMN created_by TEXT");
  const itemCols = (db.prepare("PRAGMA table_info(items)").all() as Row[]).map((c) => c.name);
  if (!itemCols.includes("deck_id")) db.exec("ALTER TABLE items ADD COLUMN deck_id TEXT; ALTER TABLE items ADD COLUMN slide_no INTEGER;");
  if (!itemCols.includes("slide_json")) db.exec("ALTER TABLE items ADD COLUMN slide_json TEXT");
  const deckCols = (db.prepare("PRAGMA table_info(decks)").all() as Row[]).map((c) => c.name);
  if (!deckCols.includes("parent_item_id")) db.exec("ALTER TABLE decks ADD COLUMN parent_item_id TEXT;");
  const noteCols = (db.prepare("PRAGMA table_info(notes)").all() as Row[]).map((c) => c.name);
  if (!noteCols.includes("discussion_id")) db.exec("ALTER TABLE notes ADD COLUMN discussion_id TEXT;");
  if (!noteCols.includes("done_at")) db.exec("ALTER TABLE notes ADD COLUMN done_at INTEGER; ALTER TABLE notes ADD COLUMN done_by TEXT;");
  if (!deckCols.includes("kind")) db.exec("ALTER TABLE decks ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'; ALTER TABLE decks ADD COLUMN theme TEXT NOT NULL DEFAULT 'paper';");

  return {
    raw: db,

    /** Finds the user by Google subject (or email, for accounts created by the
     *  stand-in sign-in) and refreshes their profile. */
    upsertUser(u: { googleSub: string | null; email: string; name: string; picture: string | null }): User {
      const email = u.email.toLowerCase();
      const existing = (
        u.googleSub ? db.prepare("SELECT * FROM users WHERE google_sub = ?").get(u.googleSub) : undefined
      ) as Row | undefined ?? (db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined);
      if (existing) {
        db.prepare("UPDATE users SET google_sub = COALESCE(?, google_sub), email = ?, name = ?, picture = COALESCE(?, picture) WHERE id = ?").run(
          u.googleSub,
          email,
          u.name,
          u.picture,
          existing.id as string,
        );
        return toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id as string) as Row);
      }
      const id = "u" + newId(11);
      db.prepare("INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        u.googleSub,
        email,
        u.name,
        u.picture,
        Date.now(),
      );
      return { id, email, name: u.name, picture: u.picture };
    },
    createSession(userId: string) {
      const id = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, Date.now() + SESSION_TTL_MS);
      return { id, maxAgeMs: SESSION_TTL_MS };
    },
    /** The signed-in user, and whether Google verified their email
     *  (false for the stand-in name-and-email sign-in). */
    sessionUser(sessionId: string): { user: User; verified: boolean } | null {
      const r = db
        .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?")
        .get(sessionId, Date.now()) as Row | undefined;
      return r ? { user: toUser(r), verified: Boolean(r.google_sub) } : null;
    },
    deleteSession(sessionId: string) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    },

    touchMembership(roomId: string, userId: string) {
      db.prepare(
        `INSERT INTO room_members (room_id, user_id, last_joined_at) VALUES (?, ?, ?)
         ON CONFLICT (room_id, user_id) DO UPDATE SET last_joined_at = excluded.last_joined_at`,
      ).run(roomId, userId, Date.now());
    },
    userRooms(userId: string) {
      return (
        db
          .prepare(
            `SELECT r.id, r.name, m.last_joined_at FROM room_members m JOIN rooms r ON r.id = m.room_id
             WHERE m.user_id = ? ORDER BY m.last_joined_at DESC LIMIT 30`,
          )
          .all(userId) as Row[]
      ).map((r) => ({ id: r.id as string, name: r.name as string, lastJoinedAt: r.last_joined_at as number }));
    },

    createRoom(name: string, createdBy: string | null = null) {
      const id = newId(8);
      db.prepare("INSERT INTO rooms (id, name, created_at, created_by) VALUES (?, ?, ?, ?)").run(id, name, Date.now(), createdBy);
      return { id, name, createdBy };
    },
    getRoom(id: string) {
      const r = db.prepare("SELECT id, name, created_by FROM rooms WHERE id = ?").get(id) as Row | undefined;
      return r ? { id: r.id as string, name: r.name as string, createdBy: (r.created_by as string) ?? null } : null;
    },

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
      const maxPos = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE room_id = ? AND archived = 0").get(roomId) as Row).p as number;
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
          insert.run(newId(), roomId, it.source, it.externalId, it.title, it.url, it.description, pos++, it.deckId ?? null, it.slideNo ?? null, Date.now());
        }
      }
      return this.listItems(roomId);
    },
    updateItem(id: string, patch: { title?: string; position?: number }) {
      if (patch.title !== undefined) db.prepare("UPDATE items SET title = ? WHERE id = ?").run(patch.title, id);
      if (patch.position !== undefined) db.prepare("UPDATE items SET position = ? WHERE id = ?").run(patch.position, id);
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
      const items = this.listItems(deck.roomId);
      const mine = items.filter((it) => it.deckId === deckId).map((it) => it.id);
      const others = items.filter((it) => it.deckId !== deckId);
      let at = others.findIndex((it) => it.id === parentItemId);
      if (at < 0) return;
      const siblings = new Set(
        (db.prepare("SELECT id FROM decks WHERE parent_item_id = ? AND id != ?").all(parentItemId, deckId) as Row[]).map((r) => r.id as string),
      );
      while (at + 1 < others.length && others[at + 1].deckId && siblings.has(others[at + 1].deckId!)) at++;
      const ids = others.map((it) => it.id);
      this.reorderItems(deck.roomId, [...ids.slice(0, at + 1), ...mine, ...ids.slice(at + 1)]);
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
        db.prepare("UPDATE decks SET title = ?, theme = ?, page_count = ? WHERE id = ?").run(draft.title, draft.theme, draft.slides.length, deck.id);
        const before = this.listItems(deck.roomId);
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
        db.prepare(`UPDATE items SET archived = 1 WHERE deck_id = ? AND id NOT IN (${ids.map(() => "?").join(",") || "''"})`).run(deck.id, ...ids);
        // Re-lay the agenda with the deck as one block where its first slide was.
        const others = before.filter((it) => it.deckId !== deck.id && !keep.has(it.id)).map((it) => it.id);
        const at = before.findIndex((it) => it.deckId === deck.id);
        const anchor = at < 0 ? others.length : before.slice(0, at).filter((it) => it.deckId !== deck.id).length;
        this.reorderItems(deck.roomId, [...others.slice(0, anchor), ...ids, ...others.slice(anchor)]);
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
          .prepare("SELECT * FROM decks d WHERE room_id = ? AND EXISTS (SELECT 1 FROM items i WHERE i.deck_id = d.id AND i.archived = 0) ORDER BY created_at")
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
        db.prepare("SELECT n.* FROM notes n JOIN items i ON i.id = n.item_id WHERE i.deck_id = ? ORDER BY n.ts, n.rowid").all(deckId) as Row[]
      ).map(toNote);
      return { segments, notes };
    },

    startMeeting(roomId: string) {
      const id = newId();
      const startedAt = Date.now();
      db.prepare("INSERT INTO meetings (id, room_id, started_at) VALUES (?, ?, ?)").run(id, roomId, startedAt);
      return { id, startedAt };
    },
    endMeeting(id: string, summary: string | null) {
      db.prepare("UPDATE meetings SET ended_at = ?, summary = ? WHERE id = ?").run(Date.now(), summary, id);
    },
    getMeeting(id: string) {
      const r = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
      if (!r) return null;
      return {
        id: r.id as string,
        roomId: r.room_id as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number) ?? null,
        summary: (r.summary as string) ?? null,
      };
    },
    listMeetings(roomId: string) {
      return (
        db
          .prepare(
            `SELECT m.*, (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS n
             FROM meetings m WHERE room_id = ? ORDER BY started_at DESC LIMIT 50`,
          )
          .all(roomId) as Row[]
      ).map((r) => ({
        id: r.id as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number) ?? null,
        summary: (r.summary as string) ?? null,
        segmentCount: r.n as number,
      }));
    },

    addSegment(s: Omit<Segment, "id">): Segment {
      const seg = { ...s, id: newId(12) };
      db.prepare(
        "INSERT INTO segments (id, meeting_id, item_id, speaker_id, speaker_name, kind, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(seg.id, seg.meetingId, seg.itemId, seg.speakerId, seg.speakerName, seg.kind, seg.text, seg.ts);
      return seg;
    },
    appendSegmentText(id: string, text: string): Segment | null {
      db.prepare("UPDATE segments SET text = text || ' ' || ? WHERE id = ?").run(text, id);
      const r = db.prepare("SELECT * FROM segments WHERE id = ?").get(id) as Row | undefined;
      return r ? toSegment(r) : null;
    },
    moveSegment(id: string, itemId: string | null): Segment | null {
      db.prepare("UPDATE segments SET item_id = ? WHERE id = ?").run(itemId, id);
      const r = db.prepare("SELECT * FROM segments WHERE id = ?").get(id) as Row | undefined;
      return r ? toSegment(r) : null;
    },
    /** Re-pins speech in [from, now] that was attached to `fromItem` onto `toItem`.
     *  Used when someone confirms an agent suggestion: the screen changed at
     *  `from`, so what was said since then belongs to the new item. */
    repinSince(meetingId: string, from: number, fromItem: string | null, toItem: string): Segment[] {
      const rows = db
        .prepare("SELECT * FROM segments WHERE meeting_id = ? AND ts >= ? AND item_id IS ?")
        .all(meetingId, from, fromItem) as Row[];
      const st = db.prepare("UPDATE segments SET item_id = ? WHERE id = ?");
      return rows.map((r) => {
        st.run(toItem, r.id as string);
        return { ...toSegment(r), itemId: toItem };
      });
    },
    meetingSegments(meetingId: string): Segment[] {
      return (db.prepare("SELECT * FROM segments WHERE meeting_id = ? ORDER BY ts").all(meetingId) as Row[]).map(toSegment);
    },
    itemSegments(meetingId: string, itemId: string | null): Segment[] {
      return (
        db.prepare("SELECT * FROM segments WHERE meeting_id = ? AND item_id IS ? ORDER BY ts").all(meetingId, itemId) as Row[]
      ).map(toSegment);
    },

    logFocus(meetingId: string, itemId: string | null, actor: string, reason: string) {
      db.prepare("INSERT INTO focus_events (id, meeting_id, item_id, actor, reason, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
        newId(12),
        meetingId,
        itemId,
        actor,
        reason,
        Date.now(),
      );
    },

    /** Notes for one item in one meeting are regenerated as a whole. An action
     *  someone already checked off stays checked when its wording comes back. */
    replaceNotes(
      meetingId: string,
      itemId: string | null,
      notes: Array<
        Pick<Note, "kind" | "text" | "owner"> & { discussionId?: string | null; id?: string; ts?: number; doneAt?: number | null; doneBy?: string | null }
      >,
    ): Note[] {
      const done = new Map(
        (db.prepare("SELECT text, done_at, done_by FROM notes WHERE meeting_id = ? AND item_id IS ? AND done_at IS NOT NULL").all(meetingId, itemId) as Row[]).map(
          (r) => [r.text as string, { doneAt: r.done_at as number, doneBy: (r.done_by as string) ?? null }],
        ),
      );
      db.prepare("DELETE FROM notes WHERE meeting_id = ? AND item_id IS ?").run(meetingId, itemId);
      const st = db.prepare(
        "INSERT INTO notes (id, meeting_id, item_id, kind, text, owner, ts, done_at, done_by, discussion_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const ts = Date.now();
      return notes.map((n) => {
        const d = n.doneAt ? { doneAt: n.doneAt, doneBy: n.doneBy ?? null } : n.kind === "action" ? done.get(n.text) : undefined;
        const note: Note = {
          id: n.id ?? newId(12),
          meetingId,
          itemId,
          kind: n.kind,
          text: n.text,
          owner: n.owner ?? null,
          ts: n.ts ?? ts,
          doneAt: d?.doneAt ?? null,
          doneBy: d?.doneBy ?? null,
          discussionId: n.discussionId ?? null,
        };
        st.run(note.id, meetingId, itemId, note.kind, note.text, note.owner, ts, note.doneAt, note.doneBy, note.discussionId);
        return note;
      });
    },
    /** Discussions for one item in one meeting are regenerated as a whole, with its notes. */
    replaceDiscussions(meetingId: string, itemId: string | null, drafts: DraftDiscussion[]): Discussion[] {
      db.prepare("DELETE FROM discussions WHERE meeting_id = ? AND item_id IS ?").run(meetingId, itemId);
      const st = db.prepare(
        "INSERT INTO discussions (id, meeting_id, item_id, topic, positions_json, outcome, segment_ids_json, continues_id, position, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const ts = Date.now();
      const ids = drafts.map((d, i) => {
        const id = newId(12);
        st.run(id, meetingId, itemId, d.topic, JSON.stringify(d.positions), d.outcome, JSON.stringify(d.segmentIds), d.continuesId, i, ts);
        return id;
      });
      const byId = new Map(
        (db.prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? AND d.item_id IS ?`).all(meetingId, itemId) as Row[]).map((r) => [r.id as string, toDiscussion(r)]),
      );
      return ids.map((id) => byId.get(id)!);
    },
    getDiscussion(id: string): Discussion | null {
      const r = db.prepare(`${DISCUSSION_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
      return r ? toDiscussion(r) : null;
    },
    meetingDiscussions(meetingId: string): Discussion[] {
      return (db.prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? ORDER BY d.ts, d.position`).all(meetingId) as Row[]).map(toDiscussion);
    },
    /** Every discussion of an item across meetings, newest meeting first. */
    itemDiscussions(itemId: string): Array<Discussion & { meetingStartedAt: number }> {
      return (
        db
          .prepare(
            `SELECT x.*, m.started_at AS meeting_started_at FROM (${DISCUSSION_SELECT} WHERE d.item_id = ?) x
             JOIN meetings m ON m.id = x.meeting_id ORDER BY m.started_at DESC, x.position`,
          )
          .all(itemId) as Row[]
      ).map((r) => ({ ...toDiscussion(r), meetingStartedAt: r.meeting_started_at as number }));
    },
    deckDiscussions(deckId: string): Discussion[] {
      return (
        db.prepare(`${DISCUSSION_SELECT} JOIN items i ON i.id = d.item_id WHERE i.deck_id = ? ORDER BY d.ts, d.position`).all(deckId) as Row[]
      ).map(toDiscussion);
    },

    /** Checks an action item off (by someone) or reopens it (by: null). */
    setActionDone(roomId: string, noteId: string, by: string | null): Note | null {
      const res = db
        .prepare("UPDATE notes SET done_at = ?, done_by = ? WHERE id = ? AND kind = 'action' AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)")
        .run(by ? Date.now() : null, by, noteId, roomId);
      if (!res.changes) return null;
      return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row);
    },
    /** Every action item from the room's finished meetings, newest meeting first. */
    roomFollowUps(roomId: string): FollowUp[] {
      return (
        db
          .prepare(
            `SELECT n.*, m.started_at AS meeting_started_at FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE m.room_id = ? AND m.ended_at IS NOT NULL AND n.kind = 'action' ORDER BY m.started_at DESC, n.rowid`,
          )
          .all(roomId) as Row[]
      ).map((r) => ({ ...toNote(r), meetingStartedAt: r.meeting_started_at as number }));
    },
    meetingNotes(meetingId: string): Note[] {
      return (db.prepare("SELECT * FROM notes WHERE meeting_id = ? ORDER BY ts, rowid").all(meetingId) as Row[]).map(toNote);
    },

    itemHistory(itemId: string) {
      const meetings = db
        .prepare(
          `SELECT DISTINCT m.id, m.started_at, m.ended_at FROM meetings m
           JOIN segments s ON s.meeting_id = m.id WHERE s.item_id = ?
           UNION
           SELECT DISTINCT m.id, m.started_at, m.ended_at FROM meetings m
           JOIN notes n ON n.meeting_id = m.id WHERE n.item_id = ?
           ORDER BY started_at DESC`,
        )
        .all(itemId, itemId) as Row[];
      return meetings.map((m) => {
        const segments = (
          db.prepare("SELECT * FROM segments WHERE meeting_id = ? AND item_id = ? ORDER BY ts").all(m.id as string, itemId) as Row[]
        ).map(toSegment);
        const notes = (
          db.prepare("SELECT * FROM notes WHERE meeting_id = ? AND item_id = ? ORDER BY rowid").all(m.id as string, itemId) as Row[]
        ).map(toNote);
        return {
          meetingId: m.id as string,
          startedAt: m.started_at as number,
          endedAt: (m.ended_at as number) ?? null,
          participants: [...new Set(segments.map((s) => s.speakerName))],
          segments,
          notes,
          discussions: (
            db.prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? AND d.item_id = ? ORDER BY d.position`).all(m.id as string, itemId) as Row[]
          ).map(toDiscussion),
        };
      });
    },
  };
}
