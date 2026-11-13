// Chat capture: what people write in a space's chat becomes to-dos, open questions, decisions and
// topics, the way a meeting's talk does. A session of chat is a meetings row (chat.ts), so a run
// here is a meeting's notes run over it: the same model call, the same merge, the same rows. While
// people write, a run reads the session after each pause; as the session closes, one more reads it
// whole on the tidy model, which gives each line the message it came from and the session a summary.
import type { ChatCaught, ChatEvent, ChatMessage } from "../shared/chat.ts";
import type { Note } from "../shared/protocol.ts";
import { isClosed, stateOf } from "../shared/tasks.ts";
import type { DB } from "./db.ts";
import type { DraftDiscussion } from "./db/rows.ts";
import type { Agent } from "./llm.ts";
import { capturedFor, mergeNotes } from "./notesMerge.ts";
import { PassRunner } from "./passRunner.ts";
import { keepLeftOut } from "./room.ts";
import { metered } from "./usage.ts";

/** How long a channel is quiet before what was written is read, and the longest it waits while
 *  people keep writing. Longer than a meeting's: nobody is watching a board. */
export const CAPTURE_QUIET_MS = 60_000;
export const CAPTURE_MAX_WAIT_MS = 5 * 60_000;
/** Fewer new words than this wait for more, or for the session to close. */
export const CAPTURE_MIN_WORDS = 6;
/** Runs a channel gets in a day while people write. The run as a session closes is on top. */
export const CAPTURE_DAILY_MAX = 200;
/** A session whose runs fail this many times in a row is given up on. */
export const CAPTURE_FAILURES = 5;
/** After a restart, a session that closed longer ago than this is left as it is. */
export const CAPTURE_STALE_MS = 2 * 3600_000;

export interface CaptureOptions {
  quietMs?: number;
  maxWaitMs?: number;
  minWords?: number;
  dailyMax?: number;
}

// Written from the first real chat (Nov 11): "We need a todo to pin colors, assign that to Huy" came
// out as an open question, because the notes rules want a suggestion accepted and in chat often nobody answers.
const CHAT_GUIDE = `This talk is a written chat between meetings, not a call. The lines are typed messages and can be hours apart, and often one person writes and nobody answers.

In this chat, when someone asks for a to-do, says that something needs doing, or says they will do something, write it as an action item even if nobody answered. Its owner is the person they name; else the writer, when they took it on themselves; else null. Do not turn such a line into an open question. An open question is something a person asked that nobody answered.

A decision still needs a settled choice: one person's proposal that nobody answered is not a decision. A greeting, a joke, a reaction, thanks, or a line that only tries the chat out is nothing to note. Text pasted in from elsewhere (instructions, a log, a list of steps) is context: note nothing from it unless someone in the chat takes it up.`;

const KEPT = new Set<Note["kind"]>(["action", "question", "decision"]);
const wordsIn = (texts: string[]) => texts.join(" ").split(/\s+/).filter(Boolean).length;

interface ChannelState {
  runner: PassRunner;
  /** When the first message not yet read came. */
  since: number | null;
  /** The newest message of the open session at the last pass, read or not. */
  seen: number;
  /** A message capture had read was changed: the next run doesn't wait for more words. */
  changed: boolean;
  failed: boolean;
  failures: { sessionId: string; n: number } | null;
}

/** What Stand made of one session, as the thread shows it. Null when it made nothing of it. */
export function caughtIn(db: DB, sessionId: string): ChatCaught | null {
  const lines = db.meetingNotes(sessionId).filter((n) => KEPT.has(n.kind));
  const topics = db.meetingDiscussions(sessionId);
  const summary = db.getMeeting(sessionId)?.summary ?? null;
  if (!lines.length && !topics.length && !summary) return null;
  return {
    sessionId,
    summary,
    topics: topics.map((d) => ({ id: d.id, topic: d.topic, outcome: d.outcome })),
    lines: lines.map((n) => ({
      id: n.id,
      kind: n.kind as "action" | "question" | "decision",
      text: n.text,
      owner: n.owner,
      closed: n.kind !== "decision" && isClosed(stateOf(n)),
      messageId: n.quote?.segmentId ?? null,
      ts: n.ts,
    })),
  };
}

export class ChatCapture {
  private readonly channels = new Map<string, ChannelState>();
  private readonly runs = new Map<string, { day: string; n: number }>();
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly minWords: number;
  private readonly dailyMax: number;
  private stopped = false;

