// People tagged with @Name in a task comment. The task goes first in their task list until they
// comment on it, dismiss it, or it closes. Their agent sees it too (list_my_work, whats_new).

import type { ItemUpdate, TaskMention } from "../shared/protocol.ts";
import { mentionedIn } from "../shared/mentions.ts";
import type { DB } from "./db.ts";

/** Keeps who a new comment tags, and clears what waited on its author there: a reply answers it.
 *  Returns the names of the people tagged. */
export function recordMentions(db: DB, update: ItemUpdate, authorId: string): string[] {
  if (update.status !== "comment" || !update.noteId) return [];
  db.clearMentions(update.noteId, authorId);
  const people = db.roomPeople(update.roomId);
  const ids = mentionedIn(update.text, people).filter((id) => id !== authorId);
  db.addMentions(update, ids);
  return ids.map((id) => people.find((p) => p.id === id)!.name);
}

export const mentionView = (u: ItemUpdate & { noteId: string }): TaskMention => ({
  noteId: u.noteId,
  updateId: u.id,
  by: u.client ? `${u.userName} via ${u.client}` : u.userName,
  text: u.text,
  ts: u.ts,
});
