// The running list behind the board's Decided, To do and Open tabs: what the meeting has
// decided, who is doing what, and what is still open, kept up within seconds of being said.
//
// After each pause in the talk (LIST_DEBOUNCE_MS quiet, never more than LIST_MAX_WAIT_MS after
// the first line it hasn't read), the list model gets the list so far, with ids, and the last
// LIST_WINDOW_MS of talk with the lines it hasn't seen marked NEW, and returns only what those
// lines add, change or close. A line on the list is never rewritten wholesale, regrouped or
// dropped by a later run, so what people are reading stays where it is. The live notes still
// group the talk into topics for the chapter bar and the recap; the list is only for the screen.
// On the Oct 17 and Oct 22 replays it showed lines about 5 s after they were said (live notes:
// 21-77 s) and caught every core item (scripts/live-eval).
import { z } from "zod";
import type { ListNote, NoteKind, Segment } from "../shared/protocol.ts";
import { similar } from "./notesMerge.ts";

export const LIST_DEBOUNCE_MS = 3_000;
export const LIST_MAX_WAIT_MS = 8_000;
/** How much recent talk a run reads, besides every line it hasn't read yet. */
const LIST_WINDOW_MS = 2 * 60_000;
/** Most lines on a list; past this a run adds nothing more. */
const MAX_ITEMS = 300;

const Kind = z.enum(["todo", "decided", "open"]);
export const ListAnswerSchema = z.object({
  add: z
    .array(
      z.object({
        kind: Kind,
        who: z.string().nullable().describe("A to-do's owner (first name); null if nobody took it or not a to-do"),
        text: z.string().describe("At most 10 words, plain; a to-do starts with its verb"),
        line: z.number().int().describe("The NEW line it comes from"),
      }),
    )
    .describe("Only things the NEW lines add that the list doesn't already have"),
  change: z.array(z.object({ id: z.string(), text: z.string() })).describe("A line whose meaning the NEW talk changed (new owner, narrowed scope). Never to polish wording. Usually empty"),
  close: z
    .array(
      z.object({
        id: z.string(),
        how: z.enum(["answered", "done", "dropped", "wrong"]),
        decision: z.string().nullable().describe("For answered: what was decided, at most 10 words. Otherwise null"),
      }),
    )
    .describe("answered: an open question got settled. done or dropped: a to-do. wrong: you misheard it earlier. Usually empty"),
});
export type ListAnswer = z.infer<typeof ListAnswerSchema>;

export const LIST_SYSTEM = `You keep the running list on the middle screen of a live team meeting: to-dos (with owner), decisions, and open questions. Everyone glances at it while they talk. A line that shows up within seconds of being said is worth a lot; a wrong or repeated line costs more, because everyone reads it.

Each time you get the list so far (with ids, including lines closed earlier) and the last couple of minutes of transcript. Lines marked NEW are the ones you haven't seen yet. Return only what the NEW lines add or change; everything you don't name stays as it is. Most of the time the answer is empty: a busy meeting adds about one line every two or three minutes.

Add a line only when the NEW talk itself does one of these:
- todo: someone commits to doing something, or asks a named person to and they don't refuse ("I'll make the PR", "can you send me the link", "Joe, you take the redesign"). who = the owner's first name. Start with the verb. Not ideas, wishes or "we should think about".
- decided: the people talking settle something between them (one proposes, others agree, nobody objects; or "okay, let's do X"). Not one person's opinion, not a proposal still being argued, and not someone reading out or describing a document, spec or another agent's output: that is information, not a decision.
- open: a question about the work that the group explicitly raises as something to figure out and leaves unanswered. Not rhetorical questions, not small talk, not questions answered in the next lines.

Before adding, check the list: if a line there (open or closed) already says the same thing in other words, don't add it; at most use change on that line if the owner or scope changed. One line per thing.
When an open question gets answered, close it as answered with the decision in a few words; don't also add that decision. Never return commentary about the transcript as a line.
Transcription is rough: read through misheard words, and match misheard names to the people in the meeting.`;

/** What the list needs from the model; null when it couldn't answer. */
export interface ListModel {
  liveList(context: string, talk: string): Promise<ListAnswer | null>;
}

type Kind = z.infer<typeof Kind>;
const NOTE_KIND: Record<Kind, NoteKind> = { todo: "action", decided: "decision", open: "question" };

/** One line on the list, as kept and saved. */
export interface ListItem {
  id: string;
  kind: Kind;
  who: string | null;
  text: string;
  itemId: string | null;
  /** When the line it came from was said. */
  said: number;
  doneAt: number | null;
  doneBy: string | null;
  closed: { how: "answered" | "dropped" | "wrong"; at: number } | null;
  /** A decision that answered an open question: the question's id. */
  answers: string | null;
}

