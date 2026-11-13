// Notifications on the iPhone app. A new chat message reaches the people in its space who haven't
// read it a few seconds later, on every phone they turned notifications on in. A burst of messages
// in one space shows as one notification that each new one replaces.
import type { ChatEvent, ChatMessage } from "../shared/chat.ts";
import { mentionedIn } from "../shared/mentions.ts";
import type { PushMessage } from "../shared/push.ts";
import { Apns, type ApnsKey, DeviceGone } from "./apns.ts";
import type { DB } from "./db.ts";
import type { PushDevice } from "./db/push.ts";

/** Long enough that someone with the chat open has read the message, and the next few in a burst
 *  go out together. */
export const PUSH_WAIT_MS = 8_000;
const BODY_MAX = 180;

/** Sends one notification to one phone. Throws DeviceGone when the phone no longer takes them. */
export type PushSend = (device: PushDevice, m: PushMessage) => Promise<unknown>;

export class Push {
  private readonly send: PushSend | null;
  private readonly apns: Apns | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per channel and person, the newest message a notification has already told them about. */
  private readonly told = new Map<string, number>();
  private readonly waitMs: number;

  constructor(
    private readonly db: DB,
    key: Partial<ApnsKey>,
    opts: { send?: PushSend; waitMs?: number } = {},
  ) {
    this.waitMs = opts.waitMs ?? PUSH_WAIT_MS;
    if (opts.send) this.send = opts.send;
    else if (key.key && key.keyId && key.teamId && key.topic) {
      const apns = new Apns(key as ApnsKey);
      this.apns = apns;
      this.send = (d, m) => apns.send(d, m);
    } else this.send = null;
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
    this.apns?.close();
  }

  /** Each person in the space with something unread here that no notification has told them of yet. */
  async notifyChannel(roomId: string, channelId: string): Promise<void> {
    const room = this.db.getRoom(roomId);
    if (!room || !this.send) return;
    const people = this.db.roomPeople(roomId);
    const sends: Promise<boolean>[] = [];
    for (const p of people) {
      const subs = this.db.pushDevices(p.id);
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
    const devices = this.db.pushDevices(userId);
    const m: PushMessage = { title: "Stand", body: "Notifications are on. New chat messages will show up here.", url: "/", tag: "stand-test" };
    const ok = await Promise.all(devices.map((d) => this.deliver(d, m)));
    return ok.filter(Boolean).length;
  }

  /** A message that @mentions this person, or replies to something they wrote. */
  private callsOn(m: ChatMessage, userId: string, people: Array<{ id: string; name: string }>) {
    if (mentionedIn(m.text, people).includes(userId)) return true;
    return !!m.replyTo && this.db.chatMessage(m.replyTo)?.authorId === userId;
  }

  /** True when the phone took it. */
  private async deliver(device: PushDevice, m: PushMessage): Promise<boolean> {
    try {
      await this.send!(device, m);
      return true;
    } catch (err) {
      // The app was deleted, or its notifications turned off: forget the phone. It says so again if it comes back.
      if (err instanceof DeviceGone) this.db.removePushDevice(device.token);
      else console.warn(`push: ${(err as Error).message}`);
      return false;
    }
  }
}

/** The space's name on top, then who wrote and what. More than one shows the newest, and how many. */
export function chatPayload(spaceName: string, roomId: string, reaching: ChatMessage[], unread: number): PushMessage {
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
