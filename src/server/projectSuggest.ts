// Stand's project suggestions: a pass over a space's open to-dos and open questions that nobody
// filed into a project, which asks Claude for the one project each is clearly part of. What it finds
// is only a suggestion (shared/projects.ts rule 4): the to-do shows in that project, marked as not
// confirmed, until a person or an agent confirms or changes it. It runs when a meeting or a chat
// stretch ends, a while after to-dos are added or changed between meetings, soon after a project is
// made or renamed, and once for each space as the server starts. It never makes a project, never
// sets one by hand, never changes a suggestion already there, and asks about each note once (until
// the projects change).

import { firmProjectOf } from "../shared/projects.ts";
import type { Note } from "../shared/protocol.ts";
import { isClosed, stateOf } from "../shared/tasks.ts";
import { config } from "./config.ts";
import { type DB, ProjectError } from "./db.ts";
import type { Agent, ProjectSuggestInput } from "./llm.ts";
import { forSpace } from "./usage.ts";

/** A to-do added or changed between meetings: wait for the rest of the batch. */
export const SUGGEST_AFTER_CHANGE_MS = 10 * 60_000;
/** A project made, renamed or brought back: wait for its goal and first to-dos. */
export const SUGGEST_AFTER_PROJECT_MS = 60_000;
/** How many lines one pass reads, newest first. */
const MAX_CANDIDATES = 120;
/** To-dos shown under each project, to say what is in it. */
const EXAMPLES = 5;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a pass shows the model, with the notes and projects behind its keys. Null when there is nothing to ask. */
export function projectSuggestInput(db: DB, roomId: string): { input: ProjectSuggestInput; noteOf: Map<string, Note>; projectOf: Map<string, string> } | null {
  const projects = db.listProjects(roomId).filter((p) => !p.archived);
  if (!projects.length) return null;
  const candidates = db.projectCandidates(roomId, MAX_CANDIDATES);
  if (!candidates.length) return null;
  const g = db.projectGraph(roomId);
  // What is firmly in each: open to-dos first, then the ones closed most recently.
  const todos = db.roomFollowUps(roomId);
  const open = todos.filter((n) => !isClosed(stateOf(n)));
  const closed = todos.filter((n) => isClosed(stateOf(n))).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const examples = (id: string) =>
    [...open, ...closed]
      .filter((n) => g.notes[n.id] && firmProjectOf(g.notes[n.id], g) === id)
      .slice(0, EXAMPLES)
      .map((n) => clip(n.text, 160));
  const projectOf = new Map(projects.map((p, i) => [`P${i + 1}`, p.id]));
  const noteOf = new Map(candidates.map((n, i) => [`N${i + 1}`, n]));
  return {
    input: {
      projects: projects.map((p, i) => ({ key: `P${i + 1}`, name: p.name, goal: p.goal, examples: examples(p.id) })),
      candidates: [...noteOf].map(([key, n]) => ({
        key,
        kind: n.kind as "action" | "question",
        text: clip(n.text, 300),
        owner: n.owner,
        item: n.itemId ? (db.getItem(n.itemId)?.title ?? null) : null,
        topic: n.discussionId ? (db.getDiscussion(n.discussionId)?.topic ?? null) : null,
      })),
    },
    noteOf,
    projectOf,
  };
}

/** One pass over a space: asks about each unfiled note, writes what came back as suggestions, and
 *  marks each note it got an answer for so the next pass leaves it. */
export async function suggestProjects(db: DB, agent: Agent, roomId: string): Promise<{ asked: number; suggested: number }> {
  const read = projectSuggestInput(db, roomId);
  if (!read) return { asked: 0, suggested: 0 };
  const started = Date.now();
  const answers = await forSpace(agent, roomId).suggestProjects(read.input);
  if (!answers) return { asked: read.noteOf.size, suggested: 0 };
  const judged: string[] = [];
  let suggested = 0;
  for (const a of answers) {
    const note = read.noteOf.get(a.note);
    const projectId = a.project === "none" ? null : read.projectOf.get(a.project);
    if (!note || projectId === undefined || judged.includes(note.id)) continue;
    // A person may have filed it while the model worked: theirs stands.
    if (!db.projectUnfiled(note.id)) continue;
    judged.push(note.id);
    if (!projectId) continue;
    try {
      if (db.suggestNoteProject(roomId, note.id, projectId)) suggested++;
    } catch (err) {
      // The project was archived or deleted meanwhile.
      if (!(err instanceof ProjectError)) throw err;
    }
  }
  db.markProjectJudged(judged, Date.now());
  if (suggested)
    console.log(`[agent] suggested projects in ${roomId}: ${suggested} of ${read.noteOf.size} lines in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { asked: read.noteOf.size, suggested };
}

export class ProjectSuggester {
  private timers = new Map<string, { timer: NodeJS.Timeout; due: number }>();
  private running = new Set<string>();
  /** Spaces scheduled while a pass ran in them: one more pass after it. */
  private again = new Set<string>();

  constructor(
    private db: DB,
    private agent: Agent,
    /** Tells the space its to-dos' projects changed. */
    private changed: (roomId: string) => void,
  ) {}

  /** Something in the space changed: a pass in a while. A pass already waiting keeps its time unless
   *  this asks for sooner. */
  schedule(roomId: string, delayMs: number) {
    if (!config.projectSuggest) return;
    const due = Date.now() + delayMs;
    const waiting = this.timers.get(roomId);
    if (waiting && waiting.due <= due) return;
    if (waiting) clearTimeout(waiting.timer);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      this.run(roomId).catch((err) => console.error("[agent] project suggestions failed:", err));
    }, delayMs);
    timer.unref?.();
    this.timers.set(roomId, { timer, due });
  }

  /** Each space with a project and something to file gets one pass, spread over the first minute. The
   *  events that schedule a pass cover what happens after. */
  start() {
    if (!config.projectSuggest) return;
    for (const roomId of this.db.roomsWithProjects())
      if (this.db.projectCandidates(roomId, 1).length) this.schedule(roomId, 1000 + Math.random() * 59_000);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
  }

  async run(roomId: string): Promise<void> {
    if (!config.projectSuggest) return;
    if (this.running.has(roomId)) {
      this.again.add(roomId);
      return;
    }
    this.running.add(roomId);
    try {
      const { suggested } = await suggestProjects(this.db, this.agent, roomId);
      if (suggested) this.changed(roomId);
    } finally {
      this.running.delete(roomId);
    }
    if (this.again.delete(roomId)) await this.run(roomId);
  }
}
