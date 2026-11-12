// Projects: named groups of a space's to-dos, open questions and decisions, one level above them.
// A note's project is worked out each time it is read, from the first rule that applies:
//   1. set by hand (a project, or Unassigned);
//   2. from its agenda item: the project of the to-do the item shows, else the item's link, else the
//      link of the agenda item its deck is presented under;
//   3. from its parent task;
//   4. else Unassigned.
// The server and the browser share this file.

export const PROJECT_NAME_MAX = 80;
export const PROJECT_GOAL_MAX = 200;

export const normalizeProjectName = (value: string) => value.trim().replace(/\s+/g, " ");
/** Two names are the same project when this is the same. */
export const projectKey = (value: string) => normalizeProjectName(value).toLowerCase();

/** A project as the web app and agents read it. */
export interface Project {
  id: string;
  roomId: string;
  name: string;
  goal: string | null;
  position: number;
  /** Archived projects are out of the list and the picker. Their tasks keep the link. */
  archived: boolean;
  /** Open to-dos in it, by the rules. */
  openTodos: number;
  createdBy: string | null;
  createdAt: number;
}

/** What the rules read: each with only the fields they need, by id. */
export interface ProjectGraph {
  items: Record<string, { projectId: string | null; taskId: string | null; deckId: string | null }>;
  decks: Record<string, { parentItemId: string | null }>;
  /** A review slide's item: the to-do the slide shows. */
  shows: Record<string, string>;
  notes: Record<string, ProjectNote>;
}

export interface ProjectNote {
  id: string;
  itemId: string | null;
  parentId?: string | null;
  projectId?: string | null;
  /** Who set the project by hand; null or missing: it follows the rules. */
  projectSetBy?: string | null;
}

/** How far the rules follow other tasks before they stop, so a loop can't run forever. */
const MAX_STEPS = 5;

/** The note's project: rule 1, else the rules after it. */
export function projectOf(note: ProjectNote, g: ProjectGraph, steps = 0): string | null {
  if (note.projectSetBy != null) return note.projectId ?? null;
  return ruledProjectOf(note, g, steps);
}

/** What rules 2 to 4 give, leaving out what was set by hand. */
export function ruledProjectOf(note: ProjectNote, g: ProjectGraph, steps = 0): string | null {
  if (steps >= MAX_STEPS) return null;
  const item = note.itemId ? g.items[note.itemId] : undefined;
  if (item && note.itemId) {
    const shown = item.taskId ?? g.shows[note.itemId];
    const task = shown && shown !== note.id ? g.notes[shown] : undefined;
    const fromTask = task ? projectOf(task, g, steps + 1) : null;
    if (fromTask) return fromTask;
    if (item.projectId) return item.projectId;
    const deck = item.deckId ? g.decks[item.deckId] : undefined;
    const parent = deck?.parentItemId ? g.items[deck.parentItemId] : undefined;
    if (parent?.projectId) return parent.projectId;
  }
  const parent = note.parentId && note.parentId !== note.id ? g.notes[note.parentId] : undefined;
  return parent ? projectOf(parent, g, steps + 1) : null;
}

/** The project filter in the URL: "" for everything, "none" for Unassigned, or a project's id. */
export function matchesProject(projectId: string | null, filter: string): boolean {
  return !filter || (filter === "none" ? !projectId : projectId === filter);
}

/** What is happening in a project now, for the Active first order. */
export interface ProjectActivity {
  /** Open to-dos someone is on: an agent at work, or one a person moved to Doing. */
  inProgress: number;
  /** When its newest open to-do was added or last reported on. 0 with nothing open. */
  latest: number;
}

/** One open to-do of a project, as the Active first order reads it. */
export interface ActiveTask {
  project: string | null | undefined;
  /** When it was added. */
  ts: number;
  /** Someone is on it now. */
  inProgress: boolean;
  /** When the last report on it came in, if any. */
  reportedAt?: number;
}

/** Each project's activity, from the open to-dos. A project with none is left out. */
export function projectActivity(tasks: ActiveTask[]): Map<string, ProjectActivity> {
  const out = new Map<string, ProjectActivity>();
  for (const t of tasks) {
    if (!t.project) continue;
    const a = out.get(t.project) ?? { inProgress: 0, latest: 0 };
    out.set(t.project, { inProgress: a.inProgress + (t.inProgress ? 1 : 0), latest: Math.max(a.latest, t.ts, t.reportedAt ?? 0) });
  }
  return out;
}

/** The Active first order: projects with work in progress, then the others, each by its newest to-do.
 *  Projects that tie keep the order they came in, which is the team's. */
export function activeFirst<T extends { id: string }>(projects: T[], activity: Map<string, ProjectActivity>): T[] {
  const of = (p: T) => activity.get(p.id) ?? { inProgress: 0, latest: 0 };
  return projects
    .map((p, i) => ({ p, i, a: of(p) }))
    .sort((x, y) => Number(y.a.inProgress > 0) - Number(x.a.inProgress > 0) || y.a.latest - x.a.latest || x.i - y.i)
    .map((x) => x.p);
}
