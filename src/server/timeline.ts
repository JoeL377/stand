// A meeting's timeline (shared/timeline.ts), put together from what each part already keeps:
// segments (speech and chat), notes (what Stand caught), the Ask Stand cards, the focus log, and
// the reports agents posted to the space while the meeting ran.

import { parseActor } from "../shared/actors.ts";
import type { AgentCard, Discussion, Item, ItemUpdate, Note, Segment } from "../shared/protocol.ts";
import type { TimelineEntry } from "../shared/timeline.ts";
import type { DB } from "./db.ts";

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
  for (const s of input.segments)
    add({ id: `${s.kind}:${s.id}`, kind: s.kind, ts: s.ts, who: s.speakerName, whoId: s.speakerId, text: s.text, itemId: s.itemId }, 1);

  // A note is written a little after the words it came from: it sits right after that line, which is
  // its quote when it has one, else the last line of its discussion said before it was written.
  const discById = new Map(input.discussions.map((d) => [d.id, d]));
  const anchor = (n: Note): number => {
    const quoted = n.quote?.segmentId ? segById.get(n.quote.segmentId) : undefined;
    if (quoted) return quoted.ts;
    const d = n.discussionId ? discById.get(n.discussionId) : undefined;
    const lines = (d?.segmentIds ?? []).flatMap((id) => segById.get(id) ?? []).filter((s) => s.ts <= n.ts);
    return lines.length ? Math.max(...lines.map((s) => s.ts)) : n.ts;
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
    if (c.kind === "answer") {
      if (!c.question.trim()) continue;
      add({ id: `ask:${c.id}`, kind: "ask", ts: c.at, who: c.by, whoId: null, text: c.question, itemId: null, answer: ready ? c.note : null }, 1);
    } else {
      const options = c.options.map((o) => `${o.title}: ${o.why}`).join("\n");
      add({ id: `ask:${c.id}`, kind: "ask", ts: c.at, who: c.by, whoId: null, text: `Options for: ${c.about}`, itemId: null, answer: ready ? options || c.note : null }, 1);
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
        itemId: u.itemId,
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

export function meetingTimeline(db: DB, meetingId: string): TimelineEntry[] {
  const m = db.getMeeting(meetingId);
  if (!m) return [];
  return buildTimeline({
    meeting: m,
    segments: db.meetingSegments(m.id),
    notes: db.meetingNotes(m.id),
    discussions: db.meetingDiscussions(m.id),
    cards: db.meetingAgentCards(m.id) ?? [],
    focus: db.focusEvents(m.id),
    updates: db.roomUpdates(m.roomId, m.startedAt, 1000),
    itemById: (id) => db.getItem(id),
  });
}
