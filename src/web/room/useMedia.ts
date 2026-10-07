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

export function useMedia(opts: { roomId: string; participantId: string; name: string; livekit: boolean; enabled: boolean }) {
  const { roomId, participantId, name, livekit, enabled } = opts;
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
        const { url, token } = await api.token(roomId, participantId, name);
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
  }, [livekit, enabled, roomId, participantId, name]);

  // ---- mic ----------------------------------------------------------------
  const mockMicStream = useRef<MediaStream | null>(null);
  const toggleMic = useCallback(async () => {
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
      setMediaError(`Microphone: ${(err as Error).message}`);
    }
  }, [livekit, micOn]);

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
      if ((err as Error).name !== "NotAllowedError") setMediaError(`Screen share: ${(err as Error).message}`);
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
