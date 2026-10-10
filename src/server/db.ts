import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type {
  AgentToken,
  Deck,
  DeckDraft,
  DeckTheme,
  Discussion,
  DiscussionOutcome,
  FollowUp,
  Item,
  ItemSource,
  ItemUpdate,
  Note,
  NoteKind,
  Segment,
  SegmentKind,
  UpdateStatus,
  User,
} from "../shared/protocol.ts";
import { newId } from "./ids.ts";
import type { SnapRow } from "./snaps.ts";
import type { Polish, UpNextInput } from "./upNext.ts";

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
-- Notes the meeting's host deleted or reworded, so the agent's next redraft doesn't bring the old ones back.
CREATE TABLE IF NOT EXISTS dismissed_notes (
  meeting_id TEXT NOT NULL,
  item_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dismissed_notes_item ON dismissed_notes(meeting_id, item_id);
-- Agenda suggestions the host waved off, so the agent doesn't bring them back until something changes.
CREATE TABLE IF NOT EXISTS upnext_dismissed (
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, key)
);
-- Stills of the shared screen (snaps.ts). The image is a file named by id.
CREATE TABLE IF NOT EXISTS snaps (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  ts INTEGER NOT NULL,
  ext TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  taken_by_id TEXT,
  taken_by TEXT NOT NULL,
  sharer_id TEXT,
  sharer_name TEXT,
  caption TEXT,
  note_id TEXT,
  -- The topic the end-of-meeting recap placed it under, when it backs no note.
  discussion_id TEXT
);
CREATE INDEX IF NOT EXISTS snaps_meeting ON snaps(meeting_id, ts);
CREATE INDEX IF NOT EXISTS snaps_item ON snaps(item_id, ts);
-- Claude's last pass over a space's suggested agenda (upNext.ts Polish), as JSON.
CREATE TABLE IF NOT EXISTS upnext_polish (
  room_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  rows_json TEXT NOT NULL
);
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
-- Personal access tokens for agents (the Stand MCP). Only a hash is kept.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
-- Apps that connect through the sign-in flow (Claude's custom connectors, for
-- example). They register themselves; they're public clients, so no secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- One-time codes from the consent page, swapped for a token within minutes.
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- What agents and people report back on an item between meetings. Append only.
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  item_id TEXT,
  note_id TEXT,
  note_text TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  client TEXT,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  links_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_room ON updates(room_id, ts);
CREATE INDEX IF NOT EXISTS updates_item ON updates(item_id, ts);
CREATE INDEX IF NOT EXISTS updates_note ON updates(note_id);
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

const toSnapRow = (r: Row): SnapRow => ({
  id: r.id as string,
  roomId: r.room_id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  ts: r.ts as number,
  ext: r.ext as string,
  version: r.version as number,
  width: r.width as number,
  height: r.height as number,
  source: r.source as SnapRow["source"],
  takenById: (r.taken_by_id as string) ?? null,
  takenBy: r.taken_by as string,
  sharerId: (r.sharer_id as string) ?? null,
  sharerName: (r.sharer_name as string) ?? null,
  caption: (r.caption as string) ?? null,
  noteId: (r.note_id as string) ?? null,
  topicId: (r.discussion_id as string) ?? null,
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
  editedBy: (r.edited_by as string) ?? null,
});

const toUpdate = (r: Row): ItemUpdate => ({
  id: r.id as string,
  roomId: r.room_id as string,
  itemId: (r.item_id as string) ?? null,
  noteId: (r.note_id as string) ?? null,
  noteText: (r.note_text as string) ?? null,
  userName: r.user_name as string,
  client: (r.client as string) ?? null,
  status: r.status as UpdateStatus,
  text: r.text as string,
  links: JSON.parse(r.links_json as string),
  ts: r.ts as number,
});

