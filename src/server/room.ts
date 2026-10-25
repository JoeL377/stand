// One live meeting in a room: who is here, which item is in focus, and the
// agent's pinning of speech and chat to that item.

import { roomVocabulary, vocabularyLine } from "./conxtGlossary.ts";
import { confirmRoomOpenItem, liveCards, refreshRoomOpenItems, roomOpenItems, saysTerm, shareRoomOpenItem } from "./conxtOpenItems.ts";
import fs from "node:fs";
import type { WebSocket } from "ws";
import type {
  User,
  ChapterRecap,
  ClientMessage,
  DoneDeck,
  Discussion,
  Item,
  Note,
  Participant,
  RoomState,
  Segment,
  ServerMessage,
  Suggestion,
} from "../shared/protocol.ts";
import { BOARD_EVERY_MS, BoardKeeper } from "./board.ts";
import { LIST_DEBOUNCE_MS, LIST_MAX_WAIT_MS, ListKeeper } from "./liveList.ts";
import { capabilities, config } from "./config.ts";
import type { DB, DraftDiscussion, OpenMeeting } from "./db.ts";
import { type Agent, type ItemNotesDraft, NotesTrouble, type RecapChapter, type RecapInput, type SettledTopic, type SnapMedia } from "./llm.ts";
import { meetingChapters } from "../shared/chapters.ts";
import { currentDoneDeck } from "./doneDeck.ts";
import { sampleSprint } from "./linear.ts";
import { runDemo } from "./demo.ts";
import { capturedFor, mergeNotes, similar } from "./notesMerge.ts";
import { LOCK_AFTER_MS, LOCK_MIN_LINES, settle } from "./settle.ts";
import { applyMerges, mergePrompt, planMerge, stickyMerges, type TopicMerge } from "./topicMerge.ts";
import { newId } from "./ids.ts";
import { linkSnaps, saveSnapFile, snapFile } from "./snaps.ts";
import { addUpNext } from "./upNext.ts";
import { type UpNextPolisher, upNextView } from "./upNextPolish.ts";

