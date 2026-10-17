// The middle board: one card for the thread of discussion the group is on. Built from the
// talk itself, not from the live notes' topics, which split and fold back from run to run.
//
// Every BOARD_EVERY_MS while people talk, the board model gets the card on screen, the earlier
// threads and the last few minutes of transcript, and returns the card brought up to date, plus a
// proposed next thread when the talk has clearly moved on. The title is set once (it may be
// sharpened one time while the thread is young). A move shows only after it holds for two answers
// in a row, so a tangent never moves it. Every DRIFT_EVERY runs a second check reads only the
// title and the latest talk, without the summary, so a slow drift into a new question still moves
// it. When the host focuses another agenda item, the next answer starts a thread there at once.
import { z } from "zod";
import type { Board, BoardCard, BoardThread, Item, Segment } from "../shared/protocol.ts";

export const BOARD_EVERY_MS = 30_000;
/** How much recent talk the card model reads. */
const WINDOW_MS = 4 * 60_000;
/** How much recent talk the drift check reads. */
const DRIFT_WINDOW_MS = 3 * 60_000;
/** Runs between drift checks on one thread. */
const DRIFT_EVERY = 4;
/** A move shows after this many answers in a row. */
const CONFIRM = 2;
/** A title may be sharpened once while the thread is younger than this. */
const RETITLE_MS = 3 * 60_000;
/** New talk a run needs, once there is a card. */
const MIN_NEW_LINES = 2;
/** A thread's stretch on the chapter bar breaks after a pause this long. */
const SPAN_GAP_MS = 3 * 60_000;

const Detail = z.object({
  kind: z.enum(["position", "decided", "todo", "open", "ref"]),
  who: z.string().nullable().describe("First name for a position or a to-do's owner; null otherwise"),
  text: z.string(),
});
const Card = z.object({ summary: z.string(), now: z.string(), details: z.array(Detail) });
export const BoardAnswerSchema = z.object({
  current: Card.describe("The thread on screen, brought up to date"),
  retitle: z.string().nullable().describe("Only while the thread on screen is under 3 minutes old and its title doesn't name the problem being worked out: a better title. Otherwise null"),
  shift: z
    .object({
      kind: z.enum(["new", "return"]),
      returnTo: z.string().nullable().describe("For return: the id of the earlier thread"),
      title: z.string(),
      card: Card,
    })
    .nullable()
    .describe("Only when the newest talk has clearly moved off the thread on screen"),
});
export type BoardAnswer = z.infer<typeof BoardAnswerSchema>;
export const BoardDriftSchema = z.object({
  verdict: z.enum(["same", "moved"]),
  title: z.string().nullable().describe("For moved: the thread the talk is on now, at most 8 words"),
});
export type BoardDrift = z.infer<typeof BoardDriftSchema>;

export const BOARD_SYSTEM = `You keep the middle screen of a live team meeting. It shows ONE card: the thread of discussion the group is on.

A thread is ONE question or problem the group is working through, named the way a person would name it afterwards: "First-join audio bug", "Should participants edit to-dos?", "Should we merge Connect and Stand?". Never a container like "Testing the app" or "Product feedback": in a meeting that reviews a product, each bug, feature, or design question is its own thread. A long debate about one decision that moves through sub-questions is still one thread: follow the sub-questions in the summary and the "now" line.

Typical threads last 2 to 15 minutes; a big debate can last much longer.

Each time you get: the people in the meeting, the thread on screen (title, summary, details), earlier threads, and the last few minutes of transcript with the lines since your last look marked NEW. Transcription is rough: guess through misheard words, and match misheard names to the people in the meeting.

Return:
- current: the on-screen thread brought up to date.
  - summary: one paragraph, 2-4 sentences, at most 70 words, present tense: what is being worked out, the main views by first name, and where it stands. Keep the previous wording where it is still right; change only what the new talk changes. Don't narrate ("they discuss"); say the substance. The summary is about this thread only: if you would need to write "now they..." about a different problem, that is a shift, not a summary edit.
  - now: at most 14 words, the point being made in the NEW lines, starting with the first name of who is making it ("Andy: building ingestion in Stand means merging in practice"). If the NEW lines are off this thread, say what they are about anyway.
  - details: at most 6, the most useful first: position (who + their view, one per person), decided, todo (who = owner), open (an unanswered question), ref (a name, link, number or thing mentioned that people may want to look up). Keep earlier details unless the talk replaced them.
- retitle: usually null. While the thread on screen is under 3 minutes old, if its title names the first remark rather than the problem being worked out, give a better title once.
- shift: null while the NEW lines still belong to the thread on screen. Ask: would the title on screen still be the right name for what the NEW lines are about? A tangent of a line or two, a joke, or the next sub-question of the same debate keeps the thread. A different problem, bug, feature, or decision is a new thread, even when it is about the same product (a bug report, then a question about how notes should look, are two threads). A mic check or small talk at the start is not a thread: move off it as soon as real work starts. Then give kind "new" with a short title (at most 8 words, the question or problem being worked out in plain words, not the first remark) and its own card from the lines that belong to it, or kind "return" with returnTo when talk went back to an earlier thread. When a move is already pending, say it again if it still holds, with the same title.`;

