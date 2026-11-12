// Notes (to-dos, decisions, open questions, context) and the discussions they are grouped in.
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../../shared/actors.ts";
import type { Discussion, FollowUp, Note, NoteKind, Quote, TaskState } from "../../shared/protocol.ts";
import { normalizeTopic, TOPIC_MAX } from "../../shared/topics.ts";
import { newId } from "../ids.ts";
import { DISCUSSION_SELECT, type DraftDiscussion, type Row, TASK_COLS, toDiscussion, toNote } from "./rows.ts";
import type { Tx } from "./tx.ts";

/** Whether a person or an agent did something with a note, so a notes run must not delete it: it
 *  was ticked, edited, given a topic or a task state, added by someone, or something hangs on it
 *  (a plan, an update or comment, a mention, a screenshot, a link, a check, a slide, an agenda item). */
function actedOnBy(db: DatabaseSync) {
  const own = db.prepare(
    `SELECT 1 FROM notes WHERE id = ? AND (done_at IS NOT NULL OR edited_by IS NOT NULL OR topic IS NOT NULL OR added_actor_json IS NOT NULL
       OR state IS NOT NULL OR done_when IS NOT NULL OR parent_id IS NOT NULL OR closed_by IS NOT NULL OR said_done_json IS NOT NULL OR checked_at IS NOT NULL)`,
  );
  const hangs = db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM task_plans WHERE note_id = ?1) OR EXISTS (SELECT 1 FROM updates WHERE note_id = ?1)
       OR EXISTS (SELECT 1 FROM mentions WHERE note_id = ?1) OR EXISTS (SELECT 1 FROM work_shots WHERE note_id = ?1)
       OR EXISTS (SELECT 1 FROM links WHERE from_id = ?1 OR to_id = ?1) OR EXISTS (SELECT 1 FROM decision_checks WHERE note_id = ?1)
       OR EXISTS (SELECT 1 FROM review_slides WHERE note_id = ?1) OR EXISTS (SELECT 1 FROM items WHERE note_id = ?1)
       OR EXISTS (SELECT 1 FROM brainstorms WHERE task_id = ?1)`,
  );
  return (id: string) => !!own.get(id) || !!hangs.get(id);
}

export function notesStore(db: DatabaseSync, tx: Tx) {
  const actedOn = actedOnBy(db);
  return {
    /** Whether someone did something with a note (see actedOnBy), so it is theirs to close, not to delete. */
    noteActedOn(id: string): boolean {
      return actedOn(id);
    },
    /** Writes a notes run for one item in one meeting. Each note updates the row it continues (by
     *  its id, else by its exact wording) or is added, so a note keeps its id, its tick, where its
     *  task stands, its topic and who did what through every run, reworded or not. A row the run
     *  left out goes only if nobody acted on it (see actedOn). Returns the item's notes: the run's,
     *  in its order, then the ones kept for what was done with them. */
    syncNotes(
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
          quote?: Quote | null;
        }
      >,
    ): Note[] {
      return tx(() => {
        const rows = db.prepare("SELECT id, kind, text FROM notes WHERE meeting_id = ? AND item_id IS ?").all(meetingId, itemId) as Row[];
        const here = new Set(rows.map((r) => r.id as string));
        const sameText = new Map(rows.map((r) => [`${r.kind}:${r.text}`, r.id as string]));
        // A run can write the same note twice under one topic: keep one, the one already kept if either was.
        const keyOf = (n: (typeof notes)[number]) => `${n.discussionId ?? ""}\n${n.kind}\n${n.text}`;
        const one = new Map<string, (typeof notes)[number]>();
        for (const n of notes) if (!one.has(keyOf(n)) || (!one.get(keyOf(n))!.id && n.id)) one.set(keyOf(n), n);
        // Each row once: notes that name theirs hold it, and only one note can take an old wording's row.
        const named = new Set(notes.flatMap((n) => (n.id && here.has(n.id) ? [n.id] : [])));
        const used = new Set<string>();
        const rowFor = (n: (typeof notes)[number]) => {
          if (n.id && here.has(n.id) && !used.has(n.id)) return n.id;
          const old = sameText.get(`${n.kind}:${n.text}`);
          return old && !named.has(old) && !used.has(old) ? old : null;
        };
        // People own a tick, an edit and what a task's state is: a run carries them, never takes them off.
        const update = db.prepare(
          `UPDATE notes SET kind = ?, text = ?, owner = ?, ts = COALESCE(?, ts), discussion_id = ?,
             edited_by = COALESCE(?, edited_by), quote_json = COALESCE(?, quote_json),
             done_at = COALESCE(done_at, ?), done_by = CASE WHEN done_at IS NULL THEN ? ELSE done_by END
           WHERE id = ?`,
        );
        const insert = db.prepare(
          "INSERT INTO notes (id, meeting_id, item_id, kind, text, owner, ts, done_at, done_by, discussion_id, edited_by, quote_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const now = Date.now();
        const ids: string[] = [];
        for (const n of notes) {
          if (one.get(keyOf(n)) !== n) continue;
          const quote = n.quote ? JSON.stringify(n.quote) : null;
          let id = rowFor(n);
          if (id) update.run(n.kind, n.text, n.owner ?? null, n.ts ?? null, n.discussionId ?? null, n.editedBy ?? null, quote, n.doneAt ?? null, n.doneBy ?? null, id);
          else {
            // A new row keeps an id the note brings from elsewhere (a carried note), when it's free.
            id = n.id && !db.prepare("SELECT 1 FROM notes WHERE id = ?").get(n.id) ? n.id : newId(12);
            insert.run(id, meetingId, itemId, n.kind, n.text, n.owner ?? null, n.ts ?? now, n.doneAt ?? null, n.doneAt ? (n.doneBy ?? null) : null, n.discussionId ?? null, n.editedBy ?? null, quote);
          }
          used.add(id);
          ids.push(id);
        }
        const kept: string[] = [];
        for (const r of rows) {
          const id = r.id as string;
          if (used.has(id)) continue;
          if (actedOn(id)) kept.push(id);
          else db.prepare("DELETE FROM notes WHERE id = ?").run(id);
        }
        const read = db.prepare("SELECT * FROM notes WHERE id = ?");
        return [...ids, ...kept].map((id) => toNote(read.get(id) as Row));
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
    /** Undoes removeNote: the note comes back as it was, and the agent may write it again. */
    restoreNote(n: Note) {
      db.prepare(
        `INSERT OR IGNORE INTO notes (id, meeting_id, item_id, kind, text, owner, ts, done_at, done_by, discussion_id, edited_by, ${TASK_COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        n.id, n.meetingId, n.itemId, n.kind, n.text, n.owner, n.ts, n.doneAt, n.doneBy, n.discussionId, n.editedBy ?? null,
        n.state ?? null, n.doneWhen ?? null, n.parentId ?? null, n.closedBy ?? null, n.dropReason ?? null,
        n.saidDone ? JSON.stringify(n.saidDone) : null, n.checkedAt ?? null,
      );
      db.prepare("UPDATE notes SET topic = ? WHERE id = ?").run(n.topic ?? null, n.id);
      db.prepare("UPDATE notes SET done_actor_json = ?, added_actor_json = ? WHERE id = ?").run(
        n.doneAt && n.doneActor ? JSON.stringify(n.doneActor) : null,
        n.addedActor ? JSON.stringify(n.addedActor) : null,
        n.id,
      );
      db.prepare(
        "DELETE FROM dismissed_notes WHERE rowid IN (SELECT rowid FROM dismissed_notes WHERE meeting_id = ? AND item_id IS ? AND kind = ? AND text = ? LIMIT 1)",
      ).run(n.meetingId, n.itemId, n.kind, n.text);
    },
    /** A to-do someone added by hand, outside any meeting. */
    addTask(roomId: string, t: { text: string; owner: string | null; itemId: string | null }, by: string): Note {
      return this.addOutsideMeeting(roomId, { kind: "action", ...t }, by);
    },
    /** Every note belongs to a meeting, so one added by hand gets a holder of its own (meetings.kind
     *  "added", started and ended now) that lists of meetings leave out; everything that lists a
     *  space's notes then finds it like any other. */
    addOutsideMeeting(roomId: string, n: { kind: NoteKind; text: string; owner: string | null; itemId: string | null }, by: string): Note {
      const at = Date.now();
      const meetingId = newId();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO meetings (id, room_id, started_at, ended_at, kind) VALUES (?, ?, ?, ?, 'added')").run(meetingId, roomId, at, at);
        const note = this.addNote(meetingId, n.itemId, { kind: n.kind, text: n.text, owner: n.owner }, by);
        db.exec("COMMIT");
        return note;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
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
      return tx(() => {
        // A topic that comes back keeps its id, so references agents hold and the board's place in it
        // survive (see syncNotes): by its name, or, when a run renamed it, by holding most of its lines.
        const prior = (
          db.prepare("SELECT id, topic, segment_ids_json FROM discussions WHERE meeting_id = ? AND item_id IS ?").all(meetingId, itemId) as Row[]
        ).map((r) => ({ id: r.id as string, name: (r.topic as string).trim().toLowerCase(), lines: new Set(JSON.parse(r.segment_ids_json as string) as string[]) }));
        db.prepare("DELETE FROM discussions WHERE meeting_id = ? AND item_id IS ?").run(meetingId, itemId);
        const st = db.prepare(
          "INSERT INTO discussions (id, meeting_id, item_id, topic, positions_json, outcome, segment_ids_json, continues_id, position, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const ts = Date.now();
        const used = new Set(drafts.flatMap((d) => (d.id ? [d.id] : [])));
        const ids: Array<string | undefined> = drafts.map((d) => d.id);
        drafts.forEach((d, i) => {
          const same = prior.find((p) => p.name === d.topic.trim().toLowerCase() && !used.has(p.id));
          if (ids[i] || !same) return;
          ids[i] = same.id;
          used.add(same.id);
        });
        const overlaps = drafts
          .flatMap((d, i) =>
            prior.map((p) => ({ i, p, n: d.segmentIds.filter((s) => p.lines.has(s)).length, least: Math.min(d.segmentIds.length, p.lines.size) })),
          )
          .filter((o) => o.n > 0 && o.n * 2 >= o.least)
          .sort((a, b) => b.n - a.n);
        for (const o of overlaps) {
          if (ids[o.i] || used.has(o.p.id)) continue;
          ids[o.i] = o.p.id;
          used.add(o.p.id);
        }
        drafts.forEach((d, i) => {
          const id = ids[i] ?? newId(12);
          ids[i] = id;
          st.run(id, meetingId, itemId, d.topic, JSON.stringify(d.positions), d.outcome, JSON.stringify(d.segmentIds), d.continuesId, i, ts);
        });
        const byId = new Map(
          (db.prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? AND d.item_id IS ?`).all(meetingId, itemId) as Row[]).map((r) => [
            r.id as string,
            toDiscussion(r),
          ]),
        );
        return ids.map((id) => byId.get(id!)!);
      });
    },
    /** Where each smaller topic of a meeting sits on the board, replacing the last grouping. */
    replaceTopicMerges(meetingId: string, merges: Array<{ discussionId: string; parentId: string | null; group: string | null }>) {
      db.prepare("DELETE FROM topic_merges WHERE meeting_id = ?").run(meetingId);
      const st = db.prepare("INSERT OR REPLACE INTO topic_merges (meeting_id, discussion_id, parent_id, group_title) VALUES (?, ?, ?, ?)");
      for (const m of merges) st.run(meetingId, m.discussionId, m.parentId, m.group);
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
    /** Checks an action item off (by someone) or reopens it (by: null). closedBy: what closed it
     *  (shared/tasks.ts), "confirmed" when a person ticked it with nothing to show. */
    setActionDone(roomId: string, noteId: string, by: string | null, closedBy = "confirmed", actor: Actor | null = null): Note | null {
      const res = db
        .prepare(
          `UPDATE notes SET done_at = ?, done_by = ?, done_actor_json = ?, state = ?, closed_by = ?, drop_reason = NULL
           WHERE id = ? AND kind = 'action' AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)`,
        )
        .run(by ? Date.now() : null, by, by && actor ? JSON.stringify(actor) : null, by ? "done" : null, by ? closedBy : null, noteId, roomId);
      if (!res.changes) return null;
      return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row);
    },
    /** A user-selected topic, kept apart from source and task state. */
    setNoteTopic(roomId: string, noteId: string, topic: string | null): Note | null {
      const value = topic === null ? null : normalizeTopic(topic);
      if (value !== null && value.length > TOPIC_MAX) throw new Error(`Topics must be ${TOPIC_MAX} characters or fewer`);
      const result = db.prepare(
        `UPDATE notes SET topic = ? WHERE id = ? AND kind IN ('action', 'question', 'decision')
         AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)`,
      ).run(value, noteId, roomId);
      return result.changes ? toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row) : null;
    },
    /** Moves a to-do or open question to a state by hand: done (with what closed it), dropped (with
     *  why), doing, or open again. "Still on it" is open with checkedAt, so a check-in counts it answered;
     *  checked false clears that (Undo), undefined leaves it. */
    setTaskState(
      roomId: string,
      noteId: string,
      change: { state: TaskState; by: string; actor?: Actor | null; closedBy?: string | null; reason?: string | null; checked?: boolean },
    ): Note | null {
      const closed = change.state === "done" || change.state === "dropped";
      const res = db
        .prepare(
          `UPDATE notes SET state = ?, done_at = ?, done_by = ?, done_actor_json = ?, closed_by = ?, drop_reason = ?, checked_at = CASE WHEN ? = 'keep' THEN checked_at ELSE ? END
           WHERE id = ? AND kind IN ('action', 'question') AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)`,
        )
        .run(
          change.state === "open" ? null : change.state,
          closed ? Date.now() : null,
          closed ? change.by : null,
          closed && change.actor ? JSON.stringify(change.actor) : null,
          change.state === "done" ? (change.closedBy ?? "confirmed") : null,
          change.state === "dropped" ? (change.reason ?? null) : null,
          change.checked === undefined ? "keep" : "set",
          change.checked ? Date.now() : null,
          noteId,
          roomId,
        );
      if (!res.changes) return null;
      return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row);
    },
    /** Someone said a task is finished (quote), or that was undone (null). It stays open until evidence or a click closes it. */
    setSaidDone(roomId: string, noteId: string, quote: Quote | null): Note | null {
      const res = db
        .prepare("UPDATE notes SET said_done_json = ? WHERE id = ? AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)")
        .run(quote ? JSON.stringify(quote) : null, noteId, roomId);
      if (!res.changes) return null;
      return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row);
    },
    /** Open questions from a space's finished meetings, oldest first, for the Tasks tab. */
    roomQuestions(roomId: string): Array<Note & { meetingStartedAt: number }> {
      return (
        db
          .prepare(
            `SELECT n.*, m.started_at AS meeting_started_at FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE m.room_id = ? AND m.ended_at IS NOT NULL AND n.kind = 'question' ORDER BY m.started_at DESC, n.rowid`,
          )
          .all(roomId) as Row[]
      ).map((r) => ({ ...toNote(r), meetingStartedAt: r.meeting_started_at as number }));
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
    spaceContext(roomId: string, limit = 100): Note[] {
      return (
        db
          .prepare(
            `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE m.room_id = ? AND n.kind = 'context'
               AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_id = n.id AND l.relation = 'replaces')
             ORDER BY n.ts DESC, n.rowid DESC LIMIT ?`,
          )
          .all(roomId, limit) as Row[]
      ).map(toNote);
    },
    spaceNotes(roomId: string, kind: NoteKind, limit = 20): Note[] {
      return (
        db
          .prepare(
            `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE m.room_id = ? AND m.ended_at IS NOT NULL AND n.kind = ? ORDER BY n.ts DESC, n.rowid DESC LIMIT ?`,
          )
          .all(roomId, kind, limit) as Row[]
      ).map(toNote);
    },
    /** To-dos and open questions in a space done or dropped since a time (not ones moved to another space), oldest first. */
    closedTasksSince(roomId: string, since: number): Array<Note & { meetingStartedAt: number; itemTitle: string | null }> {
      return (
        db
          .prepare(
            `SELECT n.*, m.started_at AS meeting_started_at, i.title AS item_title FROM notes n
             JOIN meetings m ON m.id = n.meeting_id LEFT JOIN items i ON i.id = n.item_id
             WHERE m.room_id = ? AND n.kind IN ('action', 'question') AND n.done_at >= ?
               AND (n.closed_by IS NULL OR n.closed_by != 'moved')
             ORDER BY n.done_at, n.rowid`,
          )
          .all(roomId, since) as Row[]
      ).map((r) => ({ ...toNote(r), meetingStartedAt: r.meeting_started_at as number, itemTitle: (r.item_title as string) ?? null }));
    },
    /** Spaces with a task closed since a time, for the "Done since" sweep. */
    roomsWithClosesSince(since: number): string[] {
      return (
        db
          .prepare(
            `SELECT DISTINCT m.room_id FROM notes n JOIN meetings m ON m.id = n.meeting_id
             WHERE n.kind IN ('action', 'question') AND n.done_at >= ?`,
          )
          .all(since) as Row[]
      ).map((r) => r.room_id as string);
    },
    /** Moves a carried to-do or question onto an agenda item, so it shows (and can be checked off) there. */
    moveNote(noteId: string, itemId: string | null) {
      db.prepare("UPDATE notes SET item_id = ? WHERE id = ?").run(itemId, noteId);
    },
    meetingNotes(meetingId: string): Note[] {
      return (db.prepare("SELECT * FROM notes WHERE meeting_id = ? ORDER BY ts, rowid").all(meetingId) as Row[]).map(toNote);
    },
    /** A note with the space and meeting it belongs to. */
    notesByIds(ids: string[]): Note[] {
      if (!ids.length) return [];
      return (db.prepare(`SELECT * FROM notes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]).map(toNote);
    },
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
    memberActions(userId: string): Array<Note & { roomId: string; roomName: string; meetingStartedAt: number; addedByHand: boolean; fromChat: boolean }> {
      return (
        db
          .prepare(
            `SELECT n.*, m.room_id, r.name AS room_name, m.started_at AS m_started, m.kind AS m_kind FROM notes n
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
        addedByHand: r.m_kind === "added",
        fromChat: r.m_kind === "chat",
      }));
    },
    /** Keeps who added a note by hand. */
    setAddedActor(noteId: string, actor: Actor) {
      db.prepare("UPDATE notes SET added_actor_json = ? WHERE id = ?").run(JSON.stringify(actor), noteId);
    },
  };
}
