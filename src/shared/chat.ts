// Chat in a space: talk in writing between meetings. A channel is one place the text comes from,
// a session is one stretch of talk in it (a meetings row of kind "chat"), a message is a segment.
import type { DiscussionOutcome } from "./protocol.ts";

export interface Channel {
  id: string;
  roomId: string;
  /** "stand" for the space's own chat. An outside source later. */
  source: string;
  name: string;
  /** The session messages go to now; null when the channel is quiet. */
  openSessionId: string | null;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  channelId: string;
  roomId: string;
  startedAt: number;
  /** When its last message came. A session always has one, open or not (see Channel.openSessionId). */
  endedAt: number;
  messages: number;
}

export interface ChatMessage {
  /** Its place in the order of everything sent to Stand's chat; grows with each message. */
  seq: number;
  /** The id of its segment. */
  id: string;
  channelId: string;
  sessionId: string;
  authorId: string;
  author: string;
  /** Empty once deleted. */
  text: string;
  ts: number;
  /** The message it answers. */
  replyTo: string | null;
  editedAt: number | null;
  deletedAt: number | null;
  /** What people answered it with, in the order each emoji was first used. */
  reactions: ChatReaction[];
  /** The key its author's page sent it with, so that page knows it as the one it showed before it was saved. */
  key: string | null;
}

/** One emoji on a message, and who put it there. */
export interface ChatReaction {
  emoji: string;
  by: Array<{ id: string; name: string }>;
}

/** What the chat tells whoever listens (the space's event stream). */
export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "session"; channelId: string; sessionId: string; open: boolean }
  /** What Stand caught from a session changed: read it again. */
  | { type: "notes"; channelId: string; sessionId: string }
  /** Someone read further. Sending says the same of a message's author, so it has no event of its own. */
  | ({ type: "read"; channelId: string } & ChatRead)
  /** Someone is writing in the box. Nothing is kept: it fades by itself a few seconds later. */
  | { type: "typing"; channelId: string; userId: string; name: string };

/** How far someone has read a channel. */
export interface ChatRead {
  userId: string;
  name: string;
  /** The seq of the last message they have read. */
  upTo: number;
}

/** A to-do, open question or decision Stand caught from chat, as the thread shows it. */
export interface CaughtLine {
  id: string;
  kind: "action" | "question" | "decision";
  text: string;
  owner: string | null;
  /** Done or dropped. */
  closed: boolean;
  /** The message it came from, once the session has closed and its words were found. */
  messageId: string | null;
  /** When Stand caught it: until it has a message, it sits after the last one written by then. */
  ts: number;
}

/** What Stand made of one session: the lines it caught, its topics, and its summary once it has closed. */
export interface ChatCaught {
  sessionId: string;
  summary: string | null;
  topics: Array<{ id: string; topic: string; outcome: DiscussionOutcome }>;
  lines: CaughtLine[];
}

/** What the Chat tab opens on. */
export interface ChatThread {
  channel: Channel;
  /** The newest messages, oldest first. */
  messages: ChatMessage[];
  /** The sessions those messages are in. */
  sessions: ChatSession[];
  /** What Stand caught from those sessions, for the ones it caught something from. */
  caught: ChatCaught[];
  /** The seq of the last message you have read. */
  readUpTo: number;
  /** How far the other people in the space have read, for those who have read anything. */
  reads: ChatRead[];
  /** The space's people, to tag with @. */
  people: Array<{ id: string; name: string }>;
}
