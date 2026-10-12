import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { PopOutBar, canPopOut, usePopOut } from "./PopOutBar.tsx";
import { LinkIcon, Logo, MicIcon, MicOffIcon, PlayIcon, ShareIcon, StopShareIcon } from "../icons.tsx";
import { dismissToast, toast, undoing } from "../Toasts.tsx";
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

  // Browser transcription when the server can't transcribe. It stops once the notes are being written:
  // nothing said after that is kept, so nothing is shown as heard.
  const browserTranscribe = caps.transcription === "browser" && media.micOn && !state?.ending;
  const [speechBlocked, setSpeechBlocked] = useState(false);
  const [speechTrouble, setSpeechTrouble] = useState<string | null>(null);
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
    setSpeechTrouble,
  );

  // Why nothing said is being kept, while that lasts. A toast says it once; this stays until it's fixed.
  const notRecording = state?.transcriptionRestarting
    ? "Stand stopped transcribing and is starting it again. What was said before is saved."
    : state?.transcriptionDown
    ? "Stand stopped transcribing. Leave and rejoin to start it again; what was said before is saved."
    : caps.transcription === "browser" && media.micOn && !browserSpeechSupported()
      ? "This browser can't transcribe, so what you say isn't recorded. Use Chrome, Edge or Safari."
      : caps.transcription === "browser" && media.micOn && speechBlocked
        ? "Speech recognition is blocked, so what you say isn't recorded. Allow the microphone for this site, then click Mute and Unmute."
        : caps.transcription === "browser" && media.micOn && speechTrouble && !state?.ending
          ? `Not recording: ${speechTrouble}. Stand keeps trying, and picks up again by itself.`
          : null;
  // Everyone sees who isn't being recorded, not just the person it's happening to.
  const recording = !(caps.transcription === "browser" && notRecording);
  useEffect(() => {
    if (caps.transcription === "browser") send({ type: "recording", on: recording });
  }, [recording, send, room.connected, caps.transcription]);

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
  // Two people pressed Share together and Stand took the other one: stop ours, so nobody
  // shares a screen the room can't see. Stand says who is sharing.
  const turnedAway = sharing && Boolean(otherSharer) && me?.isSharing === false;
  useEffect(() => {
    if (turnedAway) void media.stopShare();
  }, [turnedAway]);
  const focusItem = useMemo(
    () => state?.items.find((i) => i.id === state.focusItemId) ?? null,
    [state?.items, state?.focusItemId],
  );

  // Stand for Mac keeps a small bar on screen while Stand is in the background
  // (presenting another app, say): what's in focus, the mic, and Snap.
  const { micOn, toggleMic } = media;
  // Alignment meetings show the question where others show the item in focus.
  const aligning = state?.kind === "alignment";
  const barItem = aligning ? (state?.alignment?.state.question?.text ?? null) : (focusItem?.title ?? null);
  const barKey = aligning ? null : keyOf(focusItem);

  // Problems with the connection, the mic or the screen show up as a message that goes away, not a row.
  const lastErrorAt = useRef(0);
  useEffect(() => {
    if (!room.error) return;
    lastErrorAt.current = Date.now();
    toast({ tone: "error", text: room.error });
    room.setError(null);
  }, [room.error]);
  useEffect(() => {
    if (!media.mediaError) return;
    // In the Mac app, the way to the setting comes with the message.
    const which = /› (Microphone|Screen)/.exec(media.mediaError)?.[1];
    const fix = which && macApp?.openSettings ? { label: "Open System Settings", run: () => macApp?.openSettings?.(which === "Microphone" ? "microphone" : "screen") } : undefined;
    toast({ tone: "error", text: media.mediaError, ...(fix ? { action: fix } : {}) });
  }, [media.mediaError]);

  // Changes made while the connection was down went through once it came back: say so, once.
  // The count only drops as Stand confirms each one, and one it turned away comes as an error
  // right after; that message says what happened instead.
  const hadWaiting = useRef(false);
  useEffect(() => {
    if (room.waiting > 0) {
      hadWaiting.current = true;
      return;
    }
    if (!room.connected || !hadWaiting.current) return;
    hadWaiting.current = false;
    const t = setTimeout(() => {
      if (Date.now() - lastErrorAt.current > 2_000) toast({ text: "Back online · your changes were sent" });
    }, 800);
    return () => clearTimeout(t);
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
  // The bar also carries what would otherwise only show in the hidden window: the nudge, and anything wrong.
  const nudgeItem = canSteer && !state?.ending && state?.suggestion ? state.items.find((i) => i.id === state.suggestion!.itemId) : null;
  const nudge = nudgeItem ? (keyOf(nudgeItem) ?? nudgeItem.title) : null;
  // Switch on the bar takes the item the bar showed, and says there what moved, with Undo:
  // the window with the usual Undo is out of sight.
  const [barSwitched, setBarSwitched] = useState<string | null>(null);
  useEffect(() => {
    if (!barSwitched) return;
    const t = setTimeout(() => setBarSwitched(null), 8000);
    return () => clearTimeout(t);
  }, [barSwitched]);
  const switchFromBar = useRef(() => {});
  const switchToast = useRef<number | null>(null);
  switchFromBar.current = () => {
    const s = state?.suggestion;
    if (!s || !nudgeItem || s.itemId !== nudgeItem.id) return;
    const n = room.segments.filter((g) => g.itemId === state.focusItemId && g.ts >= s.since).length;
    if (!send({ type: "suggestion.accept", itemId: nudgeItem.id })) return;
    // The bar is narrow: where it went comes first.
    setBarSwitched(n ? `${nudge} · ${n} moved` : `${nudge}`);
    if (n)
      switchToast.current = toast({
        text: `Moved ${n} remark${n === 1 ? "" : "s"} to ${nudge}`,
        action: { label: "Undo", run: undoing(() => send({ type: "suggestion.undo" }) && (setBarSwitched(null), true)) },
      });
  };
  const barEnding = ending || Boolean(state?.ending);
  useEffect(() => {
    if (state)
      macApp?.meeting?.({
        roomId,
        space: state.roomName,
        itemKey: barKey,
        item: barItem,
        micOn,
        sharing,
        todos: barTodos,
        nudge,
        nudgeFromTalk: state.suggestion?.source === "talk",
        switched: barSwitched,
        notRecording: Boolean(notRecording),
        offline: !room.connected,
        ending: barEnding,
      });
  }, [state?.roomName, barKey, barItem, micOn, sharing, barTodos, nudge, barSwitched, Boolean(notRecording), room.connected, barEnding]);
  useEffect(() => () => macApp?.meeting?.(null), []);
  // In a browser, the bar pops out into a little always-on-top window (Chrome and Edge).
  const popOut = usePopOut();
  const popLevels = useRef<((v: number) => void) | null>(null);
  const popLevel = useCallback((v: number) => popLevels.current?.(v), []);
  const stageSnap = useRef<(() => Promise<boolean>) | null>(null);
  const openPopOut = useCallback(
    () => void popOut.open().catch(() => toast({ tone: "error", text: "Your browser didn't let Stand pop out the bar. Try the Pop out button." })),
    [popOut.open],
  );
  const offerPopOut = !macApp && canPopOut();
  // Starting a share is when you leave this tab: offer the bar then.
  useEffect(() => {
    if (sharing && offerPopOut && !popOut.win)
      toast({ text: "Pop out a small bar to keep your mic and Snap in reach while you share.", action: { label: "Pop out", run: openPopOut }, ms: 10000 });
  }, [sharing]);
  useMicLevel(media.micTrack, macApp?.level ?? (popOut.win ? popLevel : undefined));
  useEffect(
    () =>
      macApp?.onCommand?.((c) => {
        if (c === "mic") void toggleMic();
        if (c === "shortcuts") setShowKeys(true);
        if (c === "switch") switchFromBar.current();
        // One Undo: the page's goes once the bar's is used. While offline it waits to be sent.
        if (c === "undo" && send({ type: "suggestion.undo" })) {
          setBarSwitched(null);
          if (switchToast.current !== null) dismissToast(switchToast.current);
          switchToast.current = null;
        }
      }),
    [toggleMic, send],
  );
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
  // The agenda isn't what an alignment meeting is about: it starts folded, without changing what this browser remembers.
  const foldedForAlignment = useRef(false);
  useEffect(() => {
    if (!aligning || foldedForAlignment.current) return;
    foldedForAlignment.current = true;
    setAgendaFolded(true);
  }, [aligning]);
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
    return (
      <div className="loading">
        {room.trouble ? <ConnectionPill room={room} /> : room.connected ? "Joining…" : "Connecting…"}
        <button
          className="link"
          onClick={() => {
            media.leave();
            props.onLeave();
          }}
        >
          Back to the space
        </button>
      </div>
    );
  }
  // The server says so once it's on it; until then, our own click.
  const writingUp = barEnding;
  // Mic blocked while transcription is also down: one pill, with the steps in order.
  const micFirst = Boolean(state.transcriptionDown && media.micError && !media.micOn);
  const micLabel = media.micStarting
    ? "Asking for the mic…"
    : media.micError
      ? /disconnected|No microphone/.test(media.micError)
        ? "No mic"
        : "Mic blocked"
      : "Muted";
  const writingTitle = "Stand stopped listening and is writing the notes, usually in under a minute. You can leave: the recap shows up in this space.";

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
          {aligning && <span className="kind-pill">Alignment</span>}
          <span className="timer">
            <span className={notRecording ? "rec-dot off" : "rec-dot"} aria-hidden /> {fmtDuration(now - state.meetingStartedAt)}
          </span>
          {notRecording && !micFirst && (
            <button className="badge not-recording" title={notRecording} onClick={() => toast({ tone: "error", text: notRecording })}>
              {state.transcriptionRestarting ? "Not recording · restarting…" : "Not recording"}
            </button>
          )}
          {media.audioDown && !media.audioAway && (
            <span className="badge not-recording" title="People can't hear each other while the audio reconnects.">
              No audio · Reconnecting…
            </span>
          )}
          <ConnectionPill room={room} />
          {state.ending && (
            <span className="badge" title={writingTitle}>
              Writing notes · usually under a minute · you can leave
            </span>
          )}
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
            !media.micOn &&
            !media.audioDown && (
              <button
                className={media.micError ? "badge muted-pill blocked" : "badge muted-pill"}
                onClick={() => void media.toggleMic()}
                disabled={media.micStarting}
                title={
                  micFirst
                    ? `Not recording. 1. ${media.micError} 2. Then leave and rejoin, so Stand starts transcribing again.`
                    : (media.micError ?? "Nothing you say is recorded while you're muted. Click to unmute.")
                }
              >
                <MicOffIcon /> {micFirst ? `Not recording · ${micLabel}` : micLabel}
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
          canSteer={canSteer && !writingUp}
          writingUp={writingUp}
          offline={!room.connected}
          notes={room.notes}
          segments={room.segments}
          notesBusy={room.notesBusy}
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
          ending={writingUp}
          livekit={caps.livekit}
          snapRef={stageSnap}
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
          {/* With no audio connection, unmuting can't help: the button says what's wrong and retries. */}
          <button
            className={media.micOn && !media.audioDown ? "control" : "control off"}
            onClick={() => void (media.audioAway ? media.talkHere() : media.audioDown ? undefined : media.toggleMic())}
            disabled={media.micStarting || (media.audioDown && !media.audioAway)}
            title={
              media.audioAway === "elsewhere"
                ? "Your mic moved to your other window. Click to talk from here instead."
                : media.audioAway
                  ? "The audio connection failed. Click to reconnect."
                  : media.audioDown
                    ? "The audio is reconnecting."
                    : `${media.micOn ? "Mute" : "Unmute"} (${MOD.cmd} + D)`
            }
          >
            {media.micOn && !media.audioDown ? <MicIcon /> : <MicOffIcon />}
            <span>
              {media.audioAway === "elsewhere"
                ? "Talk here"
                : media.audioAway
                  ? "Reconnect"
                  : media.audioDown
                    ? "No audio"
                    : media.micStarting
                      ? "Starting…"
                      : media.micOn
                        ? "Mute"
                        : "Unmute"}
            </span>
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
              disabled={Boolean(otherSharer) || media.sharePicking}
              title={otherSharer ? `${otherSharer.name} is sharing` : media.sharePicking ? "Pick a screen or window in the dialog" : undefined}
            >
              <ShareIcon />
              <span>{media.sharePicking ? "Choosing…" : "Share screen"}</span>
            </button>
          )}
          {offerPopOut && (
            <button
              className={popOut.win ? "control on" : "control"}
              onClick={openPopOut}
              title="A small bar that stays over your other apps, with your mic, Snap and the space's to-dos"
            >
              <PopOutIcon />
              <span>Pop out</span>
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
        {canSteer && aligning && (
          <button
            className="control pill"
            disabled={writingUp || !room.connected || Boolean(state.alignment?.wrapping)}
            title={
              !room.connected
                ? "You can wrap up once Stand reconnects"
                : state.alignment?.state.landing
                  ? "Write where you landed again, with what was said since"
                  : "Stand freezes what's on the table with the outcome and who does what next. The meeting keeps going."
            }
            onClick={() => send({ type: "align.wrap" })}
          >
            {state.alignment?.wrapping ? "Wrapping up…" : state.alignment?.state.landing ? "Wrap up again" : "Wrap up"}
          </button>
        )}
        {canSteer && (
        <button
          className="control pill danger"
          disabled={writingUp || !room.connected}
          title={writingUp ? writingTitle : room.connected ? undefined : "You can end the meeting once Stand reconnects"}
          onClick={() => {
            if (!confirm(aligning ? "End the meeting for everyone? Stand writes where you landed and the recap." : "End the meeting for everyone and write up the notes?")) return;
            if (send({ type: "meeting.end" })) setEnding(true);
          }}
        >
          {writingUp ? "Writing notes…" : "End meeting"}
        </button>
        )}
      </footer>
      {popOut.win && state && (
        <PopOutBar
          win={popOut.win}
          space={state.roomName}
          itemKey={barKey}
          item={barItem}
          micOn={micOn}
          onMic={() => void toggleMic()}
          onSnap={media.localScreen || media.remoteScreen ? () => stageSnap.current?.() ?? Promise.resolve(false) : null}
          todos={barTodos}
          levels={popLevels}
        />
      )}
    </div>
  );
}

const PopOutIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <rect x="12" y="11" width="7" height="6" rx="1" />
  </svg>
);

/** What didn't happen, when a click needed the connection and it was down. */
const REFUSED: Partial<Record<string, string>> = {
  focus: "switching items waits for the connection",
  pin: "pinning waits for the connection",
  unpin: "pinning waits for the connection",
  "suggestion.accept": "switching waits for the connection",
  "suggestion.undo": "couldn't undo yet",
  "notes.retry": "trying the notes again waits for the connection",
  "suggestion.dismiss": "couldn't dismiss the suggestion yet",
  "upnext.add": "couldn't add the suggestion yet",
  "upnext.addAll": "couldn't add the suggestions yet",
  "upnext.dismiss": "couldn't dismiss the suggestion yet",
  "upnext.undismiss": "couldn't undo yet",
  "host.give": "handing over hosting waits for the connection",
  "stage.snap.close": "couldn't take the snap down yet",
  "meeting.end": "ending the meeting waits for the connection",
  "align.wrap": "wrapping up waits for the connection",
};

/** Only while something's wrong with the connection: what's happening to your changes, or what to do. */
function ConnectionPill(props: {
  room: Pick<ReturnType<typeof useRoomSocket>, "connected" | "waiting" | "refused" | "trouble" | "retryNow">;
}) {
  const { connected, waiting, refused, trouble, retryNow } = props.room;
  if (trouble === "signed-out") {
    return (
      // In a new tab, so this one keeps its waiting changes and reconnects by itself once you're back in.
      <a
        className="conn-pill"
        href="/"
        target="_blank"
        rel="noopener"
        title="Sign in in the new tab. This meeting reconnects by itself, and your changes are kept."
      >
        Signed out · Sign in again ↗
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
      : trouble === "blocked"
        ? "Can't open a live connection · a firewall or VPN may be blocking it"
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
      <button className="link" onClick={retryNow}>
        Retry now
      </button>
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
