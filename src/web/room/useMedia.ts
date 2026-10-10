// Voice and screen share. With LiveKit configured, everything goes through a
// LiveKit room. Without it (mock mode) the mic only feeds this browser's
// speech recognition and the screen share is only visible to the presenter,
// though the agent still reads it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack, type Participant } from "livekit-client";
import { api } from "../api.ts";

export interface RemoteScreen {
  participantId: string;
  track: RemoteTrack;
}

/** What went wrong with the mic or screen, and what to do about it. */
function mediaMessage(kind: "mic" | "screen", err: unknown): string {
  const e = err as Error;
  const mic = kind === "mic";
  if (e.name === "NotAllowedError") {
    if (!mic || /system/i.test(e.message))
      return `Your computer is blocking ${mic ? "the microphone" : "screen sharing"}. Allow your browser in System Settings › Privacy & Security › ${mic ? "Microphone" : "Screen Recording"}, then try again.`;
    return "Your browser blocked the microphone. Allow it from the icon at the left of the address bar, then click Unmute.";
  }
  if (e.name === "NotFoundError") return mic ? "No microphone found. Connect one, then click Unmute." : "There's no screen to share.";
  if (e.name === "NotReadableError") return mic ? "Another app is using the microphone. Close it, then click Unmute." : "Your screen couldn't be captured. Try again.";
  return `${mic ? "Microphone" : "Screen share"}: ${e.message}`;
}

export function useMedia(opts: { roomId: string; livekit: boolean; enabled: boolean }) {
  const { roomId, livekit, enabled } = opts;
  const roomRef = useRef<Room | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [localScreen, setLocalScreen] = useState<MediaStream | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [connected, setConnected] = useState(!livekit);

  // ---- LiveKit connection -------------------------------------------------
  useEffect(() => {
    if (!livekit || !enabled) return;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const audioEls = new Map<string, HTMLMediaElement>();
    let cancelled = false;

    const refreshScreen = () => {
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublication(Track.Source.ScreenShare);
        if (pub?.track && pub.isSubscribed) {
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
        refreshScreen();
      })
      .on(RoomEvent.ParticipantDisconnected, refreshScreen)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        setSpeaking(new Set(speakers.map((s) => s.identity)));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsAudioUnlock(!room.canPlaybackAudio))
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) setLocalScreen(null);
        if (pub.source === Track.Source.Microphone) setMicOn(false);
      })
      .on(RoomEvent.Disconnected, () => setConnected(false))
      .on(RoomEvent.Reconnected, () => setConnected(true));

    (async () => {
      try {
        const { url, token } = await api.token(roomId);
        if (!url || !token || cancelled) return;
        await room.connect(url, token);
        if (cancelled) return room.disconnect();
        setConnected(true);
        setNeedsAudioUnlock(!room.canPlaybackAudio);
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicOn(true);
      } catch (err) {
        setMediaError(`Couldn't connect audio: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      room.disconnect();
      audioEls.forEach((el) => el.remove());
      roomRef.current = null;
    };
  }, [livekit, enabled, roomId]);

  // ---- mic ----------------------------------------------------------------
  const mockMicStream = useRef<MediaStream | null>(null);
  // One permission prompt at a time: a second click while the first is open would open a second mic.
  const micBusy = useRef(false);
  const toggleMic = useCallback(async () => {
    if (micBusy.current) return;
    micBusy.current = true;
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
        } else {
          // Ask for mic permission up front so speech recognition can use it.
          mockMicStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
          setMicOn(true);
        }
      }
    } catch (err) {
      setMediaError(mediaMessage("mic", err));
    } finally {
      micBusy.current = false;
    }
  }, [livekit, micOn]);

  // Joining means talking: the mic starts on without LiveKit too, as it does with it.
  const toggleRef = useRef(toggleMic);
  toggleRef.current = toggleMic;
  useEffect(() => {
    if (!livekit && enabled) void toggleRef.current();
  }, [livekit, enabled]);

  // ---- screen share ---------------------------------------------------------
  const startShare = useCallback(async () => {
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
    }
  }, [livekit]);

  const stopShare = useCallback(async () => {
    if (livekit) await roomRef.current?.localParticipant.setScreenShareEnabled(false);
    else localScreen?.getTracks().forEach((t) => t.stop());
    setLocalScreen(null);
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
    toggleMic,
    localScreen,
    remoteScreen,
    startShare,
    stopShare,
    speaking,
    needsAudioUnlock,
    unlockAudio,
    mediaError,
    connected,
    leave,
  };
}
