// Links between to-dos, their plans with review threads and briefs, and checks.
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../../shared/actors.ts";
import type { PlanBrief } from "../../shared/designReview.ts";
import type { PlanThread, PlanVersion } from "../../shared/planReview.ts";
import type { LinkRelation } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import type { Row } from "./rows.ts";

export function plansStore(db: DatabaseSync) {
  return {
    /** Notes of one kind from a space's finished meetings, newest first. */
    /** Says how two things in a space relate; saying it twice changes nothing. */
    addLink(roomId: string, fromId: string, toId: string, relation: LinkRelation, by: string, actor: Actor | null = null) {
      db.prepare("INSERT OR IGNORE INTO links (id, room_id, from_id, to_id, relation, made_by, made_at, made_actor_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        newId(12),
        roomId,
        fromId,
        toId,
        relation,
        by,
        Date.now(),
        actor ? JSON.stringify(actor) : null,
      );
    },
    /** Takes a link back. */
    removeLink(fromId: string, toId: string, relation: LinkRelation) {
      return db.prepare("DELETE FROM links WHERE from_id = ? AND to_id = ? AND relation = ?").run(fromId, toId, relation).changes > 0;
    },
    /** What these point to through one relation. */
    linksFrom(fromIds: string[], relation: LinkRelation): Array<{ fromId: string; toId: string }> {
      if (!fromIds.length) return [];
      return (
        db.prepare(`SELECT from_id, to_id FROM links WHERE relation = ? AND from_id IN (${fromIds.map(() => "?").join(",")}) ORDER BY made_at`).all(relation, ...fromIds) as Row[]
      ).map((r) => ({ fromId: r.from_id as string, toId: r.to_id as string }));
    },
    /** Keeps a new version of a to-do's plan. */
    addPlan(roomId: string, noteId: string, text: string, by: string, actor: Actor | null = null) {
      db.prepare("INSERT INTO task_plans (id, note_id, room_id, text, made_by, made_at, made_actor_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        newId(12),
        noteId,
        roomId,
        text,
        by,
        Date.now(),
        actor ? JSON.stringify(actor) : null,
      );
    },
    planVersions(noteId: string): PlanVersion[] {
      return db.prepare("SELECT id, text, made_by AS by, made_at AS ts FROM task_plans WHERE note_id = ? ORDER BY made_at, rowid")
        .all(noteId) as PlanVersion[];
    },
    planThreads(noteId: string): PlanThread[] {
      return db.prepare("SELECT thread_json FROM plan_threads WHERE note_id = ? ORDER BY rowid")
        .all(noteId).map((row) => JSON.parse(row.thread_json as string) as PlanThread);
    },
    savePlanThread(noteId: string, thread: PlanThread) {
      db.prepare(`INSERT INTO plan_threads (id, note_id, thread_json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET thread_json = excluded.thread_json WHERE note_id = excluded.note_id`)
        .run(thread.id, noteId, JSON.stringify(thread));
    },
    /** A to-do's latest plan and how many versions it has had. */
    notePlan(noteId: string) {
      const rows = db.prepare("SELECT * FROM task_plans WHERE note_id = ? ORDER BY made_at DESC, rowid DESC").all(noteId) as Row[];
      const r = rows[0];
      if (!r) return null;
      return {
        text: r.text as string,
        by: r.made_by as string,
        actor: r.made_actor_json ? (JSON.parse(r.made_actor_json as string) as Actor) : undefined,
        ts: r.made_at as number,
        versions: rows.length,
      };
    },
    /** Which of these to-dos have a plan. */
    plannedNotes(noteIds: string[]): Set<string> {
      if (!noteIds.length) return new Set();
      return new Set(
        (db.prepare(`SELECT DISTINCT note_id FROM task_plans WHERE note_id IN (${noteIds.map(() => "?").join(",")})`).all(...noteIds) as Row[]).map((r) => r.note_id as string),
      );
    },
    /** A space's context, newest first, without what a later line replaced. */
    /** Checks in a space that came back or that someone holds right now. */
    takenChecks(roomId: string, now = Date.now()): Set<string> {
      return new Set(
        (db.prepare("SELECT note_id FROM decision_checks WHERE room_id = ? AND (done_at IS NOT NULL OR claimed_until > ?)").all(roomId, now) as Row[]).map(
          (r) => r.note_id as string,
        ),
      );
    },
    /** Holds a check for a while, so two agents don't do the same one. */
    claimCheck(roomId: string, noteId: string, version: string, until: number, actor: Actor) {
      db.prepare(
        `INSERT INTO decision_checks (note_id, room_id, version, claimed_until, actor_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (note_id) DO UPDATE SET version = excluded.version, claimed_until = excluded.claimed_until, actor_json = excluded.actor_json WHERE done_at IS NULL`,
      ).run(noteId, roomId, version, until, JSON.stringify(actor));
    },
    finishCheck(noteId: string, actor: Actor, findings: unknown, version: string) {
      const res = db
        .prepare("UPDATE decision_checks SET done_at = ?, actor_json = ?, findings_json = ?, version = ? WHERE note_id = ? AND done_at IS NULL")
        .run(Date.now(), JSON.stringify(actor), JSON.stringify(findings), version, noteId);
      return res.changes > 0;
    },
    /** A space's links of one relation, as from and to. */
    roomLinks(roomId: string, relation: LinkRelation): Array<{ fromId: string; toId: string }> {
      return (db.prepare("SELECT from_id, to_id FROM links WHERE room_id = ? AND relation = ? ORDER BY made_at").all(roomId, relation) as Row[]).map((r) => ({
        fromId: r.from_id as string,
        toId: r.to_id as string,
      }));
    },
    /** What Stand wrote for one version of a to-do's plan, with the author's edits (planBrief.ts). */
    planBrief(noteId: string, version: string): PlanBrief | null {
      const r = db.prepare("SELECT brief_json FROM plan_briefs WHERE note_id = ? AND version = ?").get(noteId, version) as Row | undefined;
      return r ? (JSON.parse(r.brief_json as string) as PlanBrief) : null;
    },
    savePlanBrief(noteId: string, brief: PlanBrief) {
      db.prepare(`INSERT INTO plan_briefs (note_id, version, brief_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(note_id, version) DO UPDATE SET brief_json = excluded.brief_json, updated_at = excluded.updated_at`)
        .run(noteId, brief.version, JSON.stringify(brief), Date.now());
    },
  };
}
