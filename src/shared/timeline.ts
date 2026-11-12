// A meeting's timeline: everything that happened in it, in the order it happened. What was said,
// what was typed in the chat, what Stand caught, what Ask Stand was asked and answered, which item
// or slide was up, and what agents did over the MCP while it ran. It is put together when it is
// read (server/timeline.ts) from what each part already keeps, so nothing is stored twice.

import { type Actor, parseActor } from "./actors.ts";
import type { AgentCard, Discussion, Item, ItemUpdate, Note, NoteKind, Segment, UpdateStatus } from "./protocol.ts";

export type TimelineKind = "speech" | "chat" | "capture" | "ask" | "focus" | "agent";

/** What the call's main view showed at a moment, as the room kept it (stage_events). */
export interface StageView {
  itemId: string | null;
  /** The board's tab in place of the deck or the share. */
  tab: "main" | "board" | "view";
  /** While a to-do is presented: its brief or its full spec. */
  taskMode: "brief" | "spec" | null;
  /** Which picture of a review slide is up, from 0. */
  shot: number | null;
  /** A still someone opened on the stage. */
  snapId: string | null;
  /** Who was sharing their screen, by name. */
  sharing: string | null;
}
export interface StageEvent {
  id: string;
  ts: number;
  view: StageView;
}

/** What was on screen when something was said or done. It says what was up, not that the words were
 *  about it: `points` on a line is the (guessed) sign that they were. */
export interface Shown {
  kind: "item" | "slide" | "task" | "spec" | "board" | "screen" | "still";
  /** In a line: "Saved cards", "Full spec: Build the retry worker", "Priya's screen: the pricing page". */
  label: string;
  itemId: string | null;
  /** A presented to-do, as stand:action/<id>. */
  ref?: string;
  /** A still of it: the one on the stage, or the last one taken of the shared screen. */
  snapId?: string;
  snapUrl?: string;
}

export interface TimelineEntry {
  /** Unique within the timeline: the kind and the id of what it came from. */
  id: string;
  kind: TimelineKind;
  /** Where it sits: when it was said, typed, asked or done. A capture sits at the line it came from. */
  ts: number;
  /** Who did it, exactly: the person (with their id), their agent (its name, connection and model),
   *  Stand itself, or GitHub. Null only when nothing recorded who (the host changing the view). */
  actor: Actor | null;
  /** That actor's person by name and id, for a line's label and color. Null for Stand. */
  who: string | null;
  whoId: string | null;
  text: string;
  /** The agenda item or slide it belongs to. A question to Stand or an agent's report: the one that was up. */
  itemId: string | null;
  /** A capture: what kind of note it is. */
  capture?: Exclude<NoteKind, "summary">;
  /** A capture: who it is for. The actor is who made it: Stand when it was caught from the talk. */
  owner?: string | null;
  /** A capture a person added or reworded by hand in the call (the two aren't told apart). */
  byHand?: boolean;
  /** A capture or an agent's report: the to-do, decision or question, as stand:<kind>/<id>. */
  ref?: string;
  /** An Ask Stand question: the answer, or the options it gave as one line each. Null while it had none. */
  answer?: string | null;
  /** An Ask Stand question Stand is still working on. */
  pending?: boolean;
  /** An answered question: Stand, with the model it ran. */
  answeredBy?: Actor;
  /** A focus change: the item's short label ("Slide 3", "ENG-142" or the review slide's name). */
  label?: string | null;
  /** What the main view showed then. On a change of what's up, a capture, a question to Stand, an
   *  agent's report, and a line that points at the screen. */
  shown?: Shown;
  /** A line said or typed: its words point at something on screen ("this button", "as you can see"). */
  points?: boolean;
  /** An agent's report: what kind of report. */
  status?: UpdateStatus;
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
  /** What the main view showed, each time it changed. Left out for meetings from before it was kept. */
  stage?: StageEvent[];
  /** Stills of the shared screen, for what a share showed at a moment. */
  snaps?: Array<{ id: string; ts: number; caption: string | null; url: string }>;
}

