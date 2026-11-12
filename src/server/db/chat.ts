// Chat (chat.ts): channels, the sessions in them, and what chat keeps about a message beside its segment.
import type { DatabaseSync } from "node:sqlite";
import type { Channel, ChatMessage, ChatSession } from "../../shared/chat.ts";
import { newId } from "../ids.ts";
import type { Row } from "./rows.ts";

const MESSAGE_SELECT = `SELECT c.seq, c.channel_id, c.reply_to, c.edited_at, c.deleted_at,
  s.id, s.meeting_id, s.speaker_id, s.speaker_name, s.text, s.ts
  FROM chat_messages c JOIN segments s ON s.id = c.segment_id`;

const SESSION_SELECT = `SELECT m.id, m.channel_id, m.room_id, m.started_at, m.ended_at,
  (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS n FROM meetings m`;

const toChannel = (r: Row): Channel => ({
  id: r.id as string,
  roomId: r.room_id as string,
  source: r.source as string,
  name: r.name as string,
  openSessionId: (r.open_session_id as string) ?? null,
  createdAt: r.created_at as number,
});

const toSession = (r: Row): ChatSession => ({
  id: r.id as string,
  channelId: r.channel_id as string,
  roomId: r.room_id as string,
  startedAt: r.started_at as number,
  endedAt: r.ended_at as number,
  messages: r.n as number,
});

const toMessage = (r: Row): ChatMessage => ({
  seq: r.seq as number,
  id: r.id as string,
  channelId: r.channel_id as string,
  sessionId: r.meeting_id as string,
  authorId: r.speaker_id as string,
  author: r.speaker_name as string,
  text: r.text as string,
  ts: r.ts as number,
  replyTo: (r.reply_to as string) ?? null,
  editedAt: (r.edited_at as number) ?? null,
  deletedAt: (r.deleted_at as number) ?? null,
});

