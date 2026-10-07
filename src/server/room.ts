// One live meeting in a room: who is here, which item is in focus, and the
// agent's pinning of speech and chat to that item.

import type { WebSocket } from "ws";
import type {
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
import type { Agent } from "./llm.ts";
import { sampleSprint } from "./linear.ts";
import { runDemo } from "./demo.ts";

/** Below this the agent keeps its guess to itself. */
const SUGGEST_MIN_CONFIDENCE = 0.55;
/** A dismissed item isn't suggested again for this long. */
const DISMISS_QUIET_MS = 90_000;
/** Minimum gap between screen reads, to bound vision cost. */
const FRAME_MIN_INTERVAL_MS = 4_000;
/** Notes for the item in focus refresh this long after the last new remark. */
const NOTES_DEBOUNCE_MS = 8_000;
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
}

export interface Transcriber {
  stop(): Promise<void>;
}

export class RoomSession implements SpeechSink {
  readonly roomId: string;
  readonly roomName: string;
  readonly meetingId: string;
  readonly meetingStartedAt: number;

  private conns = new Map<WebSocket, Conn | null>();
  private participants = new Map<string, Participant & { conns: number }>();
  private focusItemId: string | null = null;
  private pinnedBy: string | null = null;
  private suggestion: Suggestion | null = null;
  /** (ts, item) pairs, so late-arriving transcripts land on the item that was
   *  in focus when the words were spoken. */
  private focusLog: Array<{ ts: number; itemId: string | null }> = [];
  private dismissed = new Map<string, number>();
  private noteTimers = new Map<string | null, NodeJS.Timeout>();
  private noteRuns = new Map<string | null, Promise<void>>();
  private frame: { dataUrl: string; at: number } | null = null;
  private frameBusy = false;
  private lastFrameRead = 0;
  private emptyTimer: NodeJS.Timeout | null = null;
  private transcriber: Transcriber | null = null;
  private demoRunning = false;
  ended = false;

  constructor(
    private db: DB,
    private agent: Agent,
    room: { id: string; name: string },
    private onClosed: (s: RoomSession) => void,
    private startTranscriber?: (s: RoomSession) => Transcriber | null,
  ) {
    this.roomId = room.id;
    this.roomName = room.name;
    const m = db.startMeeting(room.id);
    this.meetingId = m.id;
    this.meetingStartedAt = m.startedAt;
    const first = db.listItems(room.id)[0];
    this.setFocusInternal(first?.id ?? null, "system", "start");
  }

  // ---- connections ---------------------------------------------------------