const at = (ms: number, start: number) => {
  const s = Math.max(0, Math.floor((ms - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Keeps one meeting's list. Not thread-safe: the room runs one pass at a time. */
export class ListKeeper {
  private items: ListItem[] = [];
  /** The latest line a run has read. */
  private lastLook = 0;
  private n = 0;

  constructor(
    private model: ListModel,
    private readonly meetingStartedAt: number,
    saved?: ListItem[] | null,
  ) {
    if (saved?.length) {
      this.items = saved;
      this.n = Math.max(0, ...saved.map((i) => Number(i.id.slice(3)) || 0));
      this.lastLook = Math.max(0, ...saved.map((i) => i.said));
    }
  }

  /** Whether any talk came in that no run has read. */
  due(segments: Segment[]): boolean {
    return segments.some((s) => s.ts > this.lastLook);
  }

  /** When the oldest line no run has read was said; null when there's none. */
  unreadSince(segments: Segment[]): number | null {
    return segments.find((s) => s.ts > this.lastLook)?.ts ?? null;
  }

  saved(): ListItem[] {
    return this.items;
  }

  /** The list as notes for the board. A line Stand misheard stays off it. */
  notes(meetingId: string): ListNote[] {
    return this.items
      .filter((i) => i.closed?.how !== "wrong")
      .map((i) => ({
        id: i.id,
        meetingId,
        itemId: i.itemId,
        kind: NOTE_KIND[i.kind],
        text: i.text,
        owner: i.who,
        ts: i.said,
        doneAt: i.doneAt,
        doneBy: i.doneBy,
        discussionId: null,
        closed: i.closed,
        answers: i.answers,
      }));
  }

  has(id: string): boolean {
    return this.items.some((i) => i.id === id);
  }

  get(id: string): ListItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Someone checked a to-do off, or back on. */
  setDone(id: string, by: string | null): ListItem | null {
    const it = this.items.find((i) => i.id === id && i.kind === "todo");
    if (!it) return null;
    it.doneAt = by ? (it.doneAt ?? Date.now()) : null;
    it.doneBy = by;
    return it;
  }

  /** The host took a line off: Stand got it wrong. Its words stay so a later run doesn't add it again. */
  remove(id: string): ListItem | null {
    const it = this.items.find((i) => i.id === id && !i.closed);
    if (!it) return null;
    it.closed = { how: "wrong", at: Date.now() };
    return it;
  }

  /** Undo for remove. */
  restore(id: string): ListItem | null {
    const it = this.items.find((i) => i.id === id && i.closed?.how === "wrong");
    if (!it) return null;
    it.closed = null;
    return it;
  }

  /** One pass over the talk up to `now`. `itemAt` is the agenda item in focus when a line was said.
   *  Returns whether the list changed. */
  async run(segments: Segment[], people: string[], itemAt: (ts: number) => string | null, now: number): Promise<boolean> {
    const talk = segments.filter((s) => s.ts <= now).sort((a, b) => a.ts - b.ts);
    const firstNew = talk.findIndex((s) => s.ts > this.lastLook);
    if (firstNew === -1) return false;
    const from = Math.min(firstNew, Math.max(0, talk.findIndex((s) => s.ts > now - LIST_WINDOW_MS)));
    const shown = talk.slice(from);
    const list =
      this.items.map((i) => `- [${i.id}] ${i.kind}${i.who ? ` (${i.who})` : ""}: ${i.text}${i.closed ? ` (closed: ${i.closed.how})` : i.doneAt ? " (closed: done)" : ""}`).join("\n") || "(empty)";
    const lines = shown
      .map((s, k) => `${from + k >= firstNew ? "NEW " : ""}[${k + 1}] [${at(s.ts, this.meetingStartedAt)}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
      .join("\n");
    const a = await this.model.liveList(`People: ${people.join(", ")}`, `Running list:\n${list}\n\nTranscript, meeting time (${at(now, this.meetingStartedAt)} now):\n${lines}`);
    this.lastLook = talk.at(-1)!.ts;
    if (!a) return false;
    let changed = false;
    const add = (kind: Kind, who: string | null, text: string, said: number, answers: string | null = null) => {
      const t = clip(text.trim(), 200);
      if (!t || this.items.length >= MAX_ITEMS || this.items.some((i) => i.id !== answers && similar(i.text, t))) return null;
      const it: ListItem = { id: `li_${++this.n}`, kind, who: who?.trim().split(/\s+/)[0] || null, text: t, itemId: itemAt(said), said, doneAt: null, doneBy: null, closed: null, answers };
      this.items.push(it);
      changed = true;
      return it;
    };
    const saidAt = (line: number) => shown[Math.min(shown.length, Math.max(firstNew - from + 1, line)) - 1].ts;
    for (const x of a.add) add(x.kind, x.kind === "todo" ? x.who : null, x.text, saidAt(x.line));
    for (const c of a.change) {
      const it = this.items.find((i) => i.id === c.id && !i.closed);
      const text = clip(c.text.trim(), 200);
      if (it && text && text !== it.text) (it.text = text), (changed = true);
    }
    for (const c of a.close) {
      const it = this.items.find((i) => i.id === c.id && !i.closed && !i.doneAt);
      if (!it) continue;
      if (c.how === "done") {
        if (it.kind !== "todo") continue;
        it.doneAt = now;
        it.doneBy = null;
      } else if (c.how === "answered") {
        if (it.kind !== "open") continue;
        it.closed = { how: "answered", at: now };
        if (c.decision?.trim()) add("decided", null, c.decision, shown.at(-1)!.ts, it.id);
      } else it.closed = { how: c.how, at: now };
      changed = true;
    }
    return changed;
  }
}
