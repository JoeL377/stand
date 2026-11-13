// Notifications (push.ts): the phones and browsers each person turned them on in, and which chat
// messages in a space reach them.
import type { DatabaseSync } from "node:sqlite";
import type { ChatNotify } from "../../shared/push.ts";
import type { Row } from "./rows.ts";

export interface PushSubscriptionRow {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
}

const toSub = (r: Row): PushSubscriptionRow => ({
  endpoint: r.endpoint as string,
  userId: r.user_id as string,
  p256dh: r.p256dh as string,
  auth: r.auth as string,
});

export function pushStore(db: DatabaseSync) {
  return {
    /** A device said yes. The same device again (its endpoint) moves to whoever is signed in on it now. */
    savePushSubscription(s: PushSubscriptionRow & { userAgent?: string | null }) {
      db.prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      ).run(s.endpoint, s.userId, s.p256dh, s.auth, s.userAgent ?? null, Date.now());
    },
    /** userId: only when it is theirs. */
    removePushSubscription(endpoint: string, userId?: string) {
      if (userId) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
      else db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    },
    pushSubscriptions(userId: string): PushSubscriptionRow[] {
      return (db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toSub);
    },
    chatNotify(roomId: string, userId: string): ChatNotify {
      const r = db.prepare("SELECT level FROM chat_notify WHERE room_id = ? AND user_id = ?").get(roomId, userId) as Row | undefined;
      return r?.level === "mentions" ? "mentions" : "all";
    },
    setChatNotify(roomId: string, userId: string, level: ChatNotify) {
      if (level === "all") db.prepare("DELETE FROM chat_notify WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      else db.prepare("INSERT INTO chat_notify (room_id, user_id, level) VALUES (?, ?, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET level = excluded.level").run(roomId, userId, level);
    },
  };
}
