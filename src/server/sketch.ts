// A sketch: the one board a call draws on. It holds every subject the talk was on, each drawn the
// way that fits it: ideas around a question as a map (brainstorm.ts), the parts of something and how
// they connect as a diagram (designSession.ts). It replaces picking "map" or "diagram" up front.
//
// One map keeper listens to the whole call. It is what notices that the talk moved to a separate
// subject (a cluster of its own, MAP_SYSTEM), so its clusters are the sketch's subjects, and every
// subject has circles whether or not they show. A subject drawn as a diagram also has a diagram
// keeper, which reads only the lines said while the talk was on that subject. Drawing a subject the
// other way is then cheap: a diagram becomes a map at once (its circles are there), and a map
// becomes a diagram by one pass over its own lines.
//
// How a subject starts out: the first one as the sketch was opened (asked for as a diagram, or from
// what the talk sounded like; a map when unsure). One the talk moves to is a diagram only when the
// map pass said the talk on it is about parts and steps; otherwise a map, and Stand may offer the
// diagram later (offer). A person's choice always stands.
import { DESIGN_KINDS, UNTITLED_DESIGN, subjectNodes, type BrainCaught, type BrainNode, type DesignKind, type Segment, type SketchStyle, type SketchUndo } from "../shared/protocol.ts";
import { MAP_DEBOUNCE_MS, MAP_MAX_WAIT_MS, MapKeeper, catchUp, clustersOf, sketchOf, type BrainstormRow, type MapModel, type SketchState, type SubjectRow } from "./brainstorm.ts";
import type { DB } from "./db.ts";
import { DiagramKeeper, saveSpecOf, type DiagramModel } from "./designSession.ts";

/** While the talk is on a diagram, the map pass (which only listens for a change of subject there)
 *  runs this often instead of after every pause. */
export const ROUTE_EVERY_MS = 40_000;
/** A sketch opened during a call starts with this much of the talk just before it already drawn. */
export const SKETCH_LOOK_BACK_MS = 2 * 60_000;
/** A change by hand or by voice can be taken back for this long. */
export const UNDO_MS = 30_000;

const first = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || null;
const partsLike = (shape: string | undefined) => !!shape && /^(part|step|flow|system|process|diagram)/.test(shape);

interface Subject extends SubjectRow {
  keeper: DiagramKeeper | null;
}

export class SketchKeeper {
  readonly map: MapKeeper;
  private subjects: Subject[];
  private live: string;
  private marks: Array<{ from: number; subject: string }>;
  private routedAt = 0;
  private undoStep: (SketchUndo & { back: () => void }) | null = null;
  /** Stand's offer to draw a subject the other way; one per subject and style in a call. */
  offer: { subject: string; style: SketchStyle } | null = null;
  private offeredOnce = new Set<string>();

  constructor(
    private models: MapModel & DiagramModel,
    row: BrainstormRow,
    /** Talk before this isn't the sketch's. */
    private readonly since: number,
    /** Talk the sketch may read. */
    private readonly inScope: (s: Segment) => boolean = () => true,
    /** What the first subject started from (a design session's pasted notes and context). */
    private background: string | null = null,
  ) {
    const sk = sketchOf(row);
    this.map = new MapKeeper(models, row.prompt, since, row.nodes, inScope);
    this.subjects = sk.subjects.map((s) => ({ ...s, keeper: null }));
    this.live = sk.live;
    this.marks = sk.marks.length ? sk.marks : [{ from: since, subject: "s0" }];
    for (const s of this.subjects) if (s.style === "diagram") this.keeperOf(s);
  }

  private subject(id: string): Subject | null {
    return this.subjects.find((s) => s.id === id) ?? null;
  }

  private subjectAt(ts: number): string {
    let on = "s0";
    for (const m of this.marks) if (m.from <= ts) on = m.subject;
    return on;
  }

  /** A subject's diagram keeper, made when it is first drawn as a diagram: it reads the subject's own lines. */
  private keeperOf(s: Subject): DiagramKeeper {
    s.keeper ??= new DiagramKeeper(this.models, s.title, this.since, s.diagram, s.id === "s0" ? this.background : null, (seg) => this.inScope(seg) && this.subjectAt(seg.ts) === s.id);
    return s.keeper;
  }

  /** The first subject was given more context during the call. */
  setBackground(text: string | null) {
    this.background = text;
    this.subjects[0].keeper?.background(text);
  }

  /** What the sketch is called: its first subject. A design session started blank is named from the talk. */
  get prompt(): string {
    return this.subjects[0].title;
  }

  get liveSubject(): string {
    return this.live;
  }