/** Below this the agent keeps its guess to itself. */
const SUGGEST_MIN_CONFIDENCE = 0.55;
/** A dismissed item isn't suggested again for this long. */
const DISMISS_QUIET_MS = 90_000;
/** A word Conxt says was used two ways stays raised this long after it is said. */
const CONXT_SAID_MS = 10 * 60_000;
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
  private focusItemId: string | null = null;
  /** See RoomState.stageSnapId. */
  private stageSnapId: string | null = null;
  private pinnedBy: string | null = null;
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
  /** Signed-in emails by participant, lowercased: the person ids Conxt knows. */
  private emails = new Map<string, string>();
  /** Conxt divergences whose word was said, and when last. */
  private conxtSaid = new Map<string, number>();
  private conxtConfirming = new Set<string>();
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
  private boardTimer: NodeJS.Timeout | null = null;
  private boardRun: Promise<void> | null = null;
  private boardRanAt = 0;
  private boardDueAt = 0;
  /** The board's running list (liveList.ts): one pass at a time, after each pause in the talk. Null without a model. */
  private list: ListKeeper | null = null;
  private listTimer: NodeJS.Timeout | null = null;
  private listRun: Promise<void> | null = null;
  /** The check-in at the start ("Since last time"): someone moved on from it, and the last answer anyone gave. */
  private checkInClosed = false;
  private checkInAnsweredAt: number | null = null;
  /** The page of the opening board everyone is on: the "Done since" pages, then the check-in. */
  private checkInPage = 0;
  /** When someone moved on from the opening board: where the Kickoff chapter on the bar ends. */
  private checkInClosedAt: number | null = null;
  /** "Done since last time" as of when it was last read (undefined: read it again). */
  private doneDeckCache: DoneDeck | null | undefined;
  ended = false;
  /** When End meeting started the write-up. */
  endingSince = 0;

  constructor(
    private db: DB,
    private agent: Agent,
    room: { id: string; name: string; createdBy: string | null },
    private onClosed: (s: RoomSession) => void,
    private startTranscriber?: (s: RoomSession) => Transcriber | null,
    private polisher?: UpNextPolisher,
    /** A meeting the server was running when it stopped: carry on with it instead of starting a new one. */
    resume?: OpenMeeting | null,
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
    } else {
      const m = db.startMeeting(room.id);
      this.meetingId = m.id;
      this.meetingStartedAt = m.startedAt;
      this.setFocusInternal(items[0]?.id ?? null, "system", "start");
    }
    this.board = new BoardKeeper(agent, this.meetingStartedAt, resume ? db.meetingBoard(resume.id) : null);
    if (agent.liveList) this.list = new ListKeeper({ liveList: agent.liveList.bind(agent) }, this.meetingStartedAt, resume ? db.meetingList(resume.id) : null);
    // Tidy the suggested agenda now, before anyone has started talking.
    polisher?.schedule(room.id, 0);
  }

  // ---- connections ---------------------------------------------------------

  /** The user comes from the session cookie checked at upgrade time; they
   *  appear in the room once their client says hello. */
  attach(ws: WebSocket, user: User) {
    this.conns.set(ws, null);
    this.pendingUser.set(ws, user);
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
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

  private broadcastState() {
    this.broadcast({ type: "state", state: this.state() });
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
      transcriptionDown: this.transcriptionDown,
      transcriptionRestarting: this.transcriptionDown && this.transcriberRestarting,
      hostAway: this.hostAwayTimer && this.hostId && !this.participants.has(this.hostId) ? (this.names.get(this.hostId) ?? "The host") : null,
      hostAwayMs: this.hostAwayTimer ? Math.max(0, this.hostAwayUntil - Date.now()) : null,
      notesFailing: [...this.notesFailing],
      notesTrouble: this.notesFailing.size ? this.notesWhy : null,
      suggestion: this.suggestion,
      items: this.items(),
      decks: this.db.listDecks(this.roomId),
      followUps: this.carried(true),
      checkIn: { closed: this.checkInClosed, answeredAt: this.checkInAnsweredAt, page: this.checkInPage, closedAt: this.checkInClosedAt },
      doneDeck: this.doneDeck(),
      updates: this.db.roomUpdates(this.roomId, this.db.previousMeetingStart(this.roomId, this.meetingStartedAt) ?? 0),
      ...this.upNext(),
      capabilities: capabilities(),
      ending: this.ended,
      conxt: this.conxtLive(),
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

  /** What the connected Conxt project would raise with the people here now. */
  private conxtLive() {
    const items = roomOpenItems(this.roomId);
    if (!items.length || this.ended) return [];
    const here = [...this.participants.values()].map((p) => ({ participantId: p.id, name: p.name, email: this.emails.get(p.id) ?? null }));
    const since = Date.now() - CONXT_SAID_MS;
    const said = new Set([...this.conxtSaid].filter(([, at]) => at >= since).map(([id]) => id));
    return liveCards(items, here, said);
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
      if (msg.meetingId && msg.meetingId !== this.meetingId && this.db.getMeeting(msg.meetingId)?.endedAt) {
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
      if (user.email) this.emails.set(id, user.email.toLowerCase());
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
      this.send(ws, { type: "list", items: this.list?.notes(this.meetingId) ?? null });
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
      // Only the host moves the meeting between items.
      case "focus":
        if (!isHost || this.ended) return;
        this.pinnedBy = null;
        this.setFocus(msg.itemId, conn.name, "manual");
        break;
      case "board.accept":
        if (!this.ended) void this.acceptBoardMove(msg.title);
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
          this.setHost(msg.participantId);
          this.suggestion = null;
          this.broadcastState();
        }
        break;
      }
      case "sharing": {
        // One screen at a time: two people pressing Share together, the second is told.
        const other = msg.on && [...this.participants.values()].find((p) => p.isSharing && p.id !== conn.participantId);
        // Their browser stops the share it started when it sees someone else's counted instead.
        if (other) return this.send(ws, { type: "error", message: `${other.name} is already sharing, so yours was stopped. Ask them to stop first.` });
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
      case "notes.retry": {
        const itemId = msg.itemId && this.items().some((i) => i.id === msg.itemId) ? msg.itemId : null;
        if (!this.ended) void this.refreshNotes(itemId);
        break;
      }
      case "chat": {
        const text = msg.text.trim().slice(0, 2000);
        if (!text) return;
        this.addSegment(conn.participantId, conn.name, "chat", text, Date.now());
        break;
      }
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
        if (!before) return;
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
          this.mirrorDone(it.text, it.doneBy);
          break;
        }
        const note = this.db.setActionDone(this.roomId, msg.noteId, msg.done ? conn.name : null);
        if (!note) break;
        // An action from this meeting: resend its item's notes so every card updates.
        if (note.meetingId === this.meetingId) this.sendItemNotes(note.itemId);
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
        this.broadcastState();
        break;
      }
      case "task.saidDone.undo": {
        if (!this.db.setSaidDone(this.roomId, msg.noteId, null)) break;
        this.broadcastState();
        break;
      }
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
        if (!msg.open) this.checkInClosedAt ??= Date.now();
        // Brought back on purpose (from the board's open tasks): it stays up a while even with the topic card
        // waiting, on the check-in, its last page.
        if (msg.open) {
          this.checkInAnsweredAt = Date.now();
          this.checkInPage = 50;
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
      case "conxt.confirm": {
        // Only someone the decision waits on, signed in and in the meeting, confirms it.
        const email = this.emails.get(conn.participantId);
        const card = this.conxtLive().find((c) => c.id === msg.itemId && c.kind === "confirmation");
        if (!email || !card?.here.some((p) => p.participantId === conn.participantId)) {
          return this.send(ws, { type: "error", message: "Couldn't confirm: this decision doesn't wait on you." });
        }
        if (this.conxtConfirming.has(card.id)) return;
        this.conxtConfirming.add(card.id);
        try {
          const r = await confirmRoomOpenItem(this.roomId, card.id, email);
          if (!r.ok) this.send(ws, { type: "error", message: `Couldn't confirm: ${r.why}.` });
          await refreshRoomOpenItems(this.roomId);
        } finally {
          this.conxtConfirming.delete(card.id);
        }
        this.broadcastState();
        break;
      }
      case "conxt.share": {
        // Only the person whose explore work it is shares it, as with confirming.
        const email = this.emails.get(conn.participantId);
        const card = this.conxtLive().find((c) => c.id === msg.itemId && c.kind === "exploring");
        if (!email || !card?.here.some((p) => p.participantId === conn.participantId)) {
          return this.send(ws, { type: "error", message: "Couldn't share: that explore work isn't yours." });
        }
        if (this.conxtConfirming.has(card.id)) return;
        this.conxtConfirming.add(card.id);
        try {
          const r = await shareRoomOpenItem(this.roomId, card.id, email);
          if (!r.ok) this.send(ws, { type: "error", message: `Couldn't share: ${r.why}.` });
          await refreshRoomOpenItems(this.roomId);
        } finally {
          this.conxtConfirming.delete(card.id);
        }
        this.broadcastState();
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
      this.board.focused(itemId, at);
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
        // Only the words just added count, so a long turn isn't scored twice.
        this.checkDrift({ ...seg, text: t });
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
    this.checkDrift(segment);
    this.checkConxtTerms(text, ts);
    return segment;
  }

  /** A word Conxt says people use two ways was just said: raise it, once per stretch. */
  private checkConxtTerms(text: string, ts: number) {
    const ids = saysTerm(roomOpenItems(this.roomId), text);
    if (!ids.length) return;
    const fresh = ids.some((id) => (this.conxtSaid.get(id) ?? -Infinity) < ts - CONXT_SAID_MS);
    for (const id of ids) this.conxtSaid.set(id, ts);
    if (fresh) this.broadcastState();
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

  /** The next list pass: LIST_DEBOUNCE_MS after the latest talk, never more than LIST_MAX_WAIT_MS after
   *  the oldest line no pass has read. One pass at a time; talk during a pass gets the next one. */
  private scheduleList() {
    const list = this.list;
    if (this.ended || !list || this.listRun) return;
    const since = list.unreadSince(this.db.meetingSegments(this.meetingId));
    if (since === null) return;
    const wait = Math.max(0, Math.min(LIST_DEBOUNCE_MS, since + LIST_MAX_WAIT_MS - Date.now()));
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      void this.runList();
    }, wait);
  }

  private runList(): Promise<void> {
    const list = this.list;
    if (this.ended || !list || this.listRun) return this.listRun ?? Promise.resolve();
    const segments = this.db.meetingSegments(this.meetingId);
    if (!list.due(segments)) return Promise.resolve();
    const people = [...new Set([...[...this.participants.values()].map((p) => p.name), ...segments.map((s) => s.speakerName)])];
    const carried = this.carried().filter((f) => !f.saidDone);
    this.listRun = list
      .run(segments, people, (ts) => this.focusAt(ts), Date.now(), carried.map((f) => ({ id: f.id, who: f.owner, text: f.text })))
      .catch((e) => {
        console.error(`[list] ${this.meetingId}: ${(e as Error).message}`);
        return false;
      })
      .then((changed) => {
        if (changed && !this.ended) this.listChanged();
        if (this.ended || !list.heardDone.length) return;
        // A carried task someone said is finished: marked Said done, still open until evidence or a click.
        for (const h of list.heardDone)
          this.db.setSaidDone(this.roomId, h.id, { segmentId: h.segment.id, ts: h.segment.ts, speaker: h.segment.speakerName, text: h.segment.text.slice(0, 500) });
        this.broadcastState();
      })
      .finally(() => {
        this.listRun = null;
        this.scheduleList();
      });
    return this.listRun;
  }

  private listChanged() {
    if (!this.list) return;
    this.db.saveList(this.meetingId, this.list.saved());
    this.broadcast({ type: "list", items: this.list.notes(this.meetingId) });
  }

  /** A to-do checked off on the board's list: the same to-do in the live notes too, so the recap,
   *  the space page and the next meeting see it. */
  private mirrorDone(text: string, by: string | null) {
    const note = this.db.meetingNotes(this.meetingId).find((n) => n.kind === "action" && !n.doneAt === !!by && similar(n.text, text));
    if (!note) return;
    if (this.db.setActionDone(this.roomId, note.id, by)) this.sendItemNotes(note.itemId);
    this.broadcastState();
  }

  // ---- board --------------------------------------------------------------

  /** The next board pass: BOARD_EVERY_MS after the last one, or soon after an agenda move. */
  private scheduleBoard(agendaMoved = false) {
    if (this.ended || !this.board || this.boardRun) return;
    const wait = agendaMoved ? BOARD_AFTER_FOCUS_MS : Math.max(BOARD_FIRST_MS, this.boardRanAt + BOARD_EVERY_MS - Date.now());
    if (this.boardTimer) {
      // A pass already waiting keeps its time unless this one is due sooner.
      if (this.boardDueAt <= Date.now() + wait) return;
      clearTimeout(this.boardTimer);
    }
    this.boardDueAt = Date.now() + wait;
    this.boardTimer = setTimeout(() => {
      this.boardTimer = null;
      void this.runBoard();
    }, wait);
  }

  private runBoard(): Promise<void> {
    const board = this.board;
    if (this.ended || !board || this.boardRun) return this.boardRun ?? Promise.resolve();
    const segments = this.db.meetingSegments(this.meetingId);
    if (!board.due(segments)) return Promise.resolve();
    this.boardRanAt = Date.now();
    board.busy = true;
    this.broadcast({ type: "board", board: board.board() });
    const people = [...new Set([...[...this.participants.values()].map((p) => p.name), ...segments.map((s) => s.speakerName)])];
    this.boardRun = board
      .run(segments, this.items(), people, this.focusItemId, Date.now())
      .catch((e) => {
        console.error(`[board] ${this.meetingId}: ${(e as Error).message}`);
        return false;
      })
      .then((changed) => {
        board.busy = false;
        if (changed && !this.ended) this.db.saveBoard(this.meetingId, board.board());
        this.broadcast({ type: "board", board: board.board() });
      })
      .finally(() => {
        this.boardRun = null;
        // Talk that came in during the pass gets the next one.
        if (!this.ended && board.due(this.db.meetingSegments(this.meetingId))) this.scheduleBoard(board.waitingOnItem);
      });
    return this.boardRun;
  }

  /** Someone clicked "Looks like you've moved to …": switch the board now, after any pass in flight. */
  private async acceptBoardMove(title: string) {
    await this.boardRun;
    const board = this.board;
    if (this.ended || !board || !board.accept(title, Date.now())) return;
    this.db.saveBoard(this.meetingId, board.board());
    this.broadcast({ type: "board", board: board.board() });
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
          notes: current.flatMap((n) => (n.discussionId === d.id && n.kind !== "summary" ? [{ kind: n.kind, text: n.text, owner: n.owner }] : [])),
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
        // The team's own instructions, then the Conxt vocabulary for words said in this stretch only.
        const vocabulary = vocabularyLine(roomVocabulary(this.roomId).terms, window.map((s) => s.text).join("\n"));
        const instructions = [this.db.getRoom(this.roomId)?.synthesisInstructions, vocabulary].filter(Boolean).join("\n\n") || undefined;
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
    const notes = this.db.replaceNotes(this.meetingId, itemId, [
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
    this.broadcast({ type: "notes", meetingId: this.meetingId, itemId, notes, discussions });
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
    for (const t of this.noteTimers.values()) clearTimeout(t);
    if (this.boardTimer) clearTimeout(this.boardTimer);
    if (this.listTimer) clearTimeout(this.listTimer);
    this.noteTimers.clear();
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.mergeTimer = null;
    // Everyone sees "Writing notes…"; a restart before it's done finishes the recap instead of resuming.
    this.db.meetingEnding(this.meetingId);
    this.broadcastState();
    await this.transcriber?.stop().catch(() => {});

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
        for (const n of doneOnList) this.mirrorDone(n.text, n.doneBy ?? "Stand");
        for (const p of perItem) p.notes = this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === (p.item?.id ?? null));
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
      this.db.endMeeting(this.meetingId, summary || null, await synthesizing, endedAt, chapterNotes);
      this.polisher?.schedule(this.roomId, 0);
      this.broadcast({ type: "meeting.ended", meetingId: this.meetingId });
      for (const ws of this.conns.keys()) ws.close();
      this.onClosed(this);
    }
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
