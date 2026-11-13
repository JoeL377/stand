// A brainstorm: a map of what the talk in a call has come up with, drawn from one sentence (a topic
// or a question). It is a view beside the board: anyone can look at it, and it changes nothing else
// in the call. The sentence is the centre; the directions
// the talk opens branch off it, and the ideas said under a direction hang off that.
//
// The map is drawn by a model pass in the style of the running list (liveList.ts): after each
// pause in the talk it gets the map so far, with ids, and the last couple of minutes of talk with
// the lines it hasn't read marked NEW, and returns only what those lines add. A circle that is on
// the map is never regrouped or dropped by a later pass, so what people are looking at stays put;
// only a person takes one off. Two levels, never deeper: a deeper tree is unreadable on a call.
import { z } from "zod";
import { UNTITLED_DESIGN, subjectNodes, type BrainCaught, type BrainNode, type BrainstormSummary, type BrainstormView, type DesignContext, type DesignDiagram, type Segment, type SketchStyle, type SketchSubject } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import { reviewedIdeas } from "./ideaReview.ts";
import { similar } from "./notesMerge.ts";

export const MAP_DEBOUNCE_MS = 4_000;
export const MAP_MAX_WAIT_MS = 12_000;
const MAP_WINDOW_MS = 2 * 60_000;
const CATCH_UP_STEPS = 20;
export const MAX_DIRECTIONS = 8;
/** Separate subjects a map holds besides its centre, each with its own centre and directions. */
export const MAX_CLUSTERS = 3;
export const MAX_IDEAS = 12;
const MAX_POINTS = 8;
export const PROMPT_MAX = 160;

export class BrainstormError extends Error {}

export const MapAnswerSchema = z.object({
  add: z
    .array(
      z.object({
        under: z.string().describe('"root" for a new direction, or the id of the direction this idea belongs to (d1, d2…)'),
        cluster: z
          .string()
          .nullable()
          .describe("Only for a new direction: null when it is an angle on the centre. When the talk has moved to a separate subject that doesn't answer the centre, the name of that subject's cluster: one already on the map, or a new one, at most 5 words"),
        label: z.string().describe("What goes in the circle: at most 5 words, plain, no full stop"),
        detail: z.string().describe("One sentence saying what the idea is, in the speaker's terms"),
        by: z.string().nullable().describe("First name of who raised it; null if unclear"),
        line: z.number().int().describe("The NEW line it comes from"),
        // A plain string, not an enum: one odd value would fail the whole pass.
        shape: z
          .string()
          .nullable()
          .optional()
          .describe('Only with a new cluster: "parts" when the talk on that subject is people working out how the parts of something connect or the steps something goes through, "ideas" when they are putting forward ideas or options. null when unsure, and for everything else'),
      }),
    )
    .describe("Only what the NEW lines add that the map doesn't already have. A direction is listed before the ideas under it; an idea may name a direction added in this same answer by its position: new1 for the first new direction, new2 for the second"),
  extend: z
    .array(
      z.object({
        id: z.string().describe("A circle on the map"),
        point: z.string().describe("What the NEW talk adds to it: a reason, a variation, a concern. At most 14 words"),
        by: z.string().nullable(),
        line: z.number().int(),
      }),
    )
    .describe("Someone built on a circle that is already on the map instead of raising something new. Usually empty"),
  caught: z
    .array(z.object({ id: z.string().describe("A circle on the map"), item: z.string().describe("A caught line's id, li_3") }))
    .describe("A to-do, decision or open question from the caught list that is about one circle and isn't linked to it yet. Usually empty"),
});
export type MapAnswer = z.infer<typeof MapAnswerSchema>;

