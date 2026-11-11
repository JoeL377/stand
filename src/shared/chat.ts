// Chat in a space: talk in writing between meetings. A channel is one place the text comes from,
// a session is one stretch of talk in it (a meetings row of kind "chat"), a message is a segment.

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
}

/** What the chat tells whoever listens (the space's event stream). */
export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "session"; channelId: string; sessionId: string; open: boolean };
