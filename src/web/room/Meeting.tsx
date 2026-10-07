import { useEffect, useMemo, useState } from "react";
import type { Capabilities, User } from "../../shared/protocol.ts";
import { useRoomSocket } from "./useRoomSocket.ts";
import { useMedia } from "./useMedia.ts";
import { browserSpeechSupported, useBrowserSpeech } from "./useBrowserSpeech.ts";
import { useFrameSampler } from "./useFrameSampler.ts";
import { AgendaPanel } from "./AgendaPanel.tsx";
import { Stage } from "./Stage.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { fmtDuration } from "../util.ts";
import { LinkIcon, Logo, MicIcon, MicOffIcon, PlayIcon, ShareIcon, StopShareIcon } from "../icons.tsx";

export function Meeting(props: {
  roomId: string;
  user: User;
  caps: Capabilities;
  onEnded: (meetingId: string) => void;
  onLeave: () => void;
}) {
  const { roomId, caps } = props;
  const participantId = props.user.id;
  const room = useRoomSocket(roomId, true);
  const media = useMedia({ roomId, livekit: caps.livekit, enabled: true });
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);
  const { send, state } = room;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (room.endedMeetingId) {
      media.leave();
      props.onEnded(room.endedMeetingId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.endedMeetingId]);

  // Browser transcription when the server can't transcribe.
  const browserTranscribe = caps.transcription === "browser" && media.micOn;
  useBrowserSpeech(
    browserTranscribe,
    (text, startedAt) => send({ type: "speech", text, startedAt }),
    (text) => send({ type: "speech.interim", text }),
    (msg) => room.setError(msg),
  );

  // Tell the room when we start/stop sharing, and feed the agent snapshots.
  const sharing = Boolean(media.localScreen);
  useEffect(() => {
    send({ type: "sharing", on: sharing });
  }, [sharing, send, room.connected]);
  useFrameSampler(media.localScreen, (dataUrl) => send({ type: "frame", dataUrl }));

  const me = state?.participants.find((p) => p.id === participantId);
  const host = state?.participants.find((p) => p.isHost);
  const canSteer = host?.id === participantId;
  const otherSharer = state?.participants.find((p) => p.isSharing && p.id !== participantId);
  const focusItem = useMemo(
    () => state?.items.find((i) => i.id === state.focusItemId) ?? null,
    [state?.items, state?.focusItemId],
  );

  if (!state) {
    return <div className="loading">{room.connected ? "Joining…" : "Connecting…"}</div>;
  }

  const anyErr = room.error ?? media.mediaError;

  return (
    <div className="meeting">
      <header className="topbar">
        <div className="topbar-left">
          <Logo size={20} />
          <strong className="room-name">{state.roomName}</strong>
          <span className="timer">
            <span className="rec-dot" aria-hidden /> {fmtDuration(now - state.meetingStartedAt)}
          </span>
          {!room.connected && <span className="badge warn">Reconnecting…</span>}
        </div>
        <div className="topbar-right">
          {!caps.livekit && <span className="badge" title="Add LiveKit keys so people can hear each other">Mock audio</span>}
          {caps.transcription === "browser" && (
            <span className="badge" title="Each browser transcribes its own mic">
              Browser transcription{!browserSpeechSupported() && " (unsupported here)"}
            </span>
          )}
          {!caps.llm && <span className="badge" title="Add an Anthropic key for AI notes and screen reading">Heuristic notes</span>}
          <button className="ghost invite" onClick={() => void navigator.clipboard?.writeText(`${location.origin}/r/${roomId}`)}>
            <LinkIcon /> Copy invite link
          </button>
        </div>
      </header>

      {anyErr && (
        <div className="banner error" onClick={() => room.setError(null)}>
          {anyErr}
        </div>
      )}
      {media.needsAudioUnlock && (
        <div className="banner">
          Your browser blocked audio. <button onClick={() => void media.unlockAudio()}>Turn on sound</button>
        </div>
      )}

      <div className="meeting-grid">
        <AgendaPanel roomId={roomId} state={state} send={send} canSteer={canSteer} notes={room.notes} segments={room.segments} />
        <Stage
          state={state}
          me={me}
          focusItem={focusItem}
          canSteer={canSteer}
          participantId={participantId}
          send={send}
          localScreen={media.localScreen}
          remoteScreen={media.remoteScreen}
          speaking={media.speaking}
          interims={room.interims}
          livekit={caps.livekit}
        />
        <SidePanel
          state={state}
          segments={room.segments}
          notes={room.notes}
          interims={room.interims}
          send={send}
          participantId={participantId}
        />
      </div>

      <footer className="controls">
        <div className="controls-group">
          <button className={media.micOn ? "control" : "control off"} onClick={() => void media.toggleMic()}>
            {media.micOn ? <MicIcon /> : <MicOffIcon />}
            <span>{media.micOn ? "Mute" : "Unmute"}</span>
          </button>
          {sharing ? (
            <button className="control sharing" onClick={() => void media.stopShare()}>
              <StopShareIcon />
              <span>Stop sharing</span>
            </button>
          ) : (
            <button
              className="control share"
              onClick={() => void media.startShare()}
              disabled={Boolean(otherSharer)}
              title={otherSharer ? `${otherSharer.name} is sharing` : undefined}
            >
              <ShareIcon />
              <span>Share screen</span>
            </button>
          )}
          {canSteer && (!caps.livekit || !caps.llm) ? (
            <button className="control" onClick={() => send({ type: "demo.play" })} title="Plays a scripted 4-person standup into this room">
              <PlayIcon />
              <span>Play demo</span>
            </button>
          ) : null}
        </div>
        <span className="spacer" />
        <button
          className="control pill"
          onClick={() => {
            media.leave();
            props.onLeave();
          }}
        >
          Leave
        </button>
        {canSteer && (
        <button
          className="control pill danger"
          disabled={ending}
          onClick={() => {
            if (!confirm("End the meeting for everyone and write up the notes?")) return;
            setEnding(true);
            send({ type: "meeting.end" });
          }}
        >
          {ending ? "Writing notes…" : "End meeting"}
        </button>
        )}
      </footer>
    </div>
  );
}
