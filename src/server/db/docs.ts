// Docs: write-ups saved to a space (shared/artifacts.ts). The one kind of artifact Stand stores
// as itself; the others are read from what their own tables keep.
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../../shared/actors.ts";
import { newId } from "../ids.ts";
import type { Row } from "./rows.ts";

export interface DocRow {
  id: string;
  roomId: string;
  title: string;
  text: string;
  projectId: string | null;
  noteId: string | null;
  by: string;
  actor: Actor | null;
  createdAt: number;
  updatedAt: number;
  /** How many times it was saved. */
  versions: number;
}

const toDoc = (r: Row): DocRow => ({
  id: r.id as string,
  roomId: r.room_id as string,
  title: r.title as string,
  text: r.text as string,
  projectId: (r.project_id as string) ?? null,
  noteId: (r.note_id as string) ?? null,
  by: r.made_by as string,
  actor: r.made_actor_json ? (JSON.parse(r.made_actor_json as string) as Actor) : null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  versions: (r.versions as number) ?? 1,
});

export function docsStore(db: DatabaseSync) {
  const get = (id: string) => {
    const r = db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as Row | undefined;
    return r ? toDoc(r) : null;
  };
  return {
    getDoc: get,
    /** A space's docs, the last changed first. */
    roomDocs(roomId: string, limit = 200): DocRow[] {
      return (db.prepare("SELECT * FROM docs WHERE room_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(roomId, limit) as Row[]).map(toDoc);
    },
    addDoc(d: { roomId: string; title: string; text: string; projectId: string | null; noteId: string | null; by: string; actor: Actor | null }, now = Date.now()): DocRow {
      const id = newId(12);
      db.prepare("INSERT INTO docs (id, room_id, title, text, project_id, note_id, made_by, made_actor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        d.roomId,
        d.title,
        d.text,
        d.projectId,
        d.noteId,
        d.by,
        d.actor ? JSON.stringify(d.actor) : null,
        now,
        now,
      );
      return get(id)!;
    },
    /** Saves a doc again: new text, and a new title, project or to-do when given. Who made it stays. */
    rewriteDoc(id: string, d: { title?: string; text: string; projectId?: string | null; noteId?: string | null }, now = Date.now()): DocRow | null {
      const had = get(id);
      if (!had) return null;
      db.prepare("UPDATE docs SET title = ?, text = ?, project_id = ?, note_id = ?, updated_at = ?, versions = versions + 1 WHERE id = ?").run(
        d.title ?? had.title,
        d.text,
        d.projectId === undefined ? had.projectId : d.projectId,
        d.noteId === undefined ? had.noteId : d.noteId,
        now,
        id,
      );
      // A project given on a save is the newest word on where it belongs.
      if (d.projectId !== undefined) db.prepare("DELETE FROM artifact_projects WHERE room_id = ? AND artifact_id = ?").run(had.roomId, `doc:${id}`);
      return get(id);
    },
    /** Where people moved a doc, a deck or a sketch by hand, by artifact id. null: to Unassigned. */
    artifactProjects(roomId: string): Map<string, string | null> {
      const rows = db.prepare("SELECT artifact_id, project_id FROM artifact_projects WHERE room_id = ?").all(roomId) as Row[];
      return new Map(rows.map((r) => [r.artifact_id as string, (r.project_id as string) ?? null]));
    },
    setArtifactProject(roomId: string, artifactId: string, projectId: string | null, by: string, now = Date.now()): void {
      db.prepare(
        "INSERT INTO artifact_projects (room_id, artifact_id, project_id, set_by, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (room_id, artifact_id) DO UPDATE SET project_id = excluded.project_id, set_by = excluded.set_by, set_at = excluded.set_at",
      ).run(roomId, artifactId, projectId, by, now);
    },
  };
}