  constructor(
    private readonly db: DB,
    private readonly agent: Agent,
    /** Told after a run saved what it caught. */
    private readonly tell: (roomId: string, e: ChatEvent) => void = () => {},
    opts: CaptureOptions = {},
  ) {
    this.quietMs = opts.quietMs ?? CAPTURE_QUIET_MS;
    this.maxWaitMs = opts.maxWaitMs ?? CAPTURE_MAX_WAIT_MS;
    this.minWords = opts.minWords ?? CAPTURE_MIN_WORDS;
    this.dailyMax = opts.dailyMax ?? CAPTURE_DAILY_MAX;
  }

  /** After a restart: what is going on, or ended a short while ago, is read. Older talk is left as it is,
   *  so turning capture on never reads a channel's whole history. */
  start(now = Date.now()) {
    for (const id of this.db.uncapturedChannels()) {
      for (let next = this.db.uncapturedSession(id); next; next = this.db.uncapturedSession(id)) {
        if (this.isOpen(id, next.session.id) || now - next.session.endedAt < CAPTURE_STALE_MS) break;
        this.db.setCapturedUpTo(id, next.newest);
      }
      const next = this.db.uncapturedSession(id);
      if (!next) continue;
      if (this.isOpen(id, next.session.id)) this.wait(id);
      else this.state(id).runner.schedule(0);
    }
  }

  stop() {
    this.stopped = true;
    for (const st of this.channels.values()) st.runner.stop();
  }

  /** What the chat tells its listener (chat.ts): a message sent, changed or deleted, a session opened or closed. */
  heard(e: ChatEvent) {
    if (this.stopped || e.type === "notes" || e.type === "read" || e.type === "typing") return;
    if (e.type === "session") {
      // Closed: it is read once more, now.
      if (!e.open) this.state(e.channelId).runner.schedule(0);
      return;
    }
    const m = e.message;
    if (m.deletedAt !== null) this.db.dropQuotesOf(m.id);
    if (m.editedAt !== null || m.deletedAt !== null) {
      // A closed session stays as it was read.
      if (!this.isOpen(m.channelId, m.sessionId)) return;
      this.db.rewindCapture(m.channelId, m.seq);
      this.state(m.channelId).changed = true;
    }
    this.wait(m.channelId);
  }

  /** A pass over a channel now, or the one already going. */
  run(channelId: string): Promise<void> {
    return this.state(channelId).runner.run();
  }

  /** Resolves once no pass is running. */
  async idle(): Promise<void> {
    await Promise.all([...this.channels.values()].map((st) => st.runner.idle()));
  }

  private isOpen(channelId: string, sessionId: string) {
    return this.db.getChannel(channelId)?.openSessionId === sessionId;
  }

  private state(channelId: string): ChannelState {
    let st = this.channels.get(channelId);
    if (!st) {
      st = {
        runner: new PassRunner(() => this.pass(channelId), { label: "chat", about: () => `capture in ${channelId}`, background: true, settled: () => this.settled(channelId) }),
        since: null,
        seen: 0,
        changed: false,
        failed: false,
        failures: null,
      };
      this.channels.set(channelId, st);
    }
    return st;
  }

  /** The next run once the channel goes quiet, and no later than the longest wait after the first unread message. */
  private wait(channelId: string) {
    const st = this.state(channelId);
    const now = Date.now();
    st.since ??= now;
    st.runner.schedule(Math.max(0, Math.min(this.quietMs, st.since + this.maxWaitMs - now)));
  }

  /** After a pass: a closed session still unread goes next, and so does talk that came meanwhile. */
  private settled(channelId: string) {
    if (this.stopped) return;
    const st = this.state(channelId);
    const next = this.db.uncapturedSession(channelId);
    if (!next) return;
    if (!this.isOpen(channelId, next.session.id)) st.runner.schedule(0);
    else if (st.failed || next.newest > st.seen) this.wait(channelId);
  }

