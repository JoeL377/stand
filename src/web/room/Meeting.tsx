import { useEffect, useMemo, useState } from "react";
import type { Capabilities, User } from "../../shared/protocol.ts";
import { useRoomSocket } from "./useRoomSocket.ts";
import { useMedia } from "./useMedia.ts";
import { browserSpeechSupported, useBrowserSpeech } from "./useBrowserSpeech.ts";
import { useFrameSampler } from "./useFrameSampler.ts";
import { AgendaPanel } from "./AgendaPanel.tsx";
import { Stage } from "./Stage.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { fmtDuration, keyOf } from "../util.ts";
import { macApp } from "../macApp.ts";
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

  // End meeting went out but the server never took it up (the host seat moved, say): offer it again.
  useEffect(() => {
    if (!ending || state?.ending || !room.connected) return;
    const t = setTimeout(() => setEnding(false), 15_000);
    return () => clearTimeout(t);
  }, [ending, state?.ending, room.connected]);
  useEffect(() => {
    if (room.error) setEnding(false);
  }, [room.error]);

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

  // Stand for Mac keeps a small bar on screen while Stand is in the background
  // (presenting another app, say): what's in focus, the mic, and Snap.
  const { micOn, toggleMic } = media;
  useEffect(() => {
    if (state) macApp?.meeting?.({ space: state.roomName, itemKey: keyOf(focusItem), item: focusItem?.title ?? null, micOn });
  }, [state?.roomName, focusItem, micOn]);
  useEffect(() => () => macApp?.meeting?.(null), []);
  useEffect(() => macApp?.onCommand?.((c) => c === "mic" && void toggleMic()), [toggleMic]);

  if (!state) {
    return <div className="loading">{room.trouble ? <ConnectionPill room={room} /> : room.connected ? "Joining…" : "Connecting…"}</div>;
  }
  // The server says so once it's on it; until then, our own click.
  const writingUp = ending || Boolean(state.ending);

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
          <ConnectionPill room={room} />
          {state.ending && !canSteer && <span className="badge">Writing notes…</span>}
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
        <AgendaPanel
          roomId={roomId}
          state={state}
          send={send}
          canSteer={canSteer}
          offline={!room.connected}
          notes={room.notes}
          segments={room.segments}
        />
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
          discussions={room.discussions}
          notesBusy={room.notesBusy}
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
            <button className="control" onClick={() => send({ type: "demo.play" })} title="Plays a scripted 4-person standup into this space">
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
          disabled={writingUp || !room.connected}
          title={room.connected ? undefined : "You can end the meeting once Stand reconnects"}
          onClick={() => {
            if (!confirm("End the meeting for everyone and write up the notes?")) return;
            if (send({ type: "meeting.end" })) setEnding(true);
          }}
        >
          {writingUp ? "Writing notes…" : "End meeting"}
        </button>
        )}
      </footer>
    </div>
  );
}

/** Only while something's wrong with the connection: what's happening to your changes, or what to do. */
function ConnectionPill(props: { room: Pick<ReturnType<typeof useRoomSocket>, "connected" | "waiting" | "refused" | "trouble"> }) {
  const { connected, waiting, refused, trouble } = props.room;
  if (trouble === "signed-out") {
    return (
      // Reloading shows the sign-in page, which brings you back here.
      <a className="conn-pill" href={location.pathname}>
        Signed out · Sign in again
      </a>
    );
  }
  if (trouble === "gone") return <span className="conn-pill">This space no longer exists</span>;
  if (connected) return null;
  const text = refused
    ? "Reconnecting · that didn't go through"
    : waiting > 0
      ? `Reconnecting · ${waiting} change${waiting === 1 ? "" : "s"} waiting`
      : trouble === "unreachable"
        ? "Can't reach Stand · retrying"
        : "Reconnecting…";
  return (
    <span
      className="conn-pill"
      role="status"
      title="Edits, to-do checks and speech are kept and sent when Stand is back. Switching items and ending the meeting wait for the connection."
    >
      {text}
    </span>
  );
}
