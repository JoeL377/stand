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
import { useMicLevel } from "./micLevel.ts";
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
      toast({ text: "Back online · your changes were sent" });
    }
  }, [room.waiting, room.connected]);
  // Changes still waiting live only in this tab: closing or reloading it now would lose them.
  useEffect(() => {
    if (!room.waiting) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [room.waiting]);

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
    const link = `${location.origin}/r/${roomId}`;
    // Plain http on a local network has no clipboard: show the link to copy by hand.
    const show = () => toast({ text: `Copy this link: ${link}`, ms: 15_000 });
    if (!navigator.clipboard) return show();
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, show);
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
  // The space's open to-dos for the bar's list: this meeting's, then earlier ones still open.
  const barTodos = useMemo(() => {
    if (!state) return [];
    const key = (itemId: string | null) => keyOf(state.items.find((i) => i.id === itemId));
    const open = [...room.notes.filter((n) => n.kind === "action").reverse(), ...state.followUps].filter((n) => !n.doneAt);
    return open.map((n) => ({ id: n.id, text: n.text, owner: n.owner, itemKey: key(n.itemId) }));
  }, [state?.items, state?.followUps, room.notes]);
  useEffect(() => {
    if (state) macApp?.meeting?.({ space: state.roomName, itemKey: keyOf(focusItem), item: focusItem?.title ?? null, micOn, sharing, todos: barTodos });
  }, [state?.roomName, focusItem, micOn, sharing, barTodos]);
  useEffect(() => () => macApp?.meeting?.(null), []);
  useMicLevel(media.micTrack, macApp?.level);
  useEffect(() => macApp?.onCommand?.((c) => c === "mic" && void toggleMic()), [toggleMic]);
  // Mute and unmute from the keyboard, as in other meeting apps (Command or Ctrl + D).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "d") return;
      // On a Mac, Control + D in a text box deletes a character; leave that alone.
      if (IS_MAC && e.ctrlKey && (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      void toggleMic();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMic]);
  // The agenda folds to a thin strip for more stage; this browser remembers the choice.
  const [agendaFolded, setAgendaFolded] = useState(() => {
    try {
      return localStorage.getItem(AGENDA_FOLDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const foldAgenda = () =>
    setAgendaFolded((f) => {
      try {
        localStorage.setItem(AGENDA_FOLDED_KEY, f ? "0" : "1");
      } catch {
        // Private windows can refuse storage; it just won't be remembered.
      }
      return !f;
    });
  const foldRef = useRef(foldAgenda);
  foldRef.current = foldAgenda;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key !== "\\") return;
      e.preventDefault();
      foldRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          {media.audioAway ? (
            <button
              className="badge muted-pill blocked"
              onClick={media.talkHere}
              title={
                media.audioAway === "elsewhere"
                  ? "You joined this meeting in another window or the Mac app, and your mic moved there. Click to talk from here instead."
                  : "Your audio disconnected, so nobody can hear you. Click to reconnect."
              }
            >
              <MicOffIcon /> {media.audioAway === "elsewhere" ? "Mic in another window · Talk here" : "Audio disconnected · Reconnect"}
            </button>
          ) : (
            !media.micOn && (
              <button
                className={media.micError ? "badge muted-pill blocked" : "badge muted-pill"}
                onClick={() => void media.toggleMic()}
                disabled={media.micStarting}
                title={media.micError ?? "Nothing you say is recorded while you're muted. Click to unmute."}
              >
                <MicOffIcon /> {media.micStarting ? "Asking for the mic…" : media.micError ? "Mic blocked" : "Muted"}
              </button>
            )
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

      <div className={agendaFolded ? "meeting-grid agenda-folded" : "meeting-grid"}>
        <AgendaPanel
          folded={agendaFolded}
          onFold={foldAgenda}
          foldKeys={`${MOD.cmd} + \\`}
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
          <button
            className={media.micOn ? "control" : "control off"}
            onClick={() => void media.toggleMic()}
            disabled={media.micStarting}
            title={`${media.micOn ? "Mute" : "Unmute"} (${MOD.cmd} + D)`}
          >
            {media.micOn ? <MicIcon /> : <MicOffIcon />}
            <span>{media.micStarting ? "Starting…" : media.micOn ? "Mute" : "Unmute"}</span>
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
            // Waiting changes live only in this tab, so leaving now would drop them.
            const n = room.waiting;
            if (n && !confirm(`${n === 1 ? "1 change hasn't" : `${n} changes haven't`} reached Stand yet and will be lost. Leave anyway?`)) return;
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

/** What didn't happen, when a click needed the connection and it was down. */
const REFUSED: Partial<Record<string, string>> = {
  focus: "switching items waits for the connection",
  pin: "pinning waits for the connection",
  unpin: "pinning waits for the connection",
  "suggestion.accept": "switching waits for the connection",
  "suggestion.dismiss": "couldn't dismiss the suggestion yet",
  "upnext.add": "couldn't add the suggestion yet",
  "upnext.addAll": "couldn't add the suggestions yet",
  "upnext.dismiss": "couldn't dismiss the suggestion yet",
  "upnext.undismiss": "couldn't undo yet",
  "host.give": "handing over hosting waits for the connection",
  "stage.snap.close": "couldn't take the snap down yet",
  "meeting.end": "ending the meeting waits for the connection",
};

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
  if (trouble === "gone")
    return (
      <a className="conn-pill" href="/">
        This space no longer exists · Back to spaces
      </a>
    );
  if (connected) return null;
  const text = refused
    ? `Reconnecting · ${REFUSED[refused] ?? "that didn't go through, try again once Stand is back"}`
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
const IS_MAC = /Mac/.test(navigator.platform);
const AGENDA_FOLDED_KEY = "stand.agendaFolded";
const MOD = IS_MAC ? { ctrl: "Control", alt: "Option", cmd: "Command" } : { ctrl: "Ctrl", alt: "Alt", cmd: "Ctrl" };

function Shortcuts({ canSteer, onClose }: { canSteer: boolean; onClose: () => void }) {
  const ref = useDismiss<HTMLDivElement>(true, onClose);
  const rows: Array<[string, string]> = [
    ...(canSteer
      ? ([
          [`${MOD.alt} + ↓  /  ↑`, "Next / previous agenda item"],
          ["←  /  →", "Flip slides while a deck is open"],
        ] as Array<[string, string]>)
      : []),
    [`${MOD.cmd} + D`, "Mute or unmute"],
    [`${MOD.cmd} + \\`, "Hide or show the agenda"],
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
