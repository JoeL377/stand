// Notifications (push.ts): the iPhones each person turned them on in, and which chat messages in a
// space reach them.
import type { DatabaseSync } from "node:sqlite";
import type { ApnsEnv, ChatNotify } from "../../shared/push.ts";
import type { Row } from "./rows.ts";

export interface PushDevice {
  token: string;
  userId: string;
  env: ApnsEnv;
}

const toDevice = (r: Row): PushDevice => ({
  token: r.token as string,
  userId: r.user_id as string,
  env: r.env === "sandbox" ? "sandbox" : "production",
});

export function pushStore(db: DatabaseSync) {
  return {
    /** A phone said yes. The same phone again moves to whoever is signed in on it now. */
    savePushDevice(d: PushDevice) {
      db.prepare(
        `INSERT INTO push_devices (token, user_id, env, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, env = excluded.env`,
      ).run(d.token, d.userId, d.env, Date.now());
    },
    /** userId: only when it is theirs. */
    removePushDevice(token: string, userId?: string) {
      if (userId) db.prepare("DELETE FROM push_devices WHERE token = ? AND user_id = ?").run(token, userId);
      else db.prepare("DELETE FROM push_devices WHERE token = ?").run(token);
    },
    pushDevices(userId: string): PushDevice[] {
      return (db.prepare("SELECT * FROM push_devices WHERE user_id = ? ORDER BY created_at").all(userId) as Row[]).map(toDevice);
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