  styleOf(id: string): SketchStyle | null {
    return this.subject(id)?.style ?? null;
  }

  nodes(): BrainNode[] {
    return this.map.all();
  }

  /** As kept in the record. */
  state(): SketchState {
    return {
      subjects: this.subjects.map(({ keeper, ...s }) => ({ ...s, diagram: keeper ? keeper.all() : s.diagram })),
      live: this.live,
      marks: this.marks,
    };
  }

  undoView(now: number): SketchUndo | null {
    const u = this.undoStep;
    return u && now - u.at < UNDO_MS ? { text: u.text, by: u.by, at: u.at } : null;
  }

  private routeDue(now: number) {
    return this.subject(this.live)?.style !== "diagram" || now - this.routedAt >= ROUTE_EVERY_MS;
  }

  /** How long until the next pass should run; null when no pass has anything to read. */
  dueIn(segments: Segment[], now: number): number | null {
    const waits: number[] = [];
    const wait = (since: number) => Math.max(0, Math.min(MAP_DEBOUNCE_MS, since + MAP_MAX_WAIT_MS - now));
    for (const s of this.subjects) {
      if (s.style !== "diagram") continue;
      const u = this.keeperOf(s).unreadSince(segments);
      if (u !== null) waits.push(wait(u));
    }
    const m = this.map.unreadSince(segments);
    if (m !== null) waits.push(this.routeDue(now) ? wait(m) : Math.max(wait(m), this.routedAt + ROUTE_EVERY_MS - now));
    return waits.length ? Math.min(...waits) : null;
  }

  /** Whether a pass now would read anything: talk a diagram hasn't read, or talk the map hasn't and its turn has come. */
  ready(segments: Segment[], now: number): boolean {
    if (this.routeDue(now) && this.map.unreadSince(segments) !== null) return true;
    return this.subjects.some((s) => s.style === "diagram" && this.keeperOf(s).unreadSince(segments) !== null);
  }

  /** One pass over the talk up to `now`. `all`: the last one, which reads everything left.
   *  Returns whether anything on the sketch changed. */
  async run(segments: Segment[], people: string[], caught: BrainCaught[], meetingStartedAt: number, now: number, opts: { all?: boolean; onStep?: () => void } = {}): Promise<boolean> {
    let changed = false;
    if ((opts.all || this.routeDue(now)) && this.map.unreadSince(segments) !== null) {
      const before = new Set(this.map.all().map((n) => n.id));
      const drew = await catchUp(this.map, segments, people, caught, meetingStartedAt, now, opts.onStep);
      this.routedAt = now;
      changed = this.route(before) || drew;
    }
    for (const s of this.subjects) {
      if (s.style !== "diagram") continue;
      const k = this.keeperOf(s);
      if (k.unreadSince(segments) === null) continue;
      if (await k.run(segments, people, caught, meetingStartedAt, now)) changed = true;
      if (s.id === "s0" && k.prompt !== UNTITLED_DESIGN && k.prompt !== s.title) ((s.title = k.prompt), (this.map.prompt = k.prompt), (changed = true));
    }
    return changed;
  }

  /** After a map pass: a cluster that is new is a new subject, and the subject the pass added to
   *  last is the one the talk is on. */
  private route(before: Set<string>): boolean {
    let changed = false;
    // One opened with nothing typed: what the talk turned out to be about names its first subject.
    const s0 = this.subjects[0];
    const named = clustersOf(this.map.all())[0];
    if (s0.title === UNTITLED_DESIGN && named && !this.map.all().some((x) => !x.parent && !x.cluster)) {
      const parts = partsLike(this.map.shapes.get(named));
      this.map.adopt(named);
      s0.title = named;
      if (s0.keeper) s0.keeper.prompt = named;
      else if (parts) ((s0.style = "diagram"), (s0.why = "steps"), this.keeperOf(s0));
      changed = true;
    }
    const nodes = this.map.all().filter((n) => !n.removed);
    let n = Math.max(0, ...this.subjects.map((s) => Number(s.id.slice(1)) || 0));
    for (const c of clustersOf(nodes)) {
      if (this.subjects.some((s, i) => i > 0 && s.title === c)) continue;
      const parts = partsLike(this.map.shapes.get(c));
      this.subjects.push({ id: `s${++n}`, title: c, style: parts ? "diagram" : "map", diagram: null, keeper: null, ...(parts ? { why: "steps" as const } : {}) });
      changed = true;
    }
    const fresh = nodes.filter((x) => !before.has(x.id));
    if (!fresh.length) return changed;
    // The talk is on the subject it added to last (the one it added the most to, when two were added to at once).
    const tally = new Map<string, { n: number; from: number; to: number }>();
    for (const s of this.subjects) {
      const mine = subjectNodes(nodes, s, s.id === "s0").filter((x) => !before.has(x.id));
      if (mine.length) tally.set(s.id, { n: mine.length, from: Math.min(...mine.map((x) => x.ts)), to: Math.max(...mine.map((x) => x.ts)) });
    }
    const top = [...tally].sort((a, b) => b[1].to - a[1].to || b[1].n - a[1].n)[0];
    if (top && top[0] !== this.live) {
      const last = this.marks.at(-1)!;
      this.marks.push({ from: Math.max(top[1].from, last.from + 1), subject: top[0] });
      this.live = top[0];
      changed = true;
    }
    return changed;
  }

