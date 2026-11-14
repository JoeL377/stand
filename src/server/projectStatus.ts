// Where a project stands: a short paragraph at the top of an opened project, written by Claude from
// what is in it (its to-dos and how they moved, what agents reported on them, its decisions and open
// questions, and the meetings that touched it). It is written when someone opens the project and
// what it reads has changed since the last one, at most once every few minutes per project, and kept
// in project_status. Opening a project that has not changed costs nothing. Without a model, or with
// nothing in the project yet, there is no paragraph.

import { createHash } from "node:crypto";
import type { FollowUp, ItemUpdate, Note } from "../shared/protocol.ts";
import { isClosed, stateOf } from "../shared/tasks.ts";
import type { DB } from "./db.ts";
import type { Agent } from "./llm.ts";
import { meetingKindName } from "./meetingNames.ts";
import { settledView } from "./spaceSettle.ts";
import { forSpace } from "./usage.ts";

/** A project that changed again soon after its paragraph was written waits this long for the next one. */
export const STATUS_MIN_GAP_MS = 10 * 60_000;
/** What counts as recent: to-dos done, reports and meetings older than this are left out. */
const RECENT_MS = 21 * 24 * 3600_000;
const MAX_OPEN = 25;
const MAX_DONE = 12;
const MAX_REPORTS_PER_TODO = 3;
const MAX_DECISIONS = 8;
const MAX_QUESTIONS = 8;
const MAX_MEETINGS = 3;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const PR = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;

export interface ProjectStatus {
  text: string | null;
  /** When the paragraph was written. */
  at: number | null;
  /** A newer paragraph is being written: ask again in a few seconds. */
  pending: boolean;
}

/** What the model reads about a project, as text, and a fingerprint of it. Null when the project has
 *  nothing in it to describe yet. */
export function projectStatusInput(db: DB, roomId: string, projectId: string, now = Date.now()): { prompt: string; fingerprint: string } | null {
  const graph = db.projectGraph(roomId);
  const project = db.listProjects(roomId, graph).find((p) => p.id === projectId);
  if (!project) return null;
  const inIt = <T extends Note>(notes: T[]) => db.withProjects(roomId, notes, graph).filter((n) => n.project === projectId);
  const since = now - RECENT_MS;

  const todos: FollowUp[] = inIt(db.roomFollowUps(roomId));
  const reports = new Map<string, ItemUpdate[]>();
  for (const u of db.notesUpdates(todos.map((n) => n.id))) {
    if (!u.noteId || u.ts < since || !u.text.trim()) continue;
    if (!["working", "progress", "blocked", "needs_decision", "ready", "done", "comment", "linked"].includes(u.status)) continue;
    const list = reports.get(u.noteId) ?? [];
    list.push(u);
    reports.set(u.noteId, list);
  }
  const lastOf = (id: string) => (reports.get(id) ?? []).sort((a, b) => a.ts - b.ts).slice(-MAX_REPORTS_PER_TODO);
  const stateWord = (n: FollowUp) => {
    const last = lastOf(n.id).at(-1);
    if (last?.status === "ready") return "ready to ship";
    if (last?.status === "blocked") return "blocked";
    if (last?.status === "needs_decision") return "waiting on a decision";
    return stateOf(n) === "doing" || last?.status === "working" || last?.status === "progress" ? "in progress" : "to do";
  };
  const reportLines = (n: FollowUp) =>
    lastOf(n.id).map((u) => {
      const pr = u.links.map((l) => PR.exec(l)?.[0]).find(Boolean);
      return `    - ${day(u.ts)} ${u.status} by ${u.actor?.agent ? `${u.userName}'s agent` : u.userName}: ${clip(u.text, 220)}${pr ? ` (${pr.replace(/^https:\/\/github\.com\//, "")})` : ""}`;
    });
  const open = todos.filter((n) => !isClosed(stateOf(n)));
  const rank = { "ready to ship": 0, blocked: 1, "waiting on a decision": 2, "in progress": 3, "to do": 4 } as Record<string, number>;
  open.sort((a, b) => rank[stateWord(a)] - rank[stateWord(b)] || b.ts - a.ts);
  const done = todos
    .filter((n) => stateOf(n) === "done" && (n.doneAt ?? 0) >= since)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .slice(0, MAX_DONE);

  const view = settledView(db, roomId);
  const decisions = inIt(view.decided.filter((n) => !n.replacedBy))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_DECISIONS);
  const questions = inIt(view.open.filter((n) => !isClosed(stateOf(n))))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_QUESTIONS);

  // The meetings that touched it lately: those its to-dos, decisions and questions came out of.
  const meetingIds = new Set<string>();
  for (const n of [...todos, ...decisions, ...questions]) if (n.ts >= since) meetingIds.add(n.meetingId);
  const meetings = [...meetingIds]
    .map((id) => db.getMeeting(id))
    .filter((m): m is NonNullable<ReturnType<DB["getMeeting"]>> => !!m && !m.added && !m.chat && m.endedAt != null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_MEETINGS);

  if (!open.length && !done.length && !decisions.length && !questions.length) return null;

  const lines: string[] = [`Project: ${project.name}`];
  if (project.goal) lines.push(`Goal: ${clip(project.goal, 400)}`);
  lines.push(`Counts: ${open.length} open to-dos, ${todos.filter((n) => stateOf(n) === "done").length} done in all, ${questions.length} open questions.`);
  if (open.length) {
    lines.push("", "Open to-dos (most advanced first):");
    for (const n of open.slice(0, MAX_OPEN)) {
      lines.push(`- [${stateWord(n)}] ${clip(n.text, 200)}${n.owner ? ` (owner: ${n.owner})` : ""}, added ${day(n.ts)}`);
      lines.push(...reportLines(n));
    }
    if (open.length > MAX_OPEN) lines.push(`- and ${open.length - MAX_OPEN} more`);
  }
  if (done.length) {
    lines.push("", "Done lately:");
    for (const n of done) {
      lines.push(`- ${day(n.doneAt!)} ${clip(n.text, 200)}${n.doneBy ? ` (by ${n.doneBy})` : ""}`);
      lines.push(...reportLines(n).slice(-1));
    }
  }
  if (decisions.length) {
    lines.push("", "Decisions (newest first):");
    for (const n of decisions) lines.push(`- ${day(n.ts)} ${clip(n.text, 220)}`);
  }
  if (questions.length) {
    lines.push("", "Open questions:");
    for (const n of questions) lines.push(`- ${clip(n.text, 220)}`);
  }
  if (meetings.length) {
    lines.push("", "Meetings that touched it lately:");
    for (const m of meetings) lines.push(`- ${day(m.startedAt)} ${m.title ?? meetingKindName(db, m.id)}${m.summary ? `: ${clip(m.summary, 400)}` : ""}`);
  }
  const prompt = lines.join("\n");
  return { prompt, fingerprint: createHash("sha256").update(prompt).digest("hex").slice(0, 32) };
}

