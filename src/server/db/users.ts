// People, their sign-in sessions, and who is in which space.
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { SpaceMember, User } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import { type Row, SESSION_TTL_MS, toUser } from "./rows.ts";

export function usersStore(db: DatabaseSync) {
  return {
    /** The names of the people in a space, for speech-to-text to listen for. */
    memberNames(roomId: string): string[] {
      return (db.prepare("SELECT u.name FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?").all(roomId) as Row[]).map((r) => r.name as string).filter(Boolean);
    },
    userName(id: string): string | null {
      return ((db.prepare("SELECT name FROM users WHERE id = ?").get(id) as Row | undefined)?.name as string | undefined) ?? null;
    },
    userByEmail(email: string): User | null {
      const r = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as Row | undefined;
      return r ? toUser(r) : null;
    },
    /** Finds the user by Google subject (or email, for accounts created by the
     *  stand-in sign-in) and refreshes their profile. */
    upsertUser(u: { googleSub: string | null; email: string; name: string; picture: string | null }): User {
      const email = u.email.toLowerCase();
      const existing =
        ((u.googleSub ? db.prepare("SELECT * FROM users WHERE google_sub = ?").get(u.googleSub) : undefined) as Row | undefined) ??
        (db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined);
      if (existing) {
        db.prepare(
          "UPDATE users SET google_sub = COALESCE(?, google_sub), email = ?, name = ?, picture = COALESCE(?, picture) WHERE id = ?",
        ).run(u.googleSub, email, u.name, u.picture, existing.id as string);
        return toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id as string) as Row);
      }
      const id = "u" + newId(11);
      db.prepare("INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        u.googleSub,
        email,
        u.name,
        u.picture,
        Date.now(),
      );
      return { id, email, name: u.name, picture: u.picture };
    },
    createSession(userId: string) {
      const id = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, Date.now() + SESSION_TTL_MS);
      return { id, maxAgeMs: SESSION_TTL_MS };
    },
    /** The signed-in user, and whether Google verified their email
     *  (false for the stand-in name-and-email sign-in). */
    sessionUser(sessionId: string): { user: User; verified: boolean } | null {
      const r = db
        .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?")
        .get(sessionId, Date.now()) as Row | undefined;
      return r ? { user: toUser(r), verified: Boolean(r.google_sub) } : null;
    },
    deleteSession(sessionId: string) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    },
    touchMembership(roomId: string, userId: string) {
      db.prepare(
        `INSERT INTO room_members (room_id, user_id, last_joined_at) VALUES (?, ?, ?)
         ON CONFLICT (room_id, user_id) DO UPDATE SET last_joined_at = excluded.last_joined_at`,
      ).run(roomId, userId, Date.now());
    },
    userRooms(userId: string) {
      return (
        db
          .prepare(
            `SELECT r.id, r.name, m.last_joined_at FROM room_members m JOIN rooms r ON r.id = m.room_id
             WHERE m.user_id = ? ORDER BY m.last_joined_at DESC LIMIT 30`,
          )
          .all(userId) as Row[]
      ).map((r) => ({ id: r.id as string, name: r.name as string, lastJoinedAt: r.last_joined_at as number }));
    },
    isMember(roomId: string, userId: string): boolean {
      return Boolean(db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?").get(roomId, userId));
    },
    /** Whether this person may change the space: they created it, or they're one of its admins.
     *  An older space with no creator is managed by anyone in it. */
    managesSpace(room: { id: string; createdBy: string | null }, userId: string): boolean {
      if (!room.createdBy || room.createdBy === userId) return true;
      return Boolean(db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND role = 'admin'").get(room.id, userId));
    },
    /** Makes someone in the space an admin, or takes that back. False when they aren't in it. */
    setAdmin(roomId: string, userId: string, admin: boolean): boolean {
      return db.prepare("UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?").run(admin ? "admin" : null, roomId, userId).changes > 0;
    },
    /** The people in a space and who manages it: the creator first, then admins, then by name. */
    spaceMembers(room: { id: string; createdBy: string | null }, viewerId: string): SpaceMember[] {
      const order = { creator: 0, admin: 1, member: 2 };
      return (
        db.prepare("SELECT u.id, u.name, u.picture, m.role FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?").all(room.id) as Row[]
      )
        .map((r): SpaceMember => ({
          id: r.id as string,
          name: r.name as string,
          picture: (r.picture as string) ?? null,
          role: r.id === room.createdBy ? "creator" : r.role === "admin" ? "admin" : "member",
          you: r.id === viewerId,
        }))
        .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
    },
    /** The people in a space, as an @mention can name them. */
    roomPeople(roomId: string): Array<{ id: string; name: string }> {
      return (db.prepare("SELECT u.id, u.name FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.name").all(roomId) as Row[])
        .map((r) => ({ id: r.id as string, name: r.name as string }))
        .filter((p) => p.name);
    },
  };
}
