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
  /** Decisions: the words it was settled in, as said (see Quote). */
  quote?: Quote | null;
  // Task fields (shared/tasks.ts), named as in Conxt's work loop so the store can move there later.
  /** Set when someone or something moved it; null means it follows doneAt (open or done). */
  state?: TaskState | null;
  /** What finishing it looks like, in a line. */
  doneWhen?: string | null;
  /** A spec's id, for a task that is part of one. */
  parentId?: string | null;
  /** What closed it: "pr:<url>" for a merged PR, "agent" for an agent's report, "confirmed" for a
   *  person's click with nothing to show, "moved" for a to-do carried to another space. */
  closedBy?: string | null;
  /** Dropped: why, in a line. */
  dropReason?: string | null;
  /** Someone said it was finished, with no evidence yet: their words and when. */
  saidDone?: Quote | null;
  /** When someone last said "Still on it" for it in a meeting's check-in. */
  checkedAt?: number | null;
}

/** Huy's verbs: a to-do is Do, a decision Decide, an open question Answer. */
export type TaskVerb = "do" | "decide" | "answer";
/** Four plain states. Everything else (suggested, waiting on you, said done) is a mark on the task. */
export type TaskState = "open" | "doing" | "done" | "dropped";

/** A line on the board's running list (server/liveList.ts), in the shape of a note so the board's
 *  tabs read either. Lines are only added, changed by id or closed, never regrouped. */
export interface ListNote extends Note {
  /** An open question that got answered, or a line that was dropped: it leaves the board. */
  closed: { how: "answered" | "dropped" | "wrong"; at: number } | null;
  /** A decision that settled an open question: that question's id. */
  answers: string | null;
}

/** Someone's own words behind a line the agent wrote, copied from the transcript and checked
 *  against it, so a reader can see what was actually said and not only how the agent put it. */
export interface Quote {
  segmentId: string;
  ts: number;
  speaker: string;
  text: string;
}

export type DiscussionOutcome = "decided" | "action" | "open" | "info";

/** Where one person stood in a discussion, in a line, with their own words behind it when the
 *  meeting-end run found them (older meetings have none). */
export interface Position {
  speaker: string;
  position: string;
  quote?: Quote | null;
}

/** A stretch of back-and-forth about one question, within one agenda item.
 *  It records who argued what and how it ended; its decisions, action items
 *  and open questions are the notes that point at it. */
export interface Discussion {
  id: string;
  meetingId: string;
  itemId: string | null;
  topic: string;
  /** Each participant's position, in a line, in the order they spoke. */
  positions: Position[];
  outcome: DiscussionOutcome;
  /** The speaker turns it covers, in order. */
  segmentIds: string[];
  /** The discussion of the same question in an earlier meeting, if it continues one. */
  continues: { id: string; meetingId: string; startedAt: number; topic: string } | null;
  /** A smaller topic folded into a main topic of the same item: that topic's id. */
  mergedInto?: string | null;
  /** A smaller topic gathered with others into a small group: the group's title. */
  group?: string | null;
  ts: number;
}

/** A still of the shared screen, pinned to the item in focus when it was taken.
 *  People take them (the camera on the shared screen, or S); the agent keeps
 *  one (source "agent") only when the frame backs a decision or to-do it wrote. */
export interface Snap {
  id: string;
  /** Null for a snap saved straight to the space between meetings. */
  meetingId: string | null;
  itemId: string | null;
  /** The agent picked the item and nobody has confirmed it yet (shown with ✦). */
  itemSuggested: boolean;
  ts: number;
  /** The image, at the size it was shared (cropped if someone cropped it). */
  url: string;
  width: number;
  height: number;
  source: "person" | "agent";
  takenById: string | null;
  takenBy: string;
  /** Whose screen it is. */
  sharerId: string | null;
  sharerName: string | null;
  /** The agent's one line on what's on screen; null until it has looked. */
  caption: string | null;
  /** The line the person typed with it, if any. */
  line: string | null;
  /** The text in the image, read on the Mac that took it; null until read, or when it wasn't. */
  screenText: string | null;
  /** The note it was pinned to on the Mac's bar: it shows with that note, and takes its item. */
  jotId?: string | null;
  /** The to-do, decision or open question it backs: the agent's own snaps when
   *  kept, and any snap once the end-of-meeting recap has looked at it. */
  noteId: string | null;
  /** The topic it was discussed in: the recap's pick, or else the topic of the remarks around it. */
  discussionId: string | null;
  /** The remarks spoken around it. */
  segmentIds: string[];
}