  // ---- changes people make -----------------------------------------------------------------

  private did(text: string, by: string | null, now: number, back: () => void) {
    this.undoStep = { text, by: first(by), at: now, back };
    return text;
  }

  /** Takes the last change back. */
  undo(now: number): boolean {
    const u = this.undoStep;
    if (!u || now - u.at >= UNDO_MS) return false;
    this.undoStep = null;
    u.back();
    return true;
  }

  /** Draws a subject the other way. A map that becomes a diagram is read by the next pass. */
  setStyle(id: string, style: SketchStyle, by: string | null, now: number): string | null {
    const s = this.subject(id);
    if (!s || s.style === style) return null;
    const was = { style: s.style, why: s.why };
    s.style = style;
    delete s.why;
    if (style === "diagram") this.keeperOf(s);
    // Back to a map: let the map pass catch up on what it only skimmed while the diagram had the talk.
    else this.routedAt = 0;
    if (this.offer?.subject === id) this.offer = null;
    return this.did(`Redrawn as a ${style}`, by, now, () => {
      s.style = was.style;
      if (was.why) s.why = was.why;
    });
  }

  /** The talk on the live subject sounds like the other kind of drawing: offer it, once. */
  suggest(style: SketchStyle): boolean {
    const s = this.subject(this.live);
    const key = `${this.live}:${style}`;
    if (!s || s.style === style || this.offeredOnce.has(key) || this.offer) return false;
    this.offeredOnce.add(key);
    this.offer = { subject: s.id, style };
    return true;
  }

  answerOffer(take: boolean, by: string | null, now: number): boolean {
    const o = this.offer;
    if (!o) return false;
    this.offer = null;
    if (take) this.setStyle(o.subject, o.style, by, now);
    return true;
  }

  /** One fix by hand. Returns what was done, in words, or null when nothing changed. */
  edit(subjectId: string, id: string, op: "rename" | "remove" | "move", arg: { label?: string; to?: string }, by: string | null, now: number): string | null {
    const s = this.subject(subjectId);
    if (!s) return null;
    if (id === subjectId) {
      if (op !== "rename" || !arg.label?.trim()) return null;
      return this.renameSubject(s, arg.label, by, now);
    }
    if (s.style === "diagram") {
      const k = this.keeperOf(s);
      const name = (x: string) => k.all().boxes.find((b) => b.id === x)?.label ?? "an arrow";
      if (op === "rename") {
        const was = k.rename(id, arg.label ?? "");
        return was === null ? null : this.did(`Renamed “${was || "the arrow"}”`, by, now, () => void k.rename(id, was));
      }
      if (op === "remove") {
        const label = name(id);
        const gone = k.take(id);
        return gone.length ? this.did(`Removed “${label}”`, by, now, () => void k.restore(gone)) : null;
      }
      return null;
    }
    const node = this.map.all().find((n) => n.id === id && !n.removed);
    if (!node) return null;
    if (op === "rename") {
      const was = this.map.rename(id, arg.label ?? "");
      return was === null ? null : this.did(`Renamed “${was}”`, by, now, () => void this.map.rename(id, was));
    }
    if (op === "remove") {
      const gone = this.map.take(id);
      return gone.length ? this.did(`Removed “${node.label}”`, by, now, () => void this.map.restore(gone)) : null;
    }
    // An idea goes under another direction; a direction goes to another subject.
    const target = arg.to ? this.subject(arg.to) : null;
    const to = target ? { cluster: target.id === "s0" ? null : target.title } : { parent: arg.to ?? "" };
    const was = this.map.move(id, to);
    if (!was) return null;
    const where = target ? target.title : (this.map.all().find((n) => n.id === arg.to)?.label ?? "");
    return this.did(`Moved “${node.label}” to “${where}”`, by, now, () => void this.map.move(id, was));
  }

