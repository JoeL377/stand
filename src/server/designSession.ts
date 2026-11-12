// A design session: a call where the meeting is the first design. It is a brainstorm (brainstorm.ts)
// whose middle screen is a diagram instead of a map: boxes are the things being designed, and
// labelled arrows say how they relate. It can start from a diagram, so the room edits something
// instead of facing a blank board.
//
// Stand proposes and the room accepts. A pass over the newest talk (in the style of the map's) adds
// boxes and arrows as suggestions; one joins the diagram only when someone keeps it, and nothing a
// person kept is renamed, moved or dropped by a later pass. When the call ends the diagram is saved
// as a draft spec on a to-do, which goes through the normal design review from there.
import { z } from "zod";
import { DESIGN_KINDS, UNTITLED_DESIGN, type BrainCaught, type DesignArrow, type DesignBox, type DesignContext, type DesignDiagram, type DesignGroup, type DesignKind, type Segment } from "../shared/protocol.ts";
import type { Actor } from "../shared/actors.ts";
import { type BrainstormRow, shownDiagram } from "./brainstorm.ts";
import type { DB } from "./db.ts";
import { planChanged } from "./designReviews.ts";
import { similar } from "./notesMerge.ts";

const WINDOW_MS = 2 * 60_000;
export const MAX_BOXES = 24;
export const MAX_ARROWS = 40;
export const MAX_GROUPS = 8;
export { UNTITLED_DESIGN as UNTITLED };
/** Suggestions waiting on the room at once: past this the board stops being calm, so new ones wait. */
export const MAX_WAITING = 8;
const MAX_POINTS = 8;
export const SEED_MAX = 20_000;

export const DiagramAnswerSchema = z.object({
  boxes: z
    .array(
      z.object({
        label: z.string().describe("The thing's name as the team says it: at most 4 words, no full stop"),
        detail: z.string().describe("One sentence saying what it is or what it is for, in the speaker's terms"),
        kind: z
          .enum(DESIGN_KINDS)
          .describe("What sort of thing it is. person: a role or someone who uses it. screen: something people look at or click. store: where data is kept, a record or a table. service: a system, an agent, an API or a tool that does work. step: a stage in a flow or something that happens. decision: a choice or a branch point. thing: none of these"),
        group: z.string().nullable().describe("The group it belongs in, by name: one from Groups so far when it fits, or a new name of at most 3 words. null when it stands alone"),
        by: z.string().nullable().describe("First name of who raised it; null if unclear"),
        line: z.number().int().describe("The NEW line it comes from"),
      }),
    )
    .describe("A thing the NEW lines introduce into the design that the diagram doesn't have. Usually empty"),
  arrows: z
    .array(
      z.object({
        from: z.string().describe("A box's id (b2), or new1 for the first box added in this same answer, new2 for the second"),
        to: z.string().describe("A box's id, or new1, new2…"),
        label: z.string().describe('How the first relates to the second, read along the arrow: at most 4 words, lower case ("belongs to", "becomes", "has many")'),
        by: z.string().nullable(),
        line: z.number().int(),
      }),
    )
    .describe("A relation between two boxes that someone stated in the NEW lines and the diagram doesn't show. Usually empty"),
  extend: z
    .array(
      z.object({
        id: z.string().describe("A box on the diagram"),
        point: z.string().describe("What the NEW talk adds about it: a field, a rule, a constraint, a concern. At most 14 words"),
        by: z.string().nullable(),
        line: z.number().int(),
      }),
    )
    .describe("Someone said more about a box that is already there instead of raising a new one"),
  caught: z
    .array(z.object({ id: z.string().describe("A box on the diagram"), item: z.string().describe("A caught line's id, li_3") }))
    .describe("A to-do, decision or open question from the caught list that is about one box and isn't linked to it yet. Usually empty"),
  place: z
    .array(z.object({ id: z.string().describe("A box on the diagram that is in no group"), group: z.string().describe("The group's name") }))
    .describe("A box with no group that clearly belongs with others: boxes about the same area of the design. Usually empty"),
  groups: z
    .array(z.object({ label: z.string().describe("A new group's name, as used in boxes or place"), detail: z.string().describe("One line on what the group holds, at most 12 words") }))
    .describe("One entry for each group named in this answer that Groups so far doesn't have"),
  topic: z.string().nullable().describe("Only when the session has no topic yet and the talk has made clear what is being designed: its name, at most 6 words, no full stop. Otherwise null"),
});
export type DiagramAnswer = z.infer<typeof DiagramAnswerSchema>;

