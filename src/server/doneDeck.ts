// "Done since last time": what a space finished between its meetings, as pages the next meeting opens
// on. It's written ahead of time, not when the meeting starts: each time a task closes between meetings
// (a click, an agent's report, a merged PR) Claude rewrites the pages from every task closed since the
// last meeting, their work logs and screenshots, and the pages it wrote before, so they're there the
// moment anyone starts talking. Claude decides how to lay them out; the only rules are that nothing
// closed goes missing and nothing is made up. It never runs while a meeting is on: the pages people
// are turning stay put. The last meeting is the last one more than one person talked in.

import { createHash } from "node:crypto";
import type { DoneDeck, DoneSlide, ItemUpdate, Note, WorkShot } from "../shared/protocol.ts";
import { closedLabel, closedPr } from "../shared/tasks.ts";
import type { DB } from "./db.ts";
import type { Agent, DoneDeckDraft } from "./llm.ts";
import { prOf, shotUrl } from "./workLog.ts";

/** A burst of closes (an agent finishing three to-dos) makes one pass, this long after the last. */
export const DONE_DEBOUNCE_MS = 20_000;
/** Every so often, a look over every space, for closes nothing told us about. */
export const DONE_SWEEP_MS = 10 * 60_000;
const MAX_SLIDES = 8;
const MAX_POINTS = 7;
/** Points on the plain pages (no model). */
const PLAIN_PER_PAGE = 6;

type Closed = Note & { meetingStartedAt: number; itemTitle: string | null };

export interface DoneInput {
  space: { name: string; purpose: string };
  last: { id: string; startedAt: number; endedAt: number };
  closed: Closed[];
  /** Reports on the closed tasks, and on open ones that moved since (working, ready), oldest first. */
  updates: ItemUpdate[];
  shots: WorkShot[];
  /** Open tasks agents reported on since: keyed so a page can point at work in flight too. */
  moving: Note[];
  previous: DoneDeck | null;
}

const day = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Everything a pass reads, gathered from the database; null when there's no last meeting to count from. */
export function doneInput(db: DB, roomId: string): DoneInput | null {
  const room = db.getRoom(roomId);
  const last = db.lastRealMeeting(roomId);
  if (!room || !last) return null;
  const closed = db.closedTasksSince(roomId, last.endedAt);
  const since = db.roomUpdates(roomId, last.endedAt, 300);
  const closedIds = new Set(closed.map((n) => n.id));
  // Open tasks with a word from an agent since: in flight, or finished and waiting to ship.
  const movingIds = [...new Set(since.filter((u) => u.noteId && !closedIds.has(u.noteId)).map((u) => u.noteId!))];
  const moving = db.notesByIds(movingIds).filter((n) => !n.doneAt);
  const ids = [...closedIds, ...moving.map((n) => n.id)];
  const prev = db.getDoneDeck(roomId);
  return {
    space: room,
    last,
    closed,
    updates: db.notesUpdates(ids),
    shots: db.noteWorkShots(ids),
    moving,
    previous: prev && prev.since === last.endedAt ? prev : null,
  };
}

/** What a pass read, so it reruns only when something changed. */
export function doneBasis(input: DoneInput): string {
  return createHash("sha1")
    .update(
      [
        input.last.endedAt,
        ...input.closed.map((n) => `${n.id}:${n.state}:${n.closedBy}:${n.text}`),
        ...input.updates.map((u) => u.id),
        ...input.shots.map((s) => s.id),
      ].join("\n"),
    )
    .digest("hex");
}

/** Keys the pass uses for tasks (T1, O1) and screenshots (S1). */
function keyed(input: DoneInput) {
  const tasks = new Map<string, { note: Note; open: boolean }>();
  input.closed.forEach((n, i) => tasks.set(`T${i + 1}`, { note: n, open: false }));
  input.moving.forEach((n, i) => tasks.set(`O${i + 1}`, { note: n, open: true }));
  const shots = new Map<string, WorkShot>();
  input.shots.forEach((s, i) => shots.set(`S${i + 1}`, s));
  return { tasks, shots };
}