/** What an agent (or person) reported back on an item through the Stand MCP:
 *  progress, a blocker, a question for the next meeting, or a to-do checked off. */
/** "working": an agent says it has started on a to-do; it shows as working until it reports again or goes quiet.
 *  "ready": the work is finished and waits to ship, usually as a PR; Stand checks the to-do off when the PR merges. */
/** "added": the details someone gave with a to-do they added by hand; "note": more about a to-do, not progress (MCP update_action). */
export type UpdateStatus = "working" | "progress" | "blocked" | "needs_decision" | "ready" | "done" | "added" | "note";
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

/** A screenshot an agent attached to a to-do's work log. */
export interface WorkShot {
  id: string;
  noteId: string;
  /** The update it was attached with; null until the agent posts one. */
  updateId: string | null;
  userName: string;
  client: string | null;
  caption: string | null;
  ext: string;
  ts: number;
}

/** What agents have done on one to-do: whether one is on it now, and the log of its reports. */
export interface ActionWork {
  /** Set while an agent is on it: who, since when, and what it said last. Clears when it reports
   *  done or stuck, or after a while with no word. */
  working: { by: string; since: number; text: string } | null;
  /** Set while the finished work waits to ship: who said so, when, and the PR Stand watches (null
   *  when the agent gave no GitHub PR link, so it can't be checked off on its own). */
  ready: { by: string; since: number; text: string; pr: string | null } | null;
  /** Reports on it, newest first, with the screenshots that came with each. */
  log: Array<{
    id: string;
    by: string;
    status: UpdateStatus | "shots";
    text: string;
    links: string[];
    shots: Array<{ url: string; caption: string | null }>;
    ts: number;
  }>;
}

/** A GitHub account (person or organization) where someone installed the Stand GitHub App. */
export interface GithubInstallation {
  id: number;
  account: string;
  accountType: "User" | "Organization";
  /** Every repo of the account, or the ones picked on GitHub. */
  repos: "all" | "selected";
  connectedBy: string | null;
  connectedAt: number;
  /** GitHub's page for changing the repos or uninstalling. */
  manageUrl: string;
}

/** The Stand GitHub App, as the Connect an agent page shows it. */
export interface GithubStatus {
  /** Whether this server has the app set up at all. */
  available: boolean;
  installations: GithubInstallation[];
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
  /** Space page only: the meeting and chapter it came out of. */
  from?: NoteFrom;
}

/** Where a to-do, decision or question came from, for a page that shows several meetings at
 *  once: the meeting, and the chapter of it the recap files it under. */
export interface NoteFrom {
  meetingId: string;
  /** When the meeting started. */
  startedAt: number;
  chapter: {
    /** Its place in the recap's chapter list, for the link (chapterAnchor). */
    i: number;
    title: string;
    /** When talk turned to it. */
    at: number;
    minutes: number;
    outcome: DiscussionOutcome;
    /** The recap's ✦ line about it, when it has one. */
    crux: string | null;
  } | null;
  /** Not from a meeting: someone added it by hand (an agent, through the MCP), and who. startedAt is when. */
  addedBy?: string;
}

/** One thing the agent proposes for the agenda, with why. Nothing joins the
 *  agenda until someone adds it. */
