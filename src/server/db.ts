// The server's SQLite database: one store per domain (db/*.ts), put together into one object.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initConxt } from "./conxt.ts";
import { initGithub } from "./github.ts";
import { initSources } from "./sources.ts";
import { migrate } from "./db/schema.ts";
import { transactions } from "./db/tx.ts";
import { agendaStore } from "./db/agenda.ts";
import { brainstormsStore } from "./db/brainstorms.ts";
import { capturesStore } from "./db/captures.ts";
import { chatStore } from "./db/chat.ts";
import { decksStore } from "./db/decks.ts";
import { meetingsStore } from "./db/meetings.ts";
import { notesStore } from "./db/notes.ts";
import { plansStore } from "./db/plans.ts";
import { projectsStore } from "./db/projects.ts";
import { reviewsStore } from "./db/reviews.ts";
import { roomsStore } from "./db/rooms.ts";
import { tokensStore } from "./db/tokens.ts";
import { upNextStore } from "./db/upNext.ts";
import { updatesStore } from "./db/updates.ts";
import { usersStore } from "./db/users.ts";

export { ProjectError } from "./db/projects.ts";
export { ParentError } from "./db/notes.ts";
export type { DraftDiscussion, IdeaSlideSaved, OpenMeeting, ReviewKind, ReviewRow, ReviewSlideRow } from "./db/rows.ts";

export type DB = ReturnType<typeof openDb>;

export function openDb(file?: string) {
  if (file && file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file ?? ":memory:");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  initConxt(db);
  initGithub(db);
  initSources(db);

  const tx = transactions(db);
  const users = usersStore(db);
  const tokens = tokensStore(db);
  const rooms = roomsStore(db);
  const agenda = agendaStore(db);
  const decks = decksStore(db, { agenda });
  const meetings = meetingsStore(db);
  const notes = notesStore(db, tx);
  const updates = updatesStore(db);
  const captures = capturesStore(db);
  const upNext = upNextStore(db, { updates, captures });
  const plans = plansStore(db);
  const projects = projectsStore(db);
  const brainstorms = brainstormsStore(db);
  const reviews = reviewsStore(db);
  const chat = chatStore(db);
  return {
    raw: db,
    tx,
    ...users,
    ...tokens,
    ...rooms,
    ...agenda,
    ...decks,
    ...meetings,
    ...notes,
    ...upNext,
    ...captures,
    ...plans,
    ...projects,
    ...brainstorms,
    ...reviews,
    ...updates,
    ...chat,
  };
}