/** The pass's prompt: the closed tasks with what closed them and their logs, the open ones that moved, and the pages so far. */
export function donePrompt(input: DoneInput): string {
  const { tasks, shots } = keyed(input);
  const keyOfShot = new Map([...shots].map(([k, s]) => [s.id, k]));
  const log = (n: Note) =>
    input.updates
      .filter((u) => u.noteId === n.id)
      .slice(-6)
      .map((u) => {
        const pics = input.shots.filter((s) => s.updateId === u.id).map((s) => `${keyOfShot.get(s.id)}${s.caption ? ` "${clip(s.caption, 80)}"` : ""}`);
        return `    · ${day(u.ts)} ${u.client ? `${u.userName} via ${u.client}` : u.userName} (${u.status}): ${clip(u.text.replace(/\s+/g, " "), 500)}${
          u.links.length ? ` [${u.links.slice(0, 3).join(" ")}]` : ""
        }${pics.length ? ` screenshots: ${pics.join(", ")}` : ""}`;
      });
  const loose = (n: Note) => input.shots.filter((s) => s.noteId === n.id && !s.updateId).map((s) => keyOfShot.get(s.id)!);
  const rows = [...tasks].map(([key, { note: n, open }]) => {
    const head = open
      ? `- ${key} · still open · ${n.kind === "question" ? "question" : "to-do"}: ${n.text}`
      : `- ${key} · ${n.state === "dropped" ? `dropped${n.dropReason ? ` (${n.dropReason})` : ""}` : `done${n.closedBy ? ` (${closedLabel(n.closedBy) ?? n.closedBy})` : ""}`} ${
          n.doneAt ? day(n.doneAt) : ""
        } · ${n.kind === "question" ? "question" : "to-do"}: ${n.text}`;
    const extra = [
      n.owner ? `owner ${n.owner}` : "no owner",
      n.doneBy && !open ? `closed by ${n.doneBy}` : null,
      `from the ${day((n as Closed).meetingStartedAt ?? n.ts)} meeting`,
      (n as Closed).itemTitle ? `under "${(n as Closed).itemTitle}"` : null,
      loose(n).length ? `screenshots ${loose(n).join(", ")}` : null,
    ].filter(Boolean);
    return [head, `    ${extra.join(" · ")}`, ...log(n)].join("\n");
  });
  const prev = input.previous?.by === "claude" ? input.previous.slides : null;
  return `Space: ${input.space.name}${input.space.purpose ? `\nPurpose: ${clip(input.space.purpose, 500)}` : ""}
Last meeting: ${day(input.last.startedAt)}. Everything below happened since it ended.

Tasks closed since (T), and open tasks agents reported on since (O):
${rows.join("\n")}
${
  prev
    ? `
The pages you wrote before the latest of these closed (rework them as you see fit):
${JSON.stringify(prev.map((s) => ({ title: s.title, lead: s.lead, points: s.points.map((p) => p.text) })))}`
    : ""
}`;
}

export const DONE_SYSTEM = `You prepare the opening of a team's next meeting: a few pages, shown one at a time on everyone's screen, of what got done since the last meeting. Someone talks the team through them in a minute or two, then the meeting moves on to what's still open.

You have a free hand in how you shape it. Group by theme, by person, by what matters most, whatever makes the opening clearest for this team. Lead with what the team most needs to know: something they asked for that now works, a thing that unblocks someone, a direction that changed. One page is fine when there's little. Things that were dropped count as progress; say so plainly.

Rules:
- Account for every closed task (T keys), folded into a line with others if it's small. Open tasks (O keys) are optional: use them only for a page like "In flight" when it helps.
- Never invent anything. Every line must come from the tasks and their logs. Use the logs for what actually changed, in plain words people would say out loud, not the to-do's wording or code names.
- A title is a few words. A lead is one short sentence, or null. A line is under 14 words; name who did it in "who" (a first name, or null), and list the task keys it covers.
- At most ${MAX_SLIDES} pages and ${MAX_POINTS} lines a page.
- Put a screenshot (S key) on a page only when it shows what that page is about; null otherwise.`;

/** The pages as the pass wrote them, checked against what it was given: unknown keys go, and a closed task it left out
 *  lands on a last "Also closed" page, so nothing finished goes missing. */
export function slidesFrom(input: DoneInput, draft: DoneDeckDraft, baseUrl = ""): DoneSlide[] {
  const { tasks, shots } = keyed(input);
  const used = new Set<string>();
  const slides: DoneSlide[] = [];
  for (const s of draft.slides.slice(0, MAX_SLIDES)) {
    const points = s.points.slice(0, MAX_POINTS).flatMap((p) => {
      const keys = p.tasks.filter((k) => tasks.has(k));
      if (!p.text.trim()) return [];
      keys.forEach((k) => used.add(k));
      return [pointOf(input, keys.map((k) => tasks.get(k)!.note), p.text, p.who)];
    });
    if (!points.length) continue;
    const shot = s.shot ? shots.get(s.shot) : undefined;
    slides.push({
      title: clip(s.title.trim() || "Done", 60),
      lead: s.lead?.trim() ? clip(s.lead.trim(), 160) : null,
      points,
      shot: shot ? { url: shotUrl(shot, baseUrl), caption: shot.caption } : null,
    });
  }
  const left = [...tasks].filter(([k, t]) => !t.open && !used.has(k)).map(([, t]) => t.note);
  if (left.length) slides.push(...plainSlides(input, left, "Also closed"));
  return slides;
}