  attach(ws: WebSocket) {
    this.conns.set(ws, null);
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
    if (conn) {
      const p = this.participants.get(conn.participantId);
      if (p && --p.conns <= 0) this.participants.delete(conn.participantId);
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

  state(): RoomState {
    return {
      roomId: this.roomId,
      roomName: this.roomName,
      meetingId: this.meetingId,
      meetingStartedAt: this.meetingStartedAt,
      participants: [...this.participants.values()].map(({ conns: _c, ...p }) => p),
      focusItemId: this.focusItemId,
      pinnedBy: this.pinnedBy,
      suggestion: this.suggestion,
      items: this.items(),
      capabilities: capabilities(),
    };
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

  nameOf(participantId: string) {
    return this.participants.get(participantId)?.name;
  }

  // ---- message handling ----------------------------------------------------

  private async handle(ws: WebSocket, msg: ClientMessage) {
    if (msg.type === "hello") {
      const name = String(msg.name || "Guest").slice(0, 40);
      const id = String(msg.participantId).slice(0, 40);
      this.conns.set(ws, { participantId: id, name });
      const existing = this.participants.get(id);
      if (existing) {
        existing.conns++;
        existing.name = name;
      } else {
        this.participants.set(id, { id, name, isPresenter: false, isSharing: false, conns: 1 });
      }
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
      });
      this.broadcastState();
      return;
    }

    const conn = this.conns.get(ws);
    if (!conn) return;
    const me = this.participants.get(conn.participantId);

    switch (msg.type) {
      case "focus":
        this.pinnedBy = null;
        this.setFocus(msg.itemId, conn.name, "manual");
        break;
      case "pin":
        this.setFocus(msg.itemId, conn.name, "pin");
        this.pinnedBy = conn.name;
        this.broadcastState();
        break;
      case "unpin":
        this.pinnedBy = null;
        this.broadcastState();
        break;
      case "suggestion.accept":
        if (this.canSteer(conn.participantId)) this.acceptSuggestion(conn.name);
        break;
      case "suggestion.dismiss":
        if (this.suggestion && this.canSteer(conn.participantId)) {
          this.dismissed.set(this.suggestion.itemId, Date.now());
          this.suggestion = null;
          this.broadcastState();
        }
        break;
      case "present":
        for (const p of this.participants.values()) {
          if (msg.on && p.id !== conn.participantId) p.isPresenter = false;
        }
        if (me) me.isPresenter = msg.on;
        if (!msg.on && me) me.isSharing = false;
        this.broadcastState();
        break;
      case "sharing":
        if (me) {
          me.isSharing = msg.on;
          if (msg.on) {
            for (const p of this.participants.values()) p.isPresenter = p.id === me.id;
          }
        }
        if (!msg.on) this.suggestion = null;
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
        if (me?.isSharing && typeof msg.dataUrl === "string" && msg.dataUrl.startsWith("data:image/jpeg;base64,")) {
          this.frame = { dataUrl: msg.dataUrl, at: Date.now() };
          void this.readScreen();
        }
        break;
      case "segment.move": {
        const before = this.db.meetingSegments(this.meetingId).find((s) => s.id === msg.segmentId);
        if (!before) return;
        const seg = this.db.moveSegment(msg.segmentId, msg.itemId);
        if (seg) {
          this.broadcast({ type: "segment.updated", segment: seg });
          this.scheduleNotes(before.itemId, 500);
          this.scheduleNotes(seg.itemId, 500);
        }
        break;
      }
      case "demo.play":
        void this.playDemo();
        break;
      case "meeting.end":
        await this.end();
        break;
    }
  }

  /** With a presenter, only they act on the agent's suggestions. */
  private canSteer(participantId: string) {
    const presenter = [...this.participants.values()].find((p) => p.isPresenter);
    return !presenter || presenter.id === participantId;
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
    this.addSegment(speakerId, speakerName, "speech", t, startedAt);
  }

  interim(speakerId: string, speakerName: string, text: string) {
    this.broadcast({ type: "interim", speakerId, speakerName, text: text.slice(0, 500) });
  }

  private addSegment(speakerId: string, speakerName: string, kind: "speech" | "chat", text: string, ts: number) {
    const itemId = kind === "chat" ? this.focusItemId : this.focusAt(ts);
    const segment = this.db.addSegment({ meetingId: this.meetingId, itemId, speakerId, speakerName, kind, text, ts });
    this.broadcast({ type: "segment", segment });
    this.scheduleNotes(itemId, NOTES_DEBOUNCE_MS);
  }

  // ---- notes --------------------------------------------------------------

  private scheduleNotes(itemId: string | null, delay: number) {
    if (this.ended) return;
    clearTimeout(this.noteTimers.get(itemId));
    this.noteTimers.set(
      itemId,
      setTimeout(() => {
        this.noteTimers.delete(itemId);
        void this.refreshNotes(itemId);
      }, delay),
    );
  }

  private async refreshNotes(itemId: string | null): Promise<Note[]> {
    // One run per item at a time; a request during a run queues behind it.
    const prev = this.noteRuns.get(itemId) ?? Promise.resolve();
    let notes: Note[] = [];
    const run = prev.then(async () => {
      const segments = this.db.itemSegments(this.meetingId, itemId);
      const item = itemId ? this.db.getItem(itemId) : null;
      try {
        const drafts = await this.agent.notesFor(item, segments);
        notes = this.db.replaceNotes(this.meetingId, itemId, drafts);
        this.broadcast({ type: "notes", meetingId: this.meetingId, itemId, notes });
      } catch (err) {
        console.error("[agent] notes failed:", err);
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

  /** Used by the demo script to drive the room like a real presenter would. */
  demoSuggest(itemId: string, reason: string) {
    this.suggestion = { itemId, reason, confidence: 0.9, since: Date.now() };
    this.broadcastState();
  }
  demoChat(speakerId: string, speakerName: string, text: string) {
    this.addSegment(speakerId, speakerName, "chat", text, Date.now());
  }
  demoAccept() {
    this.acceptSuggestion("Demo presenter");
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
      summary = await this.agent.summarizeMeeting(perItem);
    } catch (err) {
      console.error("[agent] summary failed:", err);
    }
    this.db.endMeeting(this.meetingId, summary || null);
    this.broadcast({ type: "meeting.ended", meetingId: this.meetingId });
    for (const ws of this.conns.keys()) ws.close();
    this.onClosed(this);
  }

  /** For the demo script: segments currently in this meeting. */
  segments(): Segment[] {
    return this.db.meetingSegments(this.meetingId);
  }
}