export interface UpNextSuggestion {
  /** "note:<id>", "item:<id>", "space:<id>" (open to-dos in another space) or "snap:<id>" (saved
   *  to the space since the last meeting); what add and dismiss refer to. */
  key: string;
  kind: "needs_people" | "question" | "capture" | "todo";
  title: string;
  /** One line shown on hover, e.g. "Open question from Thu 9 Oct". */
  reason: string;
  noteId: string | null;
  /** The agenda item it came from, if any. */
  itemId: string | null;
  owner: string | null;
  /** How many meetings it has carried over so far. */
  carried: number;
  /** Other suggestions the agent folded into this one as the same thing; adding this adds them too. */
  merged: string[];
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
  /** When Claude last merged, reworded and ordered the list; null when it's the plain ranking. */
  polishedAt: number | null;
  /** Claude is reworking the list right now (the ✦ pulses). */
  polishing: boolean;
}

export interface Participant {
  id: string;
  name: string;
  picture: string | null;
  /** The host drives the meeting: whatever item they open is what's being discussed. */
  isHost: boolean;
  isSharing: boolean;
  /** Browser transcription can't hear this person (blocked, or a browser without it). */
  notRecording?: boolean;
}

export interface Suggestion {
  itemId: string;
  /** Why the agent thinks so, e.g. "ENG-142 is visible in the window title". */
  reason: string;
  confidence: number;
  /** When the screen changed (or the talk turned to the item); confirming re-pins speech from this moment. */
  since: number;
  /** What the agent noticed: the shared screen, or the talk naming another item. */
  source?: "screen" | "talk";
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

/** "Done since last time" (server/doneDeck.ts): what a space closed since its last meeting, as pages
 *  Claude writes and rewrites each time a task closes, so the next meeting opens on it with no wait. */
export interface DoneDeck {
  /** The meeting it counts from: when it started and ended. */
  sinceMeetingId: string;
  sinceStartedAt: number;
  since: number;
  /** "claude" when Claude laid it out, "plain" when it's the tasks as they are (no model). */
  by: "claude" | "plain";
  at: number;
  /** One or two sentences on what changed since, for the top of the card; null on the plain one. */
  summary: string | null;
  /** Tasks it covers that closed, and how many of them were dropped. */
  closed: number;
  dropped: number;
  slides: DoneSlide[];
}
export interface DoneSlide {
  title: string;
  /** One sentence under the title, when it helps. */
  lead: string | null;
  points: Array<{ text: string; who: string | null; pr: string | null; dropped: boolean }>;
  /** A screenshot an agent attached to one of its tasks. */
  shot: { url: string; caption: string | null; by?: string; ts?: number } | null;
}

export interface RoomState {
  /** This meeting's snaps. */
  snaps: Snap[];
  /** The snap on everyone's middle screen: the latest one someone took of the item in
   *  focus, until the host or whoever took it takes it down, or the meeting moves on. */
  stageSnapId: string | null;
  roomId: string;
  roomName: string;
  meetingId: string;
  meetingStartedAt: number;
  participants: Participant[];
  focusItemId: string | null;
  /** When pinned, the agent stops suggesting until someone unpins. */
  pinnedBy: string | null;
  /** The host's name while their connection is down and they can still come back as host. */
  hostAway?: string | null;
  /** How long until the seat held for that host goes to someone else, as of sending.
   *  A duration, so a viewer's clock being off doesn't matter. */
  hostAwayMs?: number | null;
  /** Items whose notes the agent couldn't write on its last try (null: General). */
  notesFailing?: Array<string | null>;
  /** Why, when it's the account and not one run: its rate limit, or its credit ran out. */
  notesTrouble?: "busy" | "credit" | null;
  /** The server's transcriber stopped: talk isn't being recorded until someone rejoins. */
  transcriptionDown?: boolean;
  /** While down: Stand is about to start it again by itself. */
  transcriptionRestarting?: boolean;
  suggestion: Suggestion | null;
  items: Item[];
  decks: Deck[];
  /** Action items from earlier meetings that are still open, oldest first, plus any closed since
   *  the meeting before this one ended (so the check-in shows them and they can be reopened). */
  followUps: FollowUp[];
  /** The opening board ("Done since" pages, then the "Since last time" check-in): whether someone moved on
   *  from it, when anyone last answered or turned a page on it, and the page everyone is on. */
  checkIn?: { closed: boolean; answeredAt: number | null; page?: number; closedAt?: number | null; held?: boolean };
  /** What the space finished since its last meeting, laid out ahead of time as pages to open this one with. */
  doneDeck?: DoneDeck | null;
  /** Updates agents and people reported on this space's items since the last meeting started. */
  updates: ItemUpdate[];
  /** The agent's suggested agenda for this space. */
  upNext: UpNext;
  /** Agenda item id -> how many meetings its open to-dos have carried over. */
  carried: Record<string, number>;
  capabilities: Capabilities;
  /** The host pressed End meeting and the recap is being written. */
  ending?: boolean;
  /** From the connected Conxt project: what to raise while these people are here. */
  conxt?: ConxtLive[];
}

/** A Conxt item on the live panel. A confirmation shows while someone it waits on
 *  is in the meeting, and only they can confirm it; a divergence shows once its
 *  word is said again. */
export interface ConxtLive {
  /** exploring: someone here has agent work held in Conxt, theirs to share.
   *  came_back: their explore work came back with things to review. */
  kind: "confirmation" | "divergence" | "exploring" | "came_back";
  id: string;
  title: string;
  why: string;
  /** For a confirmation, the people it waits on who are here now; for explore
   *  work, its person, when they are here. */
  here: Array<{ participantId: string; name: string }>;
  term: string | null;
}

/** What a client asks of the room. Messages that change something carry a
 *  `cid`: the server acks it, the client sends it again after a dropped
 *  connection until it does, and the server ignores a cid it has seen. */
export type ClientMessage = (
  /** `meetingId`: the meeting this client was last in, when it reconnects. */
  | { type: "hello"; meetingId?: string }
  /** Is the connection still alive? The server answers "pong". */
  | { type: "ping" }
  | { type: "focus"; itemId: string | null }
  | { type: "pin"; itemId: string }
  | { type: "unpin" }
  /** `itemId`: the suggestion the host saw, so a newer one isn't accepted by mistake. */
  | { type: "suggestion.accept"; itemId?: string }
  /** Host: put an agent suggestion on the agenda, all of them, or wave one off. */
  | { type: "upnext.add"; key: string }
  | { type: "upnext.addAll" }
  | { type: "upnext.dismiss"; key: string }
  /** Host: Undo for a dismissed suggestion or a deleted note, within a minute. */
  | { type: "upnext.undismiss"; key: string }
  /** The signed-in person confirms a Conxt decision that waits on them. */
  | { type: "conxt.confirm"; itemId: string }
  /** The signed-in person shares their explore work in Conxt with the team. */
  | { type: "conxt.share"; itemId: string }
  | { type: "note.restore"; noteId: string }
  | { type: "suggestion.dismiss" }
  /** Anyone on the call: make the move the board is waiting to confirm, now. `title`: the one they saw. */
  | { type: "board.accept"; title: string }
  /** Take the host role when nobody holds it, or (as host) hand it to someone. */
  | { type: "host.give"; participantId: string }
  | { type: "sharing"; on: boolean }
  /** Browser transcription: whether this person's words are being picked up. */
  | { type: "recording"; on: boolean }
  /** Try the notes for an item again now, after the agent failed. */
  | { type: "notes.retry"; itemId: string | null }
  /** Take back the last "Switch and move": the focus and the remarks go back, with what was said since. */
  | { type: "suggestion.undo" }
  | { type: "chat"; text: string }
  /** Browser transcription: a finished utterance from this participant's mic. */
  | { type: "speech"; text: string; startedAt: number }
  | { type: "speech.interim"; text: string }
  /** A JPEG data URL of the shared screen, sent by the host when it changes. */
  | { type: "frame"; dataUrl: string }
  | { type: "segment.move"; segmentId: string; itemId: string | null }
  | { type: "followup.done"; noteId: string; done: boolean }
  /** Anyone: move a task from the check-in or the board. still: "Still on it" (open, and answered for this meeting). */
  | { type: "task.state"; noteId: string; state: "done" | "dropped" | "open"; still?: boolean; reason?: string }
  /** Anyone: Stand heard "done" wrong; the task loses its Said done mark. */
  | { type: "task.saidDone.undo"; noteId: string }
  /** Anyone: move on from the "Since last time" check-in (open: false), or bring it back. */
  | { type: "checkin"; open: boolean; page?: number }
  /** Anyone: turn the opening board to a page, for everyone. */
  | { type: "checkin.page"; page: number }
  // Host only: fix what the agent wrote down for the item in focus.
  | { type: "note.edit"; noteId: string; text: string; owner?: string | null }
  | { type: "note.remove"; noteId: string }
  | { type: "note.add"; itemId: string | null; kind: "action" | "decision" | "question"; text: string; owner?: string | null }
  | { type: "demo.play" }
  /** The host, or whoever took it: take the snap off everyone's middle screen. It stays on the item. */
  | { type: "stage.snap.close" }
  | { type: "meeting.end" }
) & { cid?: string };

/** One line under a board card's summary. Its id stays the same while the card is updated, so
 *  each line keeps its place and the screen can tell a new line from a reworded one. */
export interface BoardDetail {
  id: string;
  kind: "position" | "decided" | "todo" | "open";
  /** The person, for a position or a to-do's owner. */
  who: string | null;
  text: string;
}
/** What the middle shows about a thread: a short paragraph, the point being made now, and the
 *  details in fixed sections (each person's position, then decided, to do, open). */
export interface BoardCard {
  /** The paragraph, one sentence per entry. Updates replace or add single sentences. */
  summary: string[];
  /** The point being made in the newest talk, "Name: point". */
  now: string;
  details: BoardDetail[];
}
/** A thread of discussion on the middle board (server/board.ts). Its title is set once. */
export interface BoardThread {
  id: string;
  title: string;
  itemId: string | null;
  card: BoardCard;
  /** Stretches of the meeting it was the thread on screen, for the chapter bar. */
  spans: Array<[number, number]>;
}
export interface Board {
  threads: BoardThread[];
  currentId: string | null;
  /** When the thread on screen last became current (a switch, not an update). */
  switchedAt: number | null;
  /** The board pass is reading the latest talk. */
  busy: boolean;
  /** A move the board thinks the talk has made but waits one more pass to confirm. */
  pending: { kind: "new" | "return"; title: string } | null;
}

export type ServerMessage =
  | { type: "state"; state: RoomState }
  | { type: "welcome"; participantId: string; segments: Segment[]; notes: Note[]; discussions: Discussion[] }
  | { type: "segment"; segment: Segment }
  | { type: "segment.updated"; segment: Segment }
  | { type: "interim"; speakerId: string; speakerName: string; text: string }
  | { type: "notes"; meetingId: string; itemId: string | null; notes: Note[]; discussions: Discussion[] }
  /** The agent started or finished rewriting an item's notes. */
  | { type: "notes.busy"; itemId: string | null; busy: boolean }
  /** The middle board's threads, after every change. */
  | { type: "board"; board: Board }
  /** The board's running list, after every change. Null when there's no model to keep one: the tabs read the live notes. */
  | { type: "list"; items: ListNote[] | null }
  | { type: "meeting.ended"; meetingId: string }
  /** The server has a message the client sent with this cid. */
  | { type: "ack"; cid: string }
  | { type: "pong" }
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
  /** The space's synthesis instructions applied to this meeting, as Markdown; null when it had none. */
  synthesis: string | null;
  items: Array<{ item: Item | null; segments: Segment[]; notes: Note[]; discussions: Discussion[]; snaps: Snap[] }>;
  /** What the recap wrote about each chapter (shared/chapters.ts), by chapter key; empty for meetings recapped before chapters. */
  chapters: ChapterRecap[];
}

