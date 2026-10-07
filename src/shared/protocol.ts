// Types shared by the server and the browser. The WebSocket at /ws/rooms/:id
// carries ClientMessage up and ServerMessage down as JSON.

export type ItemSource = "agenda" | "linear" | "slide";

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
  /** Slides: the deck this page belongs to and its 1-based page number. */
  deckId: string | null;
  slideNo: number | null;
  /** Content of a slide made in Stand's own editor; null for PDF pages. */
  slide: SlideContent | null;
}

export type SlideLayout = "title" | "bullets" | "section" | "image" | "quote";

export interface SlideContent {
  layout: SlideLayout;
  /** Subtitle, bullet lines (one per line) or quote, depending on layout. */
  body: string;
  /** Uploaded image id (see /api/decks/:deckId/images/:imageId). */
  image: string | null;
  /** Speaker notes, shown only to the host. */
  notes: string;
}

export type DeckTheme = "paper" | "night" | "ocean" | "sunset";

/** A slide deck: an uploaded PDF, or one made in Stand's editor. Each slide
 *  is an Item, so discussion pins per slide. */
export interface Deck {
  id: string;
  roomId: string;
  title: string;
  pageCount: number;
  kind: "pdf" | "native";
  theme: DeckTheme;
  /** The agenda item this deck is presented under, or null when it stands on its own. */
  parentItemId: string | null;
}

/** What the editor saves: the whole deck, in order. */
export interface DeckDraft {
  title: string;
  theme: DeckTheme;
  slides: Array<{ id: string; title: string } & SlideContent>;
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
  /** Action items only: when someone checked it off, and who. */
  doneAt: number | null;
  doneBy: string | null;
}

/** An action item from an earlier meeting in the room, tracked until someone
 *  checks it off. It stays linked to the task, ticket or slide it came from. */
export interface FollowUp extends Note {
  meetingStartedAt: number;
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
  decks: Deck[];
  /** Action items from earlier meetings that are still open, plus any checked
   *  off during this meeting (so they can be unchecked). */
  followUps: FollowUp[];
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
  | { type: "followup.done"; noteId: string; done: boolean }
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
  deck: Deck | null;
  meetings: Array<{
    meetingId: string;
    startedAt: number;
    endedAt: number | null;
    participants: string[];
    segments: Segment[];
    notes: Note[];
  }>;
}

export interface DeckHistory {
  deck: Deck;
  room: { id: string; name: string } | null;
  slides: Array<{ item: Item; segments: Segment[]; notes: Note[] }>;
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
