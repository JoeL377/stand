// One live meeting in a room: who is here, which item is in focus, and the
// agent's pinning of speech and chat to that item.

import fs from "node:fs";
import type { WebSocket } from "ws";
import type {
  User,
  ClientMessage,
  Item,
  Note,
  Participant,
  RoomState,
  Segment,
  ServerMessage,
  Suggestion,
} from "../shared/protocol.ts";
import { capabilities } from "./config.ts";
import type { DB } from "./db.ts";
import type { Agent, RecapInput, SnapMedia } from "./llm.ts";
import { sampleSprint } from "./linear.ts";
import { runDemo } from "./demo.ts";
import { capturedFor, mergeNotes } from "./notesMerge.ts";
import { newId } from "./ids.ts";
import { linkSnaps, saveSnapFile, snapFile } from "./snaps.ts";
import { addUpNext } from "./upNext.ts";
import { type UpNextPolisher, upNextView } from "./upNextPolish.ts";

/** Below this the agent keeps its guess to itself. */
const SUGGEST_MIN_CONFIDENCE = 0.55;
/** A dismissed item isn't suggested again for this long. */
const DISMISS_QUIET_MS = 90_000;
/** Minimum gap between screen reads, to bound vision cost. */
const FRAME_MIN_INTERVAL_MS = 4_000;
/** The agent keeps a frame next to a note only if it saw it this recently. */
const FRAME_BACKS_MS = 180_000;
/** The recap sees at most this many snaps, and this many bytes of them, so the request stays within the API's limits. */
const RECAP_MAX_SNAPS = 20;
const RECAP_MAX_BYTES = 18 * 1024 * 1024;
/** Notes for the item in focus refresh this long after the last new remark. */
const NOTES_DEBOUNCE_MS = 3_000;
/** While talk keeps going, refresh notes at least this often instead of waiting for a pause. */
const NOTES_MAX_WAIT_MS = 12_000;
/** A speaker's next words join their last entry when they pause for less than this. */
const SPEECH_JOIN_GAP_MS = 2_000;
/** ...as long as the entry stays a readable size. */
const SPEECH_MAX_ENTRY_MS = 60_000;
const SPEECH_MAX_ENTRY_CHARS = 700;
/** How long an empty room waits before the meeting is closed. */
const EMPTY_ROOM_GRACE_MS = 120_000;

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
  private transcriber: Transcriber | null = null;
  private demoRunning = false;
  ended = false;

  constructor(
    private db: DB,
    private agent: Agent,
    room: { id: string; name: string; createdBy: string | null },
    private onClosed: (s: RoomSession) => void,
    private startTranscriber?: (s: RoomSession) => Transcriber | null,
    private polisher?: UpNextPolisher,
  ) {
    this.roomId = room.id;
    this.roomName = room.name;
    this.createdBy = room.createdBy;
    const m = db.startMeeting(room.id);
    this.meetingId = m.id;
    this.meetingStartedAt = m.startedAt;
    const first = db.listItems(room.id)[0];
    this.setFocusInternal(first?.id ?? null, "system", "start");
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
        this.send(ws, { type: "error", message: String(err?.message ?? err) });
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
        // The host left: hand over to whoever has been here longest.
        if (this.hostId === conn.participantId) this.hostId = this.participants.keys().next().value ?? null;
      }
      this.broadcastState();
    }
    if (this.participants.size === 0 && !this.emptyTimer && !this.ended) {
      this.emptyTimer = setTimeout(() => void this.end(), EMPTY_ROOM_GRACE_MS);
    }
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
    return {
      snaps: this.snaps(),
      roomId: this.roomId,
      roomName: this.roomName,
      meetingId: this.meetingId,
      meetingStartedAt: this.meetingStartedAt,
      participants: [...this.participants.values()].map(({ conns: _c, ...p }) => ({ ...p, isHost: p.id === this.hostId })),
      focusItemId: this.focusItemId,
      pinnedBy: this.pinnedBy,
      suggestion: this.suggestion,
      items: this.items(),
      decks: this.db.listDecks(this.roomId),
      followUps: this.db
        .roomFollowUps(this.roomId)
        .filter((f) => f.meetingId !== this.meetingId && (f.doneAt === null || f.doneAt >= this.meetingStartedAt)),
      updates: this.db.roomUpdates(this.roomId, this.db.previousMeetingStart(this.roomId, this.meetingStartedAt) ?? 0),
      ...this.upNext(),
      capabilities: capabilities(),
    };
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
  }) {
    const at = Math.min(Math.max(snap.at || Date.now(), this.meetingStartedAt), Date.now());
    const sharer = snap.pasted ? null : ([...this.participants.values()].find((p) => p.isSharing) ?? null);
    const id = newId(12);
    saveSnapFile(id, snap.ext, snap.buf);
    const itemId = this.focusAt(at);
    this.db.addSnap({
      id,
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
    });
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
    if (this.focusItemId && !items.some((i) => i.id === this.focusItemId)) this.setFocusInternal(null, "system", "removed");
    if (!this.focusItemId && items[0]) this.setFocusInternal(items[0].id, "system", "start");
    this.broadcastState();
  }

  /** Called by the REST API after an action item is checked off elsewhere. */
  followUpsChanged() {
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
    if (msg.type === "hello") {
      const user = this.pendingUser.get(ws);
      if (!user || this.conns.get(ws)) return;
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
      if (!this.hostId || !this.participants.has(this.hostId) || (isNew && id === this.createdBy)) this.hostId = id;
      if (this.emptyTimer) {
        clearTimeout(this.emptyTimer);
        this.emptyTimer = null;
      }
      if (!this.transcriber && this.startTranscriber) this.transcriber = this.startTranscriber(this);
      this.send(ws, {
        type: "welcome",
        participantId: id,
        segments: this.db.meetingSegments(this.meetingId),
        notes: this.db.meetingNotes(this.meetingId),
        discussions: this.db.meetingDiscussions(this.meetingId),
      });
      this.broadcastState();
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    const me = this.participants.get(conn.participantId);

    const isHost = this.isHost(conn.participantId);

    switch (msg.type) {
      // Only the host moves the meeting between items.
      case "focus":
        if (!isHost) return;
        this.pinnedBy = null;
        this.setFocus(msg.itemId, conn.name, "manual");
        break;
      case "pin":
        if (!isHost) return;
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
        if (isHost) this.acceptSuggestion(conn.name);
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
          this.hostId = msg.participantId;
          this.suggestion = null;
          this.broadcastState();
        }
        break;
      }
      case "sharing":
        if (me) me.isSharing = msg.on;
        if (!msg.on && isHost) this.suggestion = null;
        this.broadcastState();
        break;
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
          this.scheduleNotes(before.itemId, 500);
          this.scheduleNotes(seg.itemId, 500);
        }
        break;
      }
      case "followup.done": {
        const note = this.db.setActionDone(this.roomId, msg.noteId, msg.done ? conn.name : null);
        if (!note) break;
        // An action from this meeting: resend its item's notes so every card updates.
        if (note.meetingId === this.meetingId) this.sendItemNotes(note.itemId);
        this.broadcastState();
        break;
      }
      case "note.edit": {
        if (!isHost || !this.meetingId) return;
        const text = clean(msg.text, 500);
        const before = this.db.meetingNotes(this.meetingId).find((n) => n.id === msg.noteId);
        if (!before || !text) return;
        const owner = before.kind === "action" ? clean(msg.owner, 60) || null : null;
        this.db.editNote(before.id, { text, owner }, conn.name);
        this.sendItemNotes(before.itemId);
        if (before.kind === "action") this.broadcastState();
        break;
      }
      case "note.remove": {
        if (!isHost || !this.meetingId) return;
        const before = this.db.meetingNotes(this.meetingId).find((n) => n.id === msg.noteId);
        if (!before) return;
        this.db.removeNote(before.id);
        this.sendItemNotes(before.itemId);
        if (before.kind === "action") this.broadcastState();
        break;
      }
      case "note.add": {
        if (!isHost || !this.meetingId || !["action", "decision", "question"].includes(msg.kind)) return;
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
      case "upnext.dismiss": {
        if (!isHost) return;
        const { suggestions, parked } = this.upNext().upNext;
        const s = [...suggestions, ...parked].find((x) => x.key === msg.key);
        if (!s) return;
        for (const key of [s.key, ...s.merged]) this.db.dismissUpNext(this.roomId, key);
        this.broadcastState();
        break;
      }
      case "demo.play":
        if (isHost) void this.playDemo();
        break;
      case "meeting.end":
        if (isHost) await this.end();
        break;
    }
  }

  /** Resends one item's notes and topics in this meeting, after a hand change. */
  private sendItemNotes(itemId: string | null) {
    if (!this.meetingId) return;
    this.broadcast({
      type: "notes",
      meetingId: this.meetingId,
      itemId,
      notes: this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId),
      discussions: this.db.meetingDiscussions(this.meetingId).filter((d) => d.itemId === itemId),
    });
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

  // ---- focus ---------------------------------------------------------------

  private setFocusInternal(itemId: string | null, actor: string, reason: string, at = Date.now()) {
    const prev = this.focusItemId;
    this.focusItemId = itemId;
    this.focusLog.push({ ts: at, itemId });
    this.focusLog.sort((a, b) => a.ts - b.ts);
    this.db.logFocus(this.meetingId, itemId, actor, reason);
    if (this.suggestion?.itemId === itemId) this.suggestion = null;
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
    // Talk since the screen changed was about the new item.
    for (const seg of this.db.repinSince(this.meetingId, s.since, prev, s.itemId)) {
      this.broadcast({ type: "segment.updated", segment: seg });
    }
    this.scheduleNotes(prev, 1_000);
    this.scheduleNotes(s.itemId, 1_000);
    this.broadcastState();
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
      this.suggestion = { itemId: match.itemId, reason: match.reason, confidence: match.confidence, since: frame.at };
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
        return;
      }
    }
    const seg = this.addSegment(speakerId, speakerName, "speech", t, startedAt);
    this.lastSpeech = { segmentId: seg.id, speakerId, itemId: seg.itemId, startedAt, endedAt, length: t.length };
  }

  transcriptionFailed(reason: string) {
    console.error(`[agent] transcription unavailable in room ${this.roomId}: ${reason}`);
    // Let the next person who joins try again.
    this.transcriber = null;
    this.broadcast({ type: "error", message: `Transcription isn't working right now (${reason}). Chat still works.` });
  }

  interim(speakerId: string, speakerName: string, text: string) {
    this.broadcast({ type: "interim", speakerId, speakerName, text: text.slice(0, 500) });
  }

  private addSegment(speakerId: string, speakerName: string, kind: "speech" | "chat", text: string, ts: number) {
    const itemId = kind === "chat" ? this.focusItemId : this.focusAt(ts);
    const segment = this.db.addSegment({ meetingId: this.meetingId, itemId, speakerId, speakerName, kind, text, ts });
    if (kind === "chat") this.lastSpeech = null;
    this.broadcast({ type: "segment", segment });
    this.scheduleNotes(itemId, NOTES_DEBOUNCE_MS);
    return segment;
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
        Math.max(0, Math.min(delay, since + NOTES_MAX_WAIT_MS - Date.now())),
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
      try {
        const earlier = itemId
          ? this.db
              .itemDiscussions(itemId)
              .filter((d) => d.meetingId !== this.meetingId)
              .map((d) => ({ id: d.id, topic: d.topic, meetingStartedAt: d.meetingStartedAt }))
          : [];
        const keys = capturedFor(this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId));
        // What people saved off the screen, as words: the notes never see the images.
        const screens = this.db
          .meetingSnaps(this.meetingId)
          .filter((p) => p.itemId === itemId && p.caption)
          .map((p) => ({ at: p.ts, by: p.source === "agent" ? "Stand agent" : p.takenBy, caption: p.caption! }));
        const draft = await this.agent.notesFor(item, segments, earlier, keys, screens);
        const discussions = this.db.replaceDiscussions(
          this.meetingId,
          itemId,
          draft.discussions.map(({ segmentIndexes, ...d }) => ({ ...d, segmentIds: segmentIndexes.map((i) => segments[i].id) })),
        );
        // Re-read: a to-do may have been checked off while the agent was writing.
        const current = this.db.meetingNotes(this.meetingId).filter((n) => n.itemId === itemId);
        notes = this.db.replaceNotes(
          this.meetingId,
          itemId,
          mergeNotes(
            draft.notes.map(({ discussion, ...n }) => ({
              ...n,
              discussionId: discussion === null ? null : (discussions[discussion]?.id ?? null),
            })),
            current,
            keys,
            this.db.dismissedNotes(this.meetingId, itemId),
          ),
        );
        this.broadcast({ type: "notes", meetingId: this.meetingId, itemId, notes, discussions });
        const before = new Set(current.map((n) => n.id));
        const fresh = notes.filter((n) => !before.has(n.id) && (n.kind === "action" || n.kind === "decision"));
        if (fresh.length) void this.keepBackingFrame(itemId, fresh);
        console.log(
          `[agent] notes for ${itemId ?? "off-agenda"}: ${segments.length} turns in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.error("[agent] notes failed:", err);
      } finally {
        if (this.noteRuns.get(itemId) === run) this.broadcast({ type: "notes.busy", itemId, busy: false });
      }
    });
    this.noteRuns.set(itemId, run);
    await run;
    return notes;
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

  async end() {
    if (this.ended) return;
    this.ended = true;
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    for (const t of this.noteTimers.values()) clearTimeout(t);
    this.noteTimers.clear();
    await this.transcriber?.stop().catch(() => {});

    const segments = this.db.meetingSegments(this.meetingId);
    const itemIds = [...new Set(segments.map((s) => s.itemId))];
    const perItem: Array<{ item: Item | null; notes: Note[] }> = [];
    for (const id of itemIds) {
      perItem.push({ item: id ? this.db.getItem(id) : null, notes: await this.refreshNotes(id) });
    }
    let summary = "";
    try {
      const recap = await this.agent.recapMeeting(this.recapInput(perItem));
      summary = recap.summary;
      const kept = new Map(this.db.meetingSnaps(this.meetingId).map((p) => [p.id, p]));
      for (const place of recap.snaps) {
        const row = kept.get(place.id);
        if (!row) continue;
        // The agent's own snaps were kept for a note; that stands unless the recap names another.
        this.db.placeSnap(place.id, { ...place, noteId: place.noteId ?? (row.source === "agent" ? row.noteId : null) });
      }
    } catch (err) {
      console.error("[agent] recap failed:", err);
      try {
        summary = await this.agent.summarizeMeeting(perItem);
      } catch (err2) {
        console.error("[agent] summary failed:", err2);
      }
    }
    this.db.endMeeting(this.meetingId, summary || null);
    this.polisher?.schedule(this.roomId, 0);
    this.broadcast({ type: "meeting.ended", meetingId: this.meetingId });
    for (const ws of this.conns.keys()) ws.close();
    this.onClosed(this);
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
    return { items, snaps };
  }

  /** For the demo script: segments currently in this meeting. */
  segments(): Segment[] {
    return this.db.meetingSegments(this.meetingId);
  }
}
