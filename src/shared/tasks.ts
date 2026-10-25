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

/** Evidence is in and it needs someone with a say to look: a PR reported ready, still open. */
export const waitingOnYou = (n: Pick<Note, "kind" | "doneAt" | "state">, work?: Pick<ActionWork, "ready"> | null) =>
  !!work?.ready && !isClosed(stateOf(n));

/** Someone said it's finished, nothing shows it yet. */
export const saidDone = (n: Pick<Note, "kind" | "doneAt" | "state" | "saidDone">) => !!n.saidDone && !isClosed(stateOf(n));

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