  private renameSubject(s: Subject, label: string, by: string | null, now: number): string | null {
    const was = s.title;
    const text = label.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, 80);
    if (!text || text === was) return null;
    const set = (to: string, from: string) => {
      if (s.id === "s0") this.map.prompt = to;
      else if (clustersOf(this.map.all()).includes(from) && !this.map.renameCluster(from, to)) return false;
      s.title = to;
      if (s.keeper) s.keeper.prompt = to;
      return true;
    };
    if (!set(text, was)) return null;
    return this.did(`Renamed “${was}”`, by, now, () => void set(was, text));
  }

  /** Something asked of Stand out loud or in the chat ("Stand, add a step: text them before the
   *  email"), done on the subject the talk is on. Returns what was done, or null when the words
   *  weren't a change to the sketch (askSketch) or named nothing on it. */
  ask(ask: SketchAsk, by: string | null, now: number): string | null {
    if (ask.op === "undo") return this.undo(now) ? "Taken back" : null;
    const s = this.subject(this.live);
    if (!s) return null;
    if (ask.op === "redraw") return this.setStyle(s.id, ask.style, by, now);
    const labels: Array<{ id: string; label: string; dir?: boolean }> =
      s.style === "diagram"
        ? this.keeperOf(s).all().boxes.filter((b) => !b.removed).map((b) => ({ id: b.id, label: b.label }))
        : subjectNodes(this.map.all().filter((n) => !n.removed), s, s.id === "s0").map((n) => ({ id: n.id, label: n.label, dir: !n.parent }));
    const find = (words: string | undefined) => (words ? closest(words, labels) : null);
    if (ask.op === "remove") {
      const hit = find(ask.what);
      return hit ? this.edit(s.id, hit.id, "remove", {}, by, now) : null;
    }
    if (ask.op === "rename") {
      const hit = find(ask.what);
      return hit ? this.edit(s.id, hit.id, "rename", { label: sentence(ask.to) }, by, now) : null;
    }
    const label = sentence(ask.what);
    const near = find(ask.near);
    if (s.style === "diagram") {
      const k = this.keeperOf(s);
      const kind = ask.kind && (DESIGN_KINDS as readonly string[]).includes(ask.kind) ? (ask.kind as DesignKind) : null;
      const done = k.add(label, kind, by, now, near ? (ask.where === "after" ? { after: near.id } : { before: near.id }) : undefined);
      if (!done) return null;
      return this.did(`Added “${done.box.label}”${near ? ` ${ask.where === "after" ? "after" : "before"} “${near.label}”` : ""}`, by, now, () => k.unadd(done));
    }
    // On a map: under the direction named, else under the one talked about last.
    const dirs = labels.filter((l) => l.dir);
    const under = near?.dir ? near : near ? dirs.find((d) => d.id === this.map.all().find((n) => n.id === near.id)?.parent) : dirs.at(-1);
    const made = this.map.add(label, under?.id ?? null, s.id === "s0" ? null : s.title, by, now);
    if (!made) return null;
    return this.did(`Added “${made.label}”${under ? ` under “${under.label}”` : ""}`, by, now, () => void this.map.take(made.id));
  }

  /** What was caught may have been reworded, ticked off or taken back since it was linked. */
  refresh(caught: BrainCaught[]): boolean {
    let changed = this.map.refresh(caught);
    for (const s of this.subjects) if (s.keeper?.refresh(caught)) changed = true;
    return changed;
  }

  /** Keeps or takes off something on a subject's diagram, by its id (design.keep, design.drop). */
  diagram(subjectId: string | undefined, act: "keep" | "drop", id: string): boolean {
    const s = this.subject(subjectId ?? this.subjects.find((x) => x.style === "diagram")?.id ?? "");
    if (!s || s.style !== "diagram") return false;
    return act === "keep" ? this.keeperOf(s).keep(id) : this.keeperOf(s).drop(id);
  }
}

// ---- asking Stand to change the sketch ---------------------------------------------------------

export type SketchAsk =
  | { op: "add"; what: string; kind?: string; where?: "before" | "after" | "under"; near?: string }
  | { op: "remove"; what: string }
  | { op: "rename"; what: string; to: string }
  | { op: "redraw"; style: SketchStyle }
  | { op: "undo" };

const sentence = (s: string) => s.trim().replace(/^./, (c) => c.toUpperCase());
const STOP = new Set(["the", "a", "an", "that", "this", "to", "of", "one", "step", "box", "idea", "part", "them", "it"]);
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));

