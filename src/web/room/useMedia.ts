// Voice and screen share. With LiveKit configured, everything goes through a
// LiveKit room. Without it (mock mode) the mic only feeds this browser's
// speech recognition and the screen share is only visible to the presenter,
// though the agent still reads it.

import { useCallback, useEffect, useRef, useState } from "react";
import { DisconnectReason, Room, RoomEvent, Track, type RemoteTrack, type Participant } from "livekit-client";
import { api } from "../api.ts";
import { macApp } from "../macApp.ts";
import { toast } from "../Toasts.tsx";

export interface RemoteScreen {
  participantId: string;
  track: RemoteTrack;
}

/** What went wrong with the mic or screen, and what to do about it. */
function mediaMessage(kind: "mic" | "screen", err: unknown): string {
  const e = err as Error;
  const mic = kind === "mic";
  if (e.name === "NotAllowedError") {
    // In the Mac app there's no browser: it's Stand itself that macOS has to allow.
    if (macApp && (!mic || /system/i.test(e.message)))
      return `Your Mac is blocking ${mic ? "the microphone" : "screen sharing"} for Stand. Allow Stand in System Settings › Privacy & Security › ${mic ? "Microphone" : "Screen & System Audio Recording"}, then quit and reopen Stand.`;
    if (!mic || /system/i.test(e.message))
      return `Your computer is blocking ${mic ? "the microphone" : "screen sharing"}. Allow your browser in System Settings › Privacy & Security › ${mic ? "Microphone" : "Screen Recording"}, then try again.`;
    return "Your browser blocked the microphone. Allow it from the icon at the left of the address bar, then click Unmute.";
  }
  if (e.name === "NotFoundError") return mic ? "No microphone found. Connect one, then click Unmute." : "There's no screen to share.";
  if (e.name === "NotReadableError") return mic ? "Another app is using the microphone. Close it, then click Unmute." : "Your screen couldn't be captured. Try again.";
  return `${mic ? "Microphone" : "Screen share"}: ${e.message}`;
}

/** A microphone people can pick, by the name the computer gives it. */
export interface Mic {
  id: string;
  label: string;
}

// The mic you picked last, kept on this computer so every meeting starts with it. The name is
// kept too: browsers can hand out new ids for the same mic (Safari does on every visit).
const MIC_KEY = "stand.mic";
function saved(): Mic | null {
  try {
    const v = JSON.parse(localStorage.getItem(MIC_KEY) ?? "null");
    return v && typeof v.id === "string" ? v : null;
  } catch {
    return null;
  }
}
function saveMic(mic: Mic) {
  try {
    localStorage.setItem(MIC_KEY, JSON.stringify(mic));
  } catch {
    /* private window: the choice lasts for this meeting only */
  }
}
/** The picked mic among the ones plugged in now, by id or else by name. */
function savedAmong(mics: Mic[]): string | null {
  const s = saved();
  if (!s) return null;
  return (mics.find((m) => m.id === s.id) ?? (s.label ? mics.find((m) => m.label === s.label) : undefined))?.id ?? null;
}

/** The iPhone's mic, which macOS (Continuity) picks on its own when the phone is nearby. */
export const isPhoneMic = (label: string) => /iphone|continuity/i.test(label);

const isAlias = (id: string) => id === "default" || id === "communications";

/** The computer's mics, without the browser's "Default" and "Communications" aliases. */
async function listMics(): Promise<{ mics: Mic[]; inputs: MediaDeviceInfo[] }> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const inputs = all.filter((d) => d.kind === "audioinput");
  return {
    inputs,
    mics: inputs
      .filter((d) => d.deviceId && !isAlias(d.deviceId))
      // "MacBook Pro Microphone (Built-in)" stays; a USB id like "(046d:0825)" goes.
      .map((d) => ({ id: d.deviceId, label: d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "") })),
  };
}

