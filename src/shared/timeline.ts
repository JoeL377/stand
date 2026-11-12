// A meeting's timeline: everything that happened in it, in the order it happened. What was said,
// what was typed in the chat, what Stand caught, what Ask Stand was asked and answered, which item
// or slide was up, and what agents did over the MCP while it ran. It is put together when it is
// read (server/timeline.ts) from what each part already keeps, so nothing is stored twice.

import { type Actor, parseActor } from "./actors.ts";
import type { AgentCard, Discussion, Item, ItemUpdate, Note, NoteKind, Segment, UpdateStatus } from "./protocol.ts";

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
  /** The agenda item or slide it belongs to. A question to Stand or an agent's report: the one that was up. */
  itemId: string | null;
  /** A capture: what kind of note it is. */
  capture?: Exclude<NoteKind, "summary">;
  /** A capture or an agent's report: the to-do, decision or question, as stand:<kind>/<id>. */
  ref?: string;
  /** An Ask Stand question: the answer, or the options it gave as one line each. Null while it had none. */
  answer?: string | null;
  /** An Ask Stand question Stand is still working on. */
  pending?: boolean;
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

const REF_KIND = { action: "action", decision: "decision", question: "question", context: "context" } as const;

/** Reports that say something happened; "working" only marks a to-do as taken and repeats a lot. */
const QUIET = new Set(["working"]);

/** The short label an item goes by: its ticket key, its review or design slide's name, or "Slide 3". */
export function itemKey(item: Pick<Item, "externalId" | "slideNo" | "slide"> | null | undefined): string | null {
  if (!item) return null;
  return item.externalId ?? item.slide?.review?.name ?? item.slide?.design?.name ?? (item.slideNo ? `Slide ${item.slideNo}` : null);
}

export interface TimelineInput {
  meeting: { startedAt: number; endedAt: number | null };
  segments: Segment[];
  notes: Note[];
  discussions: Discussion[];
  cards: AgentCard[];
  /** Where the focus went and who moved it. Empty in a live call: the page doesn't have the log. */
  focus: Array<{ id: string; ts: number; itemId: string | null; actor: string; reason: string }>;
  /** The space's reports from the meeting's window (or any; the window is applied here). */
  updates: ItemUpdate[];
  itemById: (id: string) => Item | null;
}

/** Everything in order. Ties keep focus first, then what was said, then what came of it. */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const { meeting } = input;
  const out: Array<TimelineEntry & { rank: number; seq: number }> = [];
  let seq = 0;
  const add = (e: TimelineEntry, rank: number) => out.push({ ...e, rank, seq: seq++ });

  const segById = new Map(input.segments.map((s) => [s.id, s]));
  // What was up at a moment: by the focus log when there is one (a finished meeting), else by the
  // last line said or typed before it (a live call, where the page has no focus log).
  const focusLog = [...input.focus].sort((x, y) => x.ts - y.ts);
  const lines = [...input.segments].sort((x, y) => x.ts - y.ts);
  const itemAt = (ts: number): string | null => {
    const from = focusLog.length ? focusLog : lines;
    let at: string | null = from[0]?.itemId ?? null;
    for (const f of from) {
      if (f.ts > ts) break;
      at = f.itemId;
    }
    return at;
  };
  for (const s of input.segments)
    add({ id: `${s.kind}:${s.id}`, kind: s.kind, ts: s.ts, who: s.speakerName, whoId: s.speakerId, text: s.text, itemId: s.itemId }, 1);

  // A note is written a little after the words it came from: it sits right after that line, which is
  // its quote when it has one, else the last line of its discussion said before it was written.
  const discById = new Map(input.discussions.map((d) => [d.id, d]));
  const anchor = (n: Note): number => {
    const quoted = n.quote?.segmentId ? segById.get(n.quote.segmentId) : undefined;
    if (quoted) return quoted.ts;
    const d = n.discussionId ? discById.get(n.discussionId) : undefined;
    const said = (d?.segmentIds ?? []).flatMap((id) => segById.get(id) ?? []).filter((s) => s.ts <= n.ts);
    return said.length ? Math.max(...said.map((s) => s.ts)) : n.ts;
  };
  for (const n of input.notes) {
    if (n.kind === "summary") continue;
    add(
      { id: `capture:${n.id}`, kind: "capture", ts: anchor(n), who: n.owner, whoId: null, text: n.text, itemId: n.itemId, capture: n.kind, ref: `stand:${REF_KIND[n.kind]}/${n.id}` },
      2,
    );
  }

  for (const c of input.cards) {
    if (c.status === "listening") continue;
    const ready = c.status === "ready";
    const rest = { whoId: null, itemId: itemAt(c.at), ...(c.status === "working" && { pending: true }) };
    if (c.kind === "answer") {
      if (!c.question.trim()) continue;
      add({ id: `ask:${c.id}`, kind: "ask", ts: c.at, who: c.by, text: c.question, answer: ready ? c.note : null, ...rest }, 1);
    } else {
      const options = c.options.map((o) => `${o.title}: ${o.why}`).join("\n");
      add({ id: `ask:${c.id}`, kind: "ask", ts: c.at, who: c.by, text: `Options for: ${c.about}`, answer: ready ? options || c.note : null, ...rest }, 1);
    }
  }

  let last: string | null | undefined;
  for (const f of input.focus) {
    if (f.itemId === last) continue;
    last = f.itemId;
    const item = f.itemId ? input.itemById(f.itemId) : null;
    add(
      {
        id: `focus:${f.id}`,
        kind: "focus",
        ts: f.ts,
        who: f.actor === "system" ? null : f.actor,
        whoId: null,
        text: item?.title ?? (f.itemId ? "Removed item" : "General"),
        itemId: f.itemId,
        label: itemKey(item),
      },
      0,
    );
  }

  const end = meeting.endedAt ?? Number.MAX_SAFE_INTEGER;
  for (const u of input.updates) {
    if (u.ts < meeting.startedAt || u.ts > end || QUIET.has(u.status)) continue;
    const actor = u.actor ?? parseActor(u.client ? `${u.userName} via ${u.client}` : u.userName);
    add(
      {
        id: `agent:${u.id}`,
        kind: "agent",
        ts: u.ts,
        who: u.userName,
        whoId: null,
        text: u.noteText ? `${u.noteText}${u.text ? `: ${u.text}` : ""}` : u.text,
        itemId: itemAt(u.ts),
        ref: u.noteId ? `stand:action/${u.noteId}` : undefined,
        status: u.status,
        actor,
      },
      2,
    );
  }

  out.sort((a, b) => a.ts - b.ts || a.rank - b.rank || a.seq - b.seq);
  return out.map(({ rank: _r, seq: _s, ...e }) => e);
}
