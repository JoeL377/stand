// A space's projects (shared/projects.ts): the list, what each note and agenda item is linked to, and
// what the rules read to work out the rest.
import type { DatabaseSync } from "node:sqlite";
import type { Item, Note } from "../../shared/protocol.ts";
import {
  firmProjectOf,
  normalizeProjectName,
  PROJECT_GOAL_MAX,
  PROJECT_NAME_MAX,
  type Project,
  type ProjectGraph,
  projectKey,
  projectOf,
  projectSuggestedOf,
  ruledProjectOf,
} from "../../shared/projects.ts";
import { newId } from "../ids.ts";
import { type Row, toItem, toNote } from "./rows.ts";

/** A mistake in what someone asked for, said so they can fix it. */
export class ProjectError extends Error {}

/** Which notes can be in a project. Context lines can't. */
const GROUPED = "('action', 'question', 'decision')";

const cleanName = (name: unknown) => {
  const n = normalizeProjectName(String(name ?? ""));
  if (!n) throw new ProjectError("A project needs a name.");
  if (n.length > PROJECT_NAME_MAX) throw new ProjectError(`A project's name is ${PROJECT_NAME_MAX} characters or fewer.`);
  return n;
};
const cleanGoal = (goal: unknown) => {
  if (goal == null) return null;
  const g = String(goal).replace(/\s+/g, " ").trim();
  if (g.length > PROJECT_GOAL_MAX) throw new ProjectError(`A project's goal is one line of ${PROJECT_GOAL_MAX} characters or fewer.`);
  return g || null;
};

