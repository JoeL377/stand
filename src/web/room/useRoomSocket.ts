import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, Discussion, Note, RoomState, Segment, ServerMessage } from "../../shared/protocol.ts";

export interface Interim {
  speakerId: string;
  speakerName: string;
  text: string;
}

/** Why the room can't be reached, once a few reconnects have failed. */
export type Trouble = "signed-out" | "gone" | "unreachable";

/** Changes that have to reach the room. Each goes with an id and stays in the
 *  outbox until the server acks it; after a dropped connection it's sent again. */
const LASTING = new Set<ClientMessage["type"]>([
  "focus",
  "pin",
  "unpin",
  "suggestion.accept",
  "suggestion.dismiss",
  "upnext.add",
  "upnext.addAll",
  "upnext.dismiss",
  "upnext.undismiss",
  "host.give",
  "chat",
  "speech",
  "segment.move",
  "followup.done",
  "note.edit",
  "note.remove",
  "note.restore",
  "note.add",
  "stage.snap.close",
  "meeting.end",
]);
/** Of those, what can wait for the connection to come back. The rest steer the
 *  meeting as it happens, so they need the connection now. */
const CAN_WAIT = new Set<ClientMessage["type"]>(["chat", "speech", "segment.move", "followup.done", "note.edit", "note.remove", "note.restore", "note.add"]);
/** Sent on their own as things happen; nobody clicked anything. */
const BACKGROUND = new Set<ClientMessage["type"]>(["hello", "ping", "speech.interim", "frame", "sharing"]);
/** No ack or pong this long after sending: the connection is dead, even if the browser hasn't noticed yet. */
const ANSWER_WITHIN_MS = 6_000;
const PING_EVERY_MS = 10_000;

interface Outgoing {
  cid: string;
  msg: ClientMessage;
  /** When it last went out on an open socket; null while it waits for one. */
  sentAt: number | null;
}

/** What a waiting change looks like once it's through, so the screen doesn't wait for the server. */
function patchNotes(notes: Note[], { cid, msg }: Outgoing): Note[] {
  switch (msg.type) {
    case "followup.done":
      return notes.map((n) =>
        n.id === msg.noteId ? { ...n, doneAt: msg.done ? (n.doneAt ?? Date.now()) : null, doneBy: msg.done ? n.doneBy : null } : n,
      );
    case "note.edit":
      return notes.map((n) => (n.id === msg.noteId ? { ...n, text: msg.text, owner: n.kind === "action" ? (msg.owner ?? null) : null } : n));
    case "note.remove":
      return notes.filter((n) => n.id !== msg.noteId);
    case "note.add": {
      const id = `pending-${cid}`;
      if (notes.some((n) => n.id === id)) return notes;
      const added: Note = {
        id,
        meetingId: "",
        itemId: msg.itemId,
        kind: msg.kind,
        text: msg.text,
        owner: msg.owner ?? null,
        ts: Date.now(),
        doneAt: null,
        doneBy: null,
        discussionId: null,
      };
      return [...notes, added];
    }
    default:
      return notes;
  }
}
function patchState(state: RoomState, { msg }: Outgoing): RoomState {
  if (msg.type !== "followup.done") return state;
  return {
    ...state,
    followUps: state.followUps.map((f) => (f.id === msg.noteId ? { ...f, doneAt: msg.done ? (f.doneAt ?? Date.now()) : null } : f)),
  };
}
function patchSegments(segments: Segment[], { msg }: Outgoing): Segment[] {
  if (msg.type !== "segment.move") return segments;
  return segments.map((s) => (s.id === msg.segmentId ? { ...s, itemId: msg.itemId } : s));
}

