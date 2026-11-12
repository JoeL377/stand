// Chat in a space: talk in writing between meetings. Every message comes in through accept(),
// from Stand's own chat now and from an outside source later. A channel's talk is kept as sessions
// (meetings rows of kind "chat"), so what reads a meeting's segments reads a session's messages.
import type { Channel, ChatEvent, ChatMessage, ChatSession } from "../shared/chat.ts";
import type { DB } from "./db.ts";

/** A session closes once its channel has been quiet this long. The next message starts a new one. */
export const CHAT_QUIET_MS = 60 * 60_000;
/** A session that stays busy closes at this many messages, or this long after it started. */
export const CHAT_MAX_MESSAGES = 200;
export const CHAT_MAX_AGE_MS = 12 * 3600_000;
export const CHAT_TEXT_MAX = 4000;
/** How often sessions gone quiet are looked for. */
const SWEEP_MS = 60_000;

/** Someone with a Stand account, or someone an outside source names. */
export type Author = { userId: string } | { externalId: string; name: string };
/** A message by its id, or by the key it was sent with. */
type MessageRef = { id: string } | { externalId: string };
export type IntakeEvent =
  | { type: "message"; externalId?: string; author: Author; text: string; ts: number; replyTo?: string }
  | ({ type: "edit"; by: Author; text: string; ts: number } & MessageRef)
  | ({ type: "delete"; by: Author; ts: number } & MessageRef);

export interface Accepted {
  /** Messages saved, and edits and deletes made. */
  accepted: number;
  /** Messages the channel already had under the same key. */
  duplicates: number;
  /** Each message saved, changed or already there, as it is now, in the order of the events. */
  messages: ChatMessage[];
}

const cleanText = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, CHAT_TEXT_MAX) : "");

export class Chat {
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly quietMs: number;

  constructor(
    private readonly db: DB,
    /** Told after each change is saved. */
    private readonly onEvent: (roomId: string, e: ChatEvent) => void = () => {},
    /** quietMs: the quiet that closes a session, when it isn't the hour (a run that proves the close). */
    opts: { quietMs?: number } = {},
  ) {
    this.quietMs = opts.quietMs ?? CHAT_QUIET_MS;
  }

  /** Sessions the last run left open close if they went quiet meanwhile, and from now on as they do. */
  start() {
    this.sweep();
    this.sweeper ??= setInterval(() => this.sweep(), Math.min(SWEEP_MS, this.quietMs));
    this.sweeper.unref();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Takes messages, edits and deletes into a channel, in order. A message sent again with the same
   *  key is saved once. An event that changes nothing (no text, someone else's message) is left out. */
  accept(channelId: string, events: IntakeEvent[]): Accepted {
    const roomId = this.db.getChannel(channelId)?.roomId;
    if (!roomId) throw new Error(`No chat channel ${channelId}`);
    const out: Accepted = { accepted: 0, duplicates: 0, messages: [] };
    for (const e of events) {
      const tell: ChatEvent[] = [];
      const took = this.db.tx(() => this.take(this.db.getChannel(channelId)!, e, tell));
      if (took) {
        if (took.duplicate) out.duplicates++;
        else out.accepted++;
        out.messages.push(took.message);
      }
      this.tell(roomId, tell);
    }
    return out;
  }

  /** Closes the sessions that are due. Returns how many. */
  sweep(now = Date.now()): number {
    let closed = 0;
    for (const s of this.db.openChatSessions()) {
      if (!this.due(s, now)) continue;
      const tell: ChatEvent[] = [];
      this.db.tx(() => this.close(s, tell));
      this.tell(s.roomId, tell);
      closed++;
    }
    return closed;
  }

  private take(channel: Channel, e: IntakeEvent, tell: ChatEvent[]): { message: ChatMessage; duplicate?: boolean } | null {
    if (e.type === "message") {
      const text = cleanText(e.text);
      if (!text) return null;
      const again = e.externalId ? this.db.chatMessageByKey(channel.id, e.externalId) : null;
      if (again) return { message: again, duplicate: true };
      const author = this.speaker(channel, e.author);
      const ts = Number.isFinite(e.ts) ? e.ts : Date.now();
      const session = this.sessionFor(channel, ts, tell);
      const seg = this.db.addSegment({ meetingId: session.id, itemId: null, speakerId: author.id, speakerName: author.name, kind: "chat", text, ts });
      const message = this.db.addChatMessage({
        segmentId: seg.id,
        sessionId: session.id,
        channelId: channel.id,
        externalId: e.externalId ?? null,
        replyTo: e.replyTo && this.db.chatMessage(e.replyTo)?.channelId === channel.id ? e.replyTo : null,
        ts,
      });
      tell.push({ type: "message", message });
      if (session.messages + 1 >= CHAT_MAX_MESSAGES) this.close(session, tell);
      return { message };
    }
    const was = "id" in e ? this.db.chatMessage(e.id) : this.db.chatMessageByKey(channel.id, e.externalId);
    // Only whoever wrote a message changes it, and a deleted one stays deleted.
    if (!was || was.channelId !== channel.id || was.deletedAt !== null || was.authorId !== this.speaker(channel, e.by).id) return null;
    const text = e.type === "edit" ? cleanText(e.text) : "";
    if (e.type === "edit" && (!text || text === was.text)) return null;
    const message = e.type === "edit" ? this.db.editChatMessage(was.id, text, e.ts) : this.db.deleteChatMessage(was.id, e.ts);
    if (!message) return null;
    tell.push({ type: "message", message });
    return { message };
  }

  /** The session a message at this time goes to: the channel's open one, or a new one when there is none or it is due to close. */
  private sessionFor(channel: Channel, ts: number, tell: ChatEvent[]): ChatSession {
    const open = channel.openSessionId ? this.db.chatSession(channel.openSessionId) : null;
    if (open && !this.due(open, ts)) return open;
    if (open) this.close(open, tell);
    const s = this.db.startChatSession(channel, ts);
    tell.push({ type: "session", channelId: channel.id, sessionId: s.id, open: true });
    return s;
  }

  private due(s: ChatSession, now: number) {
    return now - s.endedAt >= this.quietMs || now - s.startedAt >= CHAT_MAX_AGE_MS || s.messages >= CHAT_MAX_MESSAGES;
  }

  private close(s: ChatSession, tell: ChatEvent[]) {
    this.db.closeChatSession(s.channelId);
    tell.push({ type: "session", channelId: s.channelId, sessionId: s.id, open: false });
  }

  /** Who a message is by, as a segment names its speaker. Someone from an outside source gets an id
   *  under that source, which no Stand account has. */
  private speaker(channel: Channel, a: Author): { id: string; name: string } {
    if ("userId" in a) {
      const name = this.db.userName(a.userId);
      if (name === null) throw new Error(`No user ${a.userId}`);
      return { id: a.userId, name };
    }
    return { id: `${channel.source}:${a.externalId}`, name: a.name.trim() || "Someone" };
  }

  /** A listener that fails must not fail what was saved: the sender would send it again. */
  private tell(roomId: string, events: ChatEvent[]) {
    for (const e of events) {
      try {
        this.onEvent(roomId, e);
      } catch (err) {
        console.error(`[chat] ${roomId}: ${(err as Error).message}`);
      }
    }
  }
}
