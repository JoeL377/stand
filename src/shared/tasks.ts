// The task, Stand's one primitive (see the "Redesigning Stand around tasks" spec and Conxt's
// docs/design/work-loop.md): a to-do, a decision or an open question, each with a verb, an owner,
// a state and what closed it. The states are four plain words; whether it waits on someone's
// review, or someone said it's done without showing it, are marks on top, not states.
import type { ActionWork, Note, NoteKind, TaskState, TaskVerb } from "./protocol.ts";

export const verbOf = (kind: NoteKind): TaskVerb => (kind === "decision" ? "decide" : kind === "question" ? "answer" : "do");

export const VERB_LABEL: Record<TaskVerb, string> = { do: "Do", decide: "Decide", answer: "Answer" };
export const STATE_LABEL: Record<TaskState, string> = { open: "Open", doing: "Doing", done: "Done", dropped: "Dropped" };

/** Where a task stands. A decision is a Decide task the meeting already closed. */
export function stateOf(n: Pick<Note, "kind" | "doneAt" | "state">, work?: Pick<ActionWork, "working"> | null): TaskState {
  if (n.state === "dropped") return "dropped";
  if (n.doneAt || n.state === "done" || n.kind === "decision") return "done";
  if (n.state === "doing" || work?.working) return "doing";
  return "open";
}

export const isClosed = (s: TaskState) => s === "done" || s === "dropped";

/** Someone said it's finished, nothing shows it yet. */
export const saidDone = (n: Pick<Note, "kind" | "doneAt" | "state" | "saidDone">) => !!n.saidDone && !isClosed(stateOf(n));

/** The rows of one list with each to-do's parts under it: the rows that stand on their own, in the
 *  list's order, each with its parts. A part whose parent isn't in the list stands on its own. */
export function withParts<T extends Pick<Note, "id" | "parentId">>(notes: T[]): Array<{ note: T; parts: T[] }> {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const parentIn = (n: T) => (n.parentId && n.parentId !== n.id ? byId.get(n.parentId) : undefined);
  // Tasks have one level, so a row goes under its parent only when that parent stands on its own.
  const under = (n: T) => {
    const parent = parentIn(n);
    return parent && !parentIn(parent) ? parent.id : null;
  };
  const parts = new Map<string, T[]>();
  for (const n of notes) {
    const p = under(n);
    if (p) parts.set(p, [...(parts.get(p) ?? []), n]);
  }
  return notes.filter((n) => !under(n)).map((n) => ({ note: n, parts: parts.get(n.id) ?? [] }));
}

/** Per to-do with parts: how many are done, of the ones still wanted. A dropped part doesn't count. */
export function partsTally(all: Array<Pick<Note, "id" | "kind" | "doneAt" | "state" | "parentId">>): Map<string, { done: number; total: number }> {
  const tally = new Map<string, { done: number; total: number }>();
  for (const n of all) {
    if (!n.parentId || n.parentId === n.id) continue;
    const state = stateOf(n);
    if (state === "dropped") continue;
    const t = tally.get(n.parentId) ?? { done: 0, total: 0 };
    tally.set(n.parentId, { done: t.done + (state === "done" ? 1 : 0), total: t.total + 1 });
  }
  return tally;
}

/** What closed a task, in a few words. */
export function closedLabel(closedBy: string | null | undefined): string | null {
  if (!closedBy) return null;
  if (closedBy.startsWith("pr:")) {
    const m = /\/pull\/(\d+)/.exec(closedBy);
    return m ? `PR #${m[1]} merged` : "PR merged";
  }
  if (closedBy === "agent") return "An agent finished it";
  if (closedBy === "confirmed") return "Confirmed, no PR";
  if (closedBy === "moved") return "Moved to another space";
  return null;
}

/** The PR link behind a close, if a PR closed it. */
export const closedPr = (closedBy: string | null | undefined) => (closedBy?.startsWith("pr:") ? closedBy.slice(3) : null);