/** The recap's words on one chapter: where it landed, and for a long one, the moments that moved it. */
export interface ChapterRecap {
  key: string;
  /** One sentence: where the chapter landed. */
  crux: string;
  /** Turning points, in order: the remark each one starts at, and a line on it. */
  moments: Array<{ segmentId: string; ts: number; text: string }>;
}

/** Synthesis instructions are a paragraph or a short list, not a document. */
export const MAX_SYNTHESIS_INSTRUCTIONS = 2000;

/** One space (a room) as the home page lists it. */
/** The space page's feed: what came into the space, newest first, and where it stands. */
/** A note someone saved straight to the space between meetings, typed or dictated on the
 *  Mac's bar. Like a snap, the agent suggests its item (✦) when nobody picked one. */
export interface Jot {
  id: string;
  roomId: string;
  itemId: string | null;
  itemSuggested: boolean;
  text: string;
  byId: string | null;
  by: string;
  ts: number;
  /** The snaps pinned to it on the bar, oldest first (in the feed). */
  snaps?: Snap[];
}

/** What a row archived off the space page was. */
export type ArchivedKind = "meeting" | "snap" | "jot" | "todo" | "decision" | "question" | "item" | "deck" | "suggestion";
export interface ArchivedRow {
  /** "<kind>:<id>"; a suggestion's id is its key. */
  ref: string;
  kind: ArchivedKind;
  title: string;
  /** When the thing itself happened (a meeting's end, a note's time); when it was archived for agenda rows. */
  ts: number;
  /** When it was archived, and by whom. */
  at: number;
  by: string;
}