export const DIAGRAM_SYSTEM = `You keep the diagram on the middle screen of a live design session. The team is designing something by talking it through, and the diagram is their design so far: each box is one thing in the design (an object, a record, a screen, a service, a step), and each arrow says in a few words how one box relates to another. Everyone looks at it while they talk, so it has to be right and it has to stay calm.

What you add shows as a suggestion, dashed, until someone in the room keeps it. So suggest only what the team has actually said, and suggest little: an answer with nothing in it is the usual one.

Each time you get the diagram so far, with ids, and the last couple of minutes of transcript. Lines marked NEW are the ones you haven't seen yet. Return only what the NEW lines add. You never rename, move or remove anything: the room does that.

- A box is a thing the design is made of, named the way the team names it. Add one when someone introduces a thing the diagram doesn't have and talks about it as part of the design. Not an example, not a person, not a passing mention. Before adding, check the diagram: when a box already is that thing under another name, don't add it; use extend if the talk says something new about it.
- An arrow is a relation someone stated: one thing belongs to, contains, becomes, creates, links to, replaces or depends on another. Read along the arrow it should make a short true sentence: "task belongs to project". Add one only when both ends are boxes (on the diagram or added in this answer) and the diagram doesn't already show that relation in either direction.
- Every box has a kind, so the diagram is more than a wall of boxes: say what sort of thing it is, and use thing only when nothing else fits.
- A group holds boxes that belong to the same area of the design (the same flow, the same side of a system, the same question). Three boxes about one area with no arrows between them should share a group. Reuse a group that is there before naming a new one, keep to a handful of groups, and never make a group for one box. place puts a box that is already on the diagram into a group; it never takes one out of the group it is in.
- extend is for what the talk adds to a box that is there: a field it has, a rule, a limit, a concern, a decision about it.
- Lines marked (suggested) are waiting on the room. Don't suggest them again, and don't build on them unless the talk does.
- Things under "Dropped by the team" were refused. Never suggest them again.
- A session can start with no topic. When "What the team is designing" says it isn't named yet, return topic as soon as the talk makes clear what the design is of, in the team's words; until then, and whenever the session has a topic, topic is null.
- by is the first name of the person who said it, matched to the people in the meeting.
- The caught list is the meeting's to-dos, decisions and open questions. When one is clearly about a box and isn't linked to it yet, link it in caught.
Transcription is rough: read through misheard words. Never invent a part of the design nobody said, and never return commentary about the transcript.`;

export const SEED_SYSTEM = `You turn a team's notes into the starting diagram for a design session. Each box is one thing in the design described by the notes (an object, a record, a screen, a service, a step), named as the notes name it. Each arrow says in a few words how one box relates to another, read along the arrow: "task belongs to project".

Return the boxes and arrows the notes actually describe, and nothing they don't. At most ${MAX_BOXES} boxes: when the notes hold more, keep the ones the rest hang off. Every arrow joins two boxes you return, named new1, new2… by their position in boxes. Give every box its kind. When the notes fall into areas, put each box in a group named for its area, with one line in groups on what each holds: at most ${MAX_GROUPS} groups, none for a single box. Leave extend, caught and place empty, set topic, by to null and line to 0.`;