/** The mic as a stream, from the given device when there is one (and it's still plugged in). */
async function micStream(id: string | null): Promise<MediaStream> {
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    } catch (err) {
      const name = (err as Error).name;
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

export function useMedia(opts: { roomId: string; livekit: boolean; enabled: boolean }) {
  const { roomId, livekit, enabled } = opts;
  const roomRef = useRef<Room | null>(null);
  const [micOn, setMicOn] = useState(false);
  // The mic itself, for the Mac app's bar to hear. With LiveKit it stays while muted (muting
  // silences it); without, muting lets go of the mic.
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null);
  const [localScreen, setLocalScreen] = useState<MediaStream | null>(null);
  useEffect(() => {
    screenRef.current = localScreen;
  }, [localScreen]);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [connected, setConnected] = useState(!livekit);
  // Why the voice connection dropped for good, if it did: "elsewhere" when you joined this
  // meeting again from another window or the Mac app (one person talks from one place, so
  // the newer one takes over), "lost" for anything else. talkHere() joins again from here.
  const [audioAway, setAudioAway] = useState<"elsewhere" | "lost" | null>(null);
  const [joins, setJoins] = useState(0);
  /** Audio worked in this meeting; losing it now is a drop, not a slow start. */
  const [audioWas, setAudioWas] = useState(false);
  const [mics, setMics] = useState<Mic[]>([]);
  /** The mic in use (or the one unmuting will use). */
  const [micId, setMicId] = useState<string | null>(() => saved()?.id ?? null);

  // ---- LiveKit connection -------------------------------------------------
  useEffect(() => {
    if (!livekit || !enabled) return;
    // Trying again: it shows as reconnecting until it works or fails.
    setAudioAway(null);
    // Start with the mic picked last time if it's plugged in, else the computer's default.
    const pick = saved();
    const room = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: pick ? { deviceId: pick.id } : undefined });
    roomRef.current = room;
    const audioEls = new Map<string, HTMLMediaElement>();
    let cancelled = false;

    // `gone` is a track LiveKit is letting go of: it fires TrackUnsubscribed before it
    // clears the publication, so without this a stopped share stays on the board, black.
    const refreshScreen = (gone?: Track) => {
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublication(Track.Source.ScreenShare);
        if (pub?.track && pub.isSubscribed && pub.track !== gone && pub.track.mediaStreamTrack?.readyState !== "ended") {
          setRemoteScreen({ participantId: p.identity, track: pub.track as RemoteTrack });
          return;
        }
      }
      setRemoteScreen(null);
    };

    room
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.style.display = "none";
          document.body.appendChild(el);
          audioEls.set(track.sid ?? String(Math.random()), el);
        }
        refreshScreen();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
        refreshScreen(track);
      })
      .on(RoomEvent.TrackUnpublished, () => refreshScreen())
      .on(RoomEvent.ParticipantDisconnected, () => refreshScreen())
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setSpeaking(new Set(speakers.map((s) => s.identity)));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsAudioUnlock(!room.canPlaybackAudio))
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Microphone) setMicTrack(pub.track?.mediaStreamTrack ?? null);
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) setLocalScreen(null);
        if (pub.source === Track.Source.Microphone) {
          setMicOn(false);
          setMicTrack(null);
        }
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        setConnected(false);
        if (cancelled || reason === DisconnectReason.CLIENT_INITIATED) return;
        setMicOn(false);
        setMicTrack(null);
        setLocalScreen(null);
        const elsewhere = reason === DisconnectReason.DUPLICATE_IDENTITY;
        setAudioAway(elsewhere ? "elsewhere" : "lost");
        toast({
          tone: elsewhere ? "info" : "error",
          text: elsewhere
            ? "You joined this meeting in another window, so your mic moved there."
            : "Your audio disconnected, so nobody can hear you.",
          action: { label: elsewhere ? "Talk here" : "Reconnect", run: () => setJoins((n) => n + 1) },
          ms: 12000,
        });
      })
      .on(RoomEvent.Reconnecting, () => setConnected(false))
      .on(RoomEvent.Reconnected, () => setConnected(true));

    (async () => {
      try {
        const { url, token } = await api.token(roomId);
        if (!url || !token || cancelled) return;
        await room.connect(url, token);
        if (cancelled) return room.disconnect();
        setConnected(true);
        setAudioWas(true);
        setAudioAway(null);
        setNeedsAudioUnlock(!room.canPlaybackAudio);
        // Connected is one thing; the mic is another, with its own prompt and its own ways to fail.
        micBusy.current = true;
        setMicStarting(true);
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          setMicOn(true);
          setMicError(null);
          void settleMicRef.current();
        } catch (err) {
          const msg = mediaMessage("mic", err);
          setMediaError(msg);
          setMicError(msg);
        } finally {
          micBusy.current = false;
          setMicStarting(false);
        }
      } catch (err) {
        if (cancelled) return;
        setAudioAway("lost");
        setMediaError(`Couldn't connect audio: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      room.disconnect();
      audioEls.forEach((el) => el.remove());
      roomRef.current = null;
      setMicTrack(null);
    };
  }, [livekit, enabled, roomId, joins]);
  const talkHere = useCallback(() => setJoins((n) => n + 1), []);

  // ---- mic ----------------------------------------------------------------
  const mockMicStream = useRef<MediaStream | null>(null);
  // Leaving the page (Back, say) must let go of the mic and any shared screen,
  // even if the mic was still being asked for.
  const alive = useRef(true);
  const screenRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      mockMicStream.current?.getTracks().forEach((t) => t.stop());
      mockMicStream.current = null;
      screenRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  /** Why the mic couldn't start, until it does: the Muted pill says so instead of "click to unmute". */
  const [micError, setMicError] = useState<string | null>(null);
  // One permission prompt at a time: a second click while the first is open would open a second mic.
  const micBusy = useRef(false);
  // Shown on the button while the browser asks for the mic, so a click there isn't a mystery.
  const [micStarting, setMicStarting] = useState(false);
  const toggleMic = useCallback(async () => {
    // Unmuting where the mic isn't connected any more brings it back here.
    if (audioAway) return talkHere();
    if (micBusy.current) return;
    micBusy.current = true;
    if (!micOn) setMicStarting(true);
    setMediaError(null);
    try {
      if (livekit) {
        const room = roomRef.current;
        if (!room) return;
        await room.localParticipant.setMicrophoneEnabled(!micOn);
        setMicOn(!micOn);
      } else {
        if (micOn) {
          mockMicStream.current?.getTracks().forEach((t) => t.stop());
          mockMicStream.current = null;
          setMicOn(false);
          setMicTrack(null);
        } else {
          // Ask for mic permission up front so speech recognition can use it.
          const stream = await micStream(micIdRef.current);
          if (!alive.current) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          mockMicStream.current = stream;
          // Unplugged, or taken by the system: say so instead of showing it on.
          stream.getAudioTracks()[0]?.addEventListener("ended", () => {
            if (mockMicStream.current !== stream) return;
            mockMicStream.current = null;
            setMicOn(false);
            setMicError("Your mic was disconnected. Plug it back in, then click Unmute.");
          });
          setMicOn(true);
          setMicTrack(stream.getAudioTracks()[0] ?? null);
          void settleMicRef.current();
        }
      }
      setMicError(null);
    } catch (err) {
      const msg = mediaMessage("mic", err);
      setMediaError(msg);
      setMicError(msg);
    } finally {
      micBusy.current = false;
      setMicStarting(false);
    }
  }, [livekit, micOn, audioAway, talkHere]);

  // Joining means talking: the mic starts on without LiveKit too, as it does with it.
  const toggleRef = useRef(toggleMic);
  toggleRef.current = toggleMic;
  useEffect(() => {
    if (!livekit && enabled) void toggleRef.current();
  }, [livekit, enabled]);

  // ---- which mic ------------------------------------------------------------
  const micIdRef = useRef(micId);
  micIdRef.current = micId;
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;

  /** The real id of the mic in use, even when the browser calls it "default". */
  const activeMicId = useCallback(async (): Promise<string | null> => {
    const { mics, inputs } = await listMics();
    const track = livekit
      ? roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack
      : mockMicStream.current?.getAudioTracks()[0];
    const settings = track?.getSettings();
    let id = settings?.deviceId ?? null;
    if (!id || isAlias(id)) {
      // "default" is one of the real mics: the one sharing its group.
      const group = settings?.groupId ?? inputs.find((d) => d.deviceId === "default")?.groupId;
      id = inputs.find((d) => d.groupId === group && !isAlias(d.deviceId))?.deviceId ?? null;
    }
    return mics.some((m) => m.id === id) ? id : null;
  }, [livekit]);

  /** Moves the mic to another device, on or muted as it was. */
  const switchMic = useCallback(
    async (id: string) => {
      setMicId(id);
      if (livekit) {
        const room = roomRef.current;
        if (!room) return;
        await room.switchActiveDevice("audioinput", id);
        const t = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
        if (t) setMicTrack(t);
      } else if (mockMicStream.current) {
        const stream = await micStream(id);
        mockMicStream.current.getTracks().forEach((t) => t.stop());
        mockMicStream.current = stream;
        setMicTrack(stream.getAudioTracks()[0] ?? null);
      }
    },
    [livekit],
  );

  /** Someone picked a mic from the menu: use it now and in every meeting after. */
  const pickMic = useCallback(
    async (id: string) => {
      const mic = mics.find((m) => m.id === id);
      if (mic) saveMic(mic);
      try {
        await switchMic(id);
        setMicError(null);
      } catch (err) {
        setMediaError(mediaMessage("mic", err));
        setMicId(await activeMicId());
      }
    },
    [mics, switchMic, activeMicId],
  );

  /**
   * Once the mic is on (only then can its name be read): show which one is in use, and
   * don't talk through an iPhone in someone's pocket when the Mac has a mic of its own.
   */
  const settleMic = useCallback(async () => {
    const { mics } = await listMics();
    setMics(mics);
    const current = await activeMicId();
    const picked = savedAmong(mics);
    const onPhone = mics.find((m) => m.id === current && isPhoneMic(m.label));
    // The one in use went away (unplugged): any other, the iPhone last.
    const other = mics.find((m) => !isPhoneMic(m.label))?.id ?? mics[0]?.id ?? null;
    const want = picked ?? (onPhone || !current ? (other ?? current) : current);
    if (want && want !== current) {
      try {
        await switchMic(want);
        const now = mics.find((m) => m.id === want);
        if (onPhone && now && !picked) toast({ tone: "info", text: `Using ${now.label} instead of your iPhone's mic.`, ms: 6000 });
        return;
      } catch {
        /* keep the one that works */
      }
    }
    setMicId(current);
  }, [activeMicId, switchMic]);
  const settleMicRef = useRef(settleMic);
  settleMicRef.current = settleMic;

  // Plugging in or unplugging a mic: the menu follows, and while you're talking the mic you
  // picked takes over when it comes back (or another one, when the one in use goes away).
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => {
      if (micOnRef.current) void settleMicRef.current();
      else void listMics().then(({ mics }) => setMics(mics));
    };
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, []);

  /** The menu opened: names may have changed since. */
  const refreshMics = useCallback(async () => {
    const { mics } = await listMics();
    setMics(mics);
    if (micOnRef.current) setMicId(await activeMicId());
  }, [activeMicId]);

  // ---- screen share ---------------------------------------------------------
  // One screen picker at a time.
  const shareBusy = useRef(false);
  /** The screen picker is open: the button says so, and a second click does nothing. */
  const [sharePicking, setSharePicking] = useState(false);
  const startShare = useCallback(async () => {
    if (shareBusy.current) return;
    shareBusy.current = true;
    setSharePicking(true);
    setMediaError(null);
    try {
      if (livekit) {
        const room = roomRef.current;
        if (!room) return;
        await room.localParticipant.setScreenShareEnabled(true, { audio: false });
        const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
        if (track) setLocalScreen(new MediaStream([track.mediaStreamTrack]));
      } else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
        stream.getVideoTracks()[0]?.addEventListener("ended", () => setLocalScreen(null));
        setLocalScreen(stream);
      }
    } catch (err) {
      // Cancelling the picker is a choice, not an error; the computer refusing is.
      const e = err as Error;
      if (e.name !== "NotAllowedError" || /system/i.test(e.message)) setMediaError(mediaMessage("screen", err));
    } finally {
      shareBusy.current = false;
      setSharePicking(false);
    }
  }, [livekit]);

  const stopShare = useCallback(async () => {
    try {
      if (livekit) await roomRef.current?.localParticipant.setScreenShareEnabled(false);
      else localScreen?.getTracks().forEach((t) => t.stop());
      setLocalScreen(null);
    } catch (err) {
      // Still sharing: the button stays, so it can be pressed again.
      setMediaError(`Couldn't stop sharing: ${(err as Error).message}. Try again, or close the share from your browser's bar.`);
    }
  }, [livekit, localScreen]);

  const unlockAudio = useCallback(async () => {
    await roomRef.current?.startAudio();
    setNeedsAudioUnlock(false);
  }, []);

  const leave = useCallback(() => {
    roomRef.current?.disconnect();
    localScreen?.getTracks().forEach((t) => t.stop());
    mockMicStream.current?.getTracks().forEach((t) => t.stop());
  }, [localScreen]);

  return {
    micOn,
    micTrack,
    micStarting,
    micError,
    toggleMic,
    mics,
    micId,
    pickMic,
    refreshMics,
    localScreen,
    remoteScreen,
    startShare,
    sharePicking,
    stopShare,
    speaking,
    needsAudioUnlock,
    unlockAudio,
    mediaError,
    connected,
    audioAway,
    talkHere,
    /** Audio dropped mid-meeting, or never connected: people can't hear each other. */
    audioDown: livekit && (audioAway !== null || (audioWas && !connected)),
    leave,
  };
}
