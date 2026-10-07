// LiveKit carries the voices and screen share between people. A hidden agent
// joins each room, listens to every person's mic as a separate track and
// streams it to speech-to-text, so each line of the transcript is attributed
// to its speaker without any guessing. Speech-to-text runs through LiveKit
// Inference (billed to the LiveKit account), or straight to Deepgram when
// DEEPGRAM_API_KEY is set.

import { AccessToken } from "livekit-server-sdk";
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { inference, initializeLogger, stt } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import WebSocket from "ws";
import { config } from "./config.ts";
import type { SpeechSink, Transcriber } from "./room.ts";

const AGENT_IDENTITY = "agent";
const SAMPLE_RATE = 16_000;

export async function participantToken(roomId: string, participantId: string, name: string) {
  const { apiKey, apiSecret } = config.livekit;
  const at = new AccessToken(apiKey, apiSecret, { identity: participantId, name, ttl: "6h" });
  at.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

async function agentToken(roomId: string) {
  const { apiKey, apiSecret } = config.livekit;
  const at = new AccessToken(apiKey, apiSecret, { identity: AGENT_IDENTITY, name: "Notes agent", ttl: "12h" });
  at.addGrant({ roomJoin: true, room: roomId, canPublish: false, canSubscribe: true, hidden: true });
  return at.toJwt();
}

export function startLiveKitTranscriber(roomId: string, sink: SpeechSink): Transcriber {
  const room = new Room();
  const listeners = new Map<string, SpeakerStream>();
  let stopped = false;

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) return;
    listeners.get(p.identity)?.close();
    const name = () => sink.nameOf(p.identity) ?? p.name ?? "Someone";
    listeners.set(p.identity, new SpeakerStream(track, p.identity, name, sink, recognizerFactory()));
  });
  room.on(RoomEvent.TrackUnsubscribed, (_t: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (pub.source !== TrackSource.SOURCE_MICROPHONE) return;
    listeners.get(p.identity)?.close();
    listeners.delete(p.identity);
  });
  room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
    listeners.get(p.identity)?.close();
    listeners.delete(p.identity);
  });

  (async () => {
    try {
      await room.connect(config.livekit.url!, await agentToken(roomId), { autoSubscribe: true, dynacast: false });
      if (stopped) await room.disconnect();
      else console.log(`[agent] joined LiveKit room ${roomId}`);
    } catch (err) {
      console.error("[agent] could not join LiveKit room:", err);
    }
  })();

  return {
    async stop() {
      stopped = true;
      for (const l of listeners.values()) l.close();
      listeners.clear();
      await room.disconnect().catch(() => {});
    },
  };
}

/** One person's mic → one Deepgram stream. */
/** Speech-to-text for one speaker. Times are seconds of audio pushed so far. */
interface Recognizer {
  push(frame: AudioFrame): void;
  /** Called while someone is muted, so idle connections stay open. */
  keepAlive(): void;
  close(): void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, startSec: number) => void;
  /** The speaker paused: commit what has been said so far as one utterance. */
  onEndOfUtterance?: () => void;
}

let loggerReady = false;
function recognizerFactory(): () => Recognizer {
  if (config.deepgramKey) return () => new DeepgramRecognizer();
  if (!loggerReady) {
    // @livekit/agents refuses to run until its logger is set up.
    initializeLogger({ pretty: false, level: "warn" });
    loggerReady = true;
  }
  return () => new LiveKitInferenceRecognizer();
}

/** One person's mic → one speech-to-text stream. */
class SpeakerStream {
  private closed = false;
  private keepAliveTimer: NodeJS.Timeout;
  private rec: Recognizer;
  /** Maps seconds of audio sent to wall-clock, so speech-to-text word offsets
   *  can be turned into the real moment the words were spoken. Mic tracks stop
   *  sending while muted, so audio time and wall time drift apart. */
  private checkpoints: Array<{ audioSec: number; wallMs: number }> = [];
  private audioSec = 0;
  private lastSendMs = 0;
  private pending: { text: string[]; start: number } | null = null;