/** What the diagram needs from the model; null when it couldn't answer. */
export interface DiagramModel {
  designDiagram(context: string, talk: string): Promise<DiagramAnswer | null>;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const first = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || null;
const tidy = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim().replace(/\.$/, ""), max);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const at = (ms: number, start: number) => {
  const s = Math.max(0, Math.floor((ms - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ---- starting diagram -------------------------------------------------------------------------

const KIND_WORD = new RegExp(`^(.*?)\\s*\\((${DESIGN_KINDS.join("|")})\\)$`, "i");
/** A mermaid shape to the kind it stands for. diagramMermaid writes the same shapes back. */
const SHAPES: Array<[open: string, close: string, kind: DesignKind]> = [
  ["[(", ")]", "store"],
  ["[/", "/]", "screen"],
  ["[[", "]]", "service"],
  ["((", "))", "person"],
  ["{{", "}}", "step"],
  ["([", "])", "thing"],
  ["{", "}", "decision"],
  ["[", "]", "thing"],
  ["(", ")", "thing"],
];
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const SHAPE = SHAPES.map(([open, close, kind]) => ({ kind, re: new RegExp(`^([\\w.-]+)\\s*${esc(open)}\\s*"?(.+?)"?\\s*${esc(close)}$`) }));

/** Reads a diagram someone typed or pasted, one thing per line:
 *    Task: a to-do with an owner          a box, with what it is
 *    Inbox (screen): where to-dos land    a box of a kind (person, screen, store, service, step, decision)
 *    Task -> Project: belongs to          an arrow, with how they relate
 *    ## Planning: how work is lined up    a group: the boxes first named under it sit in it
 *  and a mermaid flowchart: its arrows (A --> B, A -->|label| B, A -- label --> B, with A[Name]), its
 *  shapes as kinds (A[(Name)] is a store) and each subgraph as a group.
 *  Lines that are neither are skipped. Everything read is kept: the room chose it by pasting it. */
export function parseSeed(text: string, now = Date.now()): DesignDiagram {
  const boxes: DesignBox[] = [];
  const arrows: DesignArrow[] = [];
  let groups: DesignGroup[] = [];
  /** The group the lines being read sit under. */
  let within: DesignGroup | null = null;
  const group = (raw: string, detail: string | null = null): DesignGroup | null => {
    const label = tidy(raw.replace(/^["'`*_]+|["'`*_]+$/g, ""), 40);
    if (!label) return null;
    let g = groups.find((x) => same(x.label, label));
    if (!g) {
      if (groups.length >= MAX_GROUPS) return null;
      g = { id: `g${groups.length + 1}`, label, detail: null };
      groups.push(g);
    }
    if (detail && !g.detail) g.detail = clip(detail.trim(), 160) || null;
    return g;
  };
  /** A mermaid node id to the name it was given (A[Name]). */
  const named = new Map<string, string>();
  const box = (raw: string, detail: string | null = null): DesignBox | null => {
    let name = raw.trim();
    let kind: DesignKind | null = null;
    // "Inbox (screen)" says its kind in words; anything else in brackets is a mermaid shape.
    const word = KIND_WORD.exec(name);
    const shape = word?.[1].trim() ? null : SHAPE.map((x) => ({ kind: x.kind, m: x.re.exec(name) })).find((x) => x.m);
    if (word?.[1].trim()) ((name = named.get(word[1].trim()) ?? word[1]), (kind = word[2].toLowerCase() as DesignKind));
    else if (shape?.m) (named.set(shape.m[1], shape.m[2]), (name = shape.m[2]), (kind = shape.kind));
    else if (named.has(name)) name = named.get(name)!;
    name = tidy(name.replace(/^["'`*_]+|["'`*_]+$/g, ""), 48);
    if (!name) return null;
    let b = boxes.find((x) => same(x.label, name));
    if (!b) {
      if (boxes.length >= MAX_BOXES) return null;
      b = { id: `b${boxes.length + 1}`, label: name, detail: null, by: null, ts: now, quote: null, points: [], caught: [] };
      boxes.push(b);
    }
    if (detail && !b.detail) b.detail = clip(detail.trim(), 240) || null;
    if (kind && kind !== "thing" && !b.kind) b.kind = kind;
    if (within && !b.group) b.group = within.id;
    return b;
  };
  const arrow = (from: string, to: string, label: string) => {
    const a = box(from);
    const b = box(to);
    // A box can relate to itself: a task depends on a task.
    if (!a || !b || arrows.length >= MAX_ARROWS) return;
    if (arrows.some((x) => x.from === a.id && x.to === b.id)) return;
    arrows.push({ id: `a${arrows.length + 1}`, from: a.id, to: b.id, label: tidy(label.replace(/^["'|]+|["'|]+$/g, ""), 40), by: null, ts: now, quote: null });
  };
  for (const raw of text.slice(0, SEED_MAX).split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim().replace(/;$/, "");
    // A heading or a mermaid subgraph opens a group; `end` closes a subgraph.
    let g = /^#{1,6}\s+([^:]+?)(?::\s+(.+))?$/.exec(line);
    if (g) {
      within = group(g[1], g[2] ?? null);
      continue;
    }
    if ((g = /^subgraph\s+(?:[\w.-]+\s*\[\s*"?(.+?)"?\s*\]|"?(.+?)"?)$/i.exec(line))) {
      within = group(g[1] ?? g[2]);
      continue;
    }
    if (/^end$/i.test(line)) {
      within = null;
      continue;
    }
    if (!line || /^(```|%%|flowchart\b|graph\b|direction\b|classDef\b|class\b|style\b|linkStyle\b|#)/i.test(line)) continue;
    // A -->|label| B, A -- label --> B, A --> B (mermaid), then A -> B: label and A → B: label.
    let m = /^(.+?)\s*(?:-->|==>|-\.->|---)\s*\|\s*(.*?)\s*\|\s*(.+)$/.exec(line);
    if (m) (arrow(m[1], m[3], m[2]));
    else if ((m = /^(.+?)\s*(?:--|==)\s+(.+?)\s+(?:-->|==>|---)\s*(.+)$/.exec(line))) arrow(m[1], m[3], m[2]);
    else if ((m = /^(.+?)\s*(?:-->|==>|-\.->|->|→|=>)\s*(.+?)(?:\s*:\s*(.*))?$/.exec(line))) arrow(m[1], m[2], m[3] ?? "");
    else if ((m = /^([^:]{1,60}):\s+(.+)$/.exec(line))) box(m[1], m[2]);
    else if (/^[\w.-]+\s*[[({]/.test(line) || (line.length <= 48 && !/[.!?]$/.test(line))) box(line);
  }
  // A group is for telling areas apart: one that holds everything, or a single box, says nothing.
  const size = (id: string) => boxes.filter((b) => b.group === id).length;
  groups = groups.filter((x) => size(x.id) >= 2 && size(x.id) < boxes.length);
  for (const b of boxes) if (b.group && !groups.some((x) => x.id === b.group)) delete b.group;
  return { boxes, arrows, ...(groups.length ? { groups } : {}) };
}

/** Whether pasted text is already a diagram (most of its lines are a box or an arrow), so it can be
 *  read as written instead of asking the model to find the design in it. */
export function isDiagramText(text: string): boolean {
  const lines = text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter((l) => l && !/^(```|%%|flowchart\b|graph\b)/i.test(l));
  if (!lines.length) return false;
  const fits = lines.filter((l) => /(-->|==>|->|→|=>)/.test(l) || /^[^:]{1,40}:\s+\S/.test(l) || (l.length <= 40 && !/[.!?,]$/.test(l)));
  return fits.length / lines.length >= 0.8;
}

/** The mermaid diagrams in a plan or spec, joined: what a session started from a to-do reads. */
export const mermaidIn = (markdown: string) => [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");

/** A diagram the model read out of notes (DiagramAnswer from SEED_SYSTEM), all of it kept. */
export function seedFromAnswer(a: DiagramAnswer | null, now = Date.now()): DesignDiagram {
  if (!a) return { boxes: [], arrows: [] };
  const line = (b: DiagramAnswer["boxes"][number]) => `${tidy(b.label, 48).replace(/:/g, " ")}${b.kind && b.kind !== "thing" ? ` (${b.kind})` : ""}: ${b.detail.replace(/\s+/g, " ")}`;
  const areas = [...new Set(a.boxes.flatMap((b) => (b.group?.trim() ? [tidy(b.group, 40)] : [])))];
  const about = (area: string) => a.groups?.find((g) => same(tidy(g.label, 40), area))?.detail.replace(/\s+/g, " ").trim();
  const lines = [
    ...a.boxes.filter((b) => !b.group?.trim()).map(line),
    ...areas.flatMap((area) => [`## ${area.replace(/:/g, " ")}${about(area) ? `: ${about(area)}` : ""}`, ...a.boxes.filter((b) => b.group?.trim() && same(tidy(b.group, 40), area)).map(line)]),
    "end",
    ...a.arrows.flatMap((x) => {
      const end = (ref: string) => a.boxes[Number(/^new(\d+)$/.exec(ref)?.[1] ?? 0) - 1]?.label;
      const from = end(x.from);
      const to = end(x.to);
      return from && to ? [`${tidy(from, 48).replace(/:/g, " ")} -> ${tidy(to, 48).replace(/:/g, " ")}: ${x.label}`] : [];
    }),
  ];
  return parseSeed(lines.join("\n"), now);
}

// ---- the live diagram --------------------------------------------------------------------------

/** Keeps one design session's diagram. Not thread-safe: the room runs one pass at a time. */
export const CONTEXT_MAX = 12;
export const CONTEXT_TEXT_MAX = 20_000;

/** What every pass of a session reads as background: what was pasted at the start, then each piece
 *  of context it was given. */
export const sessionBackground = (row: { seed: string | null; context: DesignContext[] }): string | null =>
  [row.seed ?? "", ...row.context.map((c) => `## ${c.title}\n${c.text}`)].filter((x) => x.trim()).join("\n\n") || null;

export class DiagramKeeper {
  private boxes: DesignBox[] = [];
  private arrows: DesignArrow[] = [];
  private groups: DesignGroup[] = [];
  private lastLook = 0;
  private nb = 0;
  private na = 0;
  private ng = 0;

  constructor(
    private model: DiagramModel,
    /** What is being designed. UNTITLED until a pass names a session that started without a topic. */
    public prompt: string,
    /** Talk before this isn't the session's. */
    private readonly since: number,
    saved?: DesignDiagram | null,
    /** What the session started from, as pasted: context for every pass. */
    private seed: string | null = null,
  ) {
    this.lastLook = since;
    if (saved) {
      this.boxes = saved.boxes;
      this.arrows = saved.arrows;
      this.groups = saved.groups ?? [];
      const top = (xs: Array<{ id: string }>) => Math.max(0, ...xs.map((x) => Number(x.id.slice(1)) || 0));
      this.nb = top(saved.boxes);
      this.na = top(saved.arrows);
      this.ng = top(this.groups);
      // What the talk put there carries a quote; a starting diagram's boxes don't, and aren't talk.
      const heard = [...saved.boxes.flatMap((b) => [b.quote ? b.ts : 0, ...b.points.map((p) => p.ts)]), ...saved.arrows.map((a) => (a.quote ? a.ts : 0))];
      this.lastLook = Math.max(since, ...heard);
    }
  }

  /** The session was given more context during the call. */
  background(text: string | null) {
    this.seed = text;
  }

  all(): DesignDiagram {
    return { boxes: this.boxes, arrows: this.arrows, ...(this.groups.length ? { groups: this.groups } : {}) };
  }

  unreadSince(segments: Segment[]): number | null {
    return segments.find((s) => s.ts > this.lastLook)?.ts ?? null;
  }

  /** Someone kept a suggestion: it joins the diagram. Keeping an arrow keeps the boxes at its ends. */
  keep(id: string): boolean {
    const b = this.boxes.find((x) => x.id === id && !x.removed);
    if (b) return b.suggested ? (delete b.suggested, true) : false;
    const a = this.arrows.find((x) => x.id === id && !x.removed);
    if (!a) return false;
    let changed = false;
    if (a.suggested) (delete a.suggested, (changed = true));
    for (const end of [a.from, a.to]) {
      const e = this.boxes.find((x) => x.id === end && !x.removed);
      if (e?.suggested) (delete e.suggested, (changed = true));
    }
    return changed;
  }

  /** Someone dropped a suggestion, or took a kept box or arrow off. Its words stay so a later pass
   *  doesn't suggest it again. A box takes its arrows with it. */
  drop(id: string): boolean {
    const b = this.boxes.find((x) => x.id === id && !x.removed);
    if (b) {
      b.removed = true;
      for (const a of this.arrows) if (a.from === id || a.to === id) a.removed = true;
      return true;
    }
    const a = this.arrows.find((x) => x.id === id && !x.removed);
    if (!a) return false;
    a.removed = true;
    return true;
  }

  /** One pass over the talk up to `now`. `caught` is the meeting's to-dos, decisions and open
   *  questions so far. Returns whether the diagram changed. */
  async run(segments: Segment[], people: string[], caught: BrainCaught[], meetingStartedAt: number, now: number): Promise<boolean> {
    const talk = segments.filter((s) => s.ts > this.since && s.ts <= now).sort((a, b) => a.ts - b.ts);
    const firstNew = talk.findIndex((s) => s.ts > this.lastLook);
    if (firstNew === -1) return false;
    const from = Math.min(firstNew, Math.max(0, talk.findIndex((s) => s.ts > now - WINDOW_MS)));
    const shown = talk.slice(from);
    const live = shownDiagram(this.all());
    const name = (id: string) => this.boxes.find((b) => b.id === id)?.label ?? id;
    const linked = new Set(this.boxes.flatMap((b) => b.caught.map((c) => c.id)));
    const open = caught.filter((c) => !linked.has(c.id));
    const mark = (x: { suggested?: boolean }) => (x.suggested ? " (suggested)" : "");
    const groupName = (id: string | null | undefined) => this.groups.find((g) => g.id === id)?.label ?? null;
    const sort = (b: DesignBox) => ` [${b.kind ?? "thing"}, ${groupName(b.group) ? `in group ${groupName(b.group)}` : "no group"}]`;
    const boxLines = live.boxes.map((b) => `- [${b.id}] ${b.label}${mark(b)}: ${b.detail ?? ""}${b.points.length ? ` (+ ${b.points.map((p) => p.text).join("; ")})` : ""}${sort(b)}`);
    const groupLines = (live.groups ?? []).map((g) => `- ${g.label}${g.detail ? `: ${g.detail}` : ""}`);
    const arrowLines = live.arrows.map((a) => `- [${a.from}] ${name(a.from)} --${a.label || "relates to"}--> [${a.to}] ${name(a.to)}${mark(a)}`);
    const off = [...this.boxes.filter((b) => b.removed).map((b) => `- ${b.label}`), ...this.arrows.filter((a) => a.removed && !this.boxes.find((b) => (b.id === a.from || b.id === a.to) && b.removed)).map((a) => `- ${name(a.from)} --${a.label}--> ${name(a.to)}`)];
    const lines = shown
      .map((s, k) => `${from + k >= firstNew ? "NEW " : ""}[${k + 1}] [${at(s.ts, meetingStartedAt)}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
      .join("\n");
    const a = await this.model.designDiagram(
      [`What the team is designing: ${this.prompt === UNTITLED_DESIGN ? "(not named yet: the session started without a topic)" : this.prompt}`, `People: ${people.join(", ")}`, this.seed ? `What they started from:\n${clip(this.seed, 6000)}` : ""].filter(Boolean).join("\n"),
      [
        `Boxes so far:\n${boxLines.join("\n") || "(none)"}`,
        groupLines.length ? `Groups so far:\n${groupLines.join("\n")}` : "",
        `Arrows so far:\n${arrowLines.join("\n") || "(none)"}`,
        off.length ? `Dropped by the team, never suggest these again:\n${off.join("\n")}` : "",
        open.length ? `Caught, not linked to a box yet:\n${open.map((c) => `- [${c.id}] ${c.kind}: ${c.text}`).join("\n")}` : "",
        `Transcript, meeting time (${at(now, meetingStartedAt)} now):\n${lines}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    this.lastLook = talk.at(-1)!.ts;
    if (!a) return false;
    let changed = false;
    const topic = tidy(a.topic ?? "", 80);
    if (this.prompt === UNTITLED_DESIGN && topic) ((this.prompt = topic), (changed = true));
    const segOf = (n: number) => shown[Math.min(shown.length, Math.max(firstNew - from + 1, n)) - 1];
    const quote = (s: Segment) => ({ segmentId: s.id, ts: s.ts, speaker: s.speakerName, text: clip(s.text, 400) });
    const waiting = () => this.boxes.filter((b) => b.suggested && !b.removed).length + this.arrows.filter((x) => x.suggested && !x.removed).length;
    /** The group of that name: one that is there, or a new one while there is room. */
    const groupOf = (raw: string | null | undefined): DesignGroup | null => {
      const label = tidy(raw ?? "", 40);
      if (!label) return null;
      const had = this.groups.find((g) => same(g.label, label) || similar(g.label, label));
      if (had) return had;
      if ((live.groups?.length ?? 0) + this.groups.filter((g) => !live.groups?.some((x) => x.id === g.id) && this.boxes.some((b) => b.group === g.id && !b.removed)).length >= MAX_GROUPS) return null;
      const detail = a.groups?.find((g) => same(tidy(g.label, 40), label))?.detail;
      const made: DesignGroup = { id: `g${++this.ng}`, label, detail: clip((detail ?? "").replace(/\s+/g, " ").trim(), 160) || null };
      this.groups.push(made);
      return made;
    };
    /** new1, new2…: the box each answer entry became (or already was), "" when it was refused. */
    const fresh: string[] = [];
    for (const x of a.boxes) {
      const label = tidy(x.label, 48);
      if (!label) {
        fresh.push("");
        continue;
      }
      // One that is there, or that the room dropped, isn't suggested again; arrows still find the one that is there.
      const had = this.boxes.find((b) => same(b.label, label) || similar(b.label, label));
      if (had || this.boxes.filter((b) => !b.removed).length >= MAX_BOXES || waiting() >= MAX_WAITING) {
        fresh.push(had && !had.removed ? had.id : "");
        continue;
      }
      const seg = segOf(x.line);
      const b: DesignBox = { id: `b${++this.nb}`, label, detail: clip(x.detail.trim(), 240) || null, by: first(x.by), ts: seg.ts, quote: quote(seg), points: [], caught: [], suggested: true };
      if (x.kind && x.kind !== "thing" && DESIGN_KINDS.includes(x.kind)) b.kind = x.kind;
      const g = groupOf(x.group);
      if (g) b.group = g.id;
      this.boxes.push(b);
      fresh.push(b.id);
      changed = true;
    }
    const end = (ref: string) => {
      const id = /^new\d+$/.test(ref) ? fresh[Number(ref.slice(3)) - 1] : ref;
      return this.boxes.find((b) => b.id === id && !b.removed) ?? null;
    };
    for (const x of a.arrows) {
      const f = end(x.from);
      const t = end(x.to);
      if (!f || !t) continue;
      // The same pair is joined once, whichever way it was drawn or dropped.
      if (this.arrows.some((y) => (y.from === f.id && y.to === t.id) || (y.from === t.id && y.to === f.id))) continue;
      if (this.arrows.filter((y) => !y.removed).length >= MAX_ARROWS || waiting() >= MAX_WAITING + 4) continue;
      const seg = segOf(x.line);
      this.arrows.push({ id: `a${++this.na}`, from: f.id, to: t.id, label: tidy(x.label, 40), by: first(x.by), ts: seg.ts, quote: quote(seg), suggested: true });
      changed = true;
    }
    for (const x of a.extend) {
      const b = this.boxes.find((b) => b.id === x.id && !b.removed);
      const text = clip(x.point.trim(), 160);
      if (!b || !text || b.points.length >= MAX_POINTS || b.points.some((p) => similar(p.text, text))) continue;
      const seg = segOf(x.line);
      b.points.push({ text, by: first(x.by), ts: seg.ts, quote: quote(seg) });
      changed = true;
    }
    // A box goes into a group only from outside one: what the room sees together stays together.
    for (const x of a.place ?? []) {
      const b = this.boxes.find((b) => b.id === x.id && !b.removed);
      if (!b || b.group) continue;
      const g = groupOf(x.group);
      if (!g) continue;
      b.group = g.id;
      changed = true;
    }
    for (const x of a.caught) {
      const b = this.boxes.find((b) => b.id === x.id && !b.removed);
      const c = open.find((c) => c.id === x.item);
      if (!b || !c || linked.has(c.id)) continue;
      b.caught.push(c);
      linked.add(c.id);
      changed = true;
    }
    return changed;
  }

  /** What was caught may have been reworded, ticked off or taken back since it was linked. */
  refresh(caught: BrainCaught[]): boolean {
    let changed = false;
    const now = new Map(caught.map((c) => [c.id, c]));
    for (const b of this.boxes) {
      const next = b.caught.flatMap((c) => (now.has(c.id) ? [now.get(c.id)!] : []));
      if (JSON.stringify(next) !== JSON.stringify(b.caught)) (b.caught = next), (changed = true);
    }
    return changed;
  }
}

// ---- the draft spec ---------------------------------------------------------------------------

const mm = (s: string) => s.replace(/"/g, "'").replace(/[\[\]{}|<>]/g, " ").replace(/\s+/g, " ").trim();

/** The diagram as a mermaid flowchart: what the room kept, nothing still waiting. Kinds are drawn
 *  as shapes and groups as subgraphs, the way parseSeed reads them back. */
export function diagramMermaid(d: DesignDiagram): string {
  const live = shownDiagram(d);
  const boxes = live.boxes.filter((b) => !b.suggested);
  const on = new Set(boxes.map((b) => b.id));
  const arrows = live.arrows.filter((a) => !a.suggested && on.has(a.from) && on.has(a.to));
  const shape = (b: DesignBox) => {
    const [open, close] = SHAPES.find((x) => x[2] === (b.kind ?? "thing") && (b.kind ? true : x[0] === "["))!;
    return `${b.id}${open}"${mm(b.label)}"${close}`;
  };
  const groups = (live.groups ?? []).filter((g) => boxes.some((b) => b.group === g.id));
  const inGroup = new Set(groups.map((g) => g.id));
  return [
    "flowchart LR",
    ...boxes.filter((b) => !b.group || !inGroup.has(b.group)).map((b) => `  ${shape(b)}`),
    ...groups.flatMap((g) => [`  subgraph ${g.id}["${mm(g.label)}"]`, ...boxes.filter((b) => b.group === g.id).map((b) => `    ${shape(b)}`), "  end"]),
    ...arrows.map((a) => (a.label ? `  ${a.from} -->|"${mm(a.label)}"| ${a.to}` : `  ${a.from} --> ${a.to}`)),
  ].join("\n");
}

/** The session as a draft spec, in markdown: the diagram, each part, how the parts relate, and what
 *  the call decided, left open and gave people to do. `caught` is everything the meeting caught. */
export function draftSpec(prompt: string, d: DesignDiagram, caught: BrainCaught[], context: DesignContext[] = []): string {
  const live = shownDiagram(d);
  const boxes = live.boxes.filter((b) => !b.suggested);
  const on = new Set(boxes.map((b) => b.id));
  const arrows = live.arrows.filter((a) => !a.suggested && on.has(a.from) && on.has(a.to));
  const name = (id: string) => live.boxes.find((b) => b.id === id)?.label ?? id;
  const about = new Map<string, string>();
  for (const b of live.boxes) for (const c of b.caught) about.set(c.id, b.label);
  const of = (kind: BrainCaught["kind"]) => caught.filter((c) => c.kind === kind);
  const list = (kind: BrainCaught["kind"]) => of(kind).map((c) => `- ${c.text}${about.has(c.id) ? ` (${about.get(c.id)})` : ""}${kind === "action" && c.owner ? `, ${c.owner}` : ""}`);
  const waiting = [...live.boxes.filter((b) => b.suggested).map((b) => `- ${b.label}${b.detail ? `: ${b.detail}` : ""}`), ...live.arrows.filter((a) => a.suggested).map((a) => `- ${name(a.from)} ${a.label || "relates to"} ${name(a.to)}`)];
  const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);
  return [
    `# ${prompt}`,
    "",
    "A draft from a design session: the diagram the team drew by talking it through. It hasn't been reviewed.",
    "",
    "## Diagram",
    "",
    "```mermaid",
    diagramMermaid(d),
    "```",
    "",
    ...section(
      "Parts",
      boxes.flatMap((b) => [`- **${b.label}**${b.detail ? `: ${b.detail}` : ""}`, ...b.points.map((p) => `  - ${p.text}`)]),
    ),
    ...section(
      "Groups",
      (live.groups ?? []).flatMap((g) => {
        const inside = boxes.filter((b) => b.group === g.id).map((b) => b.label);
        return inside.length ? [`- **${g.label}**${g.detail ? `: ${g.detail}` : ""} (${inside.join(", ")})`] : [];
      }),
    ),
    ...section(
      "How they relate",
      arrows.map((a) => `- ${name(a.from)} ${a.label || "relates to"} ${name(a.to)}`),
    ),
    ...section("Decided", list("decision")),
    ...section("Open questions", list("question")),
    ...section("To-dos", list("action")),
    ...section("Suggested, not kept", waiting),
    ...section(
      "Context it started from",
      context.map((c) => `- ${c.url ? `[${c.title}](${c.url})` : c.title}`),
    ),
  ]
    .join("\n")
    .trim();
}

const STAND: Actor = { kind: "stand", person: null };

/** The session has ended: its diagram is saved as a draft spec on its to-do. A session with no to-do
 *  gets one, filed in the meeting it ran in. Returns the to-do's id, or null when there is nothing
 *  to save (no box was kept) or nowhere to put it. */
export function saveDraftSpec(db: DB, b: BrainstormRow, caught: BrainCaught[]): string | null {
  if (b.kind !== "design" || !b.diagram) return null;
  if (!shownDiagram(b.diagram).boxes.some((x) => !x.suggested)) return null;
  let note = b.taskId ? db.getNote(b.taskId) : null;
  if (note && (note.roomId !== b.roomId || note.kind !== "action")) note = null;
  if (!note) {
    if (!b.meetingId) return null;
    const made = db.addNote(b.meetingId, b.itemId, { kind: "action", text: clip(`Design: ${b.prompt}`, 200), owner: b.startedBy }, "Stand");
    db.setBrainstormTask(b.id, made.id);
    note = db.getNote(made.id);
    if (!note) return null;
  }
  const spec = draftSpec(b.prompt, b.diagram, caught, b.context);
  db.addPlan(b.roomId, note.id, spec, "Stand", STAND);
  db.addUpdate({
    roomId: b.roomId,
    itemId: note.itemId,
    noteId: note.id,
    noteText: note.text,
    userId: "stand",
    userName: "Stand",
    client: null,
    actor: STAND,
    status: "plan",
    text: `Draft spec from the design session "${clip(b.prompt, 100)}".`,
    links: [],
  });
  planChanged(db, null, note);
  return note.id;
}
