import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, Note, RoomState, Segment, ServerMessage } from "../../shared/protocol.ts";

export interface Interim {
  speakerId: string;
  speakerName: string;
  text: string;
}

export function useRoomSocket(roomId: string, enabled: boolean) {
  const [state, setState] = useState<RoomState | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [interims, setInterims] = useState<Record<string, Interim>>({});
  const [endedMeetingId, setEndedMeetingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${roomId}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: "hello" } satisfies ClientMessage));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        switch (msg.type) {
          case "welcome":
            setSegments(msg.segments);
            setNotes(msg.notes);
            break;
          case "state":
            setState(msg.state);
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
            setNotes((all) => [...all.filter((n) => n.itemId !== msg.itemId), ...msg.notes]);
            break;
          case "meeting.ended":
            closedByUs = true;
            setEndedMeetingId(msg.meetingId);
            break;
          case "error":
            setError(msg.message);
            break;
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closedByUs) return;
        attempts++;
        retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
      };
    };
    connect();
    return () => {
      closedByUs = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [roomId, enabled]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { state, segments, notes, interims, endedMeetingId, error, setError, connected, send };
}