export interface SpaceFeed {
  /** Rows archived off the space page, newest first. The page hides them and lists them under Archived. */
  archived: ArchivedRow[];
  /** What the space got done since its last meeting, as the next meeting will open on it. */
  doneDeck?: DoneDeck | null;
  /** Snaps saved straight to the space, newest first. */
  captures: Snap[];
  /** Notes saved straight to the space, newest first. */
  jots: Jot[];
  /** Meetings that ended, newest first, each as one row. */
  meetings: Array<{
    id: string;
    startedAt: number;
    endedAt: number;
    summary: string | null;
    todos: number;
    decided: number;
    open: number;
  }>;
  /** What agents and people reported through the MCP, newest first. */
  updates: ItemUpdate[];
  /** Decisions from the space's meetings, newest first, the ones a later decision replaced last. */
  decided: Array<Note & { from?: NoteFrom; replacedBy?: { text: string; meetingId: string; startedAt: number } }>;
  /** Open questions from all its meetings that no later decision answered, newest first. */
  open: Array<Note & { from?: NoteFrom }>;
  /** Questions someone answered or dropped by hand, or a later decision answered (answeredBy), newest first. */
  closedQuestions?: Array<Note & { from?: NoteFrom; answeredBy?: string }>;
}

export interface SpaceSummary {
  id: string;
  name: string;
  purpose: string;
  /** What the space asks the agent to pull out of every meeting, besides the default notes. */
  synthesisInstructions: string;
  /** You created it, so it shows on Manage spaces. */
  mine: boolean;
  /** You have been in it (room_members). */
  following: boolean;
  /** Latest thing that happened in it: created, a meeting, someone entering. */
  activeAt: number;
  live: { people: Array<{ name: string; picture: string | null }>; focusTitle: string | null; since: number; you: boolean } | null;
  /** Open questions from its latest meeting with notes. */
  toDecide: number;
  /** Open to-dos from its meetings. */
  todos: number;
  /** Open to-dos owned by you. */
  forYou: number;
  /** Your to-dos with work in (a PR reported ready) that wait on your look. */
  waiting?: number;
  /** The latest decision or open question, for the card's last line. */
  last: { kind: "decision" | "question" | "action"; text: string; ts: number } | null;
  /** People who have been in it. */
  people: string[];
  /** Lower-cased text to search: purpose, decisions, to-dos, questions, people. */
  search: string;
}