export function useRoomSocket(roomId: string, enabled: boolean) {
  const [state, setState] = useState<RoomState | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  /** Items whose notes the agent is rewriting right now ("" = off-agenda). */
  const [notesBusy, setNotesBusy] = useState<string[]>([]);
  const [interims, setInterims] = useState<Record<string, Interim>>({});
  const [endedMeetingId, setEndedMeetingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  /** Changes made while disconnected, to be sent when the connection is back. */
  const [waiting, setWaiting] = useState(0);
  /** Something was clicked that needs the connection, while it was down. */
  /** What was just turned away for want of a connection, so the pill can say what didn't happen. */
  const [refused, setRefused] = useState<ClientMessage["type"] | null>(null);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const outbox = useRef<Outgoing[]>([]);
  // Offline adds that were deleted before they went out, kept so Undo can bring them back.
  const droppedAdds = useRef(new Map<string, Outgoing>());
  /** The meeting we're in, so a reconnect can tell the server. */
  const meetingRef = useRef<string | null>(null);
  /** Gives up on the current socket and reconnects. */
  const dropRef = useRef<() => void>(() => {});
  const refusedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const outboxRoom = useRef(roomId);

  useEffect(() => {
    if (!enabled) return;
    // Changes waiting for one space never go to another.
    if (outboxRoom.current !== roomId) outbox.current = [];
    outboxRoom.current = roomId;
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let heardAt = 0;
    let pingedAt = 0;
    let answersPings = false;
    const reapply = <T,>(v: T, patch: (v: T, o: Outgoing) => T) => outbox.current.reduce(patch, v);

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${roomId}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempts = 0;
        heardAt = Date.now();
        pingedAt = 0;
        answersPings = false;
        setConnected(true);
        setTrouble(null);
        ws.send(JSON.stringify({ type: "hello", meetingId: meetingRef.current ?? undefined } satisfies ClientMessage));
        // Whatever hadn't got through goes now, in the order it was made.
        for (const o of outbox.current) {
          ws.send(JSON.stringify({ ...o.msg, cid: o.cid }));
          o.sentAt = Date.now();
        }
        setWaiting(0);
      };
      ws.onmessage = (ev) => {
        heardAt = Date.now();
        const msg = JSON.parse(ev.data) as ServerMessage;
        switch (msg.type) {
          case "ack":
            outbox.current = outbox.current.filter((o) => o.cid !== msg.cid);
            break;
          case "pong":
            answersPings = true;
            break;
          case "welcome":
            // A "done" for a notes run may have been missed while away; the next run says busy again.
            setNotesBusy([]);
            setSegments(reapply(msg.segments, patchSegments));
            setNotes(reapply(msg.notes, patchNotes));
            setDiscussions(msg.discussions ?? []);
            break;
          case "state":
            meetingRef.current = msg.state.meetingId;
            setState(reapply(msg.state, patchState));
            break;
          case "segment":
            setSegments((s) => [...s, msg.segment].sort((a, b) => a.ts - b.ts));
            break;
          case "segment.updated":
            setSegments((s) => s.map((x) => (x.id === msg.segment.id ? msg.segment : x)));
            break;
          case "interim":
            setInterims((m) => {
              const next = { ...m };
              if (msg.text) next[msg.speakerId] = msg;
              else delete next[msg.speakerId];
              return next;
            });
            break;
          case "notes":
            setNotes((all) => reapply([...all.filter((n) => n.itemId !== msg.itemId), ...msg.notes], patchNotes));
            setDiscussions((all) => [...all.filter((d) => d.itemId !== msg.itemId), ...(msg.discussions ?? [])]);
            break;
          case "notes.busy": {
            const key = msg.itemId ?? "";
            setNotesBusy((all) => (msg.busy ? [...all.filter((k) => k !== key), key] : all.filter((k) => k !== key)));
            break;
          }
          case "meeting.ended":
            closedByUs = true;
            setEndedMeetingId(msg.meetingId);
            break;
          case "error":
            setError(msg.message);
            break;
        }
      };
      ws.onclose = () => lost(ws);
    };
    const lost = (ws: WebSocket) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setConnected(false);
      setWaiting(outbox.current.length);
      if (closedByUs) return;
      attempts++;
      // Still failing: find out whether it's the network, the sign-in or the space.
      if (attempts >= 3) void diagnose();
      retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
    };
    const diagnose = async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}`);
        setTrouble(res.status === 401 ? "signed-out" : res.status === 404 ? "gone" : res.ok ? null : "unreachable");
      } catch {
        setTrouble("unreachable");
      }
    };
    dropRef.current = () => {
      const ws = wsRef.current;
      if (!ws) return;
      ws.onclose = ws.onmessage = null;
      ws.close();
      lost(ws);
    };
    // A socket can die without the browser noticing for minutes (a lid shut,
    // Wi-Fi swapped). No ack or pong in time means it's gone: reconnect.
    const watch = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const unanswered = outbox.current.some((o) => o.sentAt !== null && now - o.sentAt > ANSWER_WITHIN_MS);
      if (unanswered || (answersPings && pingedAt > heardAt && now - pingedAt > ANSWER_WITHIN_MS)) return dropRef.current();
      if (now - pingedAt >= PING_EVERY_MS) {
        pingedAt = now;
        ws.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
      }
    }, 2_000);
    connect();
    return () => {
      closedByUs = true;
      clearTimeout(retry);
      clearInterval(watch);
      wsRef.current?.close();
    };
  }, [roomId, enabled]);

  /** Sends to the room. Returns false when it couldn't go and won't be sent
   *  later: it needs a live connection and there isn't one. */
  const send = useCallback((msg: ClientMessage): boolean => {
    const ws = wsRef.current;
    const open = ws?.readyState === WebSocket.OPEN;
    if (!LASTING.has(msg.type) || (!open && !CAN_WAIT.has(msg.type))) {
      if (open) ws.send(JSON.stringify(msg));
      else if (!BACKGROUND.has(msg.type)) {
        setRefused(msg.type);
        clearTimeout(refusedTimer.current);
        refusedTimer.current = setTimeout(() => setRefused(null), 4_000);
      }
      return open;
    }
    // A note added while offline has no real id yet: an edit or delete of it changes the waiting add instead.
    if ((msg.type === "note.edit" || msg.type === "note.remove") && msg.noteId.startsWith("pending-")) {
      const add = outbox.current.find((o) => `pending-${o.cid}` === msg.noteId && o.msg.type === "note.add" && o.sentAt === null);
      if (add && add.msg.type === "note.add") {
        if (msg.type === "note.edit") {
          add.msg = { ...add.msg, text: msg.text, owner: msg.owner ?? null };
          setNotes((ns) => patchNotes(ns, { cid: "", msg, sentAt: null }));
        } else {
          outbox.current = outbox.current.filter((o) => o !== add);
          droppedAdds.current.set(msg.noteId, add);
          setWaiting(outbox.current.length);
          setNotes((ns) => ns.filter((n) => n.id !== msg.noteId));
        }
        return true;
      }
    }
    // Undo of deleting one of those: the add goes back in the queue as it was.
    if (msg.type === "note.restore" && droppedAdds.current.has(msg.noteId)) {
      const add = droppedAdds.current.get(msg.noteId)!;
      droppedAdds.current.delete(msg.noteId);
      outbox.current.push(add);
      if (open) {
        ws.send(JSON.stringify({ ...add.msg, cid: add.cid }));
        add.sentAt = Date.now();
      } else setWaiting(outbox.current.length);
      setNotes((ns) => patchNotes(ns, add));
      return true;
    }
    // Not crypto.randomUUID: that needs https, and people test over plain http on their network.
    const o: Outgoing = { cid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, msg, sentAt: null };
    outbox.current.push(o);
    if (open) {
      ws.send(JSON.stringify({ ...msg, cid: o.cid }));
      o.sentAt = Date.now();
    } else setWaiting(outbox.current.length);
    // Show it done now; the server's copy replaces this when it arrives.
    setNotes((ns) => patchNotes(ns, o));
    setState((s) => s && patchState(s, o));
    setSegments((ss) => patchSegments(ss, o));
    return true;
  }, []);

  return {
    state,
    segments,
    notes,
    discussions,
    notesBusy,
    interims,
    endedMeetingId,
    error,
    setError,
    connected,
    waiting,
    refused,
    trouble,
    send,
  };
}
