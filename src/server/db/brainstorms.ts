// Brainstorms and design sessions (brainstorm.ts, designSession.ts).
import type { DatabaseSync } from "node:sqlite";
import type { BrainNode, DesignContext, DesignDiagram } from "../../shared/protocol.ts";
import type { BrainstormRow, SketchState } from "../brainstorm.ts";
import { newId } from "../ids.ts";
import { type Row, toBrainstorm } from "./rows.ts";

export function brainstormsStore(db: DatabaseSync) {
  return {
    brainstormLive(roomId: string): BrainstormRow | null {
      const r = db.prepare("SELECT * FROM brainstorms WHERE room_id = ? AND status = 'live' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(roomId) as Row | undefined;
      return r ? toBrainstorm(r) : null;
    },
    getBrainstorm(id: string): BrainstormRow | null {
      const r = db.prepare("SELECT * FROM brainstorms WHERE id = ?").get(id) as Row | undefined;
      return r ? toBrainstorm(r) : null;
    },
    brainstorms(roomId: string, limit = 30): BrainstormRow[] {
      return (db.prepare("SELECT * FROM brainstorms WHERE room_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(roomId, limit) as Row[]).map(toBrainstorm);
    },
    /** The map of a board thread in a meeting. */
    brainstormOfThread(meetingId: string, threadId: string): BrainstormRow | null {
      const r = db.prepare("SELECT * FROM brainstorms WHERE meeting_id = ? AND thread_id = ? AND kind = 'map' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(meetingId, threadId) as Row | undefined;
      return r ? toBrainstorm(r) : null;
    },
    /** Every map and diagram of a meeting, oldest first. */
    brainstormsOfMeeting(meetingId: string): BrainstormRow[] {
      return (db.prepare("SELECT * FROM brainstorms WHERE meeting_id = ? ORDER BY started_at, rowid").all(meetingId) as Row[]).map(toBrainstorm);
    },
    brainstormByMeeting(meetingId: string): BrainstormRow | null {
      const r = db.prepare("SELECT * FROM brainstorms WHERE meeting_id = ? ORDER BY rowid DESC LIMIT 1").get(meetingId) as Row | undefined;
      return r ? toBrainstorm(r) : null;
    },
    createBrainstorm(b: {
      roomId: string;
      prompt: string;
      itemId: string | null;
      startedBy: string | null;
      startedAt: number;
      design?: { diagram: DesignDiagram; seed: string | null; taskId: string | null };
      threadId?: string | null;
      meetingId?: string | null;
    }): BrainstormRow {
      const id = newId();
      db.prepare("INSERT INTO brainstorms (id, room_id, prompt, status, item_id, started_by, started_at, kind, diagram_json, seed, task_id, thread_id, meeting_id) VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        b.roomId,
        b.prompt,
        b.itemId,
        b.startedBy,
        b.startedAt,
        b.design ? "design" : "map",
        b.design ? JSON.stringify(b.design.diagram) : null,
        b.design?.seed ?? null,
        b.design?.taskId ?? null,
        b.threadId ?? null,
        b.meetingId ?? null,
      );
      return this.getBrainstorm(id)!;
    },
    saveDesignDiagram(id: string, diagram: DesignDiagram) {
      db.prepare("UPDATE brainstorms SET diagram_json = ? WHERE id = ?").run(JSON.stringify(diagram), id);
    },
    setBrainstormTask(id: string, taskId: string) {
      db.prepare("UPDATE brainstorms SET task_id = ? WHERE id = ?").run(taskId, id);
    },
    /** A design session's background, as given through the MCP. */
    saveBrainstormContext(id: string, context: DesignContext[]) {
      db.prepare("UPDATE brainstorms SET context_json = ? WHERE id = ?").run(context.length ? JSON.stringify(context) : null, id);
    },
    setBrainstorm(id: string, patch: Partial<Pick<BrainstormRow, "status" | "meetingId" | "endedAt">>) {
      const cols: Record<string, string> = { status: "status", meetingId: "meeting_id", endedAt: "ended_at" };
      for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE brainstorms SET ${cols[k]} = ? WHERE id = ?`).run(v ?? null, id);
    },
    /** A session that started without a topic got one: its sentence, and the agenda item that carries it. */
    renameBrainstorm(id: string, prompt: string) {
      db.prepare("UPDATE brainstorms SET prompt = ? WHERE id = ?").run(prompt, id);
      db.prepare("UPDATE items SET title = ? WHERE id = (SELECT item_id FROM brainstorms WHERE id = ?)").run(prompt, id);
    },
    saveBrainstormStars(id: string, starred: string[]) {
      db.prepare("UPDATE brainstorms SET stars_json = ? WHERE id = ?").run(starred.length ? JSON.stringify(starred) : null, id);
    },
    saveBrainstormSpans(id: string, spans: Array<[number, number]>) {
      db.prepare("UPDATE brainstorms SET spans_json = ? WHERE id = ?").run(JSON.stringify(spans), id);
    },
    /** A sketch's subjects (sketch.ts). The first one's diagram is kept in diagram_json, not here. */
    saveBrainstormSketch(id: string, sketch: SketchState) {
      const slim = { ...sketch, subjects: sketch.subjects.map((s, i) => (i === 0 ? { ...s, diagram: null } : s)) };
      db.prepare("UPDATE brainstorms SET sketch_json = ? WHERE id = ?").run(JSON.stringify(slim), id);
    },
    saveBrainstormMap(id: string, nodes: BrainNode[]) {
      db.prepare("UPDATE brainstorms SET map_json = ? WHERE id = ?").run(JSON.stringify(nodes), id);
    },
  };
}