const POINTING =
  /\b(this|that|these|those) (slide|page|screen|button|section|part|line|copy|chart|graph|table|diagram|box|picture|image|screenshot|number|field|form|link|tab|column|row|one here)\b|\b(right|over|up|down) (here|there)\b|\bas you can see\b|\bon (the|this) (left|right|screen|slide)\b|\bat the (top|bottom)\b|\bscroll(ing)? (up|down)\b|\blook(ing)? at (this|that)\b|\bwhat(\'s| is) on (the )?screen\b/i;

/** Whether a line's words point at something on screen. A rule, so it costs nothing and can be wrong:
 *  it marks a line worth a look, and never says what the line is about. */
export function pointsAtScreen(text: string): boolean {
  return POINTING.test(text);
}

/** What a view shows, as a thing to name and link. Null for General with nothing up. */
export function shownOf(view: StageView, item: Item | null, snap?: { id: string; caption: string | null; url: string } | null): Shown | null {
  const still = snap ? { snapId: snap.id, snapUrl: snap.url } : {};
  if (view.snapId && snap) return { kind: "still", label: snap.caption ?? "A screenshot", itemId: view.itemId, ...still };
  if (view.sharing) return { kind: "screen", label: `${view.sharing.split(" ")[0]}'s screen${snap?.caption ? `: ${snap.caption}` : ""}`, itemId: view.itemId, ...still };
  if (view.tab === "board" && item) return { kind: "board", label: `The board on ${item.title}`, itemId: view.itemId };
  if (!item) return null;
  if (item.taskId) {
    const spec = view.taskMode === "spec";
    return { kind: spec ? "spec" : "task", label: `${spec ? "Full spec" : "Brief"}: ${item.title}`, itemId: item.id, ref: `stand:action/${item.taskId}` };
  }
  const key = itemKey(item);
  const name = key && !item.title.startsWith(key) ? `${key}: ${item.title}` : item.title;
  if (item.slide || item.slideNo) return { kind: "slide", label: view.shot ? `${name} (picture ${view.shot + 1})` : name, itemId: item.id };
  return { kind: "item", label: name, itemId: item.id };
}

/** What changed on the main view between two moments, in a line; null when only the item did (the
 *  focus log says that, with who moved it). */
function stageChange(prev: StageView | null, view: StageView): string | null {
  if (!prev) return view.sharing ? `${view.sharing} started sharing their screen` : null;
  if (view.sharing !== prev.sharing) return view.sharing ? `${view.sharing} started sharing their screen` : `${prev.sharing} stopped sharing`;
  if (view.snapId !== prev.snapId) return view.snapId ? "A screenshot went up on the stage" : "The screenshot came down";
  if (view.itemId !== prev.itemId) return null;
  if (view.tab !== prev.tab) return view.tab === "board" ? "The board went up" : view.tab === "view" ? "The map or diagram went up" : prev.tab === "view" ? "Back from the map or diagram" : "Back from the board";
  if (view.taskMode !== prev.taskMode && view.taskMode) return view.taskMode === "spec" ? "The full spec went up" : "Back to the brief";
  if (view.shot !== prev.shot && view.shot !== null) return `Picture ${view.shot + 1} went up`;
  return null;
}

/** Everything in order. Ties keep focus first, then what was said, then what came of it. */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const { meeting } = input;
  const out: Array<TimelineEntry & { rank: number; seq: number }> = [];
  let seq = 0;
  const add = (e: TimelineEntry, rank: number) => out.push({ ...e, rank, seq: seq++ });

  const segById = new Map(input.segments.map((s) => [s.id, s]));
  // Who did each thing. A name with no id (the focus log, a hand edit) takes the id that person's
  // lines carry, so they are the same person everywhere, color included.
  const idOf = new Map(input.segments.map((s) => [s.speakerName, s.speakerId]));
  const known = (a: Actor): Actor => {
    const id = a.personId ?? (a.person ? idOf.get(a.person) : undefined);
    return id && !a.personId ? { ...a, personId: id } : a;
  };
  const person = (name: string, id?: string | null): Actor => known(id ? { kind: "person", person: name, personId: id } : { kind: "person", person: name });
  const stand: Actor = { kind: "stand", person: null };
  const by = (actor: Actor | null) => ({ actor, who: actor?.person ?? null, whoId: actor?.personId ?? null });
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
  // What the main view showed at a moment: from the stage log when the meeting has one, else just the
  // item that was up. A share shows the last still taken of it before then.
  const stage = [...(input.stage ?? [])].sort((x, y) => x.ts - y.ts);
  const stills = [...(input.snaps ?? [])].sort((x, y) => x.ts - y.ts);
  const stillById = new Map(stills.map((p) => [p.id, p]));
  const shownAt = (ts: number, itemId?: string | null): Shown | null => {
    let view: StageView | null = null;
    let since = 0;
    for (const e of stage) {
      if (e.ts > ts) break;
      if (!view || e.view.sharing !== view.sharing) since = e.ts;
      view = e.view;
    }
    view ??= { itemId: itemId === undefined ? itemAt(ts) : itemId, tab: "main", taskMode: null, shot: null, snapId: null, sharing: null };
    const snap = view.snapId ? stillById.get(view.snapId) : view.sharing ? stills.filter((p) => p.ts >= since && p.ts <= ts).at(-1) : null;
    return shownOf(view, view.itemId ? input.itemById(view.itemId) : null, snap);
  };
  const withShown = (ts: number, itemId?: string | null) => {
    const shown = shownAt(ts, itemId);
    return shown ? { shown } : {};
  };

  for (const s of input.segments) {
    // A line carries what was up only when its words point at it, and there was more up than an agenda line.
    const shown = pointsAtScreen(s.text) ? shownAt(s.ts, s.itemId) : null;
    const pointing = shown && shown.kind !== "item" ? { shown, points: true } : {};
    add({ id: `${s.kind}:${s.id}`, kind: s.kind, ts: s.ts, ...by(person(s.speakerName, s.speakerId)), text: s.text, itemId: s.itemId, ...pointing }, 1);
  }

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
    // Who made it: whoever added it (a person or their agent), a person who wrote it by hand in the
    // call, else Stand, which caught it from the talk.
    const hand = !n.addedActor && n.editedBy ? parseActor(n.editedBy) : null;
    const maker = n.addedActor ? known(n.addedActor) : hand ? known(hand) : stand;
    add(
      {
        id: `capture:${n.id}`,
        kind: "capture",
        ts: anchor(n),
        ...by(maker),
        text: n.text,
        itemId: n.itemId,
        capture: n.kind,
        owner: n.owner,
        ...(hand && { byHand: true }),
        ref: `stand:${REF_KIND[n.kind]}/${n.id}`,
        ...withShown(anchor(n), n.itemId),
      },
      2,
    );
  }

  for (const c of input.cards) {
    if (c.status === "listening") continue;
    const ready = c.status === "ready";
    // An answer card keeps the asker's id in `about`; an options card keeps the question's there.
    const rest = {
      ...by(person(c.by, c.kind === "answer" ? c.about : null)),
      itemId: itemAt(c.at),
      ...(c.status === "working" && { pending: true }),
      ...(ready && { answeredBy: c.model ? { ...stand, model: c.model } : stand }),
      ...withShown(c.at),
    };
    if (c.kind === "answer") {
      if (!c.question.trim()) continue;
      add({ id: `ask:${c.id}`, kind: "ask", ts: c.at, text: c.question, answer: ready ? c.note : null, ...rest }, 1);
    } else {
      const options = c.options.map((o) => `${o.title}: ${o.why}`).join("\n");
      add({ id: `ask:${c.id}`, kind: "ask", ts: c.at, text: `Options for: ${c.about}`, answer: ready ? options || c.note : null, ...rest }, 1);
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
        ...by(f.actor === "system" ? stand : person(f.actor)),
        text: item?.title ?? (f.itemId ? "Removed item" : "General"),
        itemId: f.itemId,
        label: itemKey(item),
        ...withShown(f.ts, f.itemId),
      },
      0,
    );
  }

  // The main view changing without the item changing: a share starting, a spec opening, the board.
  let before: StageView | null = null;
  for (const e of stage) {
    const what = stageChange(before, e.view);
    // A share starting or stopping is the sharer's doing; the rest is the host's, and isn't recorded.
    const sharer = e.view.sharing !== (before?.sharing ?? null) ? (e.view.sharing ?? before?.sharing ?? null) : null;
    before = e.view;
    if (!what) continue;
    const item = e.view.itemId ? input.itemById(e.view.itemId) : null;
    add({ id: `stage:${e.id}`, kind: "focus", ts: e.ts, ...by(sharer ? person(sharer) : null), text: what, itemId: e.view.itemId, label: itemKey(item), ...withShown(e.ts) }, 0);
  }

  const end = meeting.endedAt ?? Number.MAX_SAFE_INTEGER;
  for (const u of input.updates) {
    if (u.ts < meeting.startedAt || u.ts > end || QUIET.has(u.status)) continue;
    const actor = known(u.actor ?? parseActor(u.client ? `${u.userName} via ${u.client}` : u.userName) ?? { kind: "person", person: u.userName });
    add(
      {
        id: `agent:${u.id}`,
        kind: "agent",
        ts: u.ts,
        ...by(actor),
        who: actor.person ?? u.userName,
        text: u.noteText ? `${u.noteText}${u.text ? `: ${u.text}` : ""}` : u.text,
        itemId: itemAt(u.ts),
        ref: u.noteId ? `stand:action/${u.noteId}` : undefined,
        status: u.status,
        ...withShown(u.ts),
      },
      2,
    );
  }

  out.sort((a, b) => a.ts - b.ts || a.rank - b.rank || a.seq - b.seq);
  return out.map(({ rank: _r, seq: _s, ...e }) => e);
}
