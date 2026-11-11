// Notes (to-dos, decisions, open questions, context) and the discussions they are grouped in.
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../../shared/actors.ts";
import type { Discussion, FollowUp, Note, NoteKind, Quote, TaskState } from "../../shared/protocol.ts";
import { normalizeTopic, TOPIC_MAX } from "../../shared/topics.ts";
import { newId } from "../ids.ts";
import { DISCUSSION_SELECT, type DraftDiscussion, type Row, TASK_COLS, toDiscussion, toNote } from "./rows.ts";
import type { Tx } from "./tx.ts";

export function notesStore(db: DatabaseSync, tx: Tx) {
  return {
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
          quote?: Quote | null;
        }
      >,
    ): Note[] {
      return tx(() => {
        const done = new Map(
          (
            db
              .prepare("SELECT text, done_at, done_by FROM notes WHERE meeting_id = ? AND item_id IS ? AND done_at IS NOT NULL")
              .all(meetingId, itemId) as Row[]
          ).map((r) => [r.text as string, { doneAt: r.done_at as number, doneBy: (r.done_by as string) ?? null }]),
        );
        // Where a task stands comes back with it: by its id when a rewording kept it, else by its wording.
        const task = new Map(
          (
            db
              .prepare(
                `SELECT id, kind, text, ${TASK_COLS} FROM notes WHERE meeting_id = ? AND item_id IS ?
                 AND (state IS NOT NULL OR done_when IS NOT NULL OR parent_id IS NOT NULL OR closed_by IS NOT NULL OR said_done_json IS NOT NULL OR checked_at IS NOT NULL)`,
              )
              .all(meetingId, itemId) as Row[]
          ).flatMap((r) => [[`id:${r.id}`, r], [`${r.kind}:${r.text}`, r]] as const),
        );
        // A note that comes back with the same wording keeps its id, so references
        // agents hold (stand:question/<id>) survive the agent rewriting the notes.
        const sameText = new Map(
          (db.prepare("SELECT id, kind, text FROM notes WHERE meeting_id = ? AND item_id IS ?").all(meetingId, itemId) as Row[]).map((r) => [
            `${r.kind}:${r.text}`,
            r.id as string,
          ]),
        );
        // Who closed or added a note comes back the same way.
        const actors = new Map(
          (
            db
              .prepare(
                `SELECT id, kind, text, done_actor_json, added_actor_json FROM notes WHERE meeting_id = ? AND item_id IS ?
                 AND (done_actor_json IS NOT NULL OR added_actor_json IS NOT NULL)`,
              )
              .all(meetingId, itemId) as Row[]
          ).flatMap((r) => [[`id:${r.id}`, r], [`${r.kind}:${r.text}`, r]] as const),
        );
        // User grouping survives live note redrafts independently of the model's fields.
        const topics = db.prepare("SELECT id, kind, text, topic FROM notes WHERE meeting_id = ? AND item_id IS ? AND topic IS NOT NULL").all(meetingId, itemId) as Row[];
        db.prepare("DELETE FROM notes WHERE meeting_id = ? AND item_id IS ?").run(meetingId, itemId);
        const st = db.prepare(
          "INSERT INTO notes (id, meeting_id, item_id, kind, text, owner, ts, done_at, done_by, discussion_id, edited_by, quote_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const ts = Date.now();
        // A run can write the same note twice under one topic: keep one, the one already kept if either was.
        const keyOf = (n: (typeof notes)[number]) => `${n.discussionId ?? ""}\n${n.kind}\n${n.text}`;
        const one = new Map<string, (typeof notes)[number]>();
        for (const n of notes) if (!one.has(keyOf(n)) || (!one.get(keyOf(n))!.id && n.id)) one.set(keyOf(n), n);
        // Each id once: notes kept as they were hold theirs, and only one note can take an old wording's id.
        const taken = new Set(notes.flatMap((n) => (n.id ? [n.id] : [])));
        const used = new Set<string>();
        const idFor = (n: (typeof notes)[number]) => {
          if (n.id && !used.has(n.id)) return n.id;
          const old = sameText.get(`${n.kind}:${n.text}`);
          return old && !taken.has(old) && !used.has(old) ? old : newId(12);
        };
        return notes.flatMap((n) => {
          if (one.get(keyOf(n)) !== n) return [];
          const d = n.doneAt ? { doneAt: n.doneAt, doneBy: n.doneBy ?? null } : n.kind === "action" ? done.get(n.text) : undefined;
          const id = idFor(n);
          used.add(id);
          const note: Note = {
            id,
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
            quote: n.quote ?? null,
          };
          st.run(
            note.id,
            meetingId,
            itemId,
            note.kind,
            note.text,
            note.owner,
            note.ts,
            note.doneAt,
            note.doneBy,
            note.discussionId,
            note.editedBy ?? null,
            note.quote ? JSON.stringify(note.quote) : null,
          );
          // By the note's id when it kept one through a rewording, else by its wording.
          const a = actors.get(`id:${note.id}`) ?? actors.get(`${note.kind}:${note.text}`);
          if (a) db.prepare("UPDATE notes SET done_actor_json = ?, added_actor_json = ? WHERE id = ?").run(a.done_actor_json as string | null, a.added_actor_json as string | null, note.id);
          const t = task.get(`id:${note.id}`) ?? task.get(`${note.kind}:${note.text}`);
          if (t) {
            db.prepare(`UPDATE notes SET ${TASK_COLS.split(", ").map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
              ...TASK_COLS.split(", ").map((c) => (t[c] as string | number | null) ?? null),
              note.id,
            );
          }
          const grouping = topics.find((r) => r.id === note.id) ?? topics.find((r) => r.kind === note.kind && r.text === note.text);
          if (grouping) db.prepare("UPDATE notes SET topic = ? WHERE id = ?").run(grouping.topic as string, note.id);
          return [t || a || grouping ? toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as Row) : note];
        });
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
        // survive (see replaceNotes): by its name, or, when a run renamed it, by holding most of its lines.
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
    memberActions(userId: string): Array<Note & { roomId: string; roomName: string; meetingStartedAt: number; addedByHand: boolean }> {
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
      }));
    },
    /** Keeps who added a note by hand. */
    setAddedActor(noteId: string, actor: Actor) {
      db.prepare("UPDATE notes SET added_actor_json = ? WHERE id = ?").run(JSON.stringify(actor), noteId);
    },
  };
}
