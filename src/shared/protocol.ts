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
  /** The discussion this came out of, when the agent grouped the talk into discussions. */
  discussionId: string | null;
  /** Who in the meeting last edited or added this by hand. The agent keeps edited notes as written. */
  editedBy?: string | null;
}

export type DiscussionOutcome = "decided" | "action" | "open" | "info";

/** A stretch of back-and-forth about one question, within one agenda item.
 *  It records who argued what and how it ended; its decisions, action items
 *  and open questions are the notes that point at it. */
export interface Discussion {
  id: string;
  meetingId: string;
  itemId: string | null;
  topic: string;
  /** Each participant's position, in a line, in the order they spoke. */
  positions: Array<{ speaker: string; position: string }>;
  outcome: DiscussionOutcome;
  /** The speaker turns it covers, in order. */
  segmentIds: string[];
  /** The discussion of the same question in an earlier meeting, if it continues one. */
  continues: { id: string; meetingId: string; startedAt: number; topic: string } | null;
  ts: number;
}

/** What an agent (or person) reported back on an item through the Stand MCP:
 *  progress, a blocker, a question for the next meeting, or a to-do checked off. */
export type UpdateStatus = "progress" | "blocked" | "needs_decision" | "done";
export interface ItemUpdate {
  id: string;
  roomId: string;
  itemId: string | null;
  /** The to-do it reports on, when it reports on one. */
  noteId: string | null;
  noteText: string | null;
  userName: string;
  /** The agent token's label, e.g. "Claude Code on Joe's Mac"; null when a person posted it. */
  client: string | null;
  status: UpdateStatus;
  text: string;
  links: string[];
  ts: number;
}

/** A personal access token an agent uses to reach the Stand MCP. The secret is only shown once. */
export interface AgentToken {
  id: string;
  label: string;
  scope: "read" | "write";
  /** The first characters of the token, so people can tell tokens apart. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** An action item from an earlier meeting in the room, tracked until someone
 *  checks it off. It stays linked to the task, ticket or slide it came from. */
export interface FollowUp extends Note {
  meetingStartedAt: number;
}

/** One thing the agent proposes for the agenda, with why. Nothing joins the
 *  agenda until someone adds it. */
export interface UpNextSuggestion {
  /** "note:<id>" or "item:<id>"; what add and dismiss refer to. */
  key: string;
  kind: "needs_people" | "question" | "todo";
  title: string;
  /** One line shown on hover, e.g. "Open question from Thu 9 Oct". */
  reason: string;
  noteId: string | null;
  /** The agenda item it came from, if any. */
  itemId: string | null;
  owner: string | null;
  /** How many meetings it has carried over so far. */
  carried: number;
}

/** The space's next agenda as the agent drafts it, plus how much got closed since last time. */
export interface UpNext {
  suggestions: UpNextSuggestion[];
  /** To-dos quiet for two meetings: folded away, still addable. */
  parked: UpNextSuggestion[];
  /** To-dos from earlier meetings: closed since the last meeting started, out of all open then. */
  closed: number;
  total: number;
  /** When the last meeting started; null when there wasn't one. */
  since: number | null;
  /** What the draft was built from, for the provenance tooltip. */
  meetingsUsed: number;
  updatesUsed: number;
  builtAt: number;
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
  /** Updates agents and people reported on this space's items since the last meeting started. */
  updates: ItemUpdate[];
  /** The agent's suggested agenda for this space. */
  upNext: UpNext;
  /** Agenda item id -> how many meetings its open to-dos have carried over. */
  carried: Record<string, number>;
  capabilities: Capabilities;
}

export type ClientMessage =
  | { type: "hello" }
  | { type: "focus"; itemId: string | null }
  | { type: "pin"; itemId: string }
  | { type: "unpin" }
  | { type: "suggestion.accept" }
  /** Host: put an agent suggestion on the agenda, all of them, or wave one off. */
  | { type: "upnext.add"; key: string }
  | { type: "upnext.addAll" }
  | { type: "upnext.dismiss"; key: string }
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
  // Host only: fix what the agent wrote down for the item in focus.
  | { type: "note.edit"; noteId: string; text: string; owner?: string | null }
  | { type: "note.remove"; noteId: string }
  | { type: "note.add"; itemId: string | null; kind: "action" | "decision" | "question"; text: string; owner?: string | null }
  | { type: "demo.play" }
  | { type: "meeting.end" };

export type ServerMessage =
  | { type: "state"; state: RoomState }
  | { type: "welcome"; participantId: string; segments: Segment[]; notes: Note[]; discussions: Discussion[] }
  | { type: "segment"; segment: Segment }
  | { type: "segment.updated"; segment: Segment }
  | { type: "interim"; speakerId: string; speakerName: string; text: string }
  | { type: "notes"; meetingId: string; itemId: string | null; notes: Note[]; discussions: Discussion[] }
  /** The agent started or finished rewriting an item's notes. */
  | { type: "notes.busy"; itemId: string | null; busy: boolean }
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
    discussions: Discussion[];
  }>;
}

export interface DeckHistory {
  deck: Deck;
  room: { id: string; name: string } | null;
  slides: Array<{ item: Item; segments: Segment[]; notes: Note[]; discussions: Discussion[] }>;
}

export interface MeetingRecap {
  meetingId: string;
  roomId: string;
  roomName: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  items: Array<{ item: Item | null; segments: Segment[]; notes: Note[]; discussions: Discussion[] }>;
}

/** One space (a room) as the home page lists it. */
export interface SpaceSummary {
  id: string;
  name: string;
  purpose: string;
  /** You created it, so it shows on Manage spaces. */
  mine: boolean;
  /** You have been in it (room_members). */
  following: boolean;
  /** Latest thing that happened in it: created, a meeting, someone entering. */
  activeAt: number;
  live: { people: Array<{ name: string; picture: string | null }>; focusTitle: string | null; since: number } | null;
  /** Open questions from its latest meeting with notes. */
  toDecide: number;
  /** Open to-dos from its meetings. */
  todos: number;
  /** Open to-dos owned by you. */
  forYou: number;
  /** The latest decision or open question, for the card's last line. */
  last: { kind: "decision" | "question" | "action"; text: string; ts: number } | null;
  /** People who have been in it. */
  people: string[];
  /** Lower-cased text to search: purpose, decisions, to-dos, questions, people. */
  search: string;
}
