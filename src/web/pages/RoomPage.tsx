import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Capabilities } from "../../shared/protocol.ts";
import { api, type RoomInfo } from "../api.ts";
import { fmtDate, fmtTime, participantId, savedName, saveName } from "../util.ts";
import { rememberRoom } from "./Home.tsx";
import { Meeting } from "../room/Meeting.tsx";

export function RoomPage() {
  const { roomId = "" } = useParams();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(savedName());
  const [joined, setJoined] = useState(false);
  const nav = useNavigate();

  const load = useCallback(() => {
    api
      .room(roomId)
      .then((r) => {
        setRoom(r);
        rememberRoom({ id: r.id, name: r.name });
      })
      .catch((e) => setError(e.message));
  }, [roomId]);

  useEffect(() => {
    load();
    api.config().then(setCaps).catch(() => {});
  }, [load]);

  if (error) {
    return (
      <div className="home">
        <div className="home-card">
          <p className="error">{error}</p>
          <Link to="/">Back</Link>
        </div>
      </div>
    );
  }
  if (!room || !caps) return <div className="loading">Loading…</div>;

  if (joined) {
    return (
      <Meeting
        roomId={room.id}
        name={name}
        participantId={participantId()}
        caps={caps}
        onEnded={(meetingId) => nav(`/meetings/${meetingId}`)}
        onLeave={() => {
          setJoined(false);
          load();
        }}
      />
    );
  }

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    saveName(name.trim());
    setJoined(true);
  };

  const past = room.meetings.filter((m) => m.endedAt && m.segmentCount > 0);

  return (
    <div className="home">
      <div className="home-card">
        <div className="brand">
          <Link to="/">
            <span className="logo" aria-hidden>
              ▍▌▋
            </span>
            Standup
          </Link>
        </div>
        <h1>{room.name}</h1>
        <p className="muted">
          {room.liveMeetingId ? "A meeting is in progress." : "No one is here yet."} {room.items.length} item
          {room.items.length === 1 ? "" : "s"} on the agenda.
        </p>
        <form onSubmit={join} className="row">
          <input autoFocus placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <button className="primary" disabled={!name.trim()}>
            Join room
          </button>
        </form>
        <ModeNote caps={caps} />
        <button
          className="link"
          onClick={() => {
            void navigator.clipboard?.writeText(location.href);
          }}
        >
          Copy invite link
        </button>

        {room.items.length > 0 && (
          <div className="recent">
            <h3>Agenda history</h3>
            {room.items.map((it) => (
              <Link key={it.id} to={`/items/${it.id}`} className="recent-row">
                <span>
                  {it.externalId && <span className="key">{it.externalId}</span>} {it.title}
                </span>
                <span className="muted">History →</span>
              </Link>
            ))}
          </div>
        )}
        {past.length > 0 && (
          <div className="recent">
            <h3>Past meetings</h3>
            {past.map((m) => (
              <Link key={m.id} to={`/meetings/${m.id}`} className="recent-row">
                <span>
                  {fmtDate(m.startedAt)} · {fmtTime(m.startedAt)}
                  {m.summary && <span className="muted recap-line"> {m.summary}</span>}
                </span>
                <span className="muted">Recap →</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ModeNote({ caps }: { caps: Capabilities }) {
  const missing: string[] = [];
  if (!caps.livekit) missing.push("shared audio (LiveKit)");
  if (caps.transcription !== "deepgram") missing.push("server transcription (Deepgram)");
  if (!caps.llm) missing.push("AI notes (Anthropic)");
  if (!missing.length) return null;
  return (
    <p className="mode-note">
      <strong>Mock mode.</strong> Not connected yet: {missing.join(", ")}.{" "}
      {!caps.livekit && "People won't hear each other; each browser transcribes its own mic. "}
      Use <em>Play demo</em> in the room to see a scripted standup.
    </p>
  );
}
