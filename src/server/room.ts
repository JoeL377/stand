// One live meeting in a room: who is here, which item is in focus, and the
// agent's pinning of speech and chat to that item.

import fs from "node:fs";
import type { WebSocket } from "ws";
import type {
  User,
  NextStep,
  BrainCaught,
  AgentCard,
  AgentDraft,
  ChapterRecap,
  ClientMessage,
  DoneDeck,
  Discussion,
  HostView,
  Item,
  Note,
  Participant,
  RoomState,
  Segment,
  ServerMessage,
  Suggestion,
} from "../shared/protocol.ts";
import { BOARD_EVERY_MS, BoardKeeper } from "./board.ts";
import { LIST_DEBOUNCE_MS, LIST_MAX_WAIT_MS, type ListItem, ListKeeper } from "./liveList.ts";
import { MAP_DEBOUNCE_MS, MAP_MAX_WAIT_MS, MapKeeper, catchUp, finishBrainstorm, othersOfMeeting, parkBrainstorm, promptOf, resumeBrainstorm, toBrainstormView } from "./brainstorm.ts";
import { DiagramKeeper, sessionBackground, saveDraftSpec } from "./designSession.ts";
import { PilotSeat } from "./pilot.ts";
import { sourceDigest, repoTools } from "./sources.ts";
import { AgentKeeper, answerPrompt, ASK_MAX_MS, ASK_SETTLE_MS, AskCapture, costOf, draftOf, optionsPrompt, type SpaceHistory, toAnswer, toCard, typedAsk } from "./meetingAgent.ts";
import { capabilities, config } from "./config.ts";
import type { DB, DraftDiscussion, OpenMeeting } from "./db.ts";
import { type Agent, type ItemNotesDraft, NotesTrouble, type OnDraft, type RecapChapter, type RecapInput, type SettledTopic, type SnapMedia } from "./llm.ts";
import { meetingChapters } from "../shared/chapters.ts";
import { currentDoneDeck } from "./doneDeck.ts";
import { sampleSprint } from "./linear.ts";
import type { StageView } from "../shared/timeline.ts";
import { runDemo } from "./demo.ts";
import { capturedFor, mergeNotes, similar } from "./notesMerge.ts";
import { LOCK_AFTER_MS, LOCK_MIN_LINES, settle } from "./settle.ts";
import { applyMerges, mergePrompt, planMerge, stickyMerges, type TopicMerge } from "./topicMerge.ts";
import { newId } from "./ids.ts";
import { NEXT_QUIET_MS, NEXT_SHOWN_MS, SOUNDS_QUIET_MS, SOUNDS_WINDOW_MS, heardIntent, isReviewKind, soundsLike, type Said } from "./nextSteps.ts";
import { finishIdeaReview } from "./ideaReview.ts";
import { finishReview, isReviewDeck, refileReview, reviewView, setOutcome } from "./reviews.ts";
import { DesignReviewError, authorMay, designReviewSummary, finishDesignReview, setDesignOutcome, startDesignReview, whenBriefed, writeBackReview } from "./designReviews.ts";
import type { PlanBriefs } from "./planBrief.ts";
import { linkSnaps, saveSnapFile, snapFile } from "./snaps.ts";
import { addUpNext } from "./upNext.ts";
import { metered } from "./usage.ts";
import { type UpNextPolisher, upNextView } from "./upNextPolish.ts";
import { PassRunner } from "./passRunner.ts";

/** Below this the agent keeps its guess to itself. */
const SUGGEST_MIN_CONFIDENCE = 0.55;
/** The cost shown on the call is sent again at most this often. */
const COST_EVERY_MS = 5_000;
/** ✦ Stand's card as it streams goes out to everyone at most this often. */
const DRAFT_EVERY_MS = 150;
/** A dismissed item isn't suggested again for this long. */
const DISMISS_QUIET_MS = 90_000;
/** Minimum gap between screen reads, to bound vision cost. */
const FRAME_MIN_INTERVAL_MS = 4_000;
/** The agent keeps a frame next to a note only if it saw it this recently. */
const FRAME_BACKS_MS = 180_000;
/** The recap sees at most this many snaps, and this many bytes of them, so the request stays within the API's limits. */
const RECAP_MAX_SNAPS = 20;
/** A chapter this long gets moments in the recap, read from its remarks. */
const MOMENTS_MIN_MINUTES = 10;
/** Remarks the recap reads across all long chapters: about two hours of talk. */
const RECAP_MAX_LINES = 2500;
const RECAP_MAX_BYTES = 18 * 1024 * 1024;
/** Notes for the item in focus refresh this long after the last new remark. */
const NOTES_DEBOUNCE_MS = 3_000;
/** The first board pass waits for a little talk; later ones come every BOARD_EVERY_MS. */
const BOARD_FIRST_MS = 8_000;
/** After the host moves to another agenda item, the board starts a thread there this soon. */
const BOARD_AFTER_FOCUS_MS = 10_000;
/** What people are told when notes stop, by why. */
const NOTES_TROUBLE = {
  busy: "Notes are behind: the model's rate limit was hit. They catch up by themselves, and everything said is kept.",
  credit: "Notes stopped: the Anthropic account Stand uses is out of credit. Top it up, then press Try again in the notes. Everything said is kept.",
  other: "The agent couldn't write notes just now. It tries again after the next pause, and everything said is kept.",
};
/** While talk keeps going, refresh notes at least this often instead of waiting for a pause. */
const NOTES_MAX_WAIT_MS = 12_000;
/** The smaller topics are placed again at most this often (see topicMerge.ts). */
const MERGE_EVERY_MS = 120_000;
/** A speaker's next words join their last entry when they pause for less than this. */
const SPEECH_JOIN_GAP_MS = 2_000;
/** ...as long as the entry stays a readable size. */
const SPEECH_MAX_ENTRY_MS = 60_000;
const SPEECH_MAX_ENTRY_CHARS = 700;
/** How long an empty room waits before the meeting is closed. */
const EMPTY_ROOM_GRACE_MS = 120_000;
/** A host whose connection drops keeps the seat this long, so a blip or a
 *  server restart doesn't hand the meeting to someone else. */
const HOST_AWAY_GRACE_MS = 30_000;
/** After transcription stops, Stand starts it again by itself this much later, once per gap. */
const TRANSCRIBER_RETRY_MS = 10_000;
const TRANSCRIBER_RETRY_GAP_MS = 5 * 60_000;
/** How many message ids (cids) the room remembers, to ignore ones sent again after a reconnect. */
const HANDLED_CIDS = 2_000;
/** How long a deleted note or a dismissed suggestion can still be brought back with Undo. */
const UNDO_KEEP_MS = 60_000;
/** Talk that keeps naming another agenda item adds up to this before the host is nudged to switch. */
const DRIFT_NUDGE_SCORE = 3;

interface Conn {
  participantId: string;
  name: string;
}

export interface SpeechSink {
  addSpeech(speakerId: string, speakerName: string, text: string, startedAt: number): void;
  interim(speakerId: string, speakerName: string, text: string): void;
  nameOf(participantId: string): string | undefined;
  /** The transcriber couldn't start; tell the room instead of failing silently. */
  transcriptionFailed(reason: string): void;
}

export interface Transcriber {
  stop(): Promise<void>;
}

