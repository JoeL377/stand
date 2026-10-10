import { useEffect, useMemo, useRef, useState } from "react";
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
import { toast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";

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
  const [speechBlocked, setSpeechBlocked] = useState(false);
  useEffect(() => {
    if (media.micOn) setSpeechBlocked(false);
  }, [media.micOn]);
  useBrowserSpeech(
    browserTranscribe,
    (text, startedAt) => send({ type: "speech", text, startedAt }),
    (text) => send({ type: "speech.interim", text }),
    (msg) => {
      setSpeechBlocked(true);
      room.setError(msg);
    },
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

  // Problems with the connection, the mic or the screen show up as a message that goes away, not a row.
  useEffect(() => {
    if (!room.error) return;
    toast({ tone: "error", text: room.error });
    room.setError(null);
  }, [room.error]);
  useEffect(() => {
    if (media.mediaError) toast({ tone: "error", text: media.mediaError });
  }, [media.mediaError]);

  // Changes made while the connection was down went through once it came back: say so, once.
  const hadWaiting = useRef(false);
  useEffect(() => {
    if (room.waiting > 0) hadWaiting.current = true;
    else if (room.connected && hadWaiting.current) {
      hadWaiting.current = false;
      toast({ text: "Back online · your changes went through" });
    }
  }, [room.waiting, room.connected]);

  // Everyone hears about it when the host changes, not just the two people involved.
  const lastHost = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = host?.id ?? null;
    if (lastHost.current !== undefined && id && id !== lastHost.current) {
      toast({ text: id === participantId ? "You're the host now: you choose the item everyone talks about." : `${host!.name} is hosting now` });
    }
    if (id) lastHost.current = id;
  }, [host?.id]);

  const [copied, setCopied] = useState(false);
  const copyInvite = () => {
    navigator.clipboard?.writeText(`${location.origin}/r/${roomId}`).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast({ tone: "error", text: `Couldn't copy. The link is ${location.origin}/r/${roomId}` }),
    );
  };
  const [showKeys, setShowKeys] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "?" || t.closest("input, textarea, select, [contenteditable]")) return;
      setShowKeys((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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

  // Why nothing said is being kept, while that lasts. A toast says it once; this stays until it's fixed.
  const notRecording = state.transcriptionDown
    ? "Stand stopped transcribing. Leave and rejoin to start it again; what was said before is saved."
    : caps.transcription === "browser" && media.micOn && !browserSpeechSupported()
      ? "This browser can't transcribe, so what you say isn't recorded. Use Chrome, Edge or Safari."
      : caps.transcription === "browser" && media.micOn && speechBlocked
        ? "Speech recognition is blocked, so what you say isn't recorded. Allow the microphone for this site, then click Mute and Unmute."
        : null;

  const offParts = [
    !caps.livekit && "people can't hear each other yet (add LiveKit keys)",
    caps.transcription === "browser" &&
      (browserSpeechSupported() ? "each browser transcribes its own mic" : "this browser can't transcribe; use Chrome, Edge or Safari"),
    !caps.llm && "notes come from simple rules, not Claude (add an Anthropic key)",
  ].filter(Boolean) as string[];

  return (
    <div className="meeting">
      <header className="topbar">
        <div className="topbar-left">
          <Logo size={20} />
          <strong className="room-name">{state.roomName}</strong>
          <span className="timer">
            <span className={notRecording ? "rec-dot off" : "rec-dot"} aria-hidden /> {fmtDuration(now - state.meetingStartedAt)}
          </span>
          {notRecording && (
            <button className="badge not-recording" title={notRecording} onClick={() => toast({ tone: "error", text: notRecording })}>
              Not recording
            </button>
          )}
          <ConnectionPill room={room} />
          {state.ending && !canSteer && <span className="badge">Writing notes…</span>}
          {!media.micOn && (
            <button className="badge muted-pill" onClick={() => void media.toggleMic()} title="Nothing you say is recorded while you're muted. Click to unmute.">
              <MicOffIcon /> Muted
            </button>
          )}
        </div>
        <div className="topbar-right">
          {offParts.length > 0 && <DemoMode parts={offParts} />}
          <button
            className="ghost icon-btn keys-btn"
            title="How Stand works and keyboard shortcuts (?)"
            aria-label="Help and keyboard shortcuts"
            aria-expanded={showKeys}
            // The sheet closes on any click outside it; this button toggles it instead.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setShowKeys((v) => !v)}
          >
            ?
          </button>
          <button className="ghost invite" onClick={copyInvite}>
            <LinkIcon /> {copied ? "Copied ✓" : "Copy invite link"}
          </button>
        </div>
      </header>

      {showKeys && <Shortcuts canSteer={canSteer} onClose={() => setShowKeys(false)} />}
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
          segments={room.segments}
          offline={!room.connected}
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

/** One pill for what isn't connected yet, with the details a click away. */
function DemoMode({ parts }: { parts: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  return (
    <span className="pop-wrap demo-mode" ref={ref}>
      <button className="badge" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Demo mode
      </button>
      {open && (
        <div className="add-menu demo-mode-pop" role="dialog">
          <strong>Demo mode</strong>
          <ul>
            {parts.map((p) => (
              <li key={p}>{p[0].toUpperCase() + p.slice(1)}.</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

// Key names written out: ⇧ alone reads as an arrow.
const MOD = /Mac/.test(navigator.platform) ? { ctrl: "Control", alt: "Option" } : { ctrl: "Ctrl", alt: "Alt" };

function Shortcuts({ canSteer, onClose }: { canSteer: boolean; onClose: () => void }) {
  const ref = useDismiss<HTMLDivElement>(true, onClose);
  const rows: Array<[string, string]> = [
    ...(canSteer
      ? ([
          [`${MOD.alt} + ↓  /  ↑`, "Next / previous agenda item"],
          ["←  /  →", "Flip slides while a deck is open"],
        ] as Array<[string, string]>)
      : []),
    [`${MOD.ctrl} + Shift + S`, "Snap the shared screen into the meeting"],
    ["Paste or drop an image", "Add a screenshot to the item in focus"],
    ["Esc", "Close a menu or form"],
    ["?", "Show or hide these shortcuts"],
  ];
  return (
    <div className="shortcuts" role="dialog" aria-label="How Stand works and keyboard shortcuts" ref={ref}>
      <div className="shortcuts-head">
        <strong>How Stand works</strong>
        <button className="toast-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <ul className="how">
        <li>The host picks the item on the left. Everything said is filed under it.</li>
        <li>Notes appear after a short pause in the talk. ✦ marks what the agent wrote or suggests.</li>
        <li>Removed something by mistake? Undo is in the message at the bottom of the screen.</li>
        <li>If the connection drops, edits and to-do checks wait and go through when Stand is back.</li>
      </ul>
      <div className="shortcuts-head">
        <strong>Keyboard shortcuts</strong>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