  constructor(
    track: RemoteTrack,
    private speakerId: string,
    private speakerName: () => string,
    private sink: SpeechSink,
    makeRecognizer: () => Recognizer,
  ) {
    this.rec = makeRecognizer();
    this.rec.onInterim = (text) => {
      const sofar = [...(this.pending?.text ?? []), text].join(" ").trim();
      if (sofar) this.sink.interim(this.speakerId, this.speakerName(), sofar);
    };
    this.rec.onFinal = (text, startSec) => {
      if (!text.trim()) return;
      if (!this.pending) this.pending = { text: [], start: this.wallAt(startSec) };
      this.pending.text.push(text.trim());
    };
    this.rec.onEndOfUtterance = () => this.flush();
    this.keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastSendMs > 5_000) this.rec.keepAlive();
    }, 5_000);
    void this.pump(track);
  }

  private async pump(track: RemoteTrack) {
    const stream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
    const reader = stream.getReader();
    try {
      while (!this.closed) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        const now = Date.now();
        if (!this.checkpoints.length || now - this.lastSendMs > 250) {
          this.checkpoints.push({ audioSec: this.audioSec, wallMs: now });
          if (this.checkpoints.length > 2000) this.checkpoints.splice(0, 1000);
        }
        this.audioSec += frame.samplesPerChannel / frame.sampleRate;
        this.lastSendMs = now;
        this.rec.push(frame);
      }
    } catch (err) {
      if (!this.closed) console.error(`[agent] audio read failed for ${this.speakerId}:`, err);
    } finally {
      reader.releaseLock();
    }
  }

  private wallAt(audioSec: number) {
    let cp = this.checkpoints[0];
    for (const c of this.checkpoints) {
      if (c.audioSec <= audioSec) cp = c;
      else break;
    }
    return cp ? cp.wallMs + (audioSec - cp.audioSec) * 1000 : Date.now();
  }

  private flush() {
    const p = this.pending;
    this.pending = null;
    this.sink.interim(this.speakerId, this.speakerName(), "");
    if (p?.text.length) this.sink.addSpeech(this.speakerId, this.speakerName(), p.text.join(" "), Math.round(p.start));
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    this.rec.close();
  }
}

/** Speech-to-text through LiveKit Inference: no separate provider account. */
class LiveKitInferenceRecognizer implements Recognizer {
  onInterim?: (text: string) => void;
  onFinal?: (text: string, startSec: number) => void;
  onEndOfUtterance?: () => void;
  private stream: stt.SpeechStream;
  private closed = false;

  constructor() {
    const model = new inference.STT({
      model: config.sttModel as never,
      language: "en",
      sampleRate: SAMPLE_RATE,
      apiKey: config.livekit.apiKey,
      apiSecret: config.livekit.apiSecret,
    });
    this.stream = model.stream();
    void this.read();
  }

  private async read() {
    try {
      for await (const ev of this.stream) {
        const alt = ev.alternatives?.[0];
        switch (ev.type) {
          case stt.SpeechEventType.INTERIM_TRANSCRIPT:
            if (alt?.text) this.onInterim?.(alt.text);
            break;
          case stt.SpeechEventType.FINAL_TRANSCRIPT:
            if (alt?.text) this.onFinal?.(alt.text, alt.startTime);
            break;
          case stt.SpeechEventType.END_OF_SPEECH:
            this.onEndOfUtterance?.();
            break;
        }
      }
    } catch (err) {
      if (!this.closed) console.error("[livekit-inference] transcription stopped:", err);
    }
  }

  push(frame: AudioFrame) {
    if (!this.closed) this.stream.pushFrame(frame);
  }
  keepAlive() {
    // The inference gateway keeps its own connection alive.
  }
  close() {
    this.closed = true;
    this.stream.endInput();
    this.stream.close();
  }
}

/** Speech-to-text straight to Deepgram's streaming API. */
class DeepgramRecognizer implements Recognizer {
  onInterim?: (text: string) => void;
  onFinal?: (text: string, startSec: number) => void;
  onEndOfUtterance?: () => void;
  private ws: WebSocket;
  private closed = false;

  constructor() {
    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${config.deepgramKey}` },
    });
    this.ws.on("message", (raw) => this.onResult(String(raw)));
    this.ws.on("error", (err) => console.error("[deepgram]", err.message));
    this.ws.on("close", () => {
      if (!this.closed) console.warn("[deepgram] stream closed");
    });
  }

  private onResult(raw: string) {
    let msg: {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean;
      start?: number;
      channel?: { alternatives?: Array<{ transcript?: string }> };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "UtteranceEnd") return this.onEndOfUtterance?.();
    if (msg.type !== "Results") return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (!msg.is_final) {
      if (text) this.onInterim?.(text);
      return;
    }
    if (text) this.onFinal?.(text, msg.start ?? 0);
    if (msg.speech_final) this.onEndOfUtterance?.();
  }

  push(frame: AudioFrame) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const d = frame.data;
    this.ws.send(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
  }
  keepAlive() {
    // Deepgram closes idle streams after ~10s.
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "KeepAlive" }));
  }
  close() {
    this.closed = true;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    this.ws.close();
  }
}
