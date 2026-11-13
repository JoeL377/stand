// Notifications on phones and browsers (Web Push). A new chat message reaches the people in its
// space who haven't read it a few seconds later, on every device they turned notifications on in.
// A burst of messages in one space shows as one notification that each new one replaces.
import webpush from "web-push";
import type { ChatEvent, ChatMessage } from "../shared/chat.ts";
import { mentionedIn } from "../shared/mentions.ts";
import type { PushPayload } from "../shared/push.ts";
import type { DB } from "./db.ts";
import type { PushSubscriptionRow } from "./db/push.ts";

/** Long enough that someone with the chat open has read the message, and the next few in a burst
 *  go out together. */
export const PUSH_WAIT_MS = 8_000;
/** A notification nobody's phone took within a day is old news. */
const TTL_S = 24 * 3600;
const BODY_MAX = 180;

export interface VapidKeys {
  publicKey?: string;
  privateKey?: string;
  /** mailto: or https: */
  subject?: string;
}

/** Sends one notification to one device. Throws with statusCode 404 or 410 when the device is gone. */
export type PushSend = (sub: PushSubscriptionRow, payload: PushPayload) => Promise<unknown>;

export class Push {
  readonly publicKey: string | null;
  private readonly send: PushSend | null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per channel and person, the newest message a notification has already told them about. */
  private readonly told = new Map<string, number>();
  private readonly waitMs: number;

  constructor(
    private readonly db: DB,
    keys: VapidKeys,
    opts: { send?: PushSend; waitMs?: number } = {},
  ) {
    this.waitMs = opts.waitMs ?? PUSH_WAIT_MS;
    if (opts.send) {
      this.publicKey = keys.publicKey ?? "test";
      this.send = opts.send;
    } else if (keys.publicKey && keys.privateKey) {
      const vapidDetails = { subject: keys.subject ?? "mailto:notifications@stand.invalid", publicKey: keys.publicKey, privateKey: keys.privateKey };
      this.publicKey = keys.publicKey;
      this.send = (sub, payload) =>
        webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
          vapidDetails,
          TTL: TTL_S,
          urgency: "high",
          topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
        });
    } else {
      this.publicKey = null;
      this.send = null;
    }
  }

  get enabled() {
    return !!this.send;
  }

  /** Told of every change in a space's chat. A new message starts the wait, unless one is running. */
  heard(roomId: string, e: ChatEvent) {
    if (!this.send || e.type !== "message" || e.message.editedAt || e.message.deletedAt) return;
    const channelId = e.message.channelId;
    if (this.timers.has(channelId)) return;
    const t = setTimeout(() => {
      this.timers.delete(channelId);
      void this.notifyChannel(roomId, channelId);
    }, this.waitMs);
    t.unref?.();
    this.timers.set(channelId, t);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Each person in the space with something unread here that no notification has told them of yet. */
  async notifyChannel(roomId: string, channelId: string): Promise<void> {
    const room = this.db.getRoom(roomId);
    if (!room || !this.send) return;
    const people = this.db.roomPeople(roomId);
    const sends: Promise<void>[] = [];
    for (const p of people) {
      const subs = this.db.pushSubscriptions(p.id);
      if (!subs.length) continue;
      const key = `${channelId}:${p.id}`;
      const from = Math.max(this.db.channelReadUpTo(channelId, p.id), this.told.get(key) ?? 0);
      const fresh = this.db.channelMessages(channelId, { after: from, limit: 200 }).filter((m) => m.authorId !== p.id && !m.deletedAt);
      if (!fresh.length) continue;
      this.told.set(key, fresh.at(-1)!.seq);
      const level = this.db.chatNotify(roomId, p.id);
      const reaching = level === "all" ? fresh : fresh.filter((m) => this.callsOn(m, p.id, people));
      if (!reaching.length) continue;
      const payload = chatPayload(room.name, roomId, reaching, fresh.length);
      for (const s of subs) sends.push(this.deliver(s, payload));
    }
    await Promise.all(sends);
  }

  /** A test from the settings: one notification to each of your own devices. Returns how many took it. */
  async test(userId: string): Promise<number> {
    if (!this.send) return 0;
    const subs = this.db.pushSubscriptions(userId);
    const payload: PushPayload = { title: "Stand", body: "Notifications are on. New chat messages will show up here.", url: "/", tag: "stand-test" };
    const ok = await Promise.all(subs.map((s) => this.deliver(s, payload)));
    return ok.length;
  }

  /** A message that @mentions this person, or replies to something they wrote. */
  private callsOn(m: ChatMessage, userId: string, people: Array<{ id: string; name: string }>) {
    if (mentionedIn(m.text, people).includes(userId)) return true;
    return !!m.replyTo && this.db.chatMessage(m.replyTo)?.authorId === userId;
  }

  private async deliver(sub: PushSubscriptionRow, payload: PushPayload) {
    try {
      await this.send!(sub, payload);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // The device unsubscribed, or the app was taken off the home screen: forget it.
      if (status === 404 || status === 410) this.db.removePushSubscription(sub.endpoint);
      else console.warn(`push: ${status ?? ""} ${(err as Error).message}`);
    }
  }
}

/** The space's name on top, then who wrote and what. More than one shows the newest, and how many. */
export function chatPayload(spaceName: string, roomId: string, reaching: ChatMessage[], unread: number): PushPayload {
  const last = reaching.at(-1)!;
  const text = last.text.replace(/\s+/g, " ").trim();
  const line = `${last.author}: ${text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text}`;
  const more = unread - 1;
  return {
    title: spaceName,
    body: more > 0 ? `${line}\n+${more} more ${more === 1 ? "message" : "messages"}` : line,
    url: `/s/${roomId}?chat=1`,
    tag: `chat-${roomId}`,
  };
}