  private allowed(channelId: string): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.runs.get(channelId);
    if (!r || r.day !== day) {
      this.runs.set(channelId, { day, n: 1 });
      return true;
    }
    return ++r.n <= this.dailyMax;
  }

  /** One pass: the oldest session of the channel with something unread. Open, it is read as it stands;
   *  closed, it is read whole for the last time. */
  private async pass(channelId: string) {
    const st = this.state(channelId);
    st.since = null;
    st.failed = false;
    const channel = this.db.getChannel(channelId);
    const next = channel && this.db.uncapturedSession(channelId);
    if (!channel || !next) return;
    const { session, newest } = next;
    const open = channel.openSessionId === session.id;
    const upTo = this.db.capturedUpTo(channelId);
    const messages = this.db.sessionMessages(session.id).filter((m) => m.deletedAt === null && m.text.trim());
    if (open) {
      st.seen = newest;
      const changed = st.changed;
      st.changed = false;
      if (!changed && wordsIn(messages.filter((m) => m.seq > upTo).map((m) => m.text)) < this.minWords) return;
      if (!this.allowed(channelId)) return;
    } else if (!messages.length || (wordsIn(messages.map((m) => m.text)) < this.minWords && !this.db.meetingNotes(session.id).length)) {
      // Next to nothing was written, and nothing came of it.
      this.db.setCapturedUpTo(channelId, newest);
      return;
    }
    try {
      await this.capture(channelId, session.id, messages, { open, upTo, newest });
      st.failures = null;
    } catch (err) {
      st.failed = true;
      const n = (st.failures?.sessionId === session.id ? st.failures.n : 0) + 1;
      st.failures = { sessionId: session.id, n };
      if (n >= CAPTURE_FAILURES) {
        // Not forever: what it caught so far stays, and the next message starts it again.
        st.failures = null;
        st.failed = false;
        if (this.db.capturedUpTo(channelId) < newest) this.db.setCapturedUpTo(channelId, newest);
        console.error(`[chat] gave up on ${session.id} after ${n} failed runs`);
      }
      throw err;
    }
  }

  /** A meeting's notes run (room.ts runNotes and saveNotes) over a session: no agenda item, and
   *  nothing settles or folds, since a session is short. */
  private async capture(channelId: string, sessionId: string, messages: ChatMessage[], at: { open: boolean; upTo: number; newest: number }) {
    const startedAt = Date.now();
    const tidy = !at.open;
    const shown = new Set(messages.map((m) => m.id));
    const segments = this.db.meetingSegments(sessionId).filter((s) => shown.has(s.id));
    const roomId = this.db.getChannel(channelId)!.roomId;
    const before = this.db.meetingDiscussions(sessionId);
    const keys = capturedFor(this.db.meetingNotes(sessionId));
    const lineOf = new Map(segments.map((s, i) => [s.id, i + 1]));
    const lastTopics = tidy ? [] : before.map((d) => ({ topic: d.topic, lines: d.segmentIds.flatMap((id) => lineOf.get(id) ?? []) }));
    const instructions = [this.db.getRoom(roomId)?.synthesisInstructions, CHAT_GUIDE].filter(Boolean).join("\n\n");
    const draft = await metered(this.agent, sessionId).notesFor(null, segments, this.db.channelTopics(channelId, sessionId), keys, { instructions }, { tidy, lastTopics });

    const fresh: DraftDiscussion[] = draft.discussions.map(({ segmentIndexes, picksUp: _none, ...d }) => ({ ...d, segmentIds: segmentIndexes.map((i) => segments[i].id) }));
    // The run as the session closes reads everything: a topic it leaves out whole, it meant to.
    const revived = keepLeftOut(before, fresh, segments, { revive: !tidy });
    const when = new Map(segments.map((s) => [s.id, s.ts]));
    const start = (d: DraftDiscussion) => Math.min(...d.segmentIds.map((id) => when.get(id) ?? Infinity));
    const order = [...fresh, ...revived].map((d, i) => ({ d, i, t: start(d) })).sort((a, b) => a.t - b.t || a.i - b.i);
    const notes = this.db.tx(() => {
      const discussions = this.db.replaceDiscussions(sessionId, null, order.map((o) => o.d));
      const idOf = new Map(order.map((o, j) => [o.i, discussions[j].id]));
      // Read again: a to-do may have been ticked, or a line removed, while the model wrote.
      const notes = this.db.syncNotes(
        sessionId,
        null,
        mergeNotes(
          draft.notes.map(({ discussion, ...n }) => ({ ...n, discussionId: discussion === null ? null : (idOf.get(discussion) ?? null) })),
          this.db.meetingNotes(sessionId),
          keys,
          this.db.dismissedNotes(sessionId, null),
          draft.answered,
        ),
      );
      // A message changed, or the session closed, while the model wrote: it is read again.
      if (this.db.capturedUpTo(channelId) === at.upTo && this.isOpen(channelId, sessionId) === at.open) this.db.setCapturedUpTo(channelId, at.newest);
      const summary = tidy ? notes.find((n) => n.kind === "summary")?.text.trim() : undefined;
      if (summary) this.db.setChatSummary(sessionId, summary);
      return notes;
    });
    console.log(
      `[chat] captured ${sessionId}: ${segments.length} messages, ${notes.filter((n) => KEPT.has(n.kind)).length} lines${tidy ? ", whole session" : ""} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    try {
      this.tell(roomId, { type: "notes", channelId, sessionId });
    } catch (err) {
      console.error(`[chat] ${roomId}: ${(err as Error).message}`);
    }
  }
}