export class ProjectStatuses {
  private running = new Set<string>();
  /** When a write last failed, per project: no retry until the gap has passed. */
  private failed = new Map<string, number>();

  constructor(
    private db: DB,
    private agent: Agent,
  ) {}

  /** The paragraph for a project as kept, and a newer one started when the project changed since. */
  get(roomId: string, projectId: string, now = Date.now()): ProjectStatus {
    const kept = this.db.getProjectStatus(projectId);
    const shown = { text: kept?.text ?? null, at: kept?.madeAt ?? null };
    if (!this.agent.projectStatus) return { ...shown, pending: false };
    if (this.running.has(projectId)) return { ...shown, pending: true };
    const input = projectStatusInput(this.db, roomId, projectId, now);
    if (!input) {
      // Everything left the project: its old paragraph would mislead.
      if (kept) this.db.clearProjectStatus(projectId);
      return { text: null, at: null, pending: false };
    }
    if (kept?.fingerprint === input.fingerprint) return { ...shown, pending: false };
    if (kept && now - kept.madeAt < STATUS_MIN_GAP_MS) return { ...shown, pending: false };
    if (now - (this.failed.get(projectId) ?? 0) < STATUS_MIN_GAP_MS) return { ...shown, pending: false };
    this.running.add(projectId);
    const started = Date.now();
    forSpace(this.agent, roomId)
      .projectStatus!(input.prompt, day(now))
      .then((text) => {
        if (text) this.db.setProjectStatus(projectId, { text, fingerprint: input.fingerprint, madeAt: Date.now() });
        else this.failed.set(projectId, Date.now());
        console.log(`[agent] project status for ${projectId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      })
      .catch((err) => {
        this.failed.set(projectId, Date.now());
        console.error("[agent] project status failed:", err);
      })
      .finally(() => this.running.delete(projectId));
    return { ...shown, pending: true };
  }
}