/** The thing on the sketch a few spoken words most likely mean; null when nothing is close. */
export function closest<T extends { label: string }>(said: string, among: T[]): T | null {
  const want = words(said);
  if (!want.length) return null;
  let best: { x: T; score: number } | null = null;
  for (const x of among) {
    const have = words(x.label);
    const hit = want.filter((w) => have.some((h) => h === w || (w.length > 3 && (h.startsWith(w) || w.startsWith(h))))).length;
    const score = hit / want.length + (hit && have.length === hit ? 0.1 : 0);
    if (hit && score >= 0.5 && (!best || score > best.score)) best = { x, score };
  }
  return best?.x ?? null;
}

const TO_STAND = /^(?:(?:hey|ok|okay)[, ]+)?(?:@?stand)\b[,:.]?\s*(?:can you |could you |please |go ahead and )*/i;

/** Reads one line said or typed in the call as a change to the sketch, when it is one. It has to be
 *  said to Stand ("Stand, …", "@stand …") unless `direct` (it came through Ask Stand, which already
 *  is). Plain talk about adding and removing things is never one. */
export function askSketch(text: string, direct = false): SketchAsk | null {
  let t = text.trim();
  if (TO_STAND.test(t)) t = t.replace(TO_STAND, "");
  else if (!direct) return null;
  t = t.replace(/^(?:can you |could you |please )+/i, "").trim();
  // One sentence is the ask; what follows is the call going on. Speech-to-text may end "add a step"
  // with a full stop before what the step is, so a bare "add a step." takes the next sentence too.
  const parts = t.split(/(?<=[.!?])\s+/);
  t = (/^add\s+(?:(?:an?|another|one more)\s+)?\w*[.:]?$/i.test(parts[0]) && parts[1] ? `${parts[0].replace(/[.:]$/, "")}: ${parts[1]}` : parts[0]).replace(/[.!?]+$/, "");
  if (/^undo\b/i.test(t) || /^take (?:that|it) back\b/i.test(t)) return { op: "undo" };
  let m = /^(?:redraw|draw|make|turn|show)\s+(?:this|that|it|the \w+)?\s*(?:as|into|in)?\s*(?:an?\s+)?(diagram|map|flow ?chart|mind ?map)\b/i.exec(t);
  if (m) return { op: "redraw", style: /diagram|flow/i.test(m[1]) ? "diagram" : "map" };
  if ((m = /^(?:rename|call)\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(t)) || (m = /^call\s+(.+?)\s+["“](.+)["”]$/i.exec(t))) return { op: "rename", what: m[1], to: m[2].replace(/^["“]|["”]$/g, "") };
  if ((m = /^(?:remove|delete|drop|take (?:off|out)|get rid of)\s+(.+)$/i.exec(t))) return { op: "remove", what: m[1] };
  if ((m = /^add\s+(?:(?:an?|another|one more)\s+)?(?:(step|box|part|idea|decision|person|goal|problem|document|screen|service)\b)?\s*(?:called|named|for|that says|saying)?[:,]?\s*(.+)$/i.exec(t))) {
    const kind = m[1]?.toLowerCase();
    let what = m[2].trim();
    let where: "before" | "after" | "under" | undefined;
    let near: string | undefined;
    const at = /^(.+?)\s+(before|after|under|below|beneath)\s+(.+)$/i.exec(what);
    if (at) ((what = at[1]), (where = /before/i.test(at[2]) ? "before" : /after/i.test(at[2]) ? "after" : "under"), (near = at[3]));
    what = what.replace(/^["“]|["”]$/g, "").trim();
    if (!what) return null;
    return { op: "add", what, ...(kind && !["box", "part", "idea"].includes(kind) ? { kind } : {}), ...(where ? { where } : {}), ...(near ? { near } : {}) };
  }
  return null;
}

// ---- when it stops ----------------------------------------------------------------------------

/** The sketch has stopped: every subject drawn as a diagram is saved as a draft spec on a to-do (the
 *  first subject's on the to-do the session was started for, if it was). Returns the row as kept. */
export function saveSketchSpecs(db: DB, b: BrainstormRow, caught: BrainCaught[]): BrainstormRow {
  const sk = sketchOf(b);
  let changed = false;
  sk.subjects.forEach((s, i) => {
    if (s.style !== "diagram" || !s.diagram) return;
    const id = saveSpecOf(db, b, { prompt: s.title, diagram: s.diagram, taskId: s.taskId ?? null, context: i === 0 ? b.context : [] }, caught);
    if (!id || id === s.taskId) return;
    s.taskId = id;
    if (i === 0) db.setBrainstormTask(b.id, id);
    changed = true;
  });
  if (changed) db.saveBrainstormSketch(b.id, sk);
  return db.getBrainstorm(b.id) ?? b;
}
