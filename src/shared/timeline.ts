// A meeting's timeline: everything that happened in it, in the order it happened. What was said,
// what was typed in the chat, what Stand caught, what Ask Stand was asked and answered, which item
// or slide was up, and what agents did over the MCP while it ran. It is put together when it is
// read (server/timeline.ts) from what each part already keeps, so nothing is stored twice.

import type { Actor } from "./actors.ts";
import type { NoteKind, UpdateStatus } from "./protocol.ts";

export type TimelineKind = "speech" | "chat" | "capture" | "ask" | "focus" | "agent";

export interface TimelineEntry {
  /** Unique within the timeline: the kind and the id of what it came from. */
  id: string;
  kind: TimelineKind;
  /** Where it sits: when it was said, typed, asked or done. A capture sits at the line it came from. */
  ts: number;
  /** Who: the speaker, the person who typed or asked, who moved the focus, or the agent's person. */
  who: string | null;
  /** The speaker's participant id, for their color; null for anything that isn't a line. */
  whoId: string | null;
  text: string;
  /** The agenda item or slide it belongs to. */
  itemId: string | null;
  /** A capture: what kind of note it is. */
  capture?: Exclude<NoteKind, "summary">;
  /** A capture or an agent's report: the to-do, decision or question, as stand:<kind>/<id>. */
  ref?: string;
  /** An Ask Stand question: the answer, or the options it gave as one line each. Null while it had none. */
  answer?: string | null;
  /** A focus change: the item's short label ("Slide 3", "ENG-142" or the review slide's name). */
  label?: string | null;
  /** An agent's report: what kind of report, and who wrote it. */
  status?: UpdateStatus;
  actor?: Actor | null;
}

/** "Joe via Claude Code", "Joe", or "Stand": who an entry is by, as one line. */
export function timelineWho(e: Pick<TimelineEntry, "who" | "actor">): string {
  const a = e.actor;
  if (a?.kind === "stand") return "Stand";
  if (a?.kind === "agent" && a.agent) return `${a.person ?? e.who ?? "Someone"} via ${a.agent}`;
  return e.who ?? a?.person ?? "Someone";
}
