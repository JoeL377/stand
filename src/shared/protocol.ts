// Types shared by the server and the browser. The WebSocket at /ws/rooms/:id
// carries ClientMessage up and ServerMessage down as JSON.

export type ItemSource = "agenda" | "linear";

export interface Item {
  id: string;
  roomId: string;
  source: ItemSource;
  /** Ticket key for Linear (e.g. ENG-142); null for agenda lines. */
  externalId: string | null;
  title: string;
  url: string | null;
  description: string | null;
  position: number;
}

export type SegmentKind = "speech" | "chat";

export interface Segment {
  id: string;
  meetingId: string;
  itemId: string | null;
  speakerId: string;
  speakerName: string;
  kind: SegmentKind;
  text: string;
  /** Wall-clock ms when the utterance started (or the chat was sent). */
  ts: number;
}

export type NoteKind = "summary" | "decision" | "action" | "question";

export interface Note {
  id: string;
  meetingId: string;
  itemId: string | null;
  kind: NoteKind;
  text: string;
  owner: string | null;
  ts: number;
}

export interface Participant {
  id: string;
  name: string;
  picture: string | null;
  /** The host drives the meeting: whatever item they open is what's being discussed. */
  isHost: boolean;
  isSharing: boolean;
}

export interface Suggestion {
  itemId: string;
  /** Why the agent thinks so, e.g. "ENG-142 is visible in the window title". */
  reason: string;
  confidence: number;
  /** When the screen changed; confirming re-pins speech from this moment. */
  since: number;
}

export interface Capabilities {
  /** Shared audio and screen share between people. */
  livekit: boolean;
  /** Server-side per-speaker transcription by the agent in the LiveKit room,
   *  through LiveKit Inference or a direct Deepgram key; or "browser", where
   *  each browser transcribes its own mic (Chrome, Edge, Safari). */
  transcription: "livekit" | "deepgram" | "browser";
  /** Real LLM for notes and screen reading; otherwise heuristics. */
  llm: boolean;
  linear: boolean;
  /** false = stand-in sign-in with name and email, no verification. */
  googleSignIn: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface RoomState {
  roomId: string;
  roomName: string;
  meetingId: string;
  meetingStartedAt: number;
  participants: Participant[];
  focusItemId: string | null;
  /** When pinned, the agent stops suggesting until someone unpins. */
  pinnedBy: string | null;
  suggestion: Suggestion | null;
  items: Item[];
  capabilities: Capabilities;
}

export type ClientMessage =
  | { type: "hello" }
  | { type: "focus"; itemId: string | null }
  | { type: "pin"; itemId: string }
  | { type: "unpin" }
  | { type: "suggestion.accept" }
  | { type: "suggestion.dismiss" }
  /** Take the host role when nobody holds it, or (as host) hand it to someone. */
  | { type: "host.give"; participantId: string }
  | { type: "sharing"; on: boolean }
  | { type: "chat"; text: string }
  /** Browser transcription: a finished utterance from this participant's mic. */
  | { type: "speech"; text: string; startedAt: number }
  | { type: "speech.interim"; text: string }
  /** A JPEG data URL of the shared screen, sent by the host when it changes. */
  | { type: "frame"; dataUrl: string }
  | { type: "segment.move"; segmentId: string; itemId: string | null }
  | { type: "demo.play" }
  | { type: "meeting.end" };

export type ServerMessage =
  | { type: "state"; state: RoomState }
  | { type: "welcome"; participantId: string; segments: Segment[]; notes: Note[] }
  | { type: "segment"; segment: Segment }
  | { type: "segment.updated"; segment: Segment }
  | { type: "interim"; speakerId: string; speakerName: string; text: string }
  | { type: "notes"; meetingId: string; itemId: string | null; notes: Note[] }
  | { type: "meeting.ended"; meetingId: string }
  | { type: "error"; message: string };

export interface ItemHistory {
  item: Item;
  meetings: Array<{
    meetingId: string;
    startedAt: number;
    endedAt: number | null;
    participants: string[];
    segments: Segment[];
    notes: Note[];
  }>;
}

export interface MeetingRecap {
  meetingId: string;
  roomId: string;
  roomName: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  items: Array<{ item: Item | null; segments: Segment[]; notes: Note[] }>;
}