const toToken = (r: Row): AgentToken => ({
  id: r.id as string,
  label: r.label as string,
  scope: r.scope as AgentToken["scope"],
  hint: r.hint as string,
  createdAt: r.created_at as number,
  lastUsedAt: (r.last_used_at as number) ?? null,
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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
  const tokenCols = (db.prepare("PRAGMA table_info(api_tokens)").all() as Row[]).map((c) => c.name);
  if (!tokenCols.includes("client_id"))
    db.exec("ALTER TABLE api_tokens ADD COLUMN client_id TEXT; ALTER TABLE api_tokens ADD COLUMN refresh_hash TEXT;");
  if (!roomCols.includes("created_by")) db.exec("ALTER TABLE rooms ADD COLUMN created_by TEXT");
  if (!roomCols.includes("purpose")) db.exec("ALTER TABLE rooms ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
  // Synthesis instructions: what the space asks the agent to pull out of every meeting, besides the default notes.
  if (!roomCols.includes("synthesis_instructions")) db.exec("ALTER TABLE rooms ADD COLUMN synthesis_instructions TEXT NOT NULL DEFAULT ''");
  const meetingCols = (db.prepare("PRAGMA table_info(meetings)").all() as Row[]).map((c) => c.name);
  if (!meetingCols.includes("synthesis")) db.exec("ALTER TABLE meetings ADD COLUMN synthesis TEXT");
  const itemCols = (db.prepare("PRAGMA table_info(items)").all() as Row[]).map((c) => c.name);
  if (!itemCols.includes("deck_id")) db.exec("ALTER TABLE items ADD COLUMN deck_id TEXT; ALTER TABLE items ADD COLUMN slide_no INTEGER;");
  if (!itemCols.includes("slide_json")) db.exec("ALTER TABLE items ADD COLUMN slide_json TEXT");
  const deckCols = (db.prepare("PRAGMA table_info(decks)").all() as Row[]).map((c) => c.name);
  if (!deckCols.includes("parent_item_id")) db.exec("ALTER TABLE decks ADD COLUMN parent_item_id TEXT;");
  const noteCols = (db.prepare("PRAGMA table_info(notes)").all() as Row[]).map((c) => c.name);
  if (!noteCols.includes("discussion_id")) db.exec("ALTER TABLE notes ADD COLUMN discussion_id TEXT;");
  if (!noteCols.includes("edited_by")) db.exec("ALTER TABLE notes ADD COLUMN edited_by TEXT;");
  if (!noteCols.includes("done_at")) db.exec("ALTER TABLE notes ADD COLUMN done_at INTEGER; ALTER TABLE notes ADD COLUMN done_by TEXT;");
  const snapCols = (db.prepare("PRAGMA table_info(snaps)").all() as Row[]).map((c) => c.name);
  if (!snapCols.includes("discussion_id")) db.exec("ALTER TABLE snaps ADD COLUMN discussion_id TEXT;");
  if (!deckCols.includes("kind"))
    db.exec(
      "ALTER TABLE decks ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'; ALTER TABLE decks ADD COLUMN theme TEXT NOT NULL DEFAULT 'paper';",
    );

  return {
    raw: db,

    /** Finds the user by Google subject (or email, for accounts created by the
     *  stand-in sign-in) and refreshes their profile. */
    upsertUser(u: { googleSub: string | null; email: string; name: string; picture: string | null }): User {
      const email = u.email.toLowerCase();
      const existing =
        ((u.googleSub ? db.prepare("SELECT * FROM users WHERE google_sub = ?").get(u.googleSub) : undefined) as Row | undefined) ??
        (db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined);
      if (existing) {
        db.prepare(
          "UPDATE users SET google_sub = COALESCE(?, google_sub), email = ?, name = ?, picture = COALESCE(?, picture) WHERE id = ?",
        ).run(u.googleSub, email, u.name, u.picture, existing.id as string);
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
             EXISTS (SELECT 1 FROM room_members x WHERE x.room_id = r.id AND x.user_id = ?) AS following
           FROM rooms r
           WHERE EXISTS (SELECT 1 FROM room_members x WHERE x.room_id = r.id AND x.user_id = ?)`,
        )
        .all(userId, userId) as Row[];
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
        activeAt: Math.max((r.created_at as number) ?? 0, (r.met_at as number) ?? 0, (r.joined_at as number) ?? 0),
        following: Boolean(r.following),
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
        (db.prepare("SELECT id FROM decks WHERE parent_item_id = ? AND id != ?").all(parentItemId, deckId) as Row[]).map(
          (r) => r.id as string,
        ),
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
        db.prepare("UPDATE decks SET title = ?, theme = ?, page_count = ? WHERE id = ?").run(
          draft.title,
          draft.theme,
          draft.slides.length,
          deck.id,
        );
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
        db.prepare(`UPDATE items SET archived = 1 WHERE deck_id = ? AND id NOT IN (${ids.map(() => "?").join(",") || "''"})`).run(
          deck.id,
          ...ids,
        );
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

    startMeeting(roomId: string) {
      const id = newId();
      const startedAt = Date.now();
      db.prepare("INSERT INTO meetings (id, room_id, started_at) VALUES (?, ?, ?)").run(id, roomId, startedAt);
      return { id, startedAt };
    },
    endMeeting(id: string, summary: string | null, synthesis: string | null = null) {
      db.prepare("UPDATE meetings SET ended_at = ?, summary = ?, synthesis = ? WHERE id = ?").run(Date.now(), summary, synthesis, id);
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
        /** What the space's synthesis instructions asked for, as Markdown; null without instructions. */
        synthesis: (r.synthesis as string) ?? null,
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
      return (db.prepare("SELECT * FROM segments WHERE meeting_id = ? AND item_id IS ? ORDER BY ts").all(meetingId, itemId) as Row[]).map(
        toSegment,
      );
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
        Pick<Note, "kind" | "text" | "owner"> & {
          discussionId?: string | null;
          id?: string;
          ts?: number;
          doneAt?: number | null;
          doneBy?: string | null;
          editedBy?: string | null;
        }
      >,
    ): Note[] {
      const done = new Map(
        (
          db
            .prepare("SELECT text, done_at, done_by FROM notes WHERE meeting_id = ? AND item_id IS ? AND done_at IS NOT NULL")
            .all(meetingId, itemId) as Row[]
        ).map((r) => [r.text as string, { doneAt: r.done_at as number, doneBy: (r.done_by as string) ?? null }]),
      );
      // A note that comes back with the same wording keeps its id, so references
      // agents hold (stand:question/<id>) survive the agent rewriting the notes.
      const sameText = new Map(
        (db.prepare("SELECT id, kind, text FROM notes WHERE meeting_id = ? AND item_id IS ?").all(meetingId, itemId) as Row[]).map((r) => [
          `${r.kind}:${r.text}`,
          r.id as string,
        ]),
      );
      db.prepare("DELETE FROM notes WHERE meeting_id = ? AND item_id IS ?").run(meetingId, itemId);
      const st = db.prepare(
        "INSERT INTO notes (id, meeting_id, item_id, kind, text, owner, ts, done_at, done_by, discussion_id, edited_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const ts = Date.now();
      return notes.map((n) => {
        const d = n.doneAt ? { doneAt: n.doneAt, doneBy: n.doneBy ?? null } : n.kind === "action" ? done.get(n.text) : undefined;
        const note: Note = {
          id: n.id ?? sameText.get(`${n.kind}:${n.text}`) ?? newId(12),
          meetingId,
          itemId,
          kind: n.kind,
          text: n.text,
          owner: n.owner ?? null,
          ts: n.ts ?? ts,
          doneAt: d?.doneAt ?? null,
          doneBy: d?.doneBy ?? null,
          discussionId: n.discussionId ?? null,
          editedBy: n.editedBy ?? null,
        };
        st.run(
          note.id,
          meetingId,
          itemId,
          note.kind,
          note.text,
          note.owner,
          ts,
          note.doneAt,
          note.doneBy,
          note.discussionId,
          note.editedBy ?? null,
        );
        return note;
      });
    },
    /** The host's own wording for a note. Edited notes stay as written when the agent redrafts. */
    editNote(id: string, change: { text: string; owner: string | null }, by: string): Note | null {
      const before = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
      // The agent's old wording is replaced, so a redraft that writes it again doesn't add it twice.
      if (before && before.text !== change.text)
        db.prepare("INSERT INTO dismissed_notes (meeting_id, item_id, kind, text) VALUES (?, ?, ?, ?)").run(
          before.meeting_id as string,
          (before.item_id as string) ?? null,
          before.kind as string,
          before.text as string,
        );
      db.prepare("UPDATE notes SET text = ?, owner = ?, edited_by = ? WHERE id = ?").run(change.text, change.owner, by, id);
      const r = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
      return r ? toNote(r) : null;
    },
    /** Deletes a note and remembers it, so the agent doesn't write it again for this meeting. */
    removeNote(id: string): Note | null {
      const r = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
      if (!r) return null;
      db.prepare("INSERT INTO dismissed_notes (meeting_id, item_id, kind, text) VALUES (?, ?, ?, ?)").run(
        r.meeting_id as string,
        (r.item_id as string) ?? null,
        r.kind as string,
        r.text as string,
      );
      db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      return toNote(r);
    },
    /** by: who wrote it, which also keeps the agent's redrafts from rewording it; null for notes carried in as they were. */
    addNote(meetingId: string, itemId: string | null, n: { kind: NoteKind; text: string; owner: string | null }, by: string | null): Note {
      const note: Note = {
        id: newId(12),
        meetingId,
        itemId,
        kind: n.kind,
        text: n.text,
        owner: n.owner,
        ts: Date.now(),
        doneAt: null,
        doneBy: null,
        discussionId: null,
        editedBy: by,
      };
      db.prepare("INSERT INTO notes (id, meeting_id, item_id, kind, text, owner, ts, edited_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        note.id,
        meetingId,
        itemId,
        note.kind,
        note.text,
        note.owner,
        note.ts,
        by,
      );
      return note;
    },
    dismissedNotes(meetingId: string, itemId: string | null): Array<{ kind: NoteKind; text: string }> {
      return (
        db.prepare("SELECT kind, text FROM dismissed_notes WHERE meeting_id = ? AND item_id IS ?").all(meetingId, itemId) as Row[]
      ).map((r) => ({
        kind: r.kind as NoteKind,
        text: r.text as string,
      }));
    },
    /** Discussions for one item in one meeting are regenerated as a whole, with its notes. */
    replaceDiscussions(meetingId: string, itemId: string | null, drafts: DraftDiscussion[]): Discussion[] {
      // A topic that comes back under the same name keeps its id (see replaceNotes).
      const sameTopic = new Map(
        (db.prepare("SELECT id, topic FROM discussions WHERE meeting_id = ? AND item_id IS ?").all(meetingId, itemId) as Row[]).map((r) => [
          (r.topic as string).trim().toLowerCase(),
          r.id as string,
        ]),
      );
      db.prepare("DELETE FROM discussions WHERE meeting_id = ? AND item_id IS ?").run(meetingId, itemId);
      const st = db.prepare(
        "INSERT INTO discussions (id, meeting_id, item_id, topic, positions_json, outcome, segment_ids_json, continues_id, position, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const ts = Date.now();
      const used = new Set<string>();
      const ids = drafts.map((d, i) => {
        const prior = sameTopic.get(d.topic.trim().toLowerCase());
        const id = prior && !used.has(prior) ? prior : newId(12);
        used.add(id);
        st.run(id, meetingId, itemId, d.topic, JSON.stringify(d.positions), d.outcome, JSON.stringify(d.segmentIds), d.continuesId, i, ts);
        return id;
      });
      const byId = new Map(
        (db.prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? AND d.item_id IS ?`).all(meetingId, itemId) as Row[]).map((r) => [
          r.id as string,
          toDiscussion(r),
        ]),
      );
      return ids.map((id) => byId.get(id)!);
    },
    getDiscussion(id: string): Discussion | null {
      const r = db.prepare(`${DISCUSSION_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
      return r ? toDiscussion(r) : null;
    },
    meetingDiscussions(meetingId: string): Discussion[] {
      return (db.prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? ORDER BY d.ts, d.position`).all(meetingId) as Row[]).map(
        toDiscussion,
      );
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
        db
          .prepare(`${DISCUSSION_SELECT} JOIN items i ON i.id = d.item_id WHERE i.deck_id = ? ORDER BY d.ts, d.position`)
          .all(deckId) as Row[]
      ).map(toDiscussion);
    },

    /** Checks an action item off (by someone) or reopens it (by: null). */
    setActionDone(roomId: string, noteId: string, by: string | null): Note | null {
      const res = db
        .prepare(
          "UPDATE notes SET done_at = ?, done_by = ? WHERE id = ? AND kind = 'action' AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)",
        )
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
    /** What the agent drafts the next agenda from (see upNext.ts). */
    upNextInput(roomId: string, currentStart: number | null): UpNextInput {
      const meetings = (db.prepare("SELECT id, started_at, ended_at FROM meetings WHERE room_id = ?").all(roomId) as Row[]).map((m) => ({
        id: m.id as string,
        startedAt: m.started_at as number,
        endedAt: (m.ended_at as number) ?? null,
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
        updates: this.roomUpdates(roomId, 0, 500),
        dismissed,
        otherSpaces: meetings.some((m) => m.endedAt !== null) ? [] : this.sharedSpacesWithOpenWork(roomId),
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
    /** A space's open to-dos from finished meetings, oldest first. */
    openActions(roomId: string): Note[] {
      return (
        db
          .prepare(
            `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE m.room_id = ? AND m.ended_at IS NOT NULL AND n.kind = 'action' AND n.done_at IS NULL ORDER BY n.ts, n.rowid`,
          )
          .all(roomId) as Row[]
      ).map(toNote);
    },
    addSnap(s: Omit<SnapRow, "roomId" | "version" | "caption">): void {
      db.prepare(
        `INSERT INTO snaps (id, meeting_id, item_id, ts, ext, width, height, source, taken_by_id, taken_by, sharer_id, sharer_name, note_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        s.meetingId,
        s.itemId,
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
      );
    },
    getSnap(id: string): SnapRow | null {
      const r = db.prepare("SELECT s.*, m.room_id FROM snaps s JOIN meetings m ON m.id = s.meeting_id WHERE s.id = ?").get(id) as
        | Row
        | undefined;
      return r ? toSnapRow(r) : null;
    },
    meetingSnaps(meetingId: string): SnapRow[] {
      return (
        db
          .prepare("SELECT s.*, m.room_id FROM snaps s JOIN meetings m ON m.id = s.meeting_id WHERE s.meeting_id = ? ORDER BY s.ts")
          .all(meetingId) as Row[]
      ).map(toSnapRow);
    },
    /** An item's snaps across meetings, newest first. */
    itemSnaps(itemId: string, limit = 20): SnapRow[] {
      return (
        db
          .prepare(
            "SELECT s.*, m.room_id FROM snaps s JOIN meetings m ON m.id = s.meeting_id WHERE s.item_id = ? ORDER BY s.ts DESC LIMIT ?",
          )
          .all(itemId, limit) as Row[]
      ).map(toSnapRow);
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
    /** Puts a task that came off the agenda back at the end of it. */
    restoreItem(roomId: string, itemId: string): boolean {
      const max = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM items WHERE room_id = ? AND archived = 0").get(roomId) as Row)
        .p as number;
      return (
        db.prepare("UPDATE items SET archived = 0, position = ? WHERE id = ? AND room_id = ?").run(max + 1, itemId, roomId).changes > 0
      );
    },
    /** Moves a carried to-do or question onto an agenda item, so it shows (and can be checked off) there. */
    moveNote(noteId: string, itemId: string) {
      db.prepare("UPDATE notes SET item_id = ? WHERE id = ?").run(itemId, noteId);
    },
    meetingNotes(meetingId: string): Note[] {
      return (db.prepare("SELECT * FROM notes WHERE meeting_id = ? ORDER BY ts, rowid").all(meetingId) as Row[]).map(toNote);
    },

    // ---- agent access (Stand MCP) ----------------------------------------------

    /** A new token for this user's agent. The secret is returned once and only its hash is kept. */
    createToken(
      userId: string,
      label: string,
      scope: AgentToken["scope"],
      opts: { clientId?: string } = {},
    ): { token: string; info: AgentToken; refresh: string | null } {
      const token = `stand_pat_${randomBytes(24).toString("base64url")}`;
      // Tokens from the sign-in flow come with a refresh token, which the app
      // swaps for a fresh pair; typed tokens from the Connect page don't need one.
      const refresh = opts.clientId ? `stand_rt_${randomBytes(24).toString("base64url")}` : null;
      const id = newId(10);
      const now = Date.now();
      const hint = token.slice(0, 14);
      db.prepare(
        "INSERT INTO api_tokens (id, user_id, label, hash, hint, scope, created_at, client_id, refresh_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, userId, label, hashToken(token), hint, scope, now, opts.clientId ?? null, refresh ? hashToken(refresh) : null);
      return { token, info: { id, label, scope, hint, createdAt: now, lastUsedAt: null }, refresh };
    },
    listTokens(userId: string): AgentToken[] {
      return (
        db.prepare("SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(userId) as Row[]
      ).map(toToken);
    },
    revokeToken(userId: string, id: string): boolean {
      return (
        db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), id, userId)
          .changes > 0
      );
    },
    /** Swaps a refresh token for a new access and refresh token; the old pair stops working. */
    refreshToken(refresh: string, clientId: string): { token: string; refresh: string; scope: AgentToken["scope"] } | null {
      const r = db
        .prepare("SELECT * FROM api_tokens WHERE refresh_hash = ? AND client_id = ? AND revoked_at IS NULL")
        .get(hashToken(refresh), clientId) as Row | undefined;
      if (!r) return null;
      db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), r.id as string);
      const made = this.createToken(r.user_id as string, r.label as string, r.scope as AgentToken["scope"], { clientId });
      return { token: made.token, refresh: made.refresh!, scope: made.info.scope };
    },
    /** Signing in again from the same app replaces its earlier token rather than piling up. */
    revokeClientTokens(userId: string, clientId: string) {
      db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL").run(
        Date.now(),
        userId,
        clientId,
      );
    },
    registerClient(name: string, redirectUris: string[]): { id: string; name: string; redirectUris: string[]; createdAt: number } {
      const id = `stand_client_${newId(16)}`;
      const now = Date.now();
      db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        name,
        JSON.stringify(redirectUris),
        now,
      );
      return { id, name, redirectUris, createdAt: now };
    },
    getClient(id: string): { id: string; name: string; redirectUris: string[] } | null {
      const r = db.prepare("SELECT * FROM oauth_clients WHERE id = ?").get(id) as Row | undefined;
      return r ? { id: r.id as string, name: r.name as string, redirectUris: JSON.parse(r.redirect_uris as string) as string[] } : null;
    },
    createAuthCode(c: { clientId: string; userId: string; redirectUri: string; challenge: string; scope: AgentToken["scope"] }): string {
      const code = randomBytes(24).toString("base64url");
      db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(Date.now());
      db.prepare(
        "INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(hashToken(code), c.clientId, c.userId, c.redirectUri, c.challenge, c.scope, Date.now() + 5 * 60_000);
      return code;
    },
    /** A code works once: it's deleted as it's read. */
    takeAuthCode(code: string) {
      const r = db.prepare("DELETE FROM oauth_codes WHERE hash = ? RETURNING *").get(hashToken(code)) as Row | undefined;
      if (!r || (r.expires_at as number) < Date.now()) return null;
      return {
        clientId: r.client_id as string,
        userId: r.user_id as string,
        redirectUri: r.redirect_uri as string,
        challenge: r.challenge as string,
        scope: r.scope as AgentToken["scope"],
      };
    },
    /** The user and token behind a bearer token, or null if it's unknown or revoked. */
    tokenUser(token: string): { user: User; verified: boolean; token: AgentToken } | null {
      const r = db
        .prepare(
          `SELECT t.*, u.id AS u_id, u.email, u.name, u.picture, u.google_sub FROM api_tokens t JOIN users u ON u.id = t.user_id
           WHERE t.hash = ? AND t.revoked_at IS NULL`,
        )
        .get(hashToken(token)) as Row | undefined;
      if (!r) return null;
      const now = Date.now();
      // Last used is shown on the Connect an agent page; minute precision is plenty.
      if (!r.last_used_at || now - (r.last_used_at as number) > 60_000)
        db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, r.id as string);
      return {
        user: toUser({ id: r.u_id, email: r.email, name: r.name, picture: r.picture }),
        verified: Boolean(r.google_sub),
        token: toToken({ ...r, last_used_at: now }),
      };
    },

    isMember(roomId: string, userId: string): boolean {
      return Boolean(db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?").get(roomId, userId));
    },
    /** A note with the space and meeting it belongs to. */
    getNote(id: string): (Note & { roomId: string; meetingStartedAt: number; meetingEndedAt: number | null }) | null {
      const r = db
        .prepare(
          "SELECT n.*, m.room_id, m.started_at AS m_started, m.ended_at AS m_ended FROM notes n JOIN meetings m ON m.id = n.meeting_id WHERE n.id = ?",
        )
        .get(id) as Row | undefined;
      return r
        ? {
            ...toNote(r),
            roomId: r.room_id as string,
            meetingStartedAt: r.m_started as number,
            meetingEndedAt: (r.m_ended as number) ?? null,
          }
        : null;
    },
    /** Every note on an item across meetings, newest meeting first. */
    itemNotes(itemId: string): Array<Note & { meetingStartedAt: number }> {
      return (
        db
          .prepare(
            `SELECT n.*, m.started_at AS m_started FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE n.item_id = ? ORDER BY m.started_at DESC, n.rowid`,
          )
          .all(itemId) as Row[]
      ).map((r) => ({ ...toNote(r), meetingStartedAt: r.m_started as number }));
    },
    /** Open action items in the spaces this user is in, newest meeting first. */
    memberActions(userId: string): Array<Note & { roomId: string; roomName: string; meetingStartedAt: number }> {
      return (
        db
          .prepare(
            `SELECT n.*, m.room_id, r.name AS room_name, m.started_at AS m_started FROM notes n
             JOIN meetings m ON m.id = n.meeting_id JOIN rooms r ON r.id = m.room_id
             WHERE n.kind = 'action' AND m.room_id IN (SELECT room_id FROM room_members WHERE user_id = ?)
             ORDER BY m.started_at DESC, n.rowid LIMIT 2000`,
          )
          .all(userId) as Row[]
      ).map((r) => ({
        ...toNote(r),
        roomId: r.room_id as string,
        roomName: r.room_name as string,
        meetingStartedAt: r.m_started as number,
      }));
    },
    getSegments(ids: string[]): Segment[] {
      if (!ids.length) return [];
      const st = db.prepare("SELECT * FROM segments WHERE id = ?");
      return ids
        .map((id) => st.get(id) as Row | undefined)
        .filter((r): r is Row => !!r)
        .map(toSegment);
    },
    latestMeeting(roomId: string) {
      const r = db.prepare("SELECT id FROM meetings WHERE room_id = ? ORDER BY started_at DESC LIMIT 1").get(roomId) as Row | undefined;
      return r ? (r.id as string) : null;
    },

    addUpdate(u: Omit<ItemUpdate, "id" | "ts"> & { userId: string }): ItemUpdate {
      const update: ItemUpdate = {
        id: newId(12),
        roomId: u.roomId,
        itemId: u.itemId,
        noteId: u.noteId,
        noteText: u.noteText,
        userName: u.userName,
        client: u.client,
        status: u.status,
        text: u.text,
        links: u.links,
        ts: Date.now(),
      };
      db.prepare(
        "INSERT INTO updates (id, room_id, item_id, note_id, note_text, user_id, user_name, client, status, text, links_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        update.id,
        update.roomId,
        update.itemId,
        update.noteId,
        update.noteText,
        u.userId,
        update.userName,
        update.client,
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
    noteUpdates(noteId: string): ItemUpdate[] {
      return (db.prepare("SELECT * FROM updates WHERE note_id = ? ORDER BY ts DESC LIMIT 50").all(noteId) as Row[]).map(toUpdate);
    },
    /** When the meeting before this one started: "since last time" starts there. */
    previousMeetingStart(roomId: string, before: number): number | null {
      const r = db.prepare("SELECT MAX(started_at) AS t FROM meetings WHERE room_id = ? AND started_at < ?").get(roomId, before) as
        | Row
        | undefined;
      return (r?.t as number) ?? null;
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
            db
              .prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? AND d.item_id = ? ORDER BY d.position`)
              .all(m.id as string, itemId) as Row[]
          ).map(toDiscussion),
        };
      });
    },
  };
}