export function chatStore(db: DatabaseSync) {
  return {
    /** The space's own chat, made the first time someone asks for it. */
    spaceChannel(roomId: string, by: string): Channel {
      const r = db.prepare("SELECT * FROM channels WHERE room_id = ? AND source = 'stand' ORDER BY created_at, rowid LIMIT 1").get(roomId) as Row | undefined;
      if (r) return toChannel(r);
      const c: Channel = { id: newId(), roomId, source: "stand", name: "Chat", openSessionId: null, createdAt: Date.now() };
      db.prepare("INSERT INTO channels (id, room_id, source, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, roomId, c.source, c.name, by, c.createdAt);
      return c;
    },
    getChannel(id: string): Channel | null {
      const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row | undefined;
      return r ? toChannel(r) : null;
    },
    roomChannels(roomId: string): Channel[] {
      return (db.prepare("SELECT * FROM channels WHERE room_id = ? ORDER BY created_at, rowid").all(roomId) as Row[]).map(toChannel);
    },
    /** A new session in a channel, which its messages go to from now on. Its end is its last message's
     *  time from the start, so everything that reads a space's finished meetings finds what chat leaves. */
    startChatSession(channel: Channel, at: number): ChatSession {
      const id = newId();
      db.prepare("INSERT INTO meetings (id, room_id, started_at, ended_at, kind, channel_id) VALUES (?, ?, ?, ?, 'chat', ?)").run(id, channel.roomId, at, at, channel.id);
      db.prepare("UPDATE channels SET open_session_id = ? WHERE id = ?").run(id, channel.id);
      return { id, channelId: channel.id, roomId: channel.roomId, startedAt: at, endedAt: at, messages: 0 };
    },
    /** The channel's messages start a new session from now on. Capture goes back one message in the
     *  session that closes, so it is read once more, whole (chatCapture.ts). */
    closeChatSession(channelId: string) {
      db.prepare(
        `UPDATE channels SET open_session_id = NULL, captured_up_to = MIN(captured_up_to, COALESCE(
           (SELECT MAX(c.seq) - 1 FROM chat_messages c JOIN segments s ON s.id = c.segment_id WHERE s.meeting_id = channels.open_session_id), captured_up_to))
         WHERE id = ?`,
      ).run(channelId);
    },
    /** The seq of the newest message a capture run has read in a channel. */
    capturedUpTo(channelId: string): number {
      return ((db.prepare("SELECT captured_up_to FROM channels WHERE id = ?").get(channelId) as Row | undefined)?.captured_up_to as number) ?? 0;
    },
    setCapturedUpTo(channelId: string, seq: number) {
      db.prepare("UPDATE channels SET captured_up_to = ? WHERE id = ?").run(seq, channelId);
    },
    /** A message capture had read was changed: it reads from before that message again. */
    rewindCapture(channelId: string, beforeSeq: number) {
      db.prepare("UPDATE channels SET captured_up_to = MIN(captured_up_to, ?) WHERE id = ?").run(beforeSeq - 1, channelId);
    },
    /** The oldest session of a channel with a message capture has not read, and that session's newest message. */
    uncapturedSession(channelId: string): { session: ChatSession; newest: number } | null {
      const r = db
        .prepare(
          `SELECT s.meeting_id FROM chat_messages c JOIN segments s ON s.id = c.segment_id
           WHERE c.channel_id = ?1 AND c.seq > (SELECT captured_up_to FROM channels WHERE id = ?1) ORDER BY c.seq LIMIT 1`,
        )
        .get(channelId) as Row | undefined;
      const session = r && this.chatSession(r.meeting_id as string);
      if (!session) return null;
      const newest = db.prepare("SELECT MAX(c.seq) AS n FROM chat_messages c JOIN segments s ON s.id = c.segment_id WHERE s.meeting_id = ?").get(session.id) as Row;
      return { session, newest: newest.n as number };
    },
    /** The channels with a message capture has not read. */
    uncapturedChannels(): string[] {
      return (
        db.prepare("SELECT ch.id FROM channels ch WHERE EXISTS (SELECT 1 FROM chat_messages c WHERE c.channel_id = ch.id AND c.seq > ch.captured_up_to) ORDER BY ch.created_at, ch.rowid").all() as Row[]
      ).map((r) => r.id as string);
    },
    /** The topics of a channel's other sessions, newest session first, so a new one can link back. */
    channelTopics(channelId: string, exceptSessionId: string, limit = 15): Array<{ id: string; topic: string; meetingStartedAt: number }> {
      return (
        db
          .prepare(
            `SELECT d.id, d.topic, m.started_at FROM discussions d JOIN meetings m ON m.id = d.meeting_id
             WHERE m.channel_id = ? AND m.id != ? ORDER BY m.started_at DESC, d.position LIMIT ?`,
          )
          .all(channelId, exceptSessionId, limit) as Row[]
      ).map((r) => ({ id: r.id as string, topic: r.topic as string, meetingStartedAt: r.started_at as number }));
    },
    /** What a session was about, in a few sentences, once it has closed. */
    setChatSummary(sessionId: string, summary: string) {
      db.prepare("UPDATE meetings SET summary = ? WHERE id = ? AND kind = 'chat'").run(summary, sessionId);
    },
    /** A deleted message is quoted nowhere: what was caught from it stays, without its words. */
    dropQuotesOf(messageId: string) {
      db.prepare("UPDATE notes SET quote_json = NULL WHERE quote_json IS NOT NULL AND json_extract(quote_json, '$.segmentId') = ?").run(messageId);
      const rows = db
        .prepare("SELECT d.id, d.positions_json FROM discussions d JOIN segments s ON s.meeting_id = d.meeting_id WHERE s.id = ? AND d.positions_json LIKE ?")
        .all(messageId, `%${messageId}%`) as Row[];
      for (const r of rows) {
        const positions = (JSON.parse(r.positions_json as string) as Array<{ quote?: { segmentId: string } }>).map((p) => {
          if (p.quote?.segmentId !== messageId) return p;
          const { quote: _gone, ...rest } = p;
          return rest;
        });
        db.prepare("UPDATE discussions SET positions_json = ? WHERE id = ?").run(JSON.stringify(positions), r.id as string);
      }
    },
    chatSession(id: string): ChatSession | null {
      const r = db.prepare(`${SESSION_SELECT} WHERE m.id = ? AND m.kind = 'chat'`).get(id) as Row | undefined;
      return r ? toSession(r) : null;
    },
    /** The session each channel's messages go to now, for the channels that have one. */
    openChatSessions(): ChatSession[] {
      return (db.prepare(`${SESSION_SELECT} JOIN channels c ON c.open_session_id = m.id ORDER BY m.started_at`).all() as Row[]).map(toSession);
    },
    /** A channel's sessions, newest first. */
    channelSessions(channelId: string, limit = 50): ChatSession[] {
      return (db.prepare(`${SESSION_SELECT} WHERE m.channel_id = ? ORDER BY m.started_at DESC, m.rowid DESC LIMIT ?`).all(channelId, limit) as Row[]).map(toSession);
    },
    /** A space's sessions, in all its channels, that had a message at or after a time. Newest first. */
    roomChatSessions(roomId: string, since = 0, limit = 30): ChatSession[] {
      return (
        db.prepare(`${SESSION_SELECT} WHERE m.room_id = ? AND m.kind = 'chat' AND m.ended_at >= ? ORDER BY m.started_at DESC, m.rowid DESC LIMIT ?`).all(roomId, since, limit) as Row[]
      ).map(toSession);
    },
    /** A session's messages, oldest first. */
    sessionMessages(sessionId: string): ChatMessage[] {
      return (db.prepare(`${MESSAGE_SELECT} WHERE s.meeting_id = ? ORDER BY c.seq`).all(sessionId) as Row[]).map(toMessage);
    },
    /** What chat keeps about a message that is already a segment of its session. externalId: the
     *  key it was sent with, which a channel holds once. */
    addChatMessage(m: { segmentId: string; sessionId: string; channelId: string; externalId: string | null; replyTo: string | null; ts: number }): ChatMessage {
      db.prepare("INSERT INTO chat_messages (segment_id, channel_id, external_id, reply_to) VALUES (?, ?, ?, ?)").run(m.segmentId, m.channelId, m.externalId, m.replyTo);
      db.prepare("UPDATE meetings SET ended_at = MAX(ended_at, ?) WHERE id = ?").run(m.ts, m.sessionId);
      return this.chatMessage(m.segmentId)!;
    },
    chatMessage(id: string): ChatMessage | null {
      const r = db.prepare(`${MESSAGE_SELECT} WHERE c.segment_id = ?`).get(id) as Row | undefined;
      return r ? toMessage(r) : null;
    },
    chatMessageByKey(channelId: string, externalId: string): ChatMessage | null {
      const r = db.prepare(`${MESSAGE_SELECT} WHERE c.channel_id = ? AND c.external_id = ?`).get(channelId, externalId) as Row | undefined;
      return r ? toMessage(r) : null;
    },
    editChatMessage(id: string, text: string, at: number): ChatMessage | null {
      db.prepare("UPDATE segments SET text = ? WHERE id = ?").run(text, id);
      db.prepare("UPDATE chat_messages SET edited_at = ? WHERE segment_id = ?").run(at, id);
      return this.chatMessage(id);
    },
    /** The message stays in its place, with nothing in it. */
    deleteChatMessage(id: string, at: number): ChatMessage | null {
      db.prepare("UPDATE segments SET text = '' WHERE id = ?").run(id);
      db.prepare("UPDATE chat_messages SET deleted_at = ? WHERE segment_id = ?").run(at, id);
      return this.chatMessage(id);
    },
    /** This person has read the channel up to this message. It never moves back. */
    markChannelRead(channelId: string, userId: string, upTo: number) {
      db.prepare(
        `INSERT INTO channel_reads (channel_id, user_id, read_up_to) VALUES (?, ?, ?)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET read_up_to = MAX(read_up_to, excluded.read_up_to)`,
      ).run(channelId, userId, upTo);
    },
    channelReadUpTo(channelId: string, userId: string): number {
      const r = db.prepare("SELECT read_up_to FROM channel_reads WHERE channel_id = ? AND user_id = ?").get(channelId, userId) as Row | undefined;
      return (r?.read_up_to as number) ?? 0;
    },
    /** Messages other people wrote that this person hasn't read, in each of their spaces that has some. */
    unreadChat(userId: string): Map<string, number> {
      const rows = db
        .prepare(
          `SELECT ch.room_id, COUNT(*) AS n FROM channels ch
           JOIN room_members x ON x.room_id = ch.room_id AND x.user_id = ?
           LEFT JOIN channel_reads r ON r.channel_id = ch.id AND r.user_id = x.user_id
           JOIN chat_messages c ON c.channel_id = ch.id AND c.seq > COALESCE(r.read_up_to, 0) AND c.deleted_at IS NULL
           JOIN segments s ON s.id = c.segment_id AND s.speaker_id != x.user_id
           GROUP BY ch.room_id`,
        )
        .all(userId) as Row[];
      return new Map(rows.map((r) => [r.room_id as string, r.n as number]));
    },
    /** What other people wrote with an @ in it that this person hasn't read, per space: where a mention of them could be. */
    unreadChatWithAt(userId: string): Array<{ roomId: string; text: string }> {
      return (
        db
          .prepare(
            `SELECT ch.room_id, s.text FROM channels ch
             JOIN room_members x ON x.room_id = ch.room_id AND x.user_id = ?
             LEFT JOIN channel_reads r ON r.channel_id = ch.id AND r.user_id = x.user_id
             JOIN chat_messages c ON c.channel_id = ch.id AND c.seq > COALESCE(r.read_up_to, 0) AND c.deleted_at IS NULL
             JOIN segments s ON s.id = c.segment_id AND s.speaker_id != x.user_id AND s.text LIKE '%@%'`,
          )
          .all(userId) as Row[]
      ).map((r) => ({ roomId: r.room_id as string, text: r.text as string }));
    },
    /** A page of a channel's messages, oldest first: the newest ones, those before a seq, or those after one. */
    channelMessages(channelId: string, page: { before?: number; after?: number; limit?: number } = {}): ChatMessage[] {
      const limit = Math.min(Math.max(page.limit ?? 100, 1), 500);
      if (page.after !== undefined)
        return (db.prepare(`${MESSAGE_SELECT} WHERE c.channel_id = ? AND c.seq > ? ORDER BY c.seq LIMIT ?`).all(channelId, page.after, limit) as Row[]).map(toMessage);
      const rows = db
        .prepare(`${MESSAGE_SELECT} WHERE c.channel_id = ? AND c.seq < ? ORDER BY c.seq DESC LIMIT ?`)
        .all(channelId, page.before ?? Number.MAX_SAFE_INTEGER, limit) as Row[];
      return rows.reverse().map(toMessage);
    },
  };
}