export const MAP_SYSTEM = `You draw the map on the middle screen of a live team brainstorm. The centre is one sentence: the topic or question the team is brainstorming. Around it are the directions the talk has opened, and under each direction the ideas people have said. Everyone glances at the map while they talk, so it has to be right, and it has to stay calm: a circle that appears is read by everyone.

Each time you get the map so far, with ids, and the last couple of minutes of transcript. Lines marked NEW are the ones you haven't seen yet. Return only what the NEW lines add; everything you don't name stays as it is. Often the answer is empty.

- A direction (under "root") is a distinct angle on the centre that the talk has opened: an area, an approach, a kind of answer. Add one when someone raises an idea that fits no direction on the map, and name it for the angle, not for that one idea ("Onboarding", not "Add a welcome video"). Then add the idea under it. At most ${MAX_DIRECTIONS} directions: once they are there, put new ideas under the closest one.
- The talk can move on to a separate subject that doesn't answer the centre at all (from a company's future to credit cards, say). That subject is a cluster of its own, with its own centre: add its directions with cluster set to the subject's name, and its ideas under them, as you would for the centre. When the talk comes back to a cluster already on the map, use its name again. A new angle on the centre is a direction, not a cluster; most talk stays on the centre. With a new cluster, say in shape what the talk on it is like: "parts" when people are working out how the parts of something connect or what happens in which order, "ideas" when they are putting forward ideas or options, null when you can't tell yet. You may be told the board's current topic: a sign of where the talk is, not a reason on its own to start a cluster. Never drop what is said because it is off the centre.
- An idea (under a direction) is something specific someone proposes, suggests or wonders about that answers the centre. Add it once it has actually been stated, not while the speaker is still finding the words. Not agreement, not small talk, not logistics, not a restatement of something on the map.
- Before adding, check the map: when a circle already says it in other words, don't add it. When the NEW talk builds on an existing circle (a reason for it, a variation, a concern about it), use extend on that circle instead.
- Labels are what people will read at a glance: at most 5 words, concrete, in the team's own words. The detail is one plain sentence.
- by is the first name of the person who raised it, matched to the people in the meeting.
- The caught list is the meeting's to-dos, decisions and open questions. When one is clearly about a circle and isn't linked to it yet, link it in caught.
Transcription is rough: read through misheard words. Never invent an idea nobody said, and never return commentary about the transcript.`;