function pointOf(input: DoneInput, notes: Note[], text: string, who: string | null): DoneSlide["points"][number] {
  // A PR that closed one of its tasks, or one an agent reported it ready with.
  let pr: string | null = null;
  for (const n of notes) {
    pr ??= closedPr(n.closedBy);
    pr ??= input.updates.filter((u) => u.noteId === n.id).flatMap((u) => u.links).find((l) => prOf(l)) ?? null;
  }
  const owner = notes.find((n) => n.owner)?.owner ?? null;
  return {
    text: clip(text.trim(), 160),
    who: who?.trim() || owner,
    pr,
    dropped: notes.length > 0 && notes.every((n) => n.state === "dropped"),
  };
}

/** The tasks as they are, a few to a page: what shows without a model, and for anything the pass left out. */
export function plainSlides(input: DoneInput, notes: Note[], title = "Done"): DoneSlide[] {
  const out: DoneSlide[] = [];
  for (let i = 0; i < notes.length; i += PLAIN_PER_PAGE) {
    const page = notes.slice(i, i + PLAIN_PER_PAGE);
    out.push({
      title: notes.length > PLAIN_PER_PAGE ? `${title} (${i / PLAIN_PER_PAGE + 1})` : title,
      lead: null,
      points: page.map((n) => pointOf(input, [n], n.text, null)),
      shot: null,
    });
  }
  return out;
}

export class DoneDecks {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private agent: Agent,
    /** Whether the space has a meeting on now. */
    private inMeeting: (roomId: string) => boolean,
    /** Tells a meeting in the space the pages changed. */
    private changed: (roomId: string) => void,
  ) {}

  /** A task in the space closed (or reopened): rewrite the pages shortly. */
  schedule(roomId: string, delayMs = DONE_DEBOUNCE_MS) {
    clearTimeout(this.timers.get(roomId));
    this.timers.set(
      roomId,
      setTimeout(() => {
        this.timers.delete(roomId);
        this.run(roomId).catch((err) => console.error("[agent] done since last time failed:", err));
      }, delayMs),
    );
  }

  /** Every space with something closed lately, now and every so often: picks up what nothing told us about,
   *  and on the first start fills in the pages for closes from before this existed. */
  start() {
    const sweep = () => {
      for (const roomId of this.db.roomsWithClosesSince(Date.now() - 60 * 86_400_000)) this.schedule(roomId, 1000 + Math.random() * 5000);
    };
    sweep();
    this.sweeper = setInterval(sweep, DONE_SWEEP_MS);
    this.sweeper.unref?.();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  async run(roomId: string) {
    if (this.running.has(roomId) || this.inMeeting(roomId)) return;
    const input = doneInput(this.db, roomId);
    if (!input) return;
    const basis = doneBasis(input);
    const prev = this.db.getDoneDeck(roomId);
    if (prev?.basis === basis && prev.since === input.last.endedAt) return;
    const base: Omit<DoneDeck, "by" | "slides"> = {
      sinceMeetingId: input.last.id,
      sinceStartedAt: input.last.startedAt,
      since: input.last.endedAt,
      at: Date.now(),
      closed: input.closed.length,
      dropped: input.closed.filter((n) => n.state === "dropped").length,
    };
    if (!input.closed.length) {
      this.db.saveDoneDeck(roomId, { ...base, by: "plain", slides: [] }, basis);
      return this.changed(roomId);
    }
    this.running.add(roomId);
    try {
      const started = Date.now();
      const draft = await this.agent.doneDeck(donePrompt(input), DONE_SYSTEM).catch((err) => {
        console.error("[agent] done since last time: Claude failed, showing the tasks as they are:", err);
        return null;
      });
      // A meeting started while Claude was writing: keep the pages it opened on.
      if (this.inMeeting(roomId)) return;
      const slides = draft?.slides.length ? slidesFrom(input, draft) : [];
      const deck: DoneDeck = slides.length ? { ...base, by: "claude", slides } : { ...base, by: "plain", slides: plainSlides(input, input.closed) };
      this.db.saveDoneDeck(roomId, deck, basis);
      console.log(
        `[agent] done since ${day(input.last.startedAt)} in ${roomId}: ${input.closed.length} closed, ${deck.slides.length} pages (${deck.by}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      this.changed(roomId);
    } finally {
      this.running.delete(roomId);
    }
  }
}