export const DRIFT_SYSTEM = `You check one thing about a live meeting screen. Its title names the thread of discussion the group is on. Read the last few minutes of transcript and answer: would a person who just walked in, reading only this talk, still name it with this title?
- same: yes, or the talk is a sub-question of the same debate, or a short tangent.
- moved: the talk has turned to a different question or problem (it may have drifted there gradually). Give the title it is on now: at most 8 words, the question or problem being worked out.
Transcription is rough: guess through misheard words and names.`;

/** What the board needs from the model; null when there's no model to ask. */
export interface BoardModel {
  boardCard(context: string, talk: string): Promise<BoardAnswer | null>;
  boardDrift(context: string, talk: string): Promise<BoardDrift | null>;
}

interface Pending {
  kind: "new" | "return";
  returnTo: string | null;
  title: string;
  card: BoardCard;
  count: number;
  /** The first line it covers. */
  since: number;
}

/** A time into the meeting, for the model: 4:05. */
const at = (ms: number, start: number) => {
  const s = Math.max(0, Math.floor((ms - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const cardText = (c: BoardCard) =>
  `Summary: ${c.summary}\nNow: ${c.now}\nDetails:\n${c.details.map((d) => `- ${d.kind}${d.who ? ` (${d.who})` : ""}: ${d.text}`).join("\n") || "(none)"}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Keeps one meeting's board. Not thread-safe: the room runs one pass at a time. */
export class BoardKeeper {
  private threads: BoardThread[] = [];
  private current: BoardThread | null = null;
  private pending: Pending | null = null;
  private switchedAt: number | null = null;
  private retitled = new Set<string>();
  private sinceDrift = 0;
  /** The latest line the model has read. */
  private lastLook = 0;
  /** The host focused this item since the last run: start a thread there without waiting. */
  private forcedItem: { itemId: string | null; at: number } | null = null;
  busy = false;

  constructor(
    private model: BoardModel,
    private readonly meetingStartedAt: number,
    saved?: Board | null,
  ) {
    if (saved) {
      this.threads = saved.threads;
      this.current = saved.threads.find((t) => t.id === saved.currentId) ?? null;
      this.switchedAt = saved.switchedAt;
      this.lastLook = Math.max(0, ...saved.threads.flatMap((t) => t.spans.map((s) => s[1])));
    }
  }

  board(): Board {
    return { threads: this.threads, currentId: this.current?.id ?? null, switchedAt: this.switchedAt, busy: this.busy };
  }

  /** The host moved the meeting to another agenda item. */
  focused(itemId: string | null, now: number) {
    if (this.current?.itemId === itemId) return void (this.forcedItem = null);
    this.forcedItem = { itemId, at: now };
    this.pending = null;
  }

  /** The host moved to another agenda item and the board has no thread there yet. */
  get waitingOnItem(): boolean {
    return !!this.forcedItem;
  }

  /** Whether there's enough new talk for a run. */
  due(segments: Segment[]): boolean {
    const fresh = segments.filter((s) => s.ts > this.lastLook).length;
    return fresh >= (this.current && !this.forcedItem ? MIN_NEW_LINES : 1);
  }

  /** One pass over the talk up to `now`. Returns whether the board changed. */
  async run(segments: Segment[], items: Item[], people: string[], focusItemId: string | null, now: number): Promise<boolean> {
    const talk = segments.filter((s) => s.ts <= now).sort((a, b) => a.ts - b.ts);
    const fresh = talk.filter((s) => s.ts > this.lastLook);
    if (!fresh.length) return false;
    const lastLook = this.lastLook;
    const forced = this.forcedItem && this.forcedItem.at <= now ? this.forcedItem : null;
    const onOtherItem = !!forced && this.current?.itemId !== forced.itemId;
    // The drift check, on a thread that has been up a while, when no move is waiting.
    let drifted: string | null = null;
    if (this.current && !this.pending && !onOtherItem && ++this.sinceDrift >= DRIFT_EVERY) {
      this.sinceDrift = 0;
      const recent = talk.filter((s) => s.ts > now - DRIFT_WINDOW_MS);
      const d = await this.model.boardDrift(`People: ${people.join(", ")}`, `Title on screen: "${this.current.title}"\n\nTranscript, last 3 minutes:\n${this.lines(recent, null)}`);
      if (d?.verdict === "moved" && d.title?.trim()) drifted = d.title.trim();
    }
    const itemTitle = (id: string | null) => (id ? (items.find((i) => i.id === id)?.title ?? "an agenda item") : "none (general talk)");
    const context = [
      `People: ${people.join(", ")}`,
      `Earlier threads:\n${this.threads.filter((t) => t !== this.current).map((t) => `- ${t.id} "${t.title}": ${t.card.summary}`).join("\n") || "(none)"}`,
    ].join("\n\n");
    const recent = talk.filter((s) => s.ts > now - WINDOW_MS);
    const live = [
      `Agenda item in focus: ${itemTitle(focusItemId)}`,
      this.current && !onOtherItem
        ? `Thread on screen: "${this.current.title}" (since ${at(this.current.spans[0]?.[0] ?? now, this.meetingStartedAt)}, now ${at(now, this.meetingStartedAt)})\n${cardText(this.current.card)}`
        : "Thread on screen: none yet. If the talk has a subject, return it as shift kind new.",
      onOtherItem ? `The host just moved the meeting to the agenda item "${itemTitle(forced!.itemId)}". Start its thread from the talk since then (shift kind new, or return to an earlier thread on that item).` : "",
      this.pending ? `Pending move (${this.pending.kind}): "${this.pending.title}"` : "",
      drifted ? `A check of the last 3 minutes says the talk has moved off the title on screen, to: "${drifted}". Unless that is plainly wrong, return shift kind new (or return, if it is an earlier thread).` : "",
      `Transcript, last ${WINDOW_MS / 60_000} minutes (meeting time):\n${this.lines(onOtherItem ? recent.filter((s) => s.ts >= forced!.at) : recent, lastLook)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const a = await this.model.boardCard(context, live);
    this.lastLook = fresh.at(-1)!.ts;
    if (!a) return false;
    const latest = fresh.at(-1)!.ts;
    if (this.current && !onOtherItem) {
      this.current.card = tidy(a.current);
      const age = now - (this.current.spans[0]?.[0] ?? now);
      if (a.retitle?.trim() && !a.shift && age < RETITLE_MS && !this.retitled.has(this.current.id)) {
        this.current.title = clip(a.retitle.trim(), 80);
        this.retitled.add(this.current.id);
      }
    }
    if (!a.shift) {
      this.pending = null;
      // After an agenda move with no thread there yet, the card waits for one.
      if (this.current && !onOtherItem) this.extend(this.current, latest);
      return true;
    }
    const s = a.shift;
    const same = this.pending && this.pending.kind === s.kind && (s.kind === "new" || this.pending.returnTo === s.returnTo);
    this.pending = same
      ? { ...this.pending!, card: tidy(s.card), count: this.pending!.count + 1 }
      : { kind: s.kind, returnTo: s.returnTo, title: clip(s.title.trim(), 80), card: tidy(s.card), count: 1, since: fresh[0].ts };
    // Nothing on screen yet, or the agenda moved: no waiting. Otherwise the move has to hold.
    if (this.current && !onOtherItem && this.pending.count < CONFIRM) {
      this.extend(this.current, latest);
      return true;
    }
    const back = this.pending.kind === "return" ? this.threads.find((t) => t.id === this.pending!.returnTo && t !== this.current) : undefined;
    const from = onOtherItem ? Math.max(forced!.at, this.pending.since) : this.pending.since;
    if (back) {
      back.card = this.pending.card;
      back.spans.push([from, latest]);
      this.current = back;
    } else {
      const t: BoardThread = { id: `t${this.threads.length + 1}`, title: this.pending.title, itemId: onOtherItem ? forced!.itemId : focusItemId, card: this.pending.card, spans: [[from, latest]] };
      this.threads.push(t);
      this.current = t;
    }
    this.switchedAt = now;
    this.pending = null;
    this.sinceDrift = 0;
    this.forcedItem = null;
    return true;
  }

  private extend(t: BoardThread, ts: number) {
    const last = t.spans.at(-1);
    if (last && ts - last[1] <= SPAN_GAP_MS) last[1] = Math.max(last[1], ts);
    else t.spans.push([ts, ts]);
  }

  private lines(segments: Segment[], newAfter: number | null) {
    return segments
      .map((s) => `${newAfter !== null && s.ts > newAfter ? "NEW " : ""}[${at(s.ts, this.meetingStartedAt)}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
      .join("\n");
  }
}

/** Keeps what the model wrote to the sizes the card has room for. */
function tidy(c: BoardCard): BoardCard {
  return {
    summary: clip(c.summary.trim(), 600),
    now: clip(c.now.trim(), 160),
    details: c.details.slice(0, 6).map((d) => ({ kind: d.kind, who: d.who?.trim() || null, text: clip(d.text.trim(), 200) })),
  };
}
