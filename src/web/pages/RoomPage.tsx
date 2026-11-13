import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { enterWhenShown } from "../motion.ts";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Capabilities } from "../../shared/protocol.ts";
import { api, type RoomInfo } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { Meeting } from "../later.tsx";
import { SpaceHome } from "./SpaceHome.tsx";

export function RoomPage() {
  const { roomId = "" } = useParams();
  // Each space starts fresh: moving between spaces keeps nothing of the last one on screen.
  return <SpacePage key={roomId} roomId={roomId} />;
}

function SpacePage({ roomId }: { roomId: string }) {
  const { user, caps } = useAuth();
  // A space seen earlier in this visit shows at once as it was, and catches up when the fresh read lands.
  const [room, setRoom] = useState<RoomInfo | null>(() => api.last.room(roomId));
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  // Coming in from a phone's join sheet with the mic off.
  const [muted, setMuted] = useState(false);
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  const load = useCallback(() => {
    api
      .room(roomId)
      .then(setRoom)
      .catch((e) => setError(e.message));
  }, [roomId]);

  useEffect(() => {
    load();
  }, [load]);
  // The space page keeps itself current; a missed refresh keeps what's shown.
  const refresh = useCallback(() => {
    api.room(roomId).then(setRoom, () => {});
  }, [roomId]);

  // "Start talking" on the Spaces page comes straight in. The flag goes once used, so
  // leaving the meeting lands on the overview rather than joining again.
  useEffect(() => {
    if (!room || !params.has("join")) return;
    setJoined(true);
    setParams({}, { replace: true });
  }, [room, params, setParams]);

  // Going into the call, its screen opens up from just under full size; leaving it, the space's page
  // fades back in. Only on the switch, never on the first page of a visit.
  const wasJoined = useRef(joined);
  useLayoutEffect(() => {
    if (wasJoined.current === joined) return;
    wasJoined.current = joined;
    return enterWhenShown((page) => page, joined ? { scale: 0.985 } : { y: 4 });
  }, [joined]);

  if (error) {
    return (
      <div className="home">
        <div className="home-card">
          <p className="error">{error}</p>
          <div className="row">
            <button
              onClick={() => {
                setError(null);
                load();
              }}
            >
              Try again
            </button>
            <Link to="/">Back to spaces</Link>
          </div>
        </div>
      </div>
    );
  }
  if (!room) return <div className="loading">Loading…</div>;

  if (joined) {
    return (
      <Meeting
        roomId={room.id}
        user={user}
        caps={caps}
        startMuted={muted}
        onEnded={(meetingId) => nav(`/meetings/${meetingId}`)}
        onLeave={() => {
          setJoined(false);
          setMuted(false);
          // After the room hears we've gone, so the lobby doesn't show us as still here.
          setTimeout(load, 500);
        }}
      />
    );
  }

  return <SpaceHome room={room} onJoin={(opts) => {
        setMuted(Boolean(opts?.muted));
        setJoined(true);
      }} reload={refresh} />;
}

export function ModeNote({ caps }: { caps: Capabilities }) {
  const missing: string[] = [];
  if (!caps.livekit) missing.push("shared audio");
  if (caps.transcription === "browser") missing.push("server transcription");
  if (!caps.llm) missing.push("AI notes");
  if (!missing.length) return null;
  return (
    <p
      className="mode-chip"
      title={`Not connected yet: ${missing.join(", ")}. ${!caps.livekit ? "People won't hear each other; each browser transcribes its own mic. " : ""}Use Play demo in the space to see a scripted standup.`}
    >
      Demo mode · {missing.length === 1 ? `${missing[0]} off` : `${missing.length} services not connected`}
    </p>
  );
}