/** Text people typed, trimmed and capped. */
const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export class RoomSession implements SpeechSink {
  readonly roomId: string;
  roomName: string;
  /** The room's creator hosts whenever they're in the room. */
  private readonly createdBy: string | null;
  readonly meetingId: string;
  readonly meetingStartedAt: number;

  private conns = new Map<WebSocket, Conn | null>();
  private pendingUser = new Map<WebSocket, User>();
  private participants = new Map<string, Participant & { conns: number }>();
  private hostId: string | null = null;
  /** Who held the host seat before someone started an experience and took it for its length. */
  private lentFrom: string | null = null;
  private focusItemId: string | null = null;
  /** See RoomState.stageSnapId. */
  private stageSnapId: string | null = null;
  private pinnedBy: string | null = null;
  /** See RoomState.hostView. */
  private hostView: HostView | null = null;
  /** Where the meeting was when the host began presenting a to-do: "Stop presenting" goes back there. */
  private beforeTask: string | null = null;
  private suggestion: Suggestion | null = null;
  /** (ts, item) pairs, so late-arriving transcripts land on the item that was
   *  in focus when the words were spoken. */
  private focusLog: Array<{ ts: number; itemId: string | null }> = [];
  private dismissed = new Map<string, number>();
  private noteTimers = new Map<string | null, NodeJS.Timeout>();
  /** When the oldest change not yet in an item's notes arrived. */
  private notePendingSince = new Map<string | null, number>();
  /** The entry new speech from the same speaker can join (see addSpeech). */
  private lastSpeech: {
    segmentId: string;
    speakerId: string;
    itemId: string | null;
    startedAt: number;
    endedAt: number;
    length: number;
  } | null = null;
  private noteRuns = new Map<string | null, Promise<void>>();
  /** A run waiting behind the current one. It reads the transcript when it
   *  starts, so later requests just join it instead of queueing more runs. */
  private noteQueued = new Map<string | null, Promise<Note[]>>();
  private frame: { dataUrl: string; at: number } | null = null;
  private frameBusy = false;
  /** The last screen the agent was shown, for keeping next to what it writes. */
  private seen: { dataUrl: string; at: number; itemId: string | null } | null = null;
  private seenUsed: number | null = null;
  private lastFrameRead = 0;
  private emptyTimer: NodeJS.Timeout | null = null;
  private hostAwayTimer: NodeJS.Timeout | null = null;
  /** Message ids already handled (see ClientMessage). */
  private handled = new Set<string>();
  /** Names of everyone who's been in this meeting, so "X is reconnecting" can name a host who dropped. */
  private names = new Map<string, string>();
  /** Deleted notes and dismissed suggestions, kept a minute for Undo. */
  private removedNotes = new Map<string, Note>();
  private dismissedKeys = new Map<string, string[]>();
  /** Recent talk on the item in focus that names another item instead (see checkDrift). */
  private drift: { itemId: string; since: number; score: number; remarks: Set<string>; unnamed: Set<string> } | null = null;
  private transcriber: Transcriber | null = null;
  private transcriptionDown = false;
  private transcriberRetriedAt = 0;
  private transcriberRestarting = false;
  /** Items whose last notes run failed. People are told once, then it shows in the notes. */
  private notesFailing = new Set<string | null>();
  /** Per item, the newest remark the last notes run that worked had read (see settle.ts). */
  private notesReadUpTo = new Map<string | null, number>();
  /** Placing the smaller topics: one at a time, and when it last asked and on what. */
  private mergeRun: Promise<void> = Promise.resolve();
  private mergeTimer: NodeJS.Timeout | null = null;
  private mergedAt = -Infinity;
  private mergedSig = "";
  private merged = "[]";
  /** Main topics as of the last placing, and placings the model changed only once (topicMerge.ts). */
  private mainTopics = new Set<string>();
  private pendingMoves = new Map<string, string>();
  /** Why, when it's the Anthropic account rather than one run: its rate limit or its credit. */
  private notesWhy: NotesTrouble["reason"] | null = null;
  /** Rate limited: no notes run starts before this, so retries don't keep it hit. */
  private notesHoldUntil = 0;
  private hostAwayUntil = 0;
  /** The last nudge the host took, until the focus moves again: Undo puts it all back. */
  private accepted: { from: string | null; to: string; since: number } | null = null;
  /** The creator handed hosting to someone on purpose, so rejoining doesn't take it back. */
  private creatorHandedOver = false;
  private demoRunning = false;
  /** The middle board (board.ts): one pass at a time, every BOARD_EVERY_MS while people talk. */
  private board: BoardKeeper | null = null;
  private boardRanAt = 0;
  /** The board's running list (liveList.ts): one pass at a time, after each pause in the talk. Null without a model. */
  private list: ListKeeper | null = null;
  /** What ✦ Stand put on the board (meetingAgent.ts); null without a model to run it. */
  private agentCards: AgentKeeper | null = null;
  private draftTimer: NodeJS.Timeout | null = null;
  /** Push-to-talk: what each person says while their Ask Stand button is down. */
  private asks = new AskCapture();
  /** Who drives ✦ Stand right now, and who's asking to (pilot.ts). */
  private pilot = new PilotSeat();
  private pilotTimer: ReturnType<typeof setTimeout> | null = null;
  /** The brainstorm running in this space, if one is (brainstorm.ts): its map, one pass at a time. */
  private brain: { id: string; threadId: string | null; map: MapKeeper | DiagramKeeper } | null = null;
  /** The next steps people asked for out loud in this call (nextSteps.ts); the one offered is on a card. */
  private nextSteps: NextStep[] = [];
  private nextTimer: NodeJS.Timeout | null = null;
  private nextHeard: { segmentId: string; upTo: number } | null = null;
  /** When each kind was last waved off: Stand stays quiet about it for a while. */
  private nextWaved = new Map<string, number>();
  /** The last few minutes of talk, and when Stand last guessed each kind from it. */
  private nextRecent: Said[] = [];
  private nextGuessed = new Map<string, number>();
  /** Opening, parking and resuming a topic's map, one at a time. */
  private viewTurn: Promise<void> = Promise.resolve();
  /** The passes that keep the list, the map and the board up to date while people talk (passRunner.ts). */
  private listPasses = new PassRunner(() => this.listPass(), { label: "list", about: () => this.meetingId, settled: () => this.scheduleList() });
  private mapPasses = new PassRunner(() => this.mapPass(), { label: "brainstorm", about: () => this.meetingId, settled: () => this.scheduleMap() });
  private boardPasses = new PassRunner(() => this.boardPass(), {
    label: "board",
    about: () => this.meetingId,
    // A pass already waiting keeps its time unless the new one is due sooner.
    keepEarlier: true,
    // Talk that came in during the pass gets the next one.
    settled: () => this.board && !this.ended && this.board.due(this.db.meetingSegments(this.meetingId)) && this.scheduleBoard(this.board.waitingOnItem),
  });
  /** The check-in at the start ("Since last time"): someone moved on from it, and the last answer anyone gave. */
  private checkInClosed = false;
  private checkInAnsweredAt: number | null = null;
  /** The page of the opening board everyone is on: the "Done since" pages, then the check-in. */
  private checkInPage = 0;
  /** Brought back on purpose: it stays on the board until someone moves on again. */
  private checkInHeld = false;
  /** When someone moved on from the opening board: where the Kickoff chapter on the bar ends. */
  private checkInClosedAt: number | null = null;
  /** "Done since last time" as of when it was last read (undefined: read it again). */
  private doneDeckCache: DoneDeck | null | undefined;
  private lastMeetingCache: number | null | undefined;
  ended = false;
  /** When End meeting started the write-up. */
  endingSince = 0;
  /** Everyone has been let go: the recap is written in the background and the space can start a new call. */
  released = false;
  /** Called once when everyone is let go, before the recap is written. */
  onRelease?: (s: RoomSession) => void;

  constructor(
    private db: DB,
    private agent: Agent,
    room: { id: string; name: string; createdBy: string | null },
    private onClosed: (s: RoomSession) => void,
    private startTranscriber?: (s: RoomSession) => Transcriber | null,
    private polisher?: UpNextPolisher,
    /** A meeting the server was running when it stopped: carry on with it instead of starting a new one. */
    resume?: OpenMeeting | null,
    /** Writes what a design review's slides say (planBrief.ts). */
    private briefs: PlanBriefs | null = null,
  ) {
    this.roomId = room.id;
    this.roomName = room.name;
    this.createdBy = room.createdBy;
    const items = db.listItems(room.id);
    if (resume) {
      this.meetingId = resume.id;
      this.meetingStartedAt = resume.startedAt;
      // Back on the item it was on, with the same host once they reconnect.
      this.focusLog = db.focusHistory(resume.id);
      const last = this.focusLog.at(-1);
      if (last && (last.itemId === null || items.some((i) => i.id === last.itemId))) this.focusItemId = last.itemId;
      else this.setFocusInternal(items[0]?.id ?? null, "system", "start");
      this.hostId = resume.hostId;
      // So the hold names who it's waiting for, though they haven't rejoined since the restart.
      const hostName = this.hostId ? db.userName(this.hostId) : null;
      if (this.hostId && hostName) this.names.set(this.hostId, hostName);
      if (this.hostId) this.hostLeft();
      // Nobody is here yet; it ends as usual if nobody comes back.
      this.emptyTimer = setTimeout(() => void this.end(), EMPTY_ROOM_GRACE_MS);
      // A card that was up when the server stopped went unanswered.
      this.nextSteps = db.meetingNext(resume.id).map((n) => (n.state === "offered" ? { ...n, state: "missed" as const } : n));
    } else {
      const m = db.startMeeting(room.id);
      this.meetingId = m.id;
      this.meetingStartedAt = m.startedAt;
      this.setFocusInternal(items[0]?.id ?? null, "system", "start");
    }
    // Every Claude call from here on counts against this meeting; the call shows what it has cost so far.
    agent = this.agent = metered(agent, this.meetingId, () => this.costChanged());
    this.board = new BoardKeeper(agent, this.meetingStartedAt, resume ? db.meetingBoard(resume.id) : null);
    if (agent.liveList) this.list = new ListKeeper({ liveList: agent.liveList.bind(agent) }, this.meetingStartedAt, resume ? db.meetingList(resume.id) : null);
    if (agent.findOptions && this.list) this.agentCards = new AgentKeeper(resume ? db.meetingAgentCards(resume.id) : null);
    this.loadBrainstorm();
    // Tidy the suggested agenda now, before anyone has started talking.
    polisher?.schedule(room.id, 0);
  }

  // ---- brainstorm -----------------------------------------------------------

  /** Picks up the brainstorm running in this space: at the start of the call, and when one is started during it. */
  private loadBrainstorm() {
    const b = this.db.brainstormLive(this.roomId);
    if (!b) return void (this.brain = null);
    // So "Maps in this call" finds it.
    if (!b.meetingId) this.db.setBrainstorm(b.id, { meetingId: this.meetingId });
    if (this.brain?.id === b.id) {
      // Context can be added to a running design session (MCP start_design_session).
      if (this.brain.map instanceof DiagramKeeper) this.brain.map.background(sessionBackground(b));
      return;
    }
    // Only talk from this call, after the brainstorm began, belongs on its map; never what was said on a review slide.
    const since = Math.max(b.startedAt, this.meetingStartedAt) - 1;
    const review = new Map<string, boolean>();
    const inScope = (s: Segment) => {
      if (!s.itemId) return true;
      if (!review.has(s.itemId)) review.set(s.itemId, isReviewDeck(this.db.getItem(s.itemId)));
      return !review.get(s.itemId);
    };
    if (b.kind === "design") {
      // A design session: the same passes, drawing a diagram of boxes and arrows (designSession.ts).
      const model = this.agent.designDiagram ? { designDiagram: this.agent.designDiagram.bind(this.agent) } : { designDiagram: async () => null };
      this.brain = { id: b.id, threadId: null, map: new DiagramKeeper(model, b.prompt, since, b.diagram, sessionBackground(b), inScope) };
      return;
    }
    const model = this.agent.brainstormMap ? { brainstormMap: this.agent.brainstormMap.bind(this.agent) } : { brainstormMap: async () => null };
    const thread = b.threadId;
    if (!thread) return void (this.brain = { id: b.id, threadId: null, map: new MapKeeper(model, b.prompt, since, b.nodes, inScope) });
    // A topic's map reads every line of its thread in this call, those said before it was opened too.
    const onThread = (s: Segment) => {
      const board = this.board?.board();
      const t = board?.threads.find((x) => x.id === thread);
      if (!t) return false;
      const open = board!.currentId === thread;
      return t.spans.some(([from, to], i) => s.ts >= from && (s.ts <= to || (open && i === t.spans.length - 1)));
    };
    this.brain = { id: b.id, threadId: thread, map: new MapKeeper(model, b.prompt, this.meetingStartedAt - 1, b.nodes, (s) => inScope(s) && onThread(s)) };
  }

  /** The stretches of the meeting a board thread was on screen. */
  private threadSpans(threadId: string): Array<[number, number]> {
    return (this.board?.board().threads.find((t) => t.id === threadId)?.spans ?? []).map(([from, to]) => [from, to]);
  }

  /** One last look at the talk no pass has read, before a map or a diagram stops reading. */
  private async lastLook() {
    await this.mapPasses.idle();
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([this.mapPasses.run(), new Promise((r) => (wait = setTimeout(r, 15_000)))]);
    clearTimeout(wait);
  }

  private inTurn(work: () => Promise<void>): Promise<void> {
    const next = this.viewTurn.then(work).catch((e) => console.error(`[view] ${this.meetingId}: ${(e as Error).message}`));
    this.viewTurn = next;
    return next;
  }

  private offered() {
    return this.nextSteps.find((n) => n.state === "offered") ?? null;
  }

  private settleNext(n: NextStep, state: NextStep["state"]) {
    n.state = state;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.nextTimer = null;
    this.db.saveMeetingNext(this.meetingId, this.nextSteps);
    this.broadcastState();
  }

  /** Someone said they want a map, a diagram or a review: offer it to everyone, once. Said or typed,
   *  both are the call's talk. Nothing starts until a person takes the card. */
  private checkNext(seg: Segment, added = seg.text) {
    if (this.ended || this.demoRunning || this.inReview()) return;
    this.nextRecent = [...this.nextRecent.filter((l) => seg.ts - l.ts <= SOUNDS_WINDOW_MS), { speaker: seg.speakerName, text: added, ts: seg.ts }];
    // One thought arrives in fragments joined into one line: read its tail, past what was already heard in it.
    const from = Math.max(this.nextHeard?.segmentId === seg.id ? this.nextHeard.upTo : 0, seg.text.length - 320);
    const asked = heardIntent(seg.text.slice(from));
    if (asked) this.nextHeard = { segmentId: seg.id, upTo: seg.text.length };
    // Nobody asked: what the last few minutes sound like, said at most once in a while for each kind.
    const sounds = asked || this.offered() ? null : soundsLike(this.nextRecent, seg.ts);
    const guessed = !!sounds && seg.ts - (this.nextGuessed.get(sounds) ?? 0) >= SOUNDS_QUIET_MS;
    const heard = asked ?? (guessed ? { kind: sounds!, topic: null } : null);
    if (!heard) return;
    // That kind is already drawing.
    const open = this.brain ? (this.brain.map instanceof DiagramKeeper ? "diagram" : "map") : null;
    if (open === heard.kind) return;
    const waved = this.nextWaved.get(heard.kind);
    if (waved && seg.ts - waved < NEXT_QUIET_MS) return;
    const before = this.offered();
    if (before) {
      // A card of that kind is up already; one Stand guessed gives way to a person asking.
      if (before.kind === heard.kind && !(before.guessed && asked)) return;
      before.state = "missed";
    }
    const ready = heard.kind === "product-review" ? (reviewView(this.db, this.roomId)?.slides.length ?? 0) : heard.kind === "design-review" ? (designReviewSummary(this.db, this.roomId)?.specs ?? 0) : 0;
    const step: NextStep = { id: newId(8), kind: heard.kind, topic: heard.topic ?? "", by: seg.speakerName, ts: seg.ts, segmentId: seg.id, state: "offered", ...(isReviewKind(heard.kind) ? { ready } : {}), ...(asked ? {} : { guessed: true }) };
    if (!asked) this.nextGuessed.set(heard.kind, seg.ts);
    this.nextSteps.push(step);
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => step.state === "offered" && this.settleNext(step, "missed"), NEXT_SHOWN_MS);
    this.db.saveMeetingNext(this.meetingId, this.nextSteps);
    this.broadcastState();
  }

  /** "Draw the map of this topic": the map of the board's thread, new or as it was left. Whatever
   *  else is drawing stops first, so a diagram saves its draft spec. */
  private openView(by: string) {
    return this.inTurn(async () => {
      const board = this.board?.board();
      const thread = board?.threads.find((t) => t.id === board.currentId);
      if (this.ended || this.inReview() || !thread) return;
      const live = this.db.brainstormLive(this.roomId);
      if (live?.kind === "map" && live.threadId === thread.id) return;
      if (live) await this.stopView();
      if (this.ended) return;
      if (this.db.brainstormLive(this.roomId)) finishBrainstorm(this.db, this.roomId, this.meetingId);
      const had = this.db.brainstormOfThread(this.meetingId, thread.id);
      if (had) resumeBrainstorm(this.db, had.id);
      else this.db.createBrainstorm({ roomId: this.roomId, prompt: promptOf(thread.title), itemId: null, threadId: thread.id, meetingId: this.meetingId, startedBy: by, startedAt: Date.now() });
      this.brainstormChanged();
    });
  }

  /** The board moved: the map of the topic it left parks, and the map of the topic it came back to
   *  goes on, unless someone stopped it or something else is drawing. */
  private syncView() {
    return this.inTurn(async () => {
      const current = this.board?.board().currentId ?? null;
      const brain = this.brain;
      if (brain?.threadId && brain.threadId !== current) {
        await this.lastLook();
        if (this.ended || this.brain !== brain) return;
        parkBrainstorm(this.db, brain.id, this.meetingId, this.threadSpans(brain.threadId));
        this.brain = null;
        this.broadcastBrainstorm();
      }
      if (this.ended || this.brain || !current || this.db.brainstormLive(this.roomId)) return;
      const parked = this.db.brainstormOfThread(this.meetingId, current);
      if (!parked || parked.status !== "done" || parked.endedAt !== null) return;
      resumeBrainstorm(this.db, parked.id);
      this.brainstormChanged();
    });
  }

  /** A brainstorm was started (or replaced) from outside the call's own messages. */
  /** The host of the call, who steers it: starts and finishes what is on the board. */
  hostIs(userId: string) {
    return this.hostId === userId;
  }

  /** Someone in the call started a review: they steer the board while it runs, so the host seat is
   *  theirs until it is finished, and then goes back. */
  startedBy(userId: string) {
    if (this.ended || !this.participants.has(userId) || userId === this.hostId) return;
    // Lent once: a second experience started by someone else still gives the seat back to the first host.
    this.lentFrom ??= this.hostId;
    this.setHost(userId);
    this.suggestion = null;
    this.broadcastState();
  }

  /** The review is over: the seat goes back to whoever lent it, when they are still here and
   *  nobody moved it on by hand in the meantime. */
  private returnSeat() {
    const to = this.lentFrom;
    this.lentFrom = null;
    if (!to || to === this.hostId || !this.participants.has(to)) return;
    this.setHost(to);
    this.suggestion = null;
    this.broadcastState();
  }

  /** "Finish this": the review running in this call is over, and the call goes on as plain talk.
   *  Each keeps what it would have kept at the end of the call; what the meeting files afterwards
   *  (reviews.ts refileReview, designReviews.ts writeBackReview) still runs then. */
  async finishExperience(): Promise<Array<"review" | "design-review">> {
    if (this.ended) return [];
    const done: Array<"review" | "design-review"> = [];
    if (finishReview(this.db, this.roomId, this.meetingId)) done.push("review");
    if (finishIdeaReview(this.db, this.roomId, this.meetingId)) done.push("review");
    if (finishDesignReview(this.db, this.roomId, this.meetingId)) done.push("design-review");
    if (done.length) {
      // Its slides left the agenda: the call is back on General.
      this.itemsChanged();
      this.followUpsChanged();
      this.returnSeat();
      this.scheduleMap();
    }
    return done;
  }

  /** "Stop drawing": the map or diagram running in this call stops, and is kept as it is. The call
   *  goes on as it was. True when one was stopped. */
  async stopView(): Promise<boolean> {
    if (this.ended || !this.brain) return false;
    // One last look at the talk no pass has read, then its map is the record.
    await this.lastLook();
    if (this.ended || !this.brain) return false;
    if (this.brain.threadId) this.db.saveBrainstormSpans(this.brain.id, this.threadSpans(this.brain.threadId));
    const row = finishBrainstorm(this.db, this.roomId, this.meetingId);
    if (row?.kind === "design") {
      try {
        saveDraftSpec(this.db, row, this.brainCaught());
      } catch (e) {
        console.error(`[design session] ${this.meetingId}: ${(e as Error).message}`);
      }
    }
    this.brain = null;
    this.broadcastBrainstorm();
    return !!row;
  }

  brainstormChanged() {
    this.loadBrainstorm();
    this.broadcastBrainstorm();
    this.scheduleMap();
  }

  private brainstormView(busy = false) {
    const b = this.brain && this.db.getBrainstorm(this.brain.id);
    if (!b) return null;
    const map = this.brain!.map;
    return toBrainstormView(map instanceof DiagramKeeper ? { ...b, diagram: map.all() } : { ...b, nodes: map.all() }, busy);
  }

  private broadcastBrainstorm(busy = false) {
    this.broadcast({ type: "brainstorm", brainstorm: this.brainstormView(busy), others: othersOfMeeting(this.db, this.meetingId, this.brain?.id ?? null) });
  }

  /** The meeting's to-dos, decisions and open questions, for linking to circles. */
  private brainCaught(): BrainCaught[] {
    const KIND = ["action", "decision", "question"];
    const lines: Note[] = this.list ? this.list.notes(this.meetingId).filter((n) => !n.closed) : this.db.meetingNotes(this.meetingId);
    return lines.filter((n) => KIND.includes(n.kind)).map((n) => ({ id: n.id, kind: n.kind as BrainCaught["kind"], text: n.text, owner: n.owner ?? null, done: !!n.doneAt }));
  }

  private saveBrainstorm() {
    if (!this.brain) return;
    const map = this.brain.map;
    if (map instanceof DiagramKeeper) {
      this.db.saveDesignDiagram(this.brain.id, map.all());
      // A session that started without a topic was just named from the talk.
      if (map.prompt !== this.db.getBrainstorm(this.brain.id)?.prompt) {
        this.db.renameBrainstorm(this.brain.id, map.prompt);
        this.itemsChanged();
      }
    } else this.db.saveBrainstormMap(this.brain.id, map.all());
    this.broadcastBrainstorm();
  }

  /** The next map pass: MAP_DEBOUNCE_MS after the latest talk, never more than MAP_MAX_WAIT_MS after
   *  the oldest line no pass has read. */
  private scheduleMap() {
    const brain = this.brain;
    if (this.ended || !brain || this.inReview()) return;
    const since = brain.map.unreadSince(this.db.meetingSegments(this.meetingId));
    if (since !== null) this.mapPasses.schedule(Math.min(MAP_DEBOUNCE_MS, since + MAP_MAX_WAIT_MS - Date.now()));
  }

  /** One map pass over the talk no pass has read. As the meeting ends it still runs, once, for the record. */
  private async mapPass() {
    const brain = this.brain;
    if (!brain) return;
    const segments = this.db.meetingSegments(this.meetingId);
    if (brain.map.unreadSince(segments) === null) return;
    if (!this.ended) this.broadcastBrainstorm(true);
    try {
      const map = brain.map;
      if (map instanceof MapKeeper) {
        // A topic's map opened late reads its earlier talk a window at a time; people watch it fill in.
        await catchUp(map, segments, this.people(segments), this.brainCaught(), this.meetingStartedAt, Date.now(), () => {
          if (this.brain !== brain) return;
          this.db.saveBrainstormMap(brain.id, map.all());
          this.broadcastBrainstorm(true);
        });
      } else await map.run(segments, this.people(segments), this.brainCaught(), this.meetingStartedAt, Date.now());
    } finally {
      if (this.brain === brain) {
        brain.map.refresh(this.brainCaught());
        this.saveBrainstorm();
      }
    }
  }

  /** Everyone in the call now, and everyone who has spoken in it. */
  private people(segments: Segment[]) {
    return [...new Set([...[...this.participants.values()].map((p) => p.name), ...segments.map((s) => s.speakerName)])];
  }

  // ---- connections ---------------------------------------------------------

  /** The user comes from the session cookie checked at upgrade time; they
   *  appear in the room once their client says hello. */
  attach(ws: WebSocket, user: User) {
    this.conns.set(ws, null);
    this.pendingUser.set(ws, user);
    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      // Each handler checks the fields it uses; this keeps out what isn't a message at all.
      if (!isMessage(msg)) return;
      this.handle(ws, msg).catch((err) => {
        console.error("[room]", err);
        this.send(ws, { type: "error", message: "Something went wrong with that. Try again." });
      });
    });
    ws.on("close", () => this.detach(ws));
  }

  private detach(ws: WebSocket) {
    const conn = this.conns.get(ws);
    this.conns.delete(ws);
    this.pendingUser.delete(ws);
    if (conn) {
      const p = this.participants.get(conn.participantId);
      if (p && --p.conns <= 0) {
        this.participants.delete(conn.participantId);
        if (this.hostId === conn.participantId) this.hostLeft();
        if (this.pilot.left(conn.participantId, Date.now())) this.pilotChanged();
        this.endAsk(conn.participantId);
      }
      this.broadcastState();
    }
    if (this.participants.size === 0 && !this.emptyTimer && !this.ended) {
      this.emptyTimer = setTimeout(() => void this.end(), EMPTY_ROOM_GRACE_MS);
    }
  }

  private setHost(id: string | null) {
    if (this.hostAwayTimer) clearTimeout(this.hostAwayTimer);
    this.hostAwayTimer = null;
    this.hostAwayUntil = 0;
    if (id === this.hostId) return;
    this.hostId = id;
    // The new host sends their own view; until then everyone is on live.
    this.hostView = null;
    this.db.setMeetingHost(this.meetingId, id);
  }

  /** The host's connection dropped: keep the seat for them a while, then
   *  hand it to whoever has been here longest. */
  private hostLeft() {
    if (this.hostAwayTimer) clearTimeout(this.hostAwayTimer);
    this.hostAwayUntil = Date.now() + HOST_AWAY_GRACE_MS;
    this.hostAwayTimer = setTimeout(() => {
      this.hostAwayTimer = null;
      if (this.ended || (this.hostId && this.participants.has(this.hostId))) return;
      // The nudge was for the host who left; the next one starts fresh.
      this.suggestion = null;
      this.setHost(this.participants.keys().next().value ?? null);
      this.broadcastState();
    }, HOST_AWAY_GRACE_MS);
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const [ws, conn] of this.conns) if (conn && ws.readyState === ws.OPEN) ws.send(data);
  }

  /** After each Claude call: tell everyone what the meeting has cost, at most every few seconds. */
  private costTimer: ReturnType<typeof setTimeout> | null = null;
  private costChanged() {
    if (this.costTimer) return;
    this.costTimer = setTimeout(() => {
      this.costTimer = null;
      const cost = this.db.meetingCost(this.meetingId);
      if (cost) this.broadcast({ type: "cost", cost });
    }, COST_EVERY_MS);
  }

  private broadcastState() {
    this.logStage();
    this.broadcast({ type: "state", state: this.state() });
  }

  /** What the main view shows now. */
  private stageView(): StageView {
    const sharer = [...this.participants.values()].find((p) => p.isSharing);
    return {
      itemId: this.focusItemId,
      tab: this.hostView?.tab ?? "main",
      taskMode: this.hostView?.taskMode ?? null,
      shot: this.hostView?.shot ?? null,
      snapId: this.stageSnapId,
      sharing: sharer?.name ?? null,
    };
  }
  private lastStage = "";
  /** Keeps what the main view shows each time it changes, so a line can say what it was said in front of. */
  private logStage() {
    if (this.ended) return;
    const view = this.stageView();
    const key = JSON.stringify(view);
    if (key === this.lastStage) return;
    this.lastStage = key;
    this.db.logStage(this.meetingId, view);
  }

  /** The space was renamed while people are in it. */
  renamed(name: string) {
    this.roomName = name;
    this.broadcast({ type: "state", state: this.state() });
  }

  state(): RoomState {
    const snaps = this.snaps();
    return {
      snaps,
      stageSnapId: snaps.some((s) => s.id === this.stageSnapId) ? this.stageSnapId : null,
      roomId: this.roomId,
      roomName: this.roomName,
      meetingId: this.meetingId,
      meetingStartedAt: this.meetingStartedAt,
      participants: [...this.participants.values()].map(({ conns: _c, ...p }) => ({ ...p, isHost: p.id === this.hostId })),
      focusItemId: this.focusItemId,
      pinnedBy: this.pinnedBy,
      hostView: this.hostView,
      transcriptionDown: this.transcriptionDown,
      transcriptionRestarting: this.transcriptionDown && this.transcriberRestarting,
      hostAway: this.hostAwayTimer && this.hostId && !this.participants.has(this.hostId) ? (this.names.get(this.hostId) ?? "The host") : null,
      hostAwayMs: this.hostAwayTimer ? Math.max(0, this.hostAwayUntil - Date.now()) : null,
      notesFailing: [...this.notesFailing],
      notesTrouble: this.notesFailing.size ? this.notesWhy : null,
      suggestion: this.suggestion,
      next: this.ended ? null : this.offered(),
      items: this.items(),
      decks: this.db.listDecks(this.roomId),
      followUps: this.carried(true),
      checkIn: { closed: this.checkInClosed, answeredAt: this.checkInAnsweredAt, page: this.checkInPage, closedAt: this.checkInClosedAt, held: this.checkInHeld },
      doneDeck: this.doneDeck(),
      lastMeetingAt: this.lastMeetingAt(),
      updates: this.db.roomUpdates(this.roomId, this.db.previousMeetingStart(this.roomId, this.meetingStartedAt) ?? 0),
      ...this.upNext(),
      capabilities: capabilities(),
      ending: this.ended,
    };
  }

  /** To-dos from earlier meetings: the open ones, oldest first. withNews: also the ones closed since the
   *  meeting before this one ended (by a PR, an agent, a click), so the check-in can show what changed. */
  private carried(withNews = false) {
    const since = this.db.previousMeetingEnd(this.roomId, this.meetingStartedAt) ?? this.meetingStartedAt;
    return this.db
      .roomFollowUps(this.roomId)
      .filter((f) => f.meetingId !== this.meetingId && (f.doneAt === null || (withNews && f.doneAt >= Math.min(since, this.meetingStartedAt))))
      .sort((a, b) => a.ts - b.ts);
  }

  private snaps() {
    const rows = this.db.meetingSnaps(this.meetingId);
    return rows.length ? linkSnaps(rows, this.db.meetingSegments(this.meetingId), this.db.meetingDiscussions(this.meetingId)) : [];
  }

  /** Someone snapped the shared screen, or pasted or dropped a screenshot of
   *  their own. It's pinned to whatever was in focus at that moment; the agent
   *  captions it afterwards. */
  addSnap(snap: {
    buf: Buffer;
    ext: string;
    width: number;
    height: number;
    at: number;
    takenById: string;
    takenBy: string;
    /** Pasted or dropped: nobody's shared screen. */
    pasted?: boolean;
    /** What they typed with it. */
    line?: string | null;
  }) {
    const at = Math.min(Math.max(snap.at || Date.now(), this.meetingStartedAt), Date.now());
    const sharer = snap.pasted ? null : ([...this.participants.values()].find((p) => p.isSharing) ?? null);
    const id = newId(12);
    saveSnapFile(id, snap.ext, snap.buf);
    const itemId = this.focusAt(at);
    this.db.addSnap({
      id,
      roomId: this.roomId,
      meetingId: this.meetingId,
      itemId,
      ts: at,
      ext: snap.ext,
      width: snap.width,
      height: snap.height,
      source: "person",
      takenById: snap.takenById,
      takenBy: snap.takenBy,
      sharerId: sharer?.id ?? null,
      sharerName: sharer?.name ?? null,
      noteId: null,
      line: snap.line ?? null,
    });
    // Everyone sees what was just captured, unless the meeting has already moved on.
    if (itemId === this.focusItemId) this.stageSnapId = id;
    this.broadcastState();
    void this.captionSnap(id, snap.buf, snap.ext, itemId, at);
    return id;
  }

  private async captionSnap(id: string, buf: Buffer, ext: string, itemId: string | null, at: number) {
    if (buf.length > 5 * 1024 * 1024) return;
    try {
      const remarks = this.db
        .meetingSegments(this.meetingId)
        .filter((g) => g.itemId === itemId && Math.abs(g.ts - at) < 45_000)
        .map((g) => `${g.speakerName}: ${g.text}`);
      const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const caption = await this.agent.describeSnap(
        { data: buf.toString("base64"), mediaType },
        itemId ? this.db.getItem(itemId) : null,
        remarks,
      );
      if (!caption || !this.db.getSnap(id)) return;
      this.db.setSnapCaption(id, caption);
      this.broadcastState();
    } catch (err) {
      console.error("[agent] snap caption failed:", err);
    }
  }

  /** A snap was cropped or deleted through the REST API. */
  snapsChanged() {
    this.broadcastState();
  }

  /** The agent just wrote decisions or to-dos: if the screen it was reading
   *  backs one of them, keep that frame next to it (once per frame). */
  private async keepBackingFrame(itemId: string | null, notes: Note[]) {
    const seen = this.seen;
    if (!seen || seen.itemId !== itemId || Date.now() - seen.at > FRAME_BACKS_MS || this.seenUsed === seen.at) return;
    const candidates = notes.filter((n) => n.kind === "action" || n.kind === "decision").slice(0, 8);
    if (!candidates.length) return;
    this.seenUsed = seen.at;
    try {
      const data = seen.dataUrl.replace(/^data:image\/jpeg;base64,/, "");
      const keyed = candidates.map((n, i) => ({ key: `N${i + 1}`, kind: n.kind as "action" | "decision", text: n.text }));
      const out = await this.agent.frameBacks({ data, mediaType: "image/jpeg" }, itemId ? this.db.getItem(itemId) : null, keyed);
      const note = out ? candidates[keyed.findIndex((k) => k.key === out.key)] : null;
      if (!out || !note || this.ended) return;
      const buf = Buffer.from(data, "base64");
      const id = newId(12);
      saveSnapFile(id, "jpg", buf);
      const sharer = [...this.participants.values()].find((p) => p.isSharing) ?? null;
      this.db.addSnap({
        id,
        roomId: this.roomId,
        meetingId: this.meetingId,
        itemId,
        ts: seen.at,
        ext: "jpg",
        width: 0,
        height: 0,
        source: "agent",
        takenById: null,
        takenBy: "Stand agent",
        sharerId: sharer?.id ?? null,
        sharerName: sharer?.name ?? null,
        noteId: note.id,
      });
      this.db.setSnapCaption(id, out.caption);
      this.broadcastState();
    } catch (err) {
      console.error("[agent] keeping a frame failed:", err);
    }
  }

  private upNext() {
    return upNextView(this.db, this.roomId, this.meetingStartedAt, this.polisher?.busy(this.roomId));
  }

  /** Claude started or finished tidying the suggested agenda. */
  upNextChanged() {
    this.broadcastState();
  }

  private items(): Item[] {
    return this.db.listItems(this.roomId);
  }

  /** Called by the REST API after the agenda changes. */
  itemsChanged() {
    const items = this.items();
    const has = (id: string | null) => items.some((i) => i.id === id);
    if (this.focusItemId && !has(this.focusItemId)) {
      // The item in focus went: on to the first one, and a pin on it goes too.
      this.pinnedBy = null;
      this.setFocusInternal(items[0]?.id ?? null, "system", "removed");
    } else if (!this.focusItemId && items[0] && !this.focusLog.some((f) => f.itemId)) {
      // The first item of an agenda that was empty. A host who chose General stays there.
      this.setFocusInternal(items[0].id, "system", "start");
    }
    if (this.suggestion && !has(this.suggestion.itemId)) this.suggestion = null;
    this.broadcastState();
  }

  /** What the space finished since its last meeting, as the pages Claude laid out for this one (doneDeck.ts):
   *  only when they count from the last meeting before this one. */
  private doneDeck(): DoneDeck | null {
    if (this.doneDeckCache === undefined) {
      this.doneDeckCache = currentDoneDeck(this.db, this.roomId, this.meetingStartedAt);
    }
    return this.doneDeckCache;
  }

  /** When the last meeting before this one started: what the "Done since" card counts from. */
  private lastMeetingAt(): number | null {
    if (this.lastMeetingCache === undefined) this.lastMeetingCache = this.db.lastRealMeeting(this.roomId, this.meetingStartedAt)?.startedAt ?? null;
    return this.lastMeetingCache;
  }

  /** Called by the REST API after an action item is checked off elsewhere. */
  followUpsChanged() {
    this.doneDeckCache = undefined;
    this.broadcastState();
  }

  /** Called when an agent reports back on an item through the Stand MCP. */
  updatesChanged() {
    this.broadcastState();
  }

  nameOf(participantId: string) {
    return this.participants.get(participantId)?.name;
  }

  // ---- message handling ----------------------------------------------------

  private async handle(ws: WebSocket, msg: ClientMessage) {
    if (msg.type === "ping") return this.send(ws, { type: "pong" });
    if (msg.type === "hello") {
      const user = this.pendingUser.get(ws);
      if (!user || this.conns.get(ws)) return;
      // The meeting this client was in ended while it was away: show it the recap, not a new meeting.
      const was = msg.meetingId && msg.meetingId !== this.meetingId ? this.db.getMeeting(msg.meetingId) : null;
      if (msg.meetingId && (was?.endedAt || was?.endRequestedAt)) {
        this.send(ws, { type: "meeting.ended", meetingId: msg.meetingId });
        ws.close();
        return;
      }
      const { id, name } = user;
      this.conns.set(ws, { participantId: id, name });
      const existing = this.participants.get(id);
      if (existing) {
        existing.conns++;
        existing.name = name;
      } else {
        this.participants.set(id, { id, name, picture: user.picture, isHost: false, isSharing: false, conns: 1 });
      }
      const isNew = !existing;
      this.names.set(id, name);
      // The host coming back keeps the seat; nobody takes it while it's held for them.
      const seatFree = !this.hostId || (!this.participants.has(this.hostId) && !this.hostAwayTimer);
      if (id === this.hostId || seatFree || (isNew && id === this.createdBy && !this.creatorHandedOver)) this.setHost(id);
      if (this.emptyTimer) {
        clearTimeout(this.emptyTimer);
        this.emptyTimer = null;
      }
      if (!this.transcriber && this.startTranscriber && !this.ended) {
        this.transcriptionDown = false;
        this.transcriber = this.startTranscriber(this);
      }
      this.send(ws, {
        type: "welcome",
        participantId: id,
        segments: this.db.meetingSegments(this.meetingId),
        notes: this.db.meetingNotes(this.meetingId),
        discussions: this.db.meetingDiscussions(this.meetingId),
      });
      if (this.board) this.send(ws, { type: "board", board: this.board.board() });
      const cost = this.db.meetingCost(this.meetingId);
      if (cost) this.send(ws, { type: "cost", cost });
      this.send(ws, { type: "list", items: this.list?.notes(this.meetingId) ?? null });
      this.send(ws, { type: "brainstorm", brainstorm: this.brainstormView(), others: othersOfMeeting(this.db, this.meetingId, this.brain?.id ?? null) });
      if (this.agentCards) this.send(ws, { type: "agent", cards: this.agentCards.all() });
      if (this.pilot.back(id)) this.pilotChanged();
      else if (this.agentCards) this.send(ws, { type: "pilot", pilot: this.pilot.view(Date.now()) });
      this.broadcastState();
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    const me = this.participants.get(conn.participantId);
    if (msg.cid) {
      this.send(ws, { type: "ack", cid: msg.cid });
      // Sent again after a reconnect, but it got here the first time.
      if (this.handled.has(msg.cid)) return;
      this.handled.add(msg.cid);
      if (this.handled.size > HANDLED_CIDS) this.handled.delete(this.handled.values().next().value!);
    }

    const isHost = this.isHost(conn.participantId);

    switch (msg.type) {
      // Only the host moves the meeting between items. Anyone in the call flips a review's slides,
      // within the review: a product, idea or design review's deck.
      case "focus":
        if (this.ended || !(isHost || this.flipsReview(msg.itemId))) return;
        this.pinnedBy = null;
        this.setFocus(msg.itemId, conn.name, "manual");
        break;
      case "board.accept":
        if (!this.ended) void this.acceptBoardMove(msg.title, conn.name);
        break;
      // How a review slide ended. Anyone in the call can say, and take it back.
      case "review.outcome":
        if (this.ended) return;
        if (setOutcome(this.db, msg.itemId, typeof msg.outcome === "string" ? msg.outcome : null, conn.name)) this.broadcastState();
        break;
      // How a point of a design review ended, or the verdict on its spec. Anyone can say, and take it back.
      case "design.outcome":
        if (this.ended) return;
        if (setDesignOutcome(this.db, this.briefs, msg.itemId, typeof msg.outcome === "string" ? msg.outcome : null, conn.name, this.meetingId)) this.broadcastState();
        break;
      // A spec's author walks the team through it: they move between its slides for everyone.
      case "design.go":
        if (this.ended || typeof msg.itemId !== "string") return;
        if (!authorMay(this.db, this.roomId, this.focusItemId, msg.itemId, { id: conn.participantId, name: conn.name })) return;
        this.pinnedBy = null;
        this.setFocus(msg.itemId, conn.name, "manual");
        break;
      case "pin":
        if (!isHost || this.ended) return;
        this.setFocus(msg.itemId, conn.name, "pin");
        this.pinnedBy = conn.name;
        this.broadcastState();
        break;
      case "unpin":
        if (!isHost) return;
        this.pinnedBy = null;
        this.broadcastState();
        break;
      case "suggestion.accept":
        // The suggestion can change between seeing it and pressing Switch; only the one seen is taken.
        if (isHost && !this.ended && (!msg.itemId || msg.itemId === this.suggestion?.itemId)) this.acceptSuggestion(conn.name);
        break;
      case "suggestion.undo":
        if (isHost && !this.ended) this.undoAccept(conn.name);
        break;
      case "suggestion.dismiss":
        if (this.suggestion && isHost) {
          this.dismissed.set(this.suggestion.itemId, Date.now());
          this.suggestion = null;
          this.broadcastState();
        }
        break;
      case "host.give": {
        const hostHere = this.hostId && this.participants.has(this.hostId);
        if ((isHost || !hostHere) && this.participants.has(msg.participantId)) {
          if (conn.participantId === this.createdBy && msg.participantId !== this.createdBy) this.creatorHandedOver = true;
          if (msg.participantId === this.createdBy) this.creatorHandedOver = false;
          // Handed over by hand: that stands, whatever is running.
          this.lentFrom = null;
          this.setHost(msg.participantId);
          this.suggestion = null;
          this.broadcastState();
        }
        break;
      }
      case "sharing": {
        // One screen at a time, and the newest share takes over (their page asked first). The person
        // taken over is told; their browser stops its share when it sees someone else's counted
        // instead. A review they were running carries on.
        const other = msg.on && [...this.participants.values()].find((p) => p.isSharing && p.id !== conn.participantId);
        if (other && me) {
          other.isSharing = false;
          for (const [w, c] of this.conns) if (c?.participantId === other.id) this.send(w, { type: "notice", message: `${conn.name} is sharing now, so your share stopped.` });
          if (other.id === this.hostId) this.suggestion = null;
        }
        // A share that ends takes the screen nudge with it; one Stand never counted doesn't.
        const wasSharing = Boolean(me?.isSharing);
        if (me) me.isSharing = msg.on;
        if (!msg.on && isHost && wasSharing) this.suggestion = null;
        this.broadcastState();
        break;
      }
      case "recording":
        if (me) me.notRecording = !msg.on;
        this.broadcastState();
        break;
      case "mic":
        // Sent again on every reconnect: only a change is worth telling everyone.
        if (!me || me.muted === !msg.on) break;
        me.muted = !msg.on;
        this.broadcastState();
        break;
      case "notes.retry": {
        const itemId = msg.itemId && this.items().some((i) => i.id === msg.itemId) ? msg.itemId : null;
        if (!this.ended) void this.refreshNotes(itemId);
        break;
      }
      case "chat": {
        const text = clean(msg.text, 2000);
        if (!text) return;
        this.addSegment(conn.participantId, conn.name, "chat", text, Date.now());
        const q = typedAsk(text);
        if (q) this.askTyped(ws, conn, q);
        break;
      }
      case "agent.ask.text": {
        const q = clean(msg.text, 1000);
        if (q) this.askTyped(ws, conn, q, typeof msg.follows === "string" ? msg.follows : null);
        break;
      }
      case "pilot.request":
        if (!this.ended && this.pilot.request({ id: conn.participantId, name: conn.name }, Date.now())) this.pilotChanged();
        break;
      case "pilot.cancel":
        if (this.pilot.cancel(conn.participantId, Date.now())) this.pilotChanged();
        break;
      case "pilot.answer":
        if (this.pilot.answer(conn.participantId, msg.yes === true, Date.now())) this.pilotChanged();
        break;
      case "pilot.give": {
        const to = msg.participantId ? this.participants.get(msg.participantId) : null;
        if (msg.participantId && !to) return;
        if (this.pilot.give(conn.participantId, to ? { id: to.id, name: to.name } : null, Date.now())) this.pilotChanged();
        break;
      }
      case "pilot.take":
        if (isHost && !this.ended && this.pilot.take({ id: conn.participantId, name: conn.name }, Date.now())) this.pilotChanged();
        break;
      case "pilot.typing":
        if (this.pilot.typing(conn.participantId, msg.on === true, Date.now())) this.pilotChanged();
        break;
      case "speech":
        if (capabilities().transcription === "browser") {
          this.addSpeech(conn.participantId, conn.name, msg.text, Math.min(msg.startedAt || Date.now(), Date.now()));
        }
        break;
      case "speech.interim":
        if (capabilities().transcription === "browser") this.interim(conn.participantId, conn.name, msg.text);
        break;
      case "frame":
        // The agent only follows the host's screen.
        if (isHost && me?.isSharing && typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:image/jpeg;base64,")) {
          this.frame = { dataUrl: msg.dataUrl, at: Date.now() };
          this.seen = { dataUrl: msg.dataUrl, at: this.frame.at, itemId: this.focusItemId };
          void this.readScreen();
        }
        break;
      case "segment.move": {
        const before = this.db.meetingSegments(this.meetingId).find((s) => s.id === msg.segmentId);
        // A remark moves to an item on this agenda, or to General.
        if (!before || (msg.itemId !== null && !this.items().some((i) => i.id === msg.itemId))) return;
        const seg = this.db.moveSegment(msg.segmentId, msg.itemId);
        if (this.lastSpeech?.segmentId === msg.segmentId) this.lastSpeech = null;
        if (seg) {
          this.broadcast({ type: "segment.updated", segment: seg });
          // An old remark moved here hasn't been read under this item yet.
          this.notesReadUpTo.delete(seg.itemId);
          this.scheduleNotes(before.itemId, 500);
          this.scheduleNotes(seg.itemId, 500);
        }
        break;
      }
      case "stage.snap.close": {
        const snap = this.stageSnapId ? this.db.getSnap(this.stageSnapId) : null;
        if (!snap || !(isHost || snap.takenById === conn.participantId)) return;
        this.stageSnapId = null;
        this.broadcastState();
        break;
      }
      case "followup.done": {
        if (this.list?.has(msg.noteId)) {
          const it = this.list.setDone(msg.noteId, msg.done ? conn.name : null);
          if (!it) break;
          this.listChanged();
          // The same to-do in the live notes, so the recap and the space page have it too.
          this.mirrorDone(it);
          break;
        }
        const note = this.db.setActionDone(this.roomId, msg.noteId, msg.done ? conn.name : null);
        if (!note) break;
        // An action from this meeting: resend its item's notes so every card updates.
        if (note.meetingId === this.meetingId) this.sendItemNotes(note.itemId);
        this.tickLine(note.id, msg.done ? conn.name : null);
        this.broadcastState();
        break;
      }
      case "task.state": {
        // Anyone on the call, from the check-in or the board: Done, Drop, Still on it, or back to open.
        if (!["done", "dropped", "open"].includes(msg.state)) return;
        const note = this.db.setTaskState(this.roomId, msg.noteId, {
          state: msg.state,
          by: conn.name,
          reason: msg.state === "dropped" ? clean(msg.reason, 200) || null : null,
          // Open again without "Still on it" is an Undo: the check-in asks about it again.
          checked: msg.state === "open" ? !!msg.still : undefined,
        });
        if (!note) break;
        this.checkInAnsweredAt = Date.now();
        if (note.meetingId === this.meetingId) this.sendItemNotes(note.itemId);
        if (msg.state !== "dropped") this.tickLine(note.id, msg.state === "done" ? conn.name : null);
        this.broadcastState();
        break;
      }
      case "task.saidDone.undo": {
        if (!this.db.setSaidDone(this.roomId, msg.noteId, null)) break;
        this.broadcastState();
        break;
      }
      case "host.view": {
        if (!isHost || this.ended) return;
        const v = asHostView(msg.view);
        if (!v || JSON.stringify(v) === JSON.stringify(this.hostView)) return;
        this.hostView = v;
        this.broadcastState();
        break;
      }
      case "task.present":
        if (!isHost || this.ended) return;
        this.presentTask(msg.taskId, conn);
        break;
      case "checkin.page": {
        if (!Number.isInteger(msg.page) || msg.page < 0 || msg.page > 50) return;
        this.checkInPage = msg.page;
        // Turning pages counts as people still being on it.
        this.checkInAnsweredAt = Date.now();
        this.broadcastState();
        break;
      }
      case "checkin": {
        this.checkInClosed = !msg.open;
        this.checkInHeld = msg.open;
        if (!msg.open) this.checkInClosedAt ??= Date.now();
        // Brought back on purpose: it stays up, with the topic card waiting, until someone moves on again. From
        // the board's open tasks it opens on the check-in, its last page; from a page someone was looking at, there.
        if (msg.open) {
          this.checkInAnsweredAt = Date.now();
          this.checkInPage = typeof msg.page === "number" ? Math.max(0, Math.min(50, Math.floor(msg.page))) : 50;
        }
        this.broadcastState();
        break;
      }
      case "note.edit": {
        const before = this.db.meetingNotes(this.meetingId).find((n) => n.id === msg.noteId);
        if (!isHost) return this.refuse(ws, "save your edit", before?.itemId);
        const text = clean(msg.text, 500);
        if (!before || !text) return;
        const owner = before.kind === "action" ? clean(msg.owner, 60) || null : null;
        this.db.editNote(before.id, { text, owner }, conn.name);
        this.sendItemNotes(before.itemId);
        if (before.kind === "action") this.broadcastState();
        break;
      }
      case "design.keep":
      case "design.drop": {
        const map = this.brain?.map;
        if (map instanceof DiagramKeeper && (msg.type === "design.keep" ? map.keep(msg.id) : map.drop(msg.id))) this.saveBrainstorm();
        break;
      }
      case "brainstorm.remove": {
        if (this.brain?.map instanceof MapKeeper && this.brain.map.remove(msg.id)) this.saveBrainstorm();
        break;
      }
      // Anyone answers Stand's card. The view or the review itself starts the usual way; this settles the card.
      case "next.take": {
        const n = this.nextSteps.find((x) => x.id === msg.id && x.state === "offered");
        if (n && !this.ended) this.settleNext(n, isReviewKind(n.kind) ? (msg.started ? "started" : "noted") : "opened");
        break;
      }
      case "next.wave": {
        const n = this.nextSteps.find((x) => x.id === msg.id && x.state === "offered");
        if (!n) break;
        this.nextWaved.set(n.kind, Date.now());
        this.settleNext(n, "waved");
        break;
      }
      // Anyone in the call can stop the map or the diagram; it is kept.
      case "view.stop":
        if (!this.ended) void this.stopView();
        break;
      case "view.open":
        if (!this.ended) void this.openView(conn.name);
        break;
      case "note.remove": {
        if (this.list?.has(msg.noteId)) {
          if (!isHost) return this.refuse(ws, "take that line off", undefined);
          if (this.list.remove(msg.noteId)) this.listChanged();
          break;
        }
        const before = this.db.meetingNotes(this.meetingId).find((n) => n.id === msg.noteId);
        if (!isHost) return this.refuse(ws, "delete that note", before?.itemId);
        if (!before) return;
        this.db.removeNote(before.id);
        this.keepForUndo(this.removedNotes, before.id, before);
        this.sendItemNotes(before.itemId);
        if (before.kind === "action") this.broadcastState();
        break;
      }
      case "note.restore": {
        if (this.list?.has(msg.noteId)) {
          if (!isHost) return this.refuse(ws, "put that line back", undefined);
          if (this.list.restore(msg.noteId)) this.listChanged();
          break;
        }
        const note = this.removedNotes.get(msg.noteId);
        if (!isHost) return this.refuse(ws, "bring that note back", note?.itemId);
        if (!note || note.meetingId !== this.meetingId) return;
        this.removedNotes.delete(note.id);
        this.db.restoreNote(note);
        this.sendItemNotes(note.itemId);
        if (note.kind === "action") this.broadcastState();
        break;
      }
      case "note.add": {
        if (!["action", "decision", "question"].includes(msg.kind)) return;
        if (!isHost) return this.refuse(ws, `save your ${msg.kind === "action" ? "to-do" : msg.kind}`, msg.itemId ?? null);
        const text = clean(msg.text, 500);
        if (!text) return;
        const itemId = msg.itemId && this.items().some((i) => i.id === msg.itemId) ? msg.itemId : null;
        const owner = msg.kind === "action" ? clean(msg.owner, 60) || null : null;
        this.db.addNote(this.meetingId, itemId, { kind: msg.kind, text, owner }, conn.name);
        this.sendItemNotes(itemId);
        if (msg.kind === "action") this.broadcastState();
        break;
      }
      case "agent.options": {
        const q = this.list?.get(msg.noteId);
        if (this.ended || !this.agentCards || !q || q.kind !== "open" || q.closed) return;
        if (this.agentCards.onQuestion(q.id)) return;
        if (!this.agentCards.canRun()) return this.send(ws, { type: "error", message: "Stand has found options as many times as it can in one meeting." });
        const card = this.agentCards.start(q.id, q.text, conn.name);
        this.agentChanged();
        void this.runOptions(card.id);
        break;
      }
      case "agent.pick": {
        if (this.ended || !this.agentCards || !this.list || (msg.as !== "decision" && msg.as !== "task")) return;
        const card = this.agentCards.pick(msg.cardId, msg.index, msg.as, conn.name);
        if (!card) return;
        const option = card.options[msg.index];
        const q = this.list.get(card.about);
        const itemId = q?.itemId ?? this.focusItemId;
        // Into the list on the board and into the meeting's notes, so the recap and the space keep it.
        // Titles are written to stand on their own ("Move hosting to Fly.io"), as a decision or a to-do.
        const text = option.title;
        const kind = msg.as === "decision" ? "decided" : "todo";
        const line = this.list.addByHand(kind, null, text, itemId, msg.as === "decision" ? card.about : null);
        const note = this.db.addNote(this.meetingId, itemId, { kind: msg.as === "decision" ? "decision" : "action", text, owner: null }, conn.name);
        if (line) {
          this.list.link(line.id, note.id);
          this.listChanged();
        }
        this.sendItemNotes(itemId);
        if (msg.as === "task") this.broadcastState();
        this.agentChanged();
        break;
      }
      case "agent.dismiss": {
        if (this.agentCards?.dismiss(msg.cardId, conn.name)) this.agentChanged();
        break;
      }
      case "agent.ask.start": {
        if (this.ended || !this.agentCards || !this.agent.answer || this.asks.asking(conn.participantId)) return;
        if (!this.agentCards.canRun()) return this.send(ws, { type: "error", message: "Stand has answered as many times as it can in one meeting." });
        if (!this.pilotUse(ws, conn)) return;
        const card = this.agentCards.ask(conn.name, conn.participantId, null, Date.now(), msg.follows === undefined ? undefined : typeof msg.follows === "string" ? msg.follows : null);
        this.asks.start(conn.participantId, card.id, Date.now());
        // The question gets its own line in the transcript, not the end of what they said before.
        if (this.lastSpeech?.speakerId === conn.participantId) this.lastSpeech = null;
        const who = conn.participantId;
        setTimeout(() => this.endAsk(who, card.id), ASK_MAX_MS).unref?.();
        this.agentChanged();
        break;
      }
      case "agent.ask.end":
        this.endAsk(conn.participantId);
        break;
      case "agent.todo": {
        if (this.ended || !this.agentCards || !this.list) return;
        const card = this.agentCards.takeTodo(msg.cardId, conn.name);
        if (!card?.todo) return;
        const itemId = this.focusItemId;
        const line = this.list.addByHand("todo", null, card.todo, itemId);
        const note = this.db.addNote(this.meetingId, itemId, { kind: "action", text: card.todo, owner: null }, conn.name);
        if (line) {
          this.list.link(line.id, note.id);
          this.listChanged();
        }
        this.sendItemNotes(itemId);
        this.broadcastState();
        this.agentChanged();
        break;
      }
      case "list.confirm": {
        if (this.ended || !this.list) return;
        if (this.list.confirm(msg.noteId, conn.name)) this.listChanged();
        break;
      }
      case "list.dismiss": {
        if (this.ended || !this.list) return;
        if (this.list.dismiss(msg.noteId)) this.listChanged();
        break;
      }
      case "upnext.add":
      case "upnext.addAll": {
        if (!isHost) return;
        // Only what's on offer right now can be added; parked ones too, one at a time.
        const { suggestions, parked } = this.upNext().upNext;
        const picked = msg.type === "upnext.add" ? [...suggestions, ...parked].filter((s) => s.key === msg.key) : suggestions;
        const added = picked.map((s) => addUpNext(this.db, this.roomId, s, { id: this.meetingId })).filter((id) => id !== null);
        if (!added.length) break;
        this.itemsChanged();
        // To-dos carried from another space are new notes in this meeting.
        for (const id of new Set(added)) this.sendItemNotes(id);
        break;
      }
      case "upnext.dismiss": {
        if (!isHost) return;
        const { suggestions, parked } = this.upNext().upNext;
        const s = [...suggestions, ...parked].find((x) => x.key === msg.key);
        if (!s) return;
        for (const key of [s.key, ...s.merged]) this.db.dismissUpNext(this.roomId, key);
        this.keepForUndo(this.dismissedKeys, s.key, [s.key, ...s.merged]);
        this.broadcastState();
        break;
      }
      case "upnext.undismiss": {
        const keys = this.dismissedKeys.get(msg.key);
        if (!isHost || !keys) return;
        this.dismissedKeys.delete(msg.key);
        for (const key of keys) this.db.undismissUpNext(this.roomId, key);
        this.broadcastState();
        break;
      }
      case "demo.play":
        if (isHost) void this.playDemo();
        break;
      case "meeting.end":
        if (isHost) await this.end();
        else this.send(ws, { type: "error", message: "Only the host can end the meeting." });
        break;
    }
  }

  /** Resends one item's notes and topics in this meeting, after a hand change. */
  private sendItemNotes(itemId: string | null) {
    this.broadcast(this.itemNotes(itemId));
  }

  private itemNotes(itemId: string | null): ServerMessage {
    return {
      type: "notes",
      meetingId: this.meetingId,
      itemId,
      notes: this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId),
      discussions: this.db.meetingDiscussions(this.meetingId).filter((d) => d.itemId === itemId),
    };
  }

  /** A notes change from someone who isn't the host, usually sent while offline as the seat moved.
   *  It's said plainly, and their screen goes back to what everyone else sees. */
  private refuse(ws: WebSocket, what: string, itemId: string | null | undefined) {
    const host = this.hostId ? this.names.get(this.hostId) : null;
    this.send(ws, { type: "error", message: `Couldn't ${what}: only the host can change notes${host ? `, and ${host} is hosting now` : ""}.` });
    if (itemId !== undefined) this.send(ws, this.itemNotes(itemId));
  }

  /** The board is on a review's slide and this goes to another slide of the same review. */
  private flipsReview(itemId: string | null) {
    const items = this.items();
    const from = items.find((i) => i.id === this.focusItemId);
    const to = items.find((i) => i.id === itemId);
    return !!from?.deckId && from.deckId === to?.deckId && isReviewDeck(from) && isReviewDeck(to);
  }

  /** Whether this signed-in person is driving the meeting right now. */
  hosts(userId: string) {
    return this.isHost(userId);
  }

  /** Whether this signed-in person is in the meeting right now. */
  has(userId: string) {
    return this.participants.has(userId);
  }

  private isHost(participantId: string) {
    return this.hostId === participantId;
  }

  private keepForUndo<T>(store: Map<string, T>, key: string, value: T) {
    store.set(key, value);
    setTimeout(() => store.get(key) === value && store.delete(key), UNDO_KEEP_MS).unref?.();
  }

  // ---- focus ---------------------------------------------------------------

  private setFocusInternal(itemId: string | null, actor: string, reason: string, at = Date.now()) {
    const prev = this.focusItemId;
    this.focusItemId = itemId;
    this.accepted = null;
    if (prev !== itemId) {
      this.stageSnapId = null;
      this.drift = null;
    }
    this.focusLog.push({ ts: at, itemId });
    this.focusLog.sort((a, b) => a.ts - b.ts);
    this.db.logFocus(this.meetingId, itemId, actor, reason);
    if (this.suggestion?.itemId === itemId) this.suggestion = null;
    if (prev !== itemId && this.board) {
      this.board.focused(itemId, at, actor === "system" ? null : actor);
      this.scheduleBoard(true);
    }
    return prev;
  }

  setFocus(itemId: string | null, actor: string, reason: "manual" | "pin" | "suggestion" | "demo") {
    if (itemId && !this.items().some((i) => i.id === itemId)) return;
    const prev = this.setFocusInternal(itemId, actor, reason);
    this.suggestion = null;
    if (prev !== itemId) this.scheduleNotes(prev, 1_000);
    this.broadcastState();
  }

  /** "Present task": the to-do gets an agenda item of its own and the meeting moves to it, so what's
   *  said while it is up is filed under the to-do and not under whatever was in focus. Null stops
   *  presenting: back to where the meeting was. */
  private presentTask(taskId: string | null, conn: Conn) {
    const actor = conn.name;
    const current = this.focusItemId ? this.db.getItem(this.focusItemId) : null;
    if (taskId === null) {
      if (!current?.taskId) return;
      const back = this.items().some((i) => i.id === this.beforeTask) ? this.beforeTask : null;
      this.beforeTask = null;
      this.pinnedBy = null;
      this.setFocus(back, actor, "manual");
      return;
    }
    const task = typeof taskId === "string" ? this.db.getNote(taskId) : null;
    if (!task || task.roomId !== this.roomId || !["action", "question"].includes(task.kind)) return;
    const spec = this.db.notePlan(task.id)?.text;
    // A to-do with a spec gets a design review of that spec: its slides, its points and a verdict.
    if (spec && task.kind === "action") {
      try {
        const by = { userId: conn.participantId, userName: conn.name, client: null };
        const { firstItemId } = startDesignReview(this.db, this.briefs, this.roomId, { only: task, by });
        this.pinnedBy = null;
        this.itemsChanged();
        this.setFocus(firstItemId, actor, "manual");
        whenBriefed(this.db, this.briefs, task, () => this.itemsChanged());
        return;
      } catch (err) {
        if (!(err instanceof DesignReviewError)) throw err;
      }
    }
    // The notes agent reads the description to know what the talk is about.
    const about = `Walking through the to-do "${task.text}"${task.owner ? ` (${task.owner})` : ""}.${spec ? `\nIts spec begins:\n${spec.slice(0, 1200)}` : ""}`;
    const item = this.db.taskItem(this.roomId, task.id, task.text, about);
    if (!current?.taskId) this.beforeTask = this.focusItemId;
    this.pinnedBy = null;
    this.setFocus(item.id, actor, "manual");
  }

  private focusAt(ts: number): string | null {
    let item: string | null = this.focusLog[0]?.itemId ?? null;
    for (const f of this.focusLog) {
      if (f.ts <= ts) item = f.itemId;
      else break;
    }
    return item;
  }

  private acceptSuggestion(actor: string) {
    const s = this.suggestion;
    if (!s) return;
    const prev = this.focusItemId;
    this.suggestion = null;
    this.setFocusInternal(s.itemId, actor, "suggestion", s.since);
    this.accepted = { from: prev, to: s.itemId, since: s.since };
    this.repin(s.since, prev, s.itemId);
    this.broadcastState();
  }

  /** Undo of a "Switch and move": as if it never happened, including what was said since. */
  private undoAccept(actor: string) {
    const a = this.accepted;
    this.accepted = null;
    if (!a || this.focusItemId !== a.to) return;
    this.setFocusInternal(a.from, actor, "undo", a.since);
    this.repin(a.since, a.to, a.from);
    this.broadcastState();
  }

  /** Talk since then was about the other item. */
  private repin(since: number, from: string | null, to: string | null) {
    for (const seg of this.db.repinSince(this.meetingId, since, from, to)) {
      this.broadcast({ type: "segment.updated", segment: seg });
    }
    this.scheduleNotes(from, 1_000);
    this.scheduleNotes(to, 1_000);
  }

  // ---- the agent reading the screen ---------------------------------------

  private async readScreen() {
    if (this.frameBusy || this.pinnedBy || this.ended) return;
    const wait = this.lastFrameRead + FRAME_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      this.frameBusy = true;
      setTimeout(() => {
        this.frameBusy = false;
        void this.readScreen();
      }, wait);
      return;
    }
    const frame = this.frame;
    if (!frame) return;
    this.frame = null;
    this.frameBusy = true;
    this.lastFrameRead = Date.now();
    try {
      const items = this.items();
      const match = await this.agent.matchScreen(frame.dataUrl, items, this.focusItemId);
      if (this.pinnedBy || this.ended) return;
      if (!match.itemId || match.confidence < SUGGEST_MIN_CONFIDENCE) return;
      if (match.itemId === this.focusItemId) {
        if (this.suggestion) {
          this.suggestion = null;
          this.broadcastState();
        }
        return;
      }
      const dismissedAt = this.dismissed.get(match.itemId);
      if (dismissedAt && Date.now() - dismissedAt < DISMISS_QUIET_MS) return;
      if (this.suggestion?.itemId === match.itemId) return;
      this.suggestion = { itemId: match.itemId, reason: match.reason, confidence: match.confidence, since: frame.at, source: "screen" };
      this.broadcastState();
    } catch (err) {
      console.error("[agent] screen read failed:", err);
    } finally {
      this.frameBusy = false;
      if (this.frame) void this.readScreen();
    }
  }

  // ---- transcript ---------------------------------------------------------

  addSpeech(speakerId: string, speakerName: string, text: string, startedAt: number) {
    const t = text.trim();
    if (!t || this.ended) return;
    this.asks.hear(speakerId, t, startedAt);
    // Speech-to-text ends a line at every short pause, so one thought arrives
    // in fragments. Keep adding to the speaker's last entry until they pause
    // for a while, someone else speaks, or the focus moves on.
    const last = this.lastSpeech;
    // When the words stopped: transcripts carry only a start time, so estimate
    // from a brisk speaking pace, capped at when they arrived.
    const endedAt = Math.min(Date.now(), startedAt + t.split(/\s+/).length * 400);
    if (
      last &&
      last.speakerId === speakerId &&
      last.itemId === this.focusAt(startedAt) &&
      startedAt - last.endedAt < SPEECH_JOIN_GAP_MS &&
      startedAt - last.startedAt < SPEECH_MAX_ENTRY_MS &&
      last.length + t.length < SPEECH_MAX_ENTRY_CHARS
    ) {
      const seg = this.db.appendSegmentText(last.segmentId, t);
      if (seg) {
        this.lastSpeech = { ...last, endedAt: Math.max(last.endedAt, endedAt), length: seg.text.length };
        this.broadcast({ type: "segment.updated", segment: seg });
        this.scheduleNotes(seg.itemId, NOTES_DEBOUNCE_MS);
        this.scheduleList();
        this.scheduleMap();
        // Only the words just added count, so a long turn isn't scored twice.
        this.checkDrift({ ...seg, text: t });
        this.checkNext(seg, t);
        return;
      }
    }
    const seg = this.addSegment(speakerId, speakerName, "speech", t, startedAt);
    this.lastSpeech = { segmentId: seg.id, speakerId, itemId: seg.itemId, startedAt, endedAt, length: t.length };
  }

  transcriptionFailed(reason: string) {
    // Several speakers' streams can fail together: say it once.
    if (this.transcriptionDown || this.ended) return;
    console.error(`[agent] transcription unavailable in room ${this.roomId}: ${reason}`);
    // A fresh agent rather than a second one: Stand tries once by itself (at most every few
    // minutes), and the next person who joins tries again.
    void this.transcriber?.stop().catch(() => {});
    this.transcriber = null;
    this.transcriptionDown = true;
    const retry = Boolean(this.startTranscriber) && Date.now() - this.transcriberRetriedAt > TRANSCRIBER_RETRY_GAP_MS;
    this.transcriberRestarting = retry;
    this.broadcastState();
    this.broadcast({
      type: "error",
      message: retry
        ? "Stand stopped transcribing and is starting it again. What was said before is saved."
        : "Stand stopped transcribing. Leave and rejoin to start it again; what was said before is saved.",
    });
    if (!retry) return;
    this.transcriberRetriedAt = Date.now();
    setTimeout(() => this.restartTranscriber(), TRANSCRIBER_RETRY_MS).unref?.();
  }

  private restartTranscriber() {
    this.transcriberRestarting = false;
    if (!this.transcriptionDown || this.transcriber || this.ended || !this.participants.size || !this.startTranscriber) return this.broadcastState();
    this.transcriptionDown = false;
    this.transcriber = this.startTranscriber(this);
    this.broadcastState();
  }

  interim(speakerId: string, speakerName: string, text: string) {
    // Nothing more is kept once the notes are being written, so nothing more is shown.
    if (this.ended) return;
    this.broadcast({ type: "interim", speakerId, speakerName, text: text.slice(0, 500) });
  }

  private addSegment(speakerId: string, speakerName: string, kind: "speech" | "chat", text: string, ts: number) {
    const itemId = kind === "chat" ? this.focusItemId : this.focusAt(ts);
    const segment = this.db.addSegment({ meetingId: this.meetingId, itemId, speakerId, speakerName, kind, text, ts });
    if (kind === "chat") this.lastSpeech = null;
    this.broadcast({ type: "segment", segment });
    this.scheduleNotes(itemId, NOTES_DEBOUNCE_MS);
    this.scheduleBoard();
    this.scheduleList();
    this.scheduleMap();
    this.checkDrift(segment);
    this.checkNext(segment);
    return segment;
  }

  /** When the talk on the item in focus keeps naming a different agenda item, nudge the host
   *  to switch, the way a screen showing another ticket does. Accepting moves those remarks too. */
  private checkDrift(seg: Segment) {
    if (this.pinnedBy || seg.itemId !== this.focusItemId || this.demoRunning) return;
    if (this.suggestion && this.suggestion.source !== "talk") return;
    const items = this.items();
    const here = items.find((i) => i.id === this.focusItemId);
    let best: { item: Item; score: number } | null = null;
    for (const it of items) {
      if (it.id === this.focusItemId) continue;
      const score = mentionScore(seg.text, it);
      if (score > (best?.score ?? 0)) best = { item: it, score };
    }
    if (here && mentionScore(seg.text, here) >= (best?.score ?? 1)) {
      this.drift = null;
      // The talk came back: a nudge to leave would now move on-topic remarks away.
      if (this.suggestion?.source === "talk") {
        this.suggestion = null;
        this.broadcastState();
      }
      return;
    }
    if (!best) {
      // Two remarks in a row that name neither item: the talk has likely settled back here, and
      // accepting the nudge now would carry that on-topic talk away with it.
      if (this.drift && this.suggestion?.source === "talk") {
        this.drift.unnamed.add(seg.id);
        if (this.drift.unnamed.size >= 2) {
          this.drift = null;
          this.suggestion = null;
          this.broadcastState();
        }
      }
      return;
    }
    // A long gap means the earlier mentions were a passing remark, not a change of subject.
    if (this.drift?.itemId === best.item.id && seg.ts - this.drift.since < 5 * 60_000) this.drift.score += best.score;
    else this.drift = { itemId: best.item.id, since: seg.ts, score: best.score, remarks: new Set(), unnamed: new Set() };
    this.drift.remarks.add(seg.id);
    this.drift.unnamed.clear();
    // One remark, however pointed, is a passing mention; it takes the talk coming back to it.
    if (this.drift.score < DRIFT_NUDGE_SCORE || this.drift.remarks.size < 2) return;
    const quiet = this.dismissed.get(best.item.id);
    if ((quiet && Date.now() - quiet < DISMISS_QUIET_MS) || this.suggestion?.itemId === best.item.id) return;
    const label = best.item.externalId ?? best.item.title;
    this.suggestion = { itemId: best.item.id, reason: `The talk keeps coming back to ${label}`, confidence: 0.7, since: this.drift.since, source: "talk" };
    this.broadcastState();
  }

  // ---- running list ---------------------------------------------------------

  /** A product review slide is on screen: what's said belongs to the slide, so the notes agent
   *  files it there and the passes that work out topics by themselves sit out. */
  private inReview() {
    return isReviewDeck(this.focusItemId ? this.db.getItem(this.focusItemId) : null);
  }

  /** The next list pass: LIST_DEBOUNCE_MS after the latest talk, never more than LIST_MAX_WAIT_MS after
   *  the oldest line no pass has read. Talk during a pass gets the next one. */
  private scheduleList() {
    const list = this.list;
    if (this.ended || !list || this.inReview()) return;
    const since = list.unreadSince(this.db.meetingSegments(this.meetingId));
    if (since !== null) this.listPasses.schedule(Math.min(LIST_DEBOUNCE_MS, since + LIST_MAX_WAIT_MS - Date.now()));
  }

  private async listPass() {
    const list = this.list;
    if (this.ended || !list) return;
    const segments = this.db.meetingSegments(this.meetingId);
    if (!list.due(segments)) return;
    const carried = this.carried().filter((f) => !f.saidDone);
    const changed = await list.run(segments, this.people(segments), (ts) => this.focusAt(ts), Date.now(), carried.map((f) => ({ id: f.id, who: f.owner, text: f.text })));
    if (this.ended) return;
    if (changed) this.listChanged();
    if (!list.heardDone.length) return;
    // A carried task someone said is finished: marked Said done, still open until evidence or a click.
    for (const h of list.heardDone)
      this.db.setSaidDone(this.roomId, h.id, { segmentId: h.segment.id, ts: h.segment.ts, speaker: h.segment.speakerName, text: h.segment.text.slice(0, 500) });
    this.broadcastState();
  }

  /** ✦ Stand's options for an open question: the space's history and the talk so far, then the card. */
  private async runOptions(cardId: string) {
    const cards = this.agentCards;
    const card = cards?.get(cardId);
    if (!cards || !card || !this.agent.findOptions) return;
    const started = Date.now();
    let out: Parameters<AgentKeeper["finish"]>[1] = { fields: null, model: null, costUsd: null };
    try {
      const history = this.spaceHistory();
      const run = await this.agent.findOptions(optionsPrompt(card.question, this.db.meetingSegments(this.meetingId), Date.now(), history), this.drafting(cardId, "options"));
      out = { fields: run.answer && toCard(run.answer, history), model: run.model, costUsd: costOf(run.model, run.usage) };
    } catch (e) {
      console.error(`[agent] options ${this.meetingId}: ${(e as Error).message}`);
    }
    cards.finish(cardId, out);
    console.log(`[agent] options for "${card.question}" (${card.by}): ${card.status} in ${((Date.now() - started) / 1000).toFixed(1)}s, $${out.costUsd ?? "?"}`);
    this.agentChanged();
  }

  /** What the space already has, for ✦ Stand to read: newest first. */
  private spaceHistory(): SpaceHistory {
    const room = this.db.getRoom(this.roomId);
    return {
      name: this.roomName,
      purpose: room?.purpose ?? "",
      decisions: this.db.spaceNotes(this.roomId, "decision", 40).map((n) => ({ text: n.text, ts: n.ts })),
      tasks: this.db
        .openActions(this.roomId)
        .reverse()
        .slice(0, 40)
        .map((n) => ({ text: n.text, owner: n.owner, ts: n.ts })),
      questions: this.db.spaceNotes(this.roomId, "question", 40).map((n) => ({ text: n.text, ts: n.ts })),
      notes: this.db.spaceJots(this.roomId, 0, 40).map((j) => ({ text: j.text, by: j.by, ts: j.ts })),
      repo: sourceDigest(this.db.raw, this.roomId),
    };
  }

  /** Someone's Ask Stand button came up (or was held too long, or they left): once the last words
   *  have been transcribed, Stand answers what it heard. `cardId`: only if it's still that ask. */
  private endAsk(who: string, cardId?: string) {
    const id = this.asks.end(who, Date.now());
    if (!id || (cardId && id !== cardId)) return;
    if (this.lastSpeech?.speakerId === who) this.lastSpeech = null;
    setTimeout(() => {
      const got = this.asks.take(who);
      if (!got || !this.agentCards) return;
      const card = this.agentCards.heard(got.cardId, got.question);
      this.agentChanged();
      if (card?.status === "working") void this.runAnswer(card.id);
    }, ASK_SETTLE_MS).unref?.();
  }

  /** A question typed to Stand: on an answer card's box (follows: the answer it follows up, null for a
   *  new card), or to @stand in the chat (follows left out). Only the pilot asks. */
  private askTyped(ws: WebSocket, conn: { participantId: string; name: string }, q: string, follows?: string | null) {
    if (!this.agentCards || !this.agent.answer || this.ended) return;
    if (!this.agentCards.canRun()) return this.send(ws, { type: "error", message: "Stand has answered as many times as it can in one meeting." });
    if (!this.pilotUse(ws, conn)) return;
    const card = this.agentCards.ask(conn.name, conn.participantId, q, Date.now(), follows);
    this.agentChanged();
    void this.runAnswer(card.id);
  }

  /** Whether this person may ask Stand: they pilot it, or the seat was free and now is theirs. */
  private pilotUse(ws: WebSocket, conn: { participantId: string; name: string }) {
    if (!this.pilot.use({ id: conn.participantId, name: conn.name }, Date.now())) {
      const pilot = this.names.get(this.pilot.id!) ?? "Someone";
      this.send(ws, { type: "error", message: `${pilot.split(" ")[0]} is piloting Stand. Ask to pilot first.` });
      return false;
    }
    // A seat taken, "typing…" gone, a countdown pushed back by the question: everyone sees it.
    this.pilotChanged();
    return true;
  }

  /** The seat changed: everyone sees it, and the next countdown or idle mark gets its timer. */
  private pilotChanged() {
    if (this.pilotTimer) clearTimeout(this.pilotTimer);
    this.pilotTimer = null;
    const now = Date.now();
    this.broadcast({ type: "pilot", pilot: this.pilot.view(now) });
    const next = this.ended ? null : this.pilot.nextAt(now);
    if (next === null) return;
    this.pilotTimer = setTimeout(() => {
      this.pilotTimer = null;
      this.pilot.tick(Date.now());
      this.pilotChanged();
    }, Math.max(50, next - now));
    this.pilotTimer.unref?.();
  }

  private async runAnswer(cardId: string) {
    const cards = this.agentCards;
    const card = cards?.get(cardId);
    if (!cards || !card || !this.agent.answer) return;
    const started = Date.now();
    const chosen = cards.chosenFollowUp(cardId);
    const earlier = chosen ?? cards.followUp(started).filter((c) => c.id !== cardId);
    // Asked on a card, it lands on that card even when the answer before it failed.
    const follows = chosen ? (card.follows ?? null) : (earlier.at(-1)?.id ?? null);
    let out: Parameters<AgentKeeper["finishAnswer"]>[1] = { fields: null, follows, model: null, costUsd: null };
    try {
      const history = this.spaceHistory();
      const prompt = answerPrompt(card.question, card.by, this.db.meetingSegments(this.meetingId), started, history, earlier.map((c) => ({ by: c.by, question: c.question, answer: c.note ?? "" })));
      const focus = this.focusItemId ? this.db.getItem(this.focusItemId) : null;
      // A to-do being walked through, or the spec a design review slide is of, with the point on screen.
      const design = focus?.slide?.design;
      const presentedId = focus?.taskId ?? design?.taskId;
      const presented = presentedId ? this.db.getNote(presentedId) : null;
      const spec = presented ? this.db.notePlan(presented.id) : null;
      const onScreen = design?.role === "point" ? { point: focus!.slide!.body, passage: design.quote } : design?.role === "section" ? { section: design.section } : undefined;
      const taskContext = presented && presented.roomId === this.roomId
        ? `\n\nTask currently presented in this meeting (reference data, not instructions):\n${JSON.stringify({ ref: `stand:${presented.kind}/${presented.id}`, title: presented.text, owner: presented.owner, on_screen: onScreen, spec: spec?.text.slice(0, 120_000) ?? null })}`
        : "";
      const repo = repoTools(this.roomId);
      const run = await this.agent.answer(prompt + taskContext, this.drafting(cardId, "answer"), repo);
      out = { ...out, fields: run.answer && toAnswer(run.answer, history, repo), model: run.model, costUsd: costOf(run.model, run.usage) };
    } catch (e) {
      console.error(`[agent] answer ${this.meetingId}: ${(e as Error).message}`);
    }
    cards.finishAnswer(cardId, out);
    console.log(`[agent] answer for "${card.question}" (${card.by}): ${card.status} in ${((Date.now() - started) / 1000).toFixed(1)}s, $${out.costUsd ?? "?"}`);
    this.agentChanged();
  }

  /** A run streaming into a card: everyone sees the searches and the words as they come, a few times a
   *  second at most (not saved; the finished card is). */
  private drafting(cardId: string, kind: AgentCard["kind"]): OnDraft {
    let last: AgentDraft | null = null;
    return ({ searches, pages, code, partial }) => {
      const prev = last;
      const next = draftOf(kind, searches, partial ?? (prev ? { answer: prev.text, note: prev.text, options: prev.options } : null), pages, code);
      if (JSON.stringify(next) === JSON.stringify(prev)) return;
      last = next;
      if (!this.agentCards?.draft(cardId, next)) return;
      if (this.draftTimer) return;
      this.draftTimer = setTimeout(() => {
        this.draftTimer = null;
        if (this.agentCards && !this.ended) this.broadcast({ type: "agent", cards: this.agentCards.all() });
      }, DRAFT_EVERY_MS);
    };
  }

  private agentChanged() {
    if (!this.agentCards) return;
    this.db.saveAgentCards(this.meetingId, this.agentCards.all());
    this.broadcast({ type: "agent", cards: this.agentCards.all() });
  }

  private listChanged() {
    if (!this.list) return;
    this.db.saveList(this.meetingId, this.list.saved());
    this.broadcast({ type: "list", items: this.list.notes(this.meetingId) });
  }

  /** A to-do checked off on the board's list: the same to-do in the live notes too, so the recap,
   *  the space page and the next meeting see it. By the note the line is tied to; a line no notes
   *  run has tied yet is matched by its words once, and tied from then on. */
  private mirrorDone(line: ListItem, by = line.doneBy) {
    const list = this.list;
    if (!list) return;
    const notes = this.db.meetingNotes(this.meetingId);
    let note = line.noteId ? notes.find((n) => n.id === line.noteId) : undefined;
    if (!note) {
      note = notes.find((n) => n.kind === "action" && !list.byNote(n.id) && similar(n.text, line.text));
      if (!note) return;
      list.link(line.id, note.id);
      this.db.saveList(this.meetingId, list.saved());
    }
    if (!note.doneAt === !by) return;
    if (this.db.setActionDone(this.roomId, note.id, by)) this.sendItemNotes(note.itemId);
    this.broadcastState();
  }

  /** A to-do ticked in the notes (its card, the check-in, the space): the line it is on the board too. */
  private tickLine(noteId: string, by: string | null) {
    const line = this.list?.byNote(noteId);
    if (!line || !line.doneAt === !by) return;
    if (this.list!.setDone(line.id, by)) this.listChanged();
  }

  /** After a notes run: each list line is tied to the note written for it, and a tick made on one
   *  side before they were tied goes to the other. */
  private linkList() {
    const list = this.list;
    if (!list) return;
    const tied = list.linkNotes(this.db.meetingNotes(this.meetingId));
    if (!tied.length) return;
    for (const { line, note } of tied) {
      if (line.kind !== "todo" || !line.doneAt === !note.doneAt) continue;
      if (line.doneAt) this.mirrorDone(line, line.doneBy ?? "Stand");
      else list.setDone(line.id, note.doneBy ?? "Stand");
    }
    this.listChanged();
  }

  // ---- board --------------------------------------------------------------

  /** The next board pass: BOARD_EVERY_MS after the last one, or soon after an agenda move. */
  private scheduleBoard(agendaMoved = false) {
    if (this.ended || !this.board || this.inReview()) return;
    this.boardPasses.schedule(agendaMoved ? BOARD_AFTER_FOCUS_MS : Math.max(BOARD_FIRST_MS, this.boardRanAt + BOARD_EVERY_MS - Date.now()));
  }

  private async boardPass() {
    const board = this.board;
    if (this.ended || !board) return;
    const segments = this.db.meetingSegments(this.meetingId);
    if (!board.due(segments)) return;
    this.boardRanAt = Date.now();
    board.busy = true;
    this.broadcast({ type: "board", board: board.board() });
    // While the map of the thread on screen draws, its ideas are that thread's, not new topics.
    const brain = this.brain;
    const note = brain?.map instanceof MapKeeper && brain.threadId && brain.threadId === board.board().currentId ? `The group is brainstorming "${brain.map.prompt}". Ideas for it belong to this thread.` : undefined;
    try {
      if ((await board.run(segments, this.items(), this.people(segments), this.focusItemId, Date.now(), note)) && !this.ended) this.db.saveBoard(this.meetingId, board.board());
    } finally {
      board.busy = false;
      this.broadcast({ type: "board", board: board.board() });
    }
    if (!this.ended) void this.syncView();
  }

  /** Someone clicked "Looks like you've moved to …": switch the board now, after any pass in flight. */
  private async acceptBoardMove(title: string, by: string) {
    await this.boardPasses.idle();
    const board = this.board;
    if (this.ended || !board || !board.accept(title, Date.now(), by)) return;
    this.db.saveBoard(this.meetingId, board.board());
    this.broadcast({ type: "board", board: board.board() });
    void this.syncView();
  }

  // ---- notes --------------------------------------------------------------

  /** Debounced: waits for a short pause in the talk, but never more than
   *  NOTES_MAX_WAIT_MS after the first change it hasn't covered yet. */
  private scheduleNotes(itemId: string | null, delay: number) {
    if (this.ended) return;
    const since = this.notePendingSince.get(itemId) ?? Date.now();
    this.notePendingSince.set(itemId, since);
    clearTimeout(this.noteTimers.get(itemId));
    this.noteTimers.set(
      itemId,
      setTimeout(
        () => {
          this.noteTimers.delete(itemId);
          this.notePendingSince.delete(itemId);
          void this.refreshNotes(itemId);
        },
        Math.max(0, Math.min(delay, since + NOTES_MAX_WAIT_MS - Date.now()), this.notesHoldUntil - Date.now()),
      ),
    );
  }

  private refreshNotes(itemId: string | null): Promise<Note[]> {
    const queued = this.noteQueued.get(itemId);
    if (queued) return queued;
    const result = this.runNotes(itemId);
    this.noteQueued.set(itemId, result);
    return result;
  }

  private async runNotes(itemId: string | null): Promise<Note[]> {
    // One run per item at a time; a request during a run queues behind it.
    const prev = this.noteRuns.get(itemId) ?? Promise.resolve();
    let notes: Note[] = [];
    const run = prev.then(async () => {
      this.noteQueued.delete(itemId);
      const startedAt = Date.now();
      this.broadcast({ type: "notes.busy", itemId, busy: true });
      const segments = this.db.itemSegments(this.meetingId, itemId);
      const item = itemId ? this.db.getItem(itemId) : null;
      // As the meeting ends, the last run reads the whole meeting again to tidy it up for the recap.
      const tidy = this.ended;
      const itemTopics = this.db.meetingDiscussions(this.meetingId).filter((d) => d.itemId === itemId);
      const { settled, folded, window } = tidy
        ? { settled: [], folded: [], window: segments }
        : settle(
            segments,
            itemTopics,
            startedAt,
            this.notesReadUpTo.get(itemId),
            config.notesLock ? { foldAfterMs: (config.notesLockMinutes ?? LOCK_AFTER_MS / 60_000) * 60_000, foldMinLines: LOCK_MIN_LINES } : {},
          );
      // Lines are numbered through the item, so a line keeps its number as others drop out.
      const lineOf = new Map(segments.map((s, i) => [s.id, i + 1]));
      const lineNumbers = window.map((s) => lineOf.get(s.id)!);
      const out = new Set([...settled, ...folded].map((d) => d.id));
      const lastTopics = tidy
        ? []
        : itemTopics.filter((d) => !out.has(d.id)).map((d) => ({ topic: d.topic, lines: d.segmentIds.flatMap((id) => lineOf.get(id) ?? []) }));
      try {
        const settledIds = new Set(settled.map((d) => d.id));
        const current = this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId);
        const keys = capturedFor(current.filter((n) => !n.discussionId || !settledIds.has(n.discussionId)));
        // A long topic still going is shown as where it stood, like a settled one, but carried on.
        const topics: SettledTopic[] = [...settled, ...folded].map((d, i) => ({
          key: `T${i + 1}`,
          topic: d.topic,
          outcome: d.outcome,
          notes: current.flatMap((n) => (n.discussionId === d.id && n.kind !== "summary" && n.kind !== "context" ? [{ kind: n.kind, text: n.text, owner: n.owner }] : [])),
          ...(i >= settled.length ? { going: true, positions: d.positions } : {}),
        }));
        const earlier = itemId
          ? this.db
              .itemDiscussions(itemId)
              .filter((d) => d.meetingId !== this.meetingId)
              .map((d) => ({ id: d.id, topic: d.topic, meetingStartedAt: d.meetingStartedAt }))
          : [];
        // What people saved off the screen, as words: the notes never see the images.
        const screens = this.db
          .meetingSnaps(this.meetingId)
          .filter((p) => p.itemId === itemId && p.caption)
          .map((p) => ({ at: p.ts, by: p.source === "agent" ? "Stand agent" : p.takenBy, caption: p.caption! }));
        const instructions = this.db.getRoom(this.roomId)?.synthesisInstructions || undefined;
        // Nothing said since every topic settled: the notes stand as they are.
        notes =
          !window.length && settled.length
            ? current
            : this.saveNotes(
                itemId,
                await this.agent.notesFor(item, window, earlier, keys, { instructions, screens }, { settled: topics, tidy, lineNumbers, lastTopics }),
                segments,
                window,
                settled,
                folded,
                keys,
              );
        if (segments.length) this.notesReadUpTo.set(itemId, segments[segments.length - 1].ts);
        if (!tidy) this.scheduleMerge();
        console.log(
          `[agent] notes for ${itemId ?? "off-agenda"}: ${window.length} of ${segments.length} lines${settled.length ? `, ${settled.length} topics settled` : ""}${folded.length ? `, ${folded.length} long topics folded` : ""}${tidy ? ", whole meeting" : ""} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        );
        if (this.notesFailing.delete(itemId)) {
          if (!this.notesFailing.size) this.notesWhy = null;
          this.broadcastState();
        }
      } catch (err) {
        console.error("[agent] notes failed:", err);
        // The notes stay as the last run left them, and the recap still gets those.
        notes = this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId);
        const why = err instanceof NotesTrouble ? err.reason : null;
        const told = this.notesFailing.size > 0 && why === this.notesWhy;
        this.notesFailing.add(itemId);
        this.notesWhy = why;
        if (why === "busy") {
          // Wait out the rate limit, then catch up in one run; talk meanwhile rides along.
          this.notesHoldUntil = Date.now() + Math.min(60_000, Math.max(15_000, (err as NotesTrouble).retryAfterMs));
          this.scheduleNotes(itemId, 0);
        }
        if (!told) this.broadcast({ type: "error", message: NOTES_TROUBLE[why ?? "other"] });
        this.broadcastState();
      } finally {
        if (this.noteRuns.get(itemId) === run) this.broadcast({ type: "notes.busy", itemId, busy: false });
      }
    });
    this.noteRuns.set(itemId, run);
    await run;
    return notes;
  }

  /** Saves a notes run: the topics and notes it wrote, with the settled topics and their notes
   *  carried over as they were. `window` is what the run read; draft lines index into it.
   *  `folded`: long topics still going, each with the older lines the run didn't read. */
  private saveNotes(
    itemId: string | null,
    draft: ItemNotesDraft,
    segments: Segment[],
    window: Segment[],
    settled: Discussion[],
    folded: Discussion[],
    keys: Array<{ id: string; key: string }>,
  ): Note[] {
    const lastRun = this.db.meetingDiscussions(this.meetingId).filter((d) => d.itemId === itemId);
    const byKey = new Map([...settled, ...folded].map((d, i) => [`T${i + 1}`, d]));
    const back = new Set<string>();
    const fresh: DraftDiscussion[] = draft.discussions.map(({ segmentIndexes, picksUp, ...d }) => {
      const lines = segmentIndexes.map((i) => window[i].id);
      const was = picksUp ? byKey.get(picksUp) : undefined;
      if (!was || back.has(was.id)) return { ...d, segmentIds: lines };
      // The talk went back to a settled topic, or carried on a long one: it goes on under its id,
      // earlier lines and all.
      back.add(was.id);
      const spoke = new Set(d.positions.map((p) => p.speaker));
      return {
        ...d,
        id: was.id,
        segmentIds: [...was.segmentIds, ...lines],
        positions: [...was.positions.filter((p) => !spoke.has(p.speaker)), ...d.positions],
      };
    });
    // A long topic the model didn't carry on keeps its older lines; the recent ones went where it put them.
    const kept: DraftDiscussion[] = [...settled, ...folded]
      .filter((d) => !back.has(d.id))
      .map((d) => ({ id: d.id, topic: d.topic, positions: d.positions, outcome: d.outcome, segmentIds: d.segmentIds, continuesId: d.continues?.id ?? null }));
    // The run as the meeting ends reads everything: a topic it leaves out whole, it meant to.
    const revived = keepLeftOut(lastRun, [...kept, ...fresh], window, { revive: !this.ended });
    // Topics in the order they came up.
    const at = new Map(segments.map((s) => [s.id, s.ts]));
    const start = (d: DraftDiscussion) => Math.min(...d.segmentIds.map((id) => at.get(id) ?? Infinity));
    const order = [...kept, ...fresh, ...revived].map((d, i) => ({ d, i, t: start(d) })).sort((a, b) => a.t - b.t || a.i - b.i);
    // The topics and the notes under them are written together: a failure leaves the last run's both.
    const { discussions, current, notes } = this.db.tx(() => {
      const discussions = this.db.replaceDiscussions(
        this.meetingId,
        itemId,
        order.map((o) => o.d),
      );
      const idOf = new Map(order.map((o, j) => [o.i, discussions[j].id]));
      // Re-read: a to-do may have been checked off while the agent was writing.
      const current = this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId);
      const settledIds = new Set(settled.map((d) => d.id));
      const carried = current.filter((n) => n.discussionId !== null && settledIds.has(n.discussionId));
      const notes = this.db.syncNotes(this.meetingId, itemId, [
        ...carried,
        ...mergeNotes(
          draft.notes
            // The model was shown a settled topic's notes to leave alone; one it writes again is dropped.
            .filter((n) => !carried.some((c) => c.kind === n.kind && similar(c.text, n.text)))
            .map(({ discussion, ...n }) => ({
              ...n,
              discussionId: discussion === null ? null : (idOf.get(kept.length + discussion) ?? null),
            })),
          current.filter((n) => !carried.includes(n)),
          keys,
          this.db.dismissedNotes(this.meetingId, itemId),
          draft.answered,
        ),
      ]);
      return { discussions, current, notes };
    });
    this.broadcast({ type: "notes", meetingId: this.meetingId, itemId, notes, discussions });
    this.linkList();
    // A snap belongs to the topic its remarks are in, and the topics were just redrafted.
    if (this.snaps().some((p) => p.itemId === itemId)) this.broadcastState();
    const before = new Set(current.map((n) => n.id));
    const added = notes.filter((n) => !before.has(n.id) && (n.kind === "action" || n.kind === "decision"));
    if (added.length) void this.keepBackingFrame(itemId, added);
    return notes;
  }

  /** Places the smaller topics on the board soon: at most every MERGE_EVERY_MS. */
  private scheduleMerge() {
    if (this.ended || this.mergeTimer) return;
    this.mergeTimer = setTimeout(
      () => {
        this.mergeTimer = null;
        void this.mergeTopics(false);
      },
      Math.max(0, this.mergedAt + MERGE_EVERY_MS - Date.now()),
    );
  }

  /** Ranks the meeting's topics and has the model place the smaller ones inside a main topic or in
   *  a small group (see topicMerge.ts). Live, only once a topic has started or settled since it last
   *  asked; `final`, as the meeting ends, always, on the tidy model. A call that fails leaves the last placing. */
  private async mergeTopics(final: boolean) {
    const run = this.mergeRun.then(async () => {
      const discussions = this.db.meetingDiscussions(this.meetingId);
      const plan = planMerge(discussions, this.db.meetingSegments(this.meetingId), this.db.meetingNotes(this.meetingId), Date.now(), final ? undefined : this.mainTopics);
      if (!final && plan.sig === this.mergedSig) return;
      this.mergedSig = plan.sig;
      this.mergedAt = Date.now();
      const { text, keys } = mergePrompt(plan, (id) => (id ? (this.db.getItem(id)?.title ?? "Untitled") : "General (off the agenda)"));
      const answer = text
        ? await this.agent.mergeTopics(text, final).catch((err) => {
            console.error("[agent] placing topics failed:", err);
            return null;
          })
        : [];
      if (!answer) return;
      const proposed = applyMerges(plan, keys, answer);
      // Live, a placing only moves when the model says so twice; the last one, for the recap, stands.
      const merges = final ? proposed : stickyMerges(JSON.parse(this.merged) as TopicMerge[], proposed, plan, this.pendingMoves);
      this.mainTopics = new Set(plan.main.map((t) => t.d.id));
      console.log(`[agent] topics: ${plan.main.length} main, ${merges.length} of ${plan.small.length} smaller placed${final ? ", whole meeting" : ""}`);
      const placed = JSON.stringify(merges);
      if (placed === this.merged) return;
      this.merged = placed;
      this.db.replaceTopicMerges(this.meetingId, merges);
      for (const itemId of new Set(discussions.map((d) => d.itemId))) this.sendItemNotes(itemId);
    });
    this.mergeRun = run.catch((err) => console.error("[agent] placing topics failed:", err));
    await this.mergeRun;
  }

  // ---- demo ---------------------------------------------------------------

  private async playDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    try {
      if (!this.items().length) {
        this.db.addItems(this.roomId, sampleSprint());
        this.itemsChanged();
      }
      await runDemo(this, this.items());
    } finally {
      this.demoRunning = false;
    }
  }

  /** Used by the demo script to drive the room like a real host would. */
  demoSuggest(itemId: string, reason: string) {
    this.suggestion = { itemId, reason, confidence: 0.9, since: Date.now() };
    this.broadcastState();
  }
  demoChat(speakerId: string, speakerName: string, text: string) {
    this.addSegment(speakerId, speakerName, "chat", text, Date.now());
  }
  demoAccept() {
    this.acceptSuggestion("Demo host");
  }
  /** The demo's stand-in for Ask Stand: the question shows as being worked on, then demoAnswer
   *  writes its answer, so the card and its line in the transcript can be seen without a model. */
  demoAsk(speakerId: string, speakerName: string, question: string): string {
    this.agentCards ??= new AgentKeeper();
    const card = this.agentCards.ask(speakerName, speakerId, question);
    this.agentChanged();
    return card.id;
  }
  demoAnswer(cardId: string, answer: string) {
    this.agentCards?.finishAnswer(cardId, { fields: { note: answer, sources: [], todo: null, fromSpace: [] }, follows: null, model: null, costUsd: null });
    this.agentChanged();
  }
  /** The demo's stand-in for someone's agent reporting over the MCP while the call runs. */
  demoReport(userId: string, userName: string, client: string, text: string) {
    this.db.addUpdate({ roomId: this.roomId, itemId: this.focusItemId, noteId: null, noteText: null, userId, userName, client, status: "progress", text, links: [] });
    this.updatesChanged();
  }
  get isEnded() {
    return this.ended;
  }

  // ---- end ----------------------------------------------------------------

  /** `endedAt`: when it really ended, for a meeting the server lost track of
   *  and is only now writing up. */
  async end(endedAt?: number) {
    if (this.ended) return;
    this.ended = true;
    this.endingSince = Date.now();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    if (this.hostAwayTimer) clearTimeout(this.hostAwayTimer);
    if (this.nextTimer) clearTimeout(this.nextTimer);
    if (this.pilotTimer) clearTimeout(this.pilotTimer);
    for (const t of this.noteTimers.values()) clearTimeout(t);
    for (const passes of [this.boardPasses, this.listPasses, this.mapPasses]) passes.stop();
    this.noteTimers.clear();
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.mergeTimer = null;
    // A restart before the recap is saved finishes it instead of resuming the call.
    // Each step below stands alone: one that fails is logged, and the meeting still ends and frees the room.
    const step = (what: string, fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        console.error(`[room] ending ${this.meetingId}: ${what} failed:`, err);
      }
    };
    step("marking it ending", () => this.db.meetingEnding(this.meetingId));
    step("telling everyone", () => this.broadcastState());
    await this.transcriber?.stop().catch(() => {});
    // A product review that ran in this meeting is over: its slides leave the agenda with what was said on them.
    step("finishing the review", () => finishReview(this.db, this.roomId, this.meetingId));
    step("finishing the idea review", () => finishIdeaReview(this.db, this.roomId, this.meetingId));
    step("finishing the design review", () => finishDesignReview(this.db, this.roomId, this.meetingId));
    step("archiving task items", () => this.db.archiveTaskItems(this.roomId));
    // Nobody waits for the write-up: everyone goes to the recap page, which fills in when it's done,
    // and the space is free for a new call. A restart before it's done still finishes it (services.ts).
    this.release();
    // So is a brainstorm: one last look at the talk no pass has read, then its map is the record.
    if (this.brain) {
      await this.mapPasses.idle();
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([this.mapPasses.run(), new Promise((r) => (wait = setTimeout(r, 25_000)))]);
      clearTimeout(wait);
      let done: ReturnType<typeof finishBrainstorm> | undefined;
      const brain = this.brain;
      if (brain?.threadId) step("keeping the map's stretches", () => this.db.saveBrainstormSpans(brain.id, this.threadSpans(brain.threadId!)));
      step("finishing the brainstorm", () => (done = finishBrainstorm(this.db, this.roomId, this.meetingId)));
      // A design session leaves a draft spec on its to-do, for the normal design review.
      if (done?.kind === "design") {
        try {
          saveDraftSpec(this.db, done, this.brainCaught());
        } catch (e) {
          console.error(`[design session] ${this.meetingId}: ${(e as Error).message}`);
        }
      }
    }
    // A topic's map parked when the board moved off it is done with the call too.
    step("ending the parked maps", () => {
      for (const b of this.db.brainstormsOfMeeting(this.meetingId)) if (b.status === "done" && b.endedAt === null) this.db.setBrainstorm(b.id, { endedAt: Date.now() });
    });

    let summary = "";
    let synthesizing: Promise<string | null> = Promise.resolve(null);
    let placing: Promise<void> = Promise.resolve();
    let chapterNotes: ChapterRecap[] = [];
    try {
      const segments = this.db.meetingSegments(this.meetingId);
      const itemIds = [...new Set(segments.map((s) => s.itemId))];
      const perItem: Array<{ item: Item | null; notes: Note[] }> = [];
      for (const id of itemIds) {
        perItem.push({ item: id ? this.db.getItem(id) : null, notes: await this.refreshNotes(id) });
      }
      // To-dos checked off on the board's list: the tidy run may have written them in other words.
      const doneOnList = (this.list?.notes(this.meetingId) ?? []).filter((n) => n.kind === "action" && n.doneAt);
      if (doneOnList.length) {
        for (const n of doneOnList) {
          const line = this.list?.get(n.id);
          if (line) this.mirrorDone(line, line.doneBy ?? "Stand");
        }
        for (const p of perItem) p.notes = this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === (p.item?.id ?? null));
      }
      // A review ran: each capture goes under the slide it was about, not the one on screen when it was said.
      const filed = await refileReview(this.db, this.meetingId, (prompt) => this.agent.refileReview(prompt)).catch((err) => {
        console.error("[agent] review filing failed:", err);
        return { moved: 0, dropped: 0 };
      });
      if (filed.moved || filed.dropped) {
        console.log(`[agent] review filing: ${filed.moved} moved, ${filed.dropped} echoes dropped`);
        const all = this.db.meetingNotes(this.meetingId);
        for (const p of perItem) p.notes = all.filter((n) => n.itemId === (p.item?.id ?? null));
        if (!perItem.some((p) => !p.item) && all.some((n) => !n.itemId)) perItem.push({ item: null, notes: all.filter((n) => !n.itemId) });
      }
      // A design review ran: its points' threads, its specs' to-dos and their links get what the meeting caught.
      try {
        writeBackReview(this.db, this.meetingId);
      } catch (err) {
        console.error("[agent] design review write-back failed:", err);
      }
      // The tidy runs rewrote the topics: place the smaller ones again, then write the recap on those chapters.
      placing = this.mergeTopics(true);
      // The recap (with the snaps in view), and the Synthesis when the space has instructions for one, side by side.
      const room = this.db.getRoom(this.roomId);
      const instructions = room?.synthesisInstructions.trim() ?? "";
      if (instructions) {
        synthesizing = this.agent
          .synthesizeMeeting({
            spaceName: room!.name,
            instructions,
            items: perItem.map((p) => ({ ...p, segments: segments.filter((s) => s.itemId === (p.item?.id ?? null)) })),
          })
          .catch((err) => {
            console.error("[agent] synthesis failed:", err);
            return null;
          });
      }
      try {
        await placing;
        const recap = await this.agent.recapMeeting(this.recapInput(perItem));
        summary = recap.summary;
        chapterNotes = recap.chapters ?? [];
        const kept = new Map(this.db.meetingSnaps(this.meetingId).map((p) => [p.id, p]));
        for (const place of recap.snaps) {
          const row = kept.get(place.id);
          if (!row) continue;
          // The agent's own snaps were kept for a note; that stands unless the recap names another.
          this.db.placeSnap(place.id, { ...place, noteId: place.noteId ?? (row.source === "agent" ? row.noteId : null) });
        }
      } catch (err) {
        console.error("[agent] recap failed:", err);
        summary = await this.agent.summarizeMeeting(perItem);
      }
    } catch (err) {
      console.error("[agent] summary failed:", err);
    } finally {
      // Whatever the agent managed, the meeting ends and the room is free again.
      await placing;
      const synthesis = await synthesizing;
      step("saving the recap", () => this.db.endMeeting(this.meetingId, summary || null, synthesis, endedAt, chapterNotes));
      this.polisher?.schedule(this.roomId, 0);
      this.release();
      this.onClosed(this);
    }
  }

  /** The server is stopping for an update: everyone's page says so, and reconnects to this meeting once it's back. */
  restarting() {
    this.broadcast({ type: "restarting" });
  }

  /** Sends everyone to the recap and lets the space go. Once. */
  private release() {
    if (this.released) return;
    this.released = true;
    this.broadcast({ type: "meeting.ended", meetingId: this.meetingId });
    for (const ws of this.conns.keys()) ws.close();
    this.onRelease?.(this);
  }

  /** Everything the recap looks at: each item's notes and topics, and the snaps
   *  with their images (within what one request can carry). */
  private recapInput(perItem: Array<{ item: Item | null; notes: Note[] }>): RecapInput {
    const discussions = this.db.meetingDiscussions(this.meetingId);
    const segments = this.db.meetingSegments(this.meetingId);
    const items = perItem.map((p) => ({
      ...p,
      topics: discussions.filter((d) => d.itemId === (p.item?.id ?? null)).map((d) => ({ id: d.id, topic: d.topic })),
    }));
    // Snaps people took first, then the agent's; each image under 5 MB, at most
    // RECAP_MAX_SNAPS of them and RECAP_MAX_BYTES in all.
    const rows = this.db.meetingSnaps(this.meetingId);
    const linked = new Map(linkSnaps(rows, segments, discussions).map((s) => [s.id, s]));
    const ordered = [...rows.filter((r) => r.source === "person"), ...rows.filter((r) => r.source === "agent")];
    const snaps: RecapInput["snaps"] = [];
    let bytes = 0;
    for (const r of ordered) {
      if (snaps.length >= RECAP_MAX_SNAPS) break;
      const file = snapFile(r.id, r.ext);
      const size = file ? fs.statSync(file).size : 0;
      if (!file || !size || size > 5 * 1024 * 1024 || bytes + size > RECAP_MAX_BYTES) continue;
      bytes += size;
      const mediaType: SnapMedia = r.ext === "png" ? "image/png" : r.ext === "webp" ? "image/webp" : "image/jpeg";
      const said = (linked.get(r.id)?.segmentIds ?? []).flatMap((id) => segments.filter((g) => g.id === id)).map((g) => `${g.speakerName}: ${g.text}`);
      snaps.push({
        id: r.id,
        itemId: r.itemId,
        at: r.ts,
        by: r.source === "agent" ? "the Stand agent" : r.takenBy,
        caption: r.caption,
        said,
        image: { data: fs.readFileSync(file).toString("base64"), mediaType },
      });
    }
    snaps.sort((a, b) => a.at - b.at);
    // The chapters as the recap page will show them. Long ones carry their remarks so the recap can pick out moments.
    let budget = RECAP_MAX_LINES;
    const byId = new Map(segments.map((s) => [s.id, s]));
    const chapters: RecapChapter[] = meetingChapters(discussions, segments).map((c) => {
      const head = discussions.find((d) => d.id === (c.headId ?? c.topicIds[0]));
      const long = c.minutes >= MOMENTS_MIN_MINUTES && budget > 0;
      const lines = long
        ? c.segmentIds.slice(0, budget).flatMap((id) => {
            const s = byId.get(id);
            return s ? [{ segmentId: s.id, ts: s.ts, speaker: s.speakerName, text: s.text }] : [];
          })
        : [];
      budget -= lines.length;
      return {
        key: c.key,
        title: c.title,
        item: perItem.find((p) => (p.item?.id ?? null) === c.itemId)?.item ?? (c.itemId ? this.db.getItem(c.itemId) : null),
        start: c.start,
        minutes: c.minutes,
        outcome: c.outcome,
        topicIds: c.topicIds,
        positions: head?.positions ?? [],
        lines,
      };
    });
    return { items, snaps, chapters, startedAt: this.db.getMeeting(this.meetingId)?.startedAt };
  }

  /** For the demo script: segments currently in this meeting. */
  segments(): Segment[] {
    return this.db.meetingSegments(this.meetingId);
  }
}

const DRIFT_STOPWORDS = new Set(
  "about after again agenda being could every first issue issues other review meeting should their there these thing things those through update which while would".split(" "),
);
/** Scripts written without spaces between words: matched on pairs of characters instead. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const driftWords = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .flatMap((w) => {
      if (!UNSPACED.test(w)) return [w.replace(/s$/, "")].filter((x) => [...x].length >= 5 && !DRIFT_STOPWORDS.has(x));
      const cs = [...w];
      return cs.slice(1).map((c, i) => cs[i] + c);
    });

/** How strongly a remark is about an agenda item: its ticket key counts 2, each distinctive title word 1. */
export function mentionScore(text: string, item: Pick<Item, "title" | "externalId">): number {
  let score = 0;
  // Speech-to-text writes a key the way it's said: "demo 103" as well as "DEMO-103".
  const key = item.externalId?.replace(/[^A-Za-z0-9-]/g, "").split("-").filter(Boolean).join("[-\\s]?");
  if (key && new RegExp(`\\b${key}\\b`, "i").test(text)) score += 2;
  const said = new Set(driftWords(text));
  for (const w of new Set(driftWords(item.title))) if (said.has(w)) score++;
  return score;
}

/** A line a run put under a topic stays there unless a later run puts it under another one.
 *  Each run regroups the talk it reads and leaves a few lines out; once such a line is too old to
 *  be read again (settle.ts) nothing would put it back, and the chapter bar would show a gap where
 *  people were talking. A line left out goes back to the topic that took over most of its old
 *  topic's lines (or has its name); a topic left out whole comes back as it was, unless `revive`
 *  is off. Adds to the drafts in place and returns the topics that come back. */
export function keepLeftOut(before: Discussion[], drafts: DraftDiscussion[], window: Segment[], { revive = true } = {}): DraftDiscussion[] {
  const read = new Set(window.map((s) => s.id));
  const placed = new Set(drafts.flatMap((d) => d.segmentIds));
  const revived: DraftDiscussion[] = [];
  for (const was of before) {
    const lost = was.segmentIds.filter((id) => read.has(id) && !placed.has(id));
    if (!lost.length) continue;
    const mine = new Set(was.segmentIds);
    const name = was.topic.trim().toLowerCase();
    let heir: DraftDiscussion | undefined;
    let most = 0;
    for (const d of drafts) {
      const shared = d.segmentIds.filter((id) => mine.has(id)).length;
      if (shared > most) [heir, most] = [d, shared];
    }
    heir ??= drafts.find((d) => d.topic.trim().toLowerCase() === name);
    if (heir) heir.segmentIds = [...heir.segmentIds, ...lost];
    else if (revive) revived.push({ id: was.id, topic: was.topic, positions: was.positions, outcome: was.outcome, segmentIds: lost, continuesId: was.continues?.id ?? null });
    for (const id of lost) placed.add(id);
  }
  return revived;
}

/** Something a client sent that has the shape of a message: an object with a type, and a cid if any as a string. */
function isMessage(v: unknown): v is ClientMessage {
  const o = v as { type?: unknown; cid?: unknown } | null;
  return typeof o === "object" && o !== null && typeof o.type === "string" && (o.cid === undefined || typeof o.cid === "string");
}

/** A host view as sent, or null when it isn't one. */
function asHostView(v: unknown): HostView | null {
  const o = v as HostView | null;
  if (!o || (o.tab !== "main" && o.tab !== "board")) return null;
  if (o.taskMode !== undefined && o.taskMode !== "brief" && o.taskMode !== "spec") return null;
  const task = o.taskMode ? { taskMode: o.taskMode } : null;
  const shot = Number.isInteger(o.shot) && o.shot! > 0 && o.shot! < 50 ? { shot: o.shot } : null;
  const r = o.rewind;
  if (r === null) return { tab: o.tab, rewind: null, ...task, ...shot };
  const str = (x: unknown, max = 200) => typeof x === "string" && x.length <= max;
  if (!r || !str(r.id) || !str(r.key) || !Number.isFinite(r.at) || !(r.live === null || str(r.live))) return null;
  const page = Number.isInteger(r.page) && r.page! >= 0 && r.page! <= 50 ? r.page : undefined;
  return { tab: o.tab, ...task, ...shot, rewind: { id: r.id, key: r.key, at: r.at, live: r.live, ...(page !== undefined && { page }) } };
}
