// A brainstorm: a call that starts from one sentence (a topic or a question) and whose middle
// screen is a map of what the talk has come up with. The sentence is the centre; the directions
// the talk opens branch off it, and the ideas said under a direction hang off that.
//
// The map is drawn by a model pass in the style of the running list (liveList.ts): after each
// pause in the talk it gets the map so far, with ids, and the last couple of minutes of talk with
// the lines it hasn't read marked NEW, and returns only what those lines add. A circle that is on
// the map is never regrouped or dropped by a later pass, so what people are looking at stays put;
// only a person takes one off. Two levels, never deeper: a deeper tree is unreadable on a call.
import { z } from "zod";
import type { BrainCaught, BrainNode, BrainstormSummary, BrainstormView, DesignDiagram, Segment } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import { similar } from "./notesMerge.ts";

export const MAP_DEBOUNCE_MS = 4_000;
export const MAP_MAX_WAIT_MS = 12_000;
const MAP_WINDOW_MS = 2 * 60_000;
export const MAX_DIRECTIONS = 8;
export const MAX_IDEAS = 12;
const MAX_POINTS = 8;
export const PROMPT_MAX = 160;

export class BrainstormError extends Error {}

export const MapAnswerSchema = z.object({
  add: z
    .array(
      z.object({
        under: z.string().describe('"root" for a new direction, or the id of the direction this idea belongs to (d1, d2…)'),
        label: z.string().describe("What goes in the circle: at most 5 words, plain, no full stop"),
        detail: z.string().describe("One sentence saying what the idea is, in the speaker's terms"),
        by: z.string().nullable().describe("First name of who raised it; null if unclear"),
        line: z.number().int().describe("The NEW line it comes from"),
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
    readonly prompt: string,
    /** Talk before this isn't the brainstorm's. */
    private readonly since: number,
    saved?: BrainNode[] | null,
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

  all(): BrainNode[] {
    return this.nodes;
  }

  unreadSince(segments: Segment[]): number | null {
    return segments.find((s) => s.ts > this.lastLook)?.ts ?? null;
  }

  /** Someone took a circle off: Stand got it wrong. Its words stay so a later pass doesn't add it
   *  again. A direction takes its ideas with it. */
  remove(id: string): boolean {
    const n = this.nodes.find((x) => x.id === id && !x.removed);
    if (!n) return false;
    n.removed = true;
    for (const c of this.nodes) if (c.parent === id) c.removed = true;
    return true;
  }

  /** One pass over the talk up to `now`. `caught` is the meeting's to-dos, decisions and open
   *  questions so far. Returns whether the map changed. */
  async run(segments: Segment[], people: string[], caught: BrainCaught[], meetingStartedAt: number, now: number): Promise<boolean> {
    const talk = segments.filter((s) => s.ts > this.since && s.ts <= now).sort((a, b) => a.ts - b.ts);
    const firstNew = talk.findIndex((s) => s.ts > this.lastLook);
    if (firstNew === -1) return false;
    const from = Math.min(firstNew, Math.max(0, talk.findIndex((s) => s.ts > now - MAP_WINDOW_MS)));
    const shown = talk.slice(from);
    const live = this.nodes.filter((n) => !n.removed);
    const linked = new Set(this.nodes.flatMap((n) => n.caught.map((c) => c.id)));
    const line = (n: BrainNode) => `[${n.id}] ${n.label}${n.by ? ` (${n.by})` : ""}: ${n.detail ?? ""}${n.points.length ? ` (+ ${n.points.map((p) => p.text).join("; ")})` : ""}`;
    const map =
      live
        .filter((n) => !n.parent)
        .map((d) => [`- ${line(d)}`, ...live.filter((n) => n.parent === d.id).map((i) => `  - ${line(i)}`)].join("\n"))
        .join("\n") || "(empty)";
    const off = this.nodes.filter((n) => n.removed).map((n) => `- ${n.label}`);
    const open = caught.filter((c) => !linked.has(c.id));
    const lines = shown
      .map((s, k) => `${from + k >= firstNew ? "NEW " : ""}[${k + 1}] [${at(s.ts, meetingStartedAt)}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
      .join("\n");
    const a = await this.model.brainstormMap(
      `The centre of the map: ${this.prompt}\nPeople: ${people.join(", ")}`,
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
        if (same || this.nodes.filter((n) => !n.parent && !n.removed).length >= MAX_DIRECTIONS) {
          fresh.push(same && !same.removed ? same.id : "");
          continue;
        }
        const d: BrainNode = { id: `d${++this.nd}`, parent: null, label, detail: clip(x.detail.trim(), 240) || null, by: first(x.by), ts: seg.ts, quote: quote(seg), points: [], caught: [] };
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
  /** The to-do a design session's draft spec is saved on. */
  taskId: string | null;
}

/** A diagram as people see it: without what was dropped. */
export const shownDiagram = (d: DesignDiagram): DesignDiagram => {
  const boxes = d.boxes.filter((b) => !b.removed);
  const on = new Set(boxes.map((b) => b.id));
  return { boxes, arrows: d.arrows.filter((a) => !a.removed && on.has(a.from) && on.has(a.to)) };
};

export const toBrainstormView = (b: BrainstormRow, busy = false): BrainstormView => ({
  id: b.id,
  roomId: b.roomId,
  prompt: b.prompt,
  status: b.status,
  itemId: b.itemId,
  meetingId: b.meetingId,
  startedBy: b.startedBy,
  startedAt: b.startedAt,
  endedAt: b.endedAt,
  nodes: b.nodes.filter((n) => !n.removed),
  ...(b.kind === "design" ? { design: shownDiagram(b.diagram ?? { boxes: [], arrows: [] }), taskId: b.taskId } : {}),
  ...(busy ? { busy } : {}),
});

const summaryOf = (b: BrainstormRow): BrainstormSummary => {
  const live = b.nodes.filter((n) => !n.removed);
  const d = b.kind === "design" ? shownDiagram(b.diagram ?? { boxes: [], arrows: [] }) : null;
  return {
    id: b.id,
    prompt: b.prompt,
    status: b.status,
    startedAt: b.startedAt,
    meetingId: b.meetingId,
    directions: live.filter((n) => !n.parent).length,
    ideas: live.filter((n) => n.parent).length,
    ...(d ? { design: { boxes: d.boxes.filter((x) => !x.suggested).length, arrows: d.arrows.filter((x) => !x.suggested).length } } : {}),
  };
};

/** Starts a brainstorm on one sentence: it becomes the agenda's first item, so what's said and
 *  caught is filed under it. One runs at a time; starting another closes the one running. */
export function startBrainstorm(
  db: DB,
  roomId: string,
  prompt: string,
  by: string | null,
  now = Date.now(),
  /** Makes it a design session: the diagram it starts from, what was pasted, and the to-do its spec goes on. */
  design?: { diagram: DesignDiagram; seed: string | null; taskId: string | null },
): BrainstormRow {
  const text = clip(prompt.replace(/\s+/g, " ").trim(), PROMPT_MAX);
  if (!text) throw new BrainstormError(design ? "Say what you're designing, in a sentence." : "Say what the brainstorm is about: a topic or a question, in a sentence.");
  const live = db.brainstormLive(roomId);
  if (live && live.prompt === text && (live.kind === "design") === !!design) return live;
  if (live) finishBrainstorm(db, roomId, null, now);
  const before = new Set(db.listItems(roomId).map((it) => it.id));
  const item = db.addItems(roomId, [{ source: "agenda", externalId: null, title: text, url: null, description: null }]).find((it) => !before.has(it.id))!;
  const rest = db.listItems(roomId).filter((it) => it.id !== item.id).map((it) => it.id);
  db.reorderItems(roomId, [item.id, ...rest]);
  return db.createBrainstorm({ roomId, prompt: text, itemId: item.id, startedBy: by, startedAt: now, design });
}

/** The meeting it ran in has ended (or another one took its place): it is done, and its sentence
 *  leaves the agenda. What was said and caught under it stays filed there. */
export function finishBrainstorm(db: DB, roomId: string, meetingId: string | null, now = Date.now()): BrainstormRow | null {
  const live = db.brainstormLive(roomId);
  if (!live) return null;
  db.setBrainstorm(live.id, { status: "done", meetingId: meetingId ?? live.meetingId, endedAt: now });
  if (live.itemId) db.archiveItem(live.itemId);
  return db.getBrainstorm(live.id);
}

export const brainstormLive = (db: DB, roomId: string): BrainstormView | null => {
  const b = db.brainstormLive(roomId);
  return b ? toBrainstormView(b) : null;
};

/** One brainstorm's page; null when it isn't this space's. */
export function brainstormPage(db: DB, roomId: string, id: string): BrainstormView | null {
  const b = db.getBrainstorm(id);
  return b && b.roomId === roomId ? toBrainstormView(b) : null;
}

/** The space's brainstorms, newest first, the one running included. */
export const brainstormsOf = (db: DB, roomId: string): BrainstormSummary[] => db.brainstorms(roomId).map(summaryOf);

/** The brainstorm that ran in a meeting, for its recap. */
export function brainstormOfMeeting(db: DB, meetingId: string): BrainstormSummary | null {
  const b = db.brainstormByMeeting(meetingId);
  return b ? summaryOf(b) : null;
}