/** What the map needs from the model; null when it couldn't answer. */
export interface MapModel {
  brainstormMap(context: string, talk: string): Promise<MapAnswer | null>;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const first = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || null;
const at = (ms: number, start: number) => {
  const s = Math.max(0, Math.floor((ms - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Keeps one brainstorm's map. Not thread-safe: the room runs one pass at a time. */
export class MapKeeper {
  private nodes: BrainNode[] = [];
  private lastLook = 0;
  private nd = 0;
  private ni = 0;

  constructor(
    private model: MapModel,
    public prompt: string,
    /** Talk before this isn't the brainstorm's. */
    private readonly since: number,
    saved?: BrainNode[] | null,
    /** Talk the map may read; a line out of it is never read. */
    private readonly inScope: (s: Segment) => boolean = () => true,
  ) {
    this.lastLook = since;
    if (saved?.length) {
      this.nodes = saved;
      const top = (p: string) => Math.max(0, ...saved.filter((n) => n.id.startsWith(p)).map((n) => Number(n.id.slice(1)) || 0));
      this.nd = top("d");
      this.ni = top("i");
      this.lastLook = Math.max(since, ...saved.flatMap((n) => [n.ts, ...n.points.map((p) => p.ts)]));
    }
  }

  /** The cluster a new direction goes in: one on the map by the same name, or a new one while there
   *  is room. null is the centre. */
  private clusterFor(raw: string | null | undefined): string | null {
    const name = clip((raw ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, ""), 48);
    if (!name || similar(name, this.prompt)) return null;
    const had = clustersOf(this.nodes).find((c) => c.toLowerCase() === name.toLowerCase() || similar(c, name));
    if (had) return had;
    return clustersOf(this.nodes).length >= MAX_CLUSTERS ? null : name;
  }

  /** The topic the call is on now, from the board. */
  topicNow: (() => string | null) | null = null;

  /** What the talk on a cluster sounded like when it began, by the cluster's name: "parts" or "ideas". */
  readonly shapes = new Map<string, string>();

  /** Someone renamed a circle. */
  rename(id: string, label: string): string | null {
    const n = this.nodes.find((x) => x.id === id && !x.removed);
    const text = clip(label.replace(/\s+/g, " ").trim().replace(/\.$/, ""), 48);
    if (!n || !text || text === n.label) return null;
    const was = n.label;
    n.label = text;
    return was;
  }

  /** A separate subject got another name: its directions go with it. */
  renameCluster(from: string, to: string): boolean {
    const text = clip(to.replace(/\s+/g, " ").trim().replace(/\.$/, ""), 48);
    if (!text || text === from || clustersOf(this.nodes).some((c) => c.toLowerCase() === text.toLowerCase())) return false;
    let changed = false;
    for (const n of this.nodes) if (n.cluster === from) ((n.cluster = text), (changed = true));
    if (changed && this.shapes.has(from)) (this.shapes.set(text, this.shapes.get(from)!), this.shapes.delete(from));
    return changed;
  }

  /** Someone moved a circle: an idea under another direction, or a direction to another subject
   *  (`cluster`: that subject's name, null for the centre). Returns where it was, to move it back. */
  move(id: string, to: { parent: string } | { cluster: string | null }): { parent: string } | { cluster: string | null } | null {
    const n = this.nodes.find((x) => x.id === id && !x.removed);
    if (!n) return null;
    if ("parent" in to) {
      const d = this.nodes.find((x) => x.id === to.parent && !x.parent && !x.removed);
      if (!n.parent || !d || d.id === n.parent) return null;
      const was = { parent: n.parent };
      n.parent = d.id;
      return was;
    }
    if (n.parent || (n.cluster ?? null) === to.cluster) return null;
    const was = { cluster: n.cluster ?? null };
    if (to.cluster) n.cluster = to.cluster;
    else delete n.cluster;
    return was;
  }

  /** Someone added a circle by hand or by asking Stand: an idea under a direction, or a direction
   *  (`under` null) in a subject. */
  add(label: string, under: string | null, cluster: string | null, by: string | null, now: number): BrainNode | null {
    const text = clip(label.replace(/\s+/g, " ").trim().replace(/\.$/, ""), 48);
    if (!text) return null;
    if (under) {
      const d = this.nodes.find((x) => x.id === under && !x.parent && !x.removed);
      if (!d) return null;
      const n: BrainNode = { id: `i${++this.ni}`, parent: d.id, label: text, detail: null, by: first(by), ts: now, quote: null, points: [], caught: [] };
      this.nodes.push(n);
      return n;
    }
    const n: BrainNode = { id: `d${++this.nd}`, parent: null, label: text, detail: null, by: first(by), ts: now, quote: null, points: [], caught: [] };
    if (cluster) n.cluster = cluster;
    this.nodes.push(n);
    return n;
  }

  /** A map that started with no sentence takes a cluster's name as its centre: that cluster's
   *  directions hang off the centre from then on. */
  adopt(cluster: string) {
    for (const n of this.nodes) if (n.cluster === cluster) delete n.cluster;
    this.prompt = cluster;
  }

  /** Puts back what remove took off: the circle, and for a direction the ideas that went with it. */
  restore(ids: string[]): boolean {
    let changed = false;
    for (const n of this.nodes) if (ids.includes(n.id) && n.removed) (delete n.removed, (changed = true));
    return changed;
  }

  all(): BrainNode[] {
    return this.nodes;
  }

  /** The time of the last line a pass has read. */
  get readTo() {
    return this.lastLook;
  }

  unreadSince(segments: Segment[]): number | null {
    return segments.find((s) => s.ts > this.lastLook && this.inScope(s))?.ts ?? null;
  }

  /** Someone took a circle off: Stand got it wrong. Its words stay so a later pass doesn't add it
   *  again. A direction takes its ideas with it. */
  remove(id: string): boolean {
    return this.take(id).length > 0;
  }

  /** remove, saying what went: the circle and, for a direction, its ideas. */
  take(id: string): string[] {
    const n = this.nodes.find((x) => x.id === id && !x.removed);
    if (!n) return [];
    const gone = [n.id];
    n.removed = true;
    for (const c of this.nodes) if (c.parent === id && !c.removed) ((c.removed = true), gone.push(c.id));
    return gone;
  }

  /** One pass over the talk up to `now`. `caught` is the meeting's to-dos, decisions and open
   *  questions so far. Returns whether the map changed. */
  async run(segments: Segment[], people: string[], caught: BrainCaught[], meetingStartedAt: number, now: number): Promise<boolean> {
    const talk = segments.filter((s) => s.ts > this.since && s.ts <= now && this.inScope(s)).sort((a, b) => a.ts - b.ts);
    const firstNew = talk.findIndex((s) => s.ts > this.lastLook);
    if (firstNew === -1) return false;
    const from = Math.min(firstNew, Math.max(0, talk.findIndex((s) => s.ts > now - MAP_WINDOW_MS)));
    const shown = talk.slice(from);
    const live = this.nodes.filter((n) => !n.removed);
    const linked = new Set(this.nodes.flatMap((n) => n.caught.map((c) => c.id)));
    const line = (n: BrainNode) => `[${n.id}] ${n.label}${n.by ? ` (${n.by})` : ""}: ${n.detail ?? ""}${n.points.length ? ` (+ ${n.points.map((p) => p.text).join("; ")})` : ""}`;
    const branch = (d: BrainNode) => [`- ${line(d)}`, ...live.filter((n) => n.parent === d.id).map((i) => `  - ${line(i)}`)].join("\n");
    const dirs = live.filter((n) => !n.parent);
    const clusters = clustersOf(this.nodes);
    const map =
      [
        dirs.filter((d) => !d.cluster).map(branch).join("\n"),
        ...clusters.map((c) => `Cluster "${c}":\n${dirs.filter((d) => d.cluster === c).map(branch).join("\n") || "(empty)"}`),
      ]
        .filter(Boolean)
        .join("\n") || "(empty)";
    const off = this.nodes.filter((n) => n.removed).map((n) => `- ${n.label}`);
    const open = caught.filter((c) => !linked.has(c.id));
    const lines = shown
      .map((s, k) => `${from + k >= firstNew ? "NEW " : ""}[${k + 1}] [${at(s.ts, meetingStartedAt)}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
      .join("\n");
    const now_ = this.topicNow?.() ?? null;
    const moved = now_ && !similar(now_, this.prompt) ? now_ : null;
    const a = await this.model.brainstormMap(
      [`The centre of the map: ${this.prompt === UNTITLED_DESIGN ? "(not named yet: put every direction in a cluster named for what the talk is about, and that name becomes the centre)" : this.prompt}`, moved ? `The board's current topic: ${moved}` : "", `People: ${people.join(", ")}`].filter(Boolean).join("\n"),
      [
        `Map so far:\n${map}`,
        off.length ? `Taken off by the team, never add these again:\n${off.join("\n")}` : "",
        open.length ? `Caught, not linked to a circle yet:\n${open.map((c) => `- [${c.id}] ${c.kind}: ${c.text}`).join("\n")}` : "",
        `Transcript, meeting time (${at(now, meetingStartedAt)} now):\n${lines}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    this.lastLook = talk.at(-1)!.ts;
    if (!a) return false;
    let changed = false;
    const segOf = (n: number) => shown[Math.min(shown.length, Math.max(firstNew - from + 1, n)) - 1];
    const quote = (s: Segment) => ({ segmentId: s.id, ts: s.ts, speaker: s.speakerName, text: clip(s.text, 400) });
    const fresh: string[] = [];
    for (const x of a.add) {
      const label = clip(x.label.replace(/\s+/g, " ").trim().replace(/\.$/, ""), 48);
      if (!label) continue;
      const seg = segOf(x.line);
      const root = x.under === "root";
      const under = root ? null : /^new\d+$/.test(x.under) ? (fresh[Number(x.under.slice(3)) - 1] ?? null) : x.under;
      if (root) {
        // A direction someone took off, or one already there, isn't added again; its ideas still find it.
        const same = this.nodes.find((n) => !n.parent && similar(n.label, label));
        const cluster = this.clusterFor(x.cluster);
        if (same || this.nodes.filter((n) => !n.parent && !n.removed && (n.cluster ?? null) === cluster).length >= MAX_DIRECTIONS) {
          fresh.push(same && !same.removed ? same.id : "");
          continue;
        }
        const d: BrainNode = { id: `d${++this.nd}`, parent: null, label, detail: clip(x.detail.trim(), 240) || null, by: first(x.by), ts: seg.ts, quote: quote(seg), points: [], caught: [] };
        if (cluster) d.cluster = cluster;
        const shape = x.shape?.trim().toLowerCase();
        if (cluster && shape && !this.shapes.has(cluster) && !clustersOf(this.nodes).includes(cluster)) this.shapes.set(cluster, shape);
        this.nodes.push(d);
        fresh.push(d.id);
        changed = true;
        continue;
      }
      const parent = this.nodes.find((n) => n.id === under && !n.parent && !n.removed);
      if (!parent) continue;
      if (this.nodes.some((n) => n.parent && (similar(n.label, label) || (!!n.detail && similar(n.detail, x.detail))))) continue;
      if (this.nodes.filter((n) => n.parent === parent.id && !n.removed).length >= MAX_IDEAS) continue;
      this.nodes.push({ id: `i${++this.ni}`, parent: parent.id, label, detail: clip(x.detail.trim(), 240) || null, by: first(x.by), ts: seg.ts, quote: quote(seg), points: [], caught: [] });
      changed = true;
    }
    for (const x of a.extend) {
      const n = this.nodes.find((n) => n.id === x.id && !n.removed);
      const text = clip(x.point.trim(), 160);
      if (!n || !text || n.points.length >= MAX_POINTS || n.points.some((p) => similar(p.text, text))) continue;
      const seg = segOf(x.line);
      n.points.push({ text, by: first(x.by), ts: seg.ts, quote: quote(seg) });
      changed = true;
    }
    for (const x of a.caught) {
      const n = this.nodes.find((n) => n.id === x.id && !n.removed);
      const c = open.find((c) => c.id === x.item);
      if (!n || !c || linked.has(c.id)) continue;
      n.caught.push(c);
      linked.add(c.id);
      changed = true;
    }
    return changed;
  }

  /** What was caught may have been reworded, ticked off or taken back since it was linked. */
  refresh(caught: BrainCaught[]): boolean {
    let changed = false;
    const now = new Map(caught.map((c) => [c.id, c]));
    for (const n of this.nodes) {
      const next = n.caught.flatMap((c) => (now.has(c.id) ? [now.get(c.id)!] : []));
      if (JSON.stringify(next) !== JSON.stringify(n.caught)) (n.caught = next), (changed = true);
    }
    return changed;
  }
}

/** The separate subjects a map holds besides its centre, in the order they came up. */
export const clustersOf = (nodes: BrainNode[]): string[] => [...new Set(nodes.filter((n) => !n.parent && !n.removed && n.cluster).map((n) => n.cluster!))];

/** One map pass over a long stretch no pass has read, a window at a time, so the model never gets
 *  more than MAP_WINDOW_MS of new talk at once. `onStep` follows each step that changed the map. */
export async function catchUp(
  keeper: MapKeeper,
  segments: Segment[],
  people: string[],
  caught: BrainCaught[],
  meetingStartedAt: number,
  now: number,
  onStep?: () => void,
): Promise<boolean> {
  const upTo = segments.filter((s) => s.ts <= now);
  let changed = false;
  for (let step = 0; step < CATCH_UP_STEPS; step++) {
    const first = keeper.unreadSince(upTo);
    if (first === null) return changed;
    if (first + MAP_WINDOW_MS >= now) break;
    if (await keeper.run(segments, people, caught, meetingStartedAt, first + MAP_WINDOW_MS)) {
      changed = true;
      onStep?.();
    }
  }
  return (await keeper.run(segments, people, caught, meetingStartedAt, now)) || changed;
}

// ---- the record -----------------------------------------------------------------------------

export interface BrainstormRow {
  id: string;
  roomId: string;
  prompt: string;
  status: "live" | "done";
  itemId: string | null;
  meetingId: string | null;
  startedBy: string | null;
  startedAt: number;
  endedAt: number | null;
  nodes: BrainNode[];
  /** "design": a design session (designSession.ts), whose board is `diagram` instead of the map. */
  kind: "map" | "design";
  diagram: DesignDiagram | null;
  /** What a design session started from, as it was pasted. */
  seed: string | null;
  /** A design session's background, given through the MCP: shown behind Context, read by every pass. */
  context: DesignContext[];
  /** The to-do a design session's draft spec is saved on. */
  taskId: string | null;
  /** Ids of the ideas people starred on its page. */
  starred: string[];
  /** The board thread it is the map of; null: it follows no topic. */
  threadId: string | null;
  /** The stretches of the meeting a topic's map read, as of when it last parked, stopped or ended. */
  spans: Array<[number, number]> | null;
  /** What it holds as a sketch (sketch.ts): its subjects and how each is drawn. Null on one from
   *  before sketches, which is read as one (sketchOf). */
  sketch: SketchState | null;
}

/** One subject of a sketch, as kept. The first one's diagram is the row's own (`diagram`). */
export interface SubjectRow {
  id: string;
  title: string;
  style: SketchStyle;
  diagram: DesignDiagram | null;
  why?: "steps" | null;
  taskId?: string | null;
}

export interface SketchState {
  subjects: SubjectRow[];
  /** The subject the talk was last on. */
  live: string;
  /** When the talk went to which subject, oldest first: a line belongs to the subject of the last mark before it. */
  marks: Array<{ from: number; subject: string }>;
}

/** Any brainstorm row read as a sketch: its first subject is the sentence it started from (a diagram
 *  for a design session, else a map), and every separate subject on its map is one more. */
export function sketchOf(b: Pick<BrainstormRow, "prompt" | "kind" | "diagram" | "nodes" | "sketch" | "taskId">): SketchState {
  const kept = b.sketch;
  const subjects: SubjectRow[] = kept
    ? kept.subjects.map((s, i) => (i === 0 ? { ...s, title: b.prompt, diagram: b.diagram ?? s.diagram ?? null, taskId: b.taskId ?? s.taskId ?? null } : { ...s }))
    : [{ id: "s0", title: b.prompt, style: b.kind === "design" ? "diagram" : "map", diagram: b.diagram, taskId: b.taskId }];
  let n = Math.max(0, ...subjects.map((s) => Number(s.id.slice(1)) || 0));
  for (const c of clustersOf(b.nodes)) if (!subjects.some((s, i) => i > 0 && s.title === c)) subjects.push({ id: `s${++n}`, title: c, style: "map", diagram: null });
  const live = kept && subjects.some((s) => s.id === kept.live) ? kept.live : "s0";
  return { subjects, live, marks: kept?.marks ?? [] };
}

/** The circles of the subjects drawn as maps. A subject drawn as a diagram keeps its circles too (so
 *  it can be redrawn at once), but they are not ideas anyone saw. */
export function mapNodesOf(b: Pick<BrainstormRow, "prompt" | "kind" | "diagram" | "nodes" | "sketch" | "taskId">): BrainNode[] {
  const subjects = sketchOf(b).subjects;
  const hidden = new Set<string>();
  subjects.forEach((s, i) => {
    if (s.style === "diagram") for (const n of subjectNodes(b.nodes, s, i === 0)) hidden.add(n.id);
  });
  return hidden.size ? b.nodes.filter((n) => !hidden.has(n.id)) : b.nodes;
}

/** How much a subject holds, as it is drawn: ideas on a map, parts on a diagram. */
export function subjectCount(s: SubjectRow, nodes: BrainNode[], first: boolean): number {
  if (s.style === "diagram") return s.diagram ? shownDiagram(s.diagram).boxes.length : 0;
  return subjectNodes(nodes.filter((n) => !n.removed), s, first).filter((n) => n.parent).length;
}

/** A sketch's subjects as people see them. */
export const subjectsView = (sk: SketchState): SketchSubject[] =>
  sk.subjects.map((s) => ({ id: s.id, title: s.title, style: s.style, ...(s.diagram ? { diagram: shownDiagram(s.diagram) } : {}), ...(s.why ? { why: s.why } : {}), ...(s.taskId ? { taskId: s.taskId } : {}) }));

/** A diagram as people see it: without what was dropped. */
export const shownDiagram = (d: DesignDiagram): DesignDiagram => {
  const boxes = d.boxes.filter((b) => !b.removed);
  const on = new Set(boxes.map((b) => b.id));
  const used = new Set(boxes.map((b) => b.group));
  const groups = (d.groups ?? []).filter((g) => used.has(g.id));
  return { boxes, arrows: d.arrows.filter((a) => !a.removed && on.has(a.from) && on.has(a.to)), ...(groups.length ? { groups } : {}) };
};

export const toBrainstormView = (b: BrainstormRow, busy = false): BrainstormView => ({
  id: b.id,
  roomId: b.roomId,
  prompt: b.prompt,
  status: b.status,
  itemId: b.itemId,
  meetingId: b.meetingId,
  threadId: b.threadId,
  startedBy: b.startedBy,
  startedAt: b.startedAt,
  endedAt: b.endedAt,
  nodes: b.nodes.filter((n) => !n.removed),
  ...(b.starred.length ? { starred: b.starred.filter((id) => b.nodes.some((n) => n.id === id && !n.removed)) } : {}),
  ...(b.kind === "design" ? { design: shownDiagram(b.diagram ?? { boxes: [], arrows: [] }), taskId: b.taskId, ...(b.context.length ? { context: b.context } : {}) } : {}),
  ...(busy ? { busy } : {}),
  ...((sk) => ({ subjects: subjectsView(sk), liveSubject: sk.live }))(sketchOf(b)),
});

const summaryOf = (b: BrainstormRow): BrainstormSummary => {
  const live = mapNodesOf(b).filter((n) => !n.removed);
  const d = b.kind === "design" ? shownDiagram(b.diagram ?? { boxes: [], arrows: [] }) : null;
  return {
    id: b.id,
    prompt: b.prompt,
    status: b.status,
    startedAt: b.startedAt,
    meetingId: b.meetingId,
    threadId: b.threadId,
    directions: live.filter((n) => !n.parent).length,
    ideas: live.filter((n) => n.parent).length,
    ...(d ? { design: { boxes: d.boxes.filter((x) => !x.suggested).length, arrows: d.arrows.filter((x) => !x.suggested).length } } : {}),
    subjects: sketchOf(b).subjects.map((s, i) => ({ id: s.id, title: s.title, style: s.style, count: subjectCount(s, b.nodes, i === 0), ...(s.taskId ? { taskId: s.taskId } : {}) })),
  };
};

/** The sentence a brainstorm keeps, from what was typed. A design session can start without a
 *  topic: it is named from the talk (designSession.ts). */
export const promptOf = (prompt: string, design = false) => clip(prompt.replace(/\s+/g, " ").trim(), PROMPT_MAX) || (design ? UNTITLED_DESIGN : "");

/** Starts a brainstorm on one sentence. It is a view beside the board: it adds nothing to the
 *  agenda, and what's said is filed as it would be without it. One runs at a time; starting
 *  another closes the one running. */
export function startBrainstorm(
  db: DB,
  roomId: string,
  prompt: string,
  by: string | null,
  now = Date.now(),
  /** Makes it a design session: the diagram it starts from, what was pasted, and the to-do its spec goes on. */
  design?: { diagram: DesignDiagram; seed: string | null; taskId: string | null },
): BrainstormRow {
  const text = promptOf(prompt, !!design);
  if (!text) throw new BrainstormError("Say what the brainstorm is about: a topic or a question, in a sentence.");
  const live = db.brainstormLive(roomId);
  if (live && live.prompt === text && (live.kind === "design") === !!design) return live;
  if (live) finishBrainstorm(db, roomId, null, now);
  return db.createBrainstorm({ roomId, prompt: text, itemId: null, startedBy: by, startedAt: now, design });
}

/** It was stopped, the meeting it ran in has ended, or another one took its place: it is done, and
 *  its map is the record. A brainstorm from before maps were views had an agenda item: it leaves
 *  the agenda, and what was said and caught under it stays filed there. */
export function finishBrainstorm(db: DB, roomId: string, meetingId: string | null, now = Date.now()): BrainstormRow | null {
  const live = db.brainstormLive(roomId);
  if (!live) return null;
  db.setBrainstorm(live.id, { status: "done", meetingId: meetingId ?? live.meetingId, endedAt: now });
  if (live.itemId) db.archiveItem(live.itemId);
  return db.getBrainstorm(live.id);
}

/** The board moved off a topic: its map stops reading, and goes on by itself when the talk comes back. */
export function parkBrainstorm(db: DB, id: string, meetingId: string, spans: Array<[number, number]>) {
  db.setBrainstorm(id, { status: "done", meetingId });
  db.saveBrainstormSpans(id, spans);
}

/** A parked or stopped map draws again, as the same map. */
export function resumeBrainstorm(db: DB, id: string) {
  db.setBrainstorm(id, { status: "live", endedAt: null });
}

/** The other maps and diagrams of a meeting, oldest first. */
export const othersOfMeeting = (db: DB, meetingId: string, except: string | null): BrainstormSummary[] =>
  db.brainstormsOfMeeting(meetingId).filter((b) => b.id !== except).map(summaryOf);

export const brainstormLive = (db: DB, roomId: string): BrainstormView | null => {
  const b = db.brainstormLive(roomId);
  return b ? toBrainstormView(b) : null;
};

/** One brainstorm's page; null when it isn't this space's. */
export function brainstormPage(db: DB, roomId: string, id: string): BrainstormView | null {
  const b = db.getBrainstorm(id);
  return b && b.roomId === roomId ? { ...toBrainstormView(b), ...reviewedIdeas(db, b.id) } : null;
}

/** Stars an idea on a brainstorm's page, or takes the star off. The star is the space's, not one
 *  person's: it marks an idea worth coming back to. Null when the idea isn't on this space's map. */
export function starIdea(db: DB, roomId: string, id: string, nodeId: string, on: boolean): BrainstormView | null {
  const b = db.getBrainstorm(id);
  if (!b || b.roomId !== roomId || !b.nodes.some((n) => n.id === nodeId && n.parent && !n.removed)) return null;
  const starred = b.starred.filter((x) => x !== nodeId);
  if (on) starred.push(nodeId);
  db.saveBrainstormStars(id, starred);
  return { ...toBrainstormView({ ...b, starred }), ...reviewedIdeas(db, b.id) };
}

/** The space's brainstorms, newest first, the one running included. */
export const brainstormsOf = (db: DB, roomId: string): BrainstormSummary[] => db.brainstorms(roomId).map(summaryOf);

/** The brainstorm that ran in a meeting, for its recap. */
export function brainstormOfMeeting(db: DB, meetingId: string): BrainstormSummary | null {
  const b = db.brainstormByMeeting(meetingId);
  return b ? summaryOf(b) : null;
}