export function projectsStore(db: DatabaseSync) {
  const row = (id: string) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  const byKey = (roomId: string, name: string) =>
    (db.prepare("SELECT * FROM projects WHERE room_id = ?").all(roomId) as Row[]).find((r) => projectKey(r.name as string) === projectKey(name));
  // The projects changed, so a note Stand found none for is worth reading again.
  const rejudge = (roomId: string) =>
    db
      .prepare("UPDATE notes SET project_judged_at = NULL WHERE suggested_project_id IS NULL AND project_judged_at IS NOT NULL AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)")
      .run(roomId);
  /** The open to-dos of a space's ended meetings: the ones a project counts. */
  const openTodoIds = (roomId: string) =>
    (
      db
        .prepare(
          `SELECT n.id FROM notes n JOIN meetings m ON m.id = n.meeting_id
           WHERE m.room_id = ? AND m.ended_at IS NOT NULL AND n.kind = 'action' AND n.done_at IS NULL`,
        )
        .all(roomId) as Row[]
    ).map((r) => r.id as string);

  const store = {
    /** What the rules read for a space: every item (archived ones too, so a task keeps its project after
     *  its item comes off the agenda), its decks, the to-do each review slide shows, and its notes. */
    projectGraph(roomId: string): ProjectGraph {
      const g: ProjectGraph = { items: {}, decks: {}, shows: {}, notes: {} };
      for (const r of db.prepare("SELECT id, project_id, note_id, deck_id FROM items WHERE room_id = ?").all(roomId) as Row[])
        g.items[r.id as string] = { projectId: (r.project_id as string) ?? null, taskId: (r.note_id as string) ?? null, deckId: (r.deck_id as string) ?? null };
      for (const r of db.prepare("SELECT id, parent_item_id FROM decks WHERE room_id = ?").all(roomId) as Row[])
        g.decks[r.id as string] = { parentItemId: (r.parent_item_id as string) ?? null };
      for (const r of db
        .prepare(
          `SELECT s.item_id, s.note_id FROM review_slides s JOIN reviews v ON v.id = s.review_id
           WHERE v.room_id = ? AND s.item_id IS NOT NULL AND s.note_id IS NOT NULL ORDER BY s.created_at`,
        )
        .all(roomId) as Row[])
        g.shows[r.item_id as string] ??= r.note_id as string;
      for (const r of db
        .prepare(
          `SELECT n.id, n.item_id, n.parent_id, n.project_id, n.project_set_by, n.suggested_project_id FROM notes n JOIN meetings m ON m.id = n.meeting_id
           WHERE m.room_id = ? AND n.kind IN ${GROUPED}`,
        )
        .all(roomId) as Row[])
        g.notes[r.id as string] = {
          id: r.id as string,
          itemId: (r.item_id as string) ?? null,
          parentId: (r.parent_id as string) ?? null,
          projectId: (r.project_id as string) ?? null,
          projectSetBy: (r.project_set_by as string) ?? null,
          suggestedProjectId: (r.suggested_project_id as string) ?? null,
        };
      return g;
    },

    /** The notes with the project each is in (project), what the rules alone give (ruledProject), and
     *  projectSuggested when the project is only Stand's suggestion. */
    withProjects<T extends Note>(roomId: string, notes: T[], graph?: ProjectGraph): T[] {
      if (!notes.length) return notes;
      const g = graph ?? store.projectGraph(roomId);
      return notes.map((n) => {
        if (n.kind === "context" || n.kind === "summary") return n;
        const ruledProject = ruledProjectOf(n, g);
        return { ...n, project: projectOf(n, g), ruledProject, ...(projectSuggestedOf(n, g) ? { projectSuggested: true } : {}) };
      });
    },

    /** A space's projects in order, archived ones too, each with its open to-dos. A project archived
     *  while it had none becomes active again once one is in it. */
    listProjects(roomId: string, graph?: ProjectGraph): Project[] {
      const rows = db.prepare("SELECT * FROM projects WHERE room_id = ? ORDER BY position, created_at").all(roomId) as Row[];
      if (!rows.length) return [];
      const g = graph ?? store.projectGraph(roomId);
      const open = new Map<string, number>();
      for (const id of openTodoIds(roomId)) {
        const n = g.notes[id];
        const p = n ? projectOf(n, g) : null;
        if (p) open.set(p, (open.get(p) ?? 0) + 1);
      }
      const revive = db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?");
      return rows.map((r) => {
        const id = r.id as string;
        const openTodos = open.get(id) ?? 0;
        if (r.archived_at != null && openTodos > 0) {
          revive.run(id);
          r.archived_at = null;
        }
        return {
          id,
          roomId: r.room_id as string,
          name: r.name as string,
          goal: (r.goal as string) ?? null,
          position: r.position as number,
          archived: r.archived_at != null,
          openTodos,
          createdBy: (r.created_by as string) ?? null,
          createdAt: r.created_at as number,
        };
      });
    },

    /** A project's name, without working out what is in it. */
    projectName(id: string): string | null {
      return (row(id)?.name as string) ?? null;
    },

    getProject(roomId: string, id: string): Project | null {
      return store.listProjects(roomId).find((p) => p.id === id) ?? null;
    },

    /** A project of the space by its name, whatever the case and spacing. */
    findProject(roomId: string, name: string): Project | null {
      const r = byKey(roomId, name);
      return r ? store.getProject(roomId, r.id as string) : null;
    },

    /** Makes a project, last in the list. A name an archived project has brings that one back instead.
     *  fromItemId: an agenda item to link to it ("Make project"). */
    createProject(roomId: string, input: { name: unknown; goal?: unknown; fromItemId?: string | null }, by: string | null): Project {
      const name = cleanName(input.name);
      const goal = input.goal === undefined ? undefined : cleanGoal(input.goal);
      const item = input.fromItemId ? db.prepare("SELECT id FROM items WHERE id = ? AND room_id = ?").get(input.fromItemId, roomId) : null;
      if (input.fromItemId && !item) throw new ProjectError("That agenda item isn't in this space.");
      const same = byKey(roomId, name);
      if (same && same.archived_at == null) throw new ProjectError(`There is already a project called ${same.name as string}.`);
      let id: string;
      if (same) {
        id = same.id as string;
        db.prepare("UPDATE projects SET archived_at = NULL, goal = COALESCE(?, goal) WHERE id = ?").run(goal ?? null, id);
      } else {
        id = newId(12);
        const end = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM projects WHERE room_id = ?").get(roomId) as Row).p as number;
        db.prepare("INSERT INTO projects (id, room_id, name, goal, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          id,
          roomId,
          name,
          goal ?? null,
          end + 1,
          by,
          Date.now(),
        );
      }
      if (input.fromItemId) db.prepare("UPDATE items SET project_id = ? WHERE id = ?").run(id, input.fromItemId);
      rejudge(roomId);
      return store.getProject(roomId, id)!;
    },

    /** Renames a project, changes its goal, moves it in the list, or archives it (only with no open
     *  to-dos in it firmly; Stand's suggestions don't count) or brings it back. Null when the space has no such project. */
    updateProject(roomId: string, id: string, change: { name?: unknown; goal?: unknown; position?: unknown; archived?: unknown }): Project | null {
      const r = row(id);
      if (!r || r.room_id !== roomId) return null;
      if (change.name !== undefined) {
        const name = cleanName(change.name);
        const same = byKey(roomId, name);
        if (same && same.id !== id) throw new ProjectError(`There is already a project called ${same.name as string}.`);
        db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      }
      if (change.goal !== undefined) db.prepare("UPDATE projects SET goal = ? WHERE id = ?").run(cleanGoal(change.goal), id);
      if (change.position !== undefined) {
        const to = Number(change.position);
        if (!Number.isInteger(to) || to < 0) throw new ProjectError("A position is a whole number from 0.");
        const ids = (db.prepare("SELECT id FROM projects WHERE room_id = ? ORDER BY position, created_at").all(roomId) as Row[])
          .map((x) => x.id as string)
          .filter((x) => x !== id);
        ids.splice(Math.min(to, ids.length), 0, id);
        const st = db.prepare("UPDATE projects SET position = ? WHERE id = ?");
        ids.forEach((x, i) => st.run(i, x));
      }
      if (change.archived !== undefined) {
        if (change.archived) {
          // Only what is in it firmly holds it: Stand's suggestions are taken off below.
          const g = store.projectGraph(roomId);
          const open = openTodoIds(roomId).filter((x) => g.notes[x] && firmProjectOf(g.notes[x], g) === id).length;
          if (open > 0) throw new ProjectError(`This project has ${open} open ${open === 1 ? "to-do" : "to-dos"}. Close or move ${open === 1 ? "it" : "them"} first.`);
          db.prepare("UPDATE projects SET archived_at = COALESCE(archived_at, ?) WHERE id = ?").run(Date.now(), id);
          // A suggestion would bring it back once its to-do opens again (listProjects).
          db.prepare("UPDATE notes SET suggested_project_id = NULL WHERE suggested_project_id = ?").run(id);
        } else db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").run(id);
      }
      if (change.name !== undefined || change.goal !== undefined || (change.archived !== undefined && !change.archived && r.archived_at != null)) rejudge(roomId);
      return store.getProject(roomId, id);
    },

    /** Puts these projects first, in this order. The others keep their order after them. */
    orderProjects(roomId: string, ids: string[]): Project[] {
      const all = (db.prepare("SELECT id FROM projects WHERE room_id = ? ORDER BY position, created_at").all(roomId) as Row[]).map((x) => x.id as string);
      const first = [...new Set(ids)];
      const stranger = first.find((id) => !all.includes(id));
      if (stranger) throw new ProjectError("That project isn't in this space.");
      const order = [...first, ...all.filter((id) => !first.includes(id))];
      const st = db.prepare("UPDATE projects SET position = ? WHERE id = ?");
      db.exec("BEGIN");
      try {
        order.forEach((id, i) => st.run(i, id));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return store.listProjects(roomId);
    },

    /** The projects this person pinned in the space. A pin is theirs alone: nobody else sees it. */
    pinnedProjects(roomId: string, userId: string): string[] {
      return (db.prepare("SELECT project_id FROM project_pins WHERE room_id = ? AND user_id = ?").all(roomId, userId) as Row[]).map((r) => r.project_id as string);
    },
    /** Pins or unpins a project for one person. False when the space has no such project. */
    pinProject(roomId: string, userId: string, id: string, pinned: boolean): boolean {
      const r = row(id);
      if (!r || r.room_id !== roomId) return false;
      if (pinned) db.prepare("INSERT OR IGNORE INTO project_pins (room_id, user_id, project_id) VALUES (?, ?, ?)").run(roomId, userId, id);
      else db.prepare("DELETE FROM project_pins WHERE room_id = ? AND user_id = ? AND project_id = ?").run(roomId, userId, id);
      return true;
    },

    /** Deletes a project. Its tasks and agenda items lose the link, and the tasks follow the rules again. */
    deleteProject(roomId: string, id: string): boolean {
      const r = row(id);
      if (!r || r.room_id !== roomId) return false;
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE notes SET project_id = NULL, project_set_by = NULL WHERE project_id = ?").run(id);
        db.prepare("UPDATE notes SET suggested_project_id = NULL WHERE suggested_project_id = ?").run(id);
        db.prepare("UPDATE items SET project_id = NULL WHERE project_id = ? AND room_id = ?").run(id, roomId);
        db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        db.prepare("DELETE FROM project_pins WHERE project_id = ?").run(id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return true;
    },

    /** Sets a to-do's, open question's or decision's project by hand: a project, or null for Unassigned.
     *  auto: back to the rules. A task put into an archived project brings it back. */
    setNoteProject(roomId: string, noteId: string, choice: { projectId: string | null; by: string } | { auto: true }): Note | null {
      if ("auto" in choice) {
        const res = db
          .prepare(`UPDATE notes SET project_id = NULL, project_set_by = NULL WHERE id = ? AND kind IN ${GROUPED} AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)`)
          .run(noteId, roomId);
        return res.changes ? toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row) : null;
      }
      if (choice.projectId) {
        const p = row(choice.projectId);
        if (!p || p.room_id !== roomId) throw new ProjectError("That project isn't in this space.");
      }
      const res = db
        .prepare(`UPDATE notes SET project_id = ?, project_set_by = ? WHERE id = ? AND kind IN ${GROUPED} AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)`)
        .run(choice.projectId, choice.by, noteId, roomId);
      if (!res.changes) return null;
      if (choice.projectId) db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").run(choice.projectId);
      return toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row);
    },

    /** Stand's suggestion for a to-do's, open question's or decision's project (rule 4), or null to
     *  take it off. It never changes what was set by hand. */
    suggestNoteProject(roomId: string, noteId: string, projectId: string | null): Note | null {
      if (projectId) {
        const p = row(projectId);
        if (!p || p.room_id !== roomId) throw new ProjectError("That project isn't in this space.");
        if (p.archived_at != null) throw new ProjectError("That project is archived.");
      }
      const res = db
        .prepare(`UPDATE notes SET suggested_project_id = ? WHERE id = ? AND kind IN ${GROUPED} AND meeting_id IN (SELECT id FROM meetings WHERE room_id = ?)`)
        .run(projectId, noteId, roomId);
      return res.changes ? toNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row) : null;
    },

    /** Moves a carried to-do or question onto an agenda item, like moveNote. When the new item gives it
     *  no project and nobody set one by hand, the project it had stays as Stand's suggestion. */
    moveNoteKeepingProject(roomId: string, noteId: string, itemId: string | null) {
      const g = store.projectGraph(roomId);
      const n = g.notes[noteId];
      const before = n ? projectOf(n, g) : null;
      db.prepare("UPDATE notes SET item_id = ? WHERE id = ?").run(itemId, noteId);
      if (!n || !before || n.projectSetBy != null || row(before)?.archived_at != null) return;
      n.itemId = itemId;
      if (!ruledProjectOf(n, g)) db.prepare("UPDATE notes SET suggested_project_id = ? WHERE id = ?").run(before, noteId);
    },

    /** What the project pass asks about (projectSuggest.ts), newest first: open to-dos and open questions
     *  of the space's ended meetings that nobody filed, Stand never read, and the rules give no project. */
    projectCandidates(roomId: string, limit = 120): Note[] {
      const rows = db
        .prepare(
          `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
           WHERE m.room_id = ? AND m.ended_at IS NOT NULL AND n.kind IN ('action', 'question') AND n.done_at IS NULL
             AND n.project_set_by IS NULL AND n.suggested_project_id IS NULL AND n.project_judged_at IS NULL
           ORDER BY n.ts DESC, n.rowid DESC`,
        )
        .all(roomId) as Row[];
      if (!rows.length) return [];
      const g = store.projectGraph(roomId);
      return rows
        .map(toNote)
        .filter((n) => !g.notes[n.id] || !projectOf(g.notes[n.id], g))
        .slice(0, limit);
    },

    /** Whether nobody filed the note yet, by hand or by a suggestion. */
    projectUnfiled(noteId: string): boolean {
      return !!db.prepare("SELECT 1 FROM notes WHERE id = ? AND project_set_by IS NULL AND suggested_project_id IS NULL").get(noteId);
    },

    /** The project pass read these notes, so it doesn't ask about them again. */
    markProjectJudged(noteIds: string[], at: number) {
      const st = db.prepare("UPDATE notes SET project_judged_at = ? WHERE id = ?");
      for (const id of noteIds) st.run(at, id);
    },

    /** Spaces with an active project. */
    roomsWithProjects(): string[] {
      return (db.prepare("SELECT DISTINCT room_id FROM projects WHERE archived_at IS NULL").all() as Row[]).map((r) => r.room_id as string);
    },

    /** Links an agenda item to a project, or takes the link off (null). */
    setItemProject(roomId: string, itemId: string, projectId: string | null): Item | null {
      if (projectId) {
        const p = row(projectId);
        if (!p || p.room_id !== roomId) throw new ProjectError("That project isn't in this space.");
      }
      const res = db.prepare("UPDATE items SET project_id = ? WHERE id = ? AND room_id = ?").run(projectId, itemId, roomId);
      return res.changes ? toItem(db.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as Row) : null;
    },
  };
  return store;
}
