// Transcribes this browser's own mic with the Web Speech API (Chrome, Edge,
// Safari). Used when the server has no Deepgram key. Each browser only hears
// its own person, so attribution is still exact.

import { useEffect, useRef } from "react";

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export const browserSpeechSupported = () =>
  typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export function useBrowserSpeech(
  enabled: boolean,
  onFinal: (text: string, startedAt: number) => void,
  onInterim: (text: string) => void,
  onError?: (msg: string) => void,
  /** Recognition stopped for a reason that may pass (the network, the mic), or null once it's back. */
  onTrouble?: (msg: string | null) => void,
) {
  const cb = useRef({ onFinal, onInterim, onError, onTrouble });
  cb.current = { onFinal, onInterim, onError, onTrouble };

  useEffect(() => {
    if (!enabled || !browserSpeechSupported()) return;
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec: SR = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let active = true;
    let utteranceStart: number | null = null;
    // After a network or mic error, restarts slow down, and the trouble is reported until a try works.
    let wait = 0;
    let troubled = false;
    let restart: ReturnType<typeof setTimeout> | undefined;
    let cleared: ReturnType<typeof setTimeout> | undefined;
    const fine = () => {
      wait = 0;
      if (troubled) cb.current.onTrouble?.(null);
      troubled = false;
    };

    rec.onresult = (e) => {
      fine();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (utteranceStart === null) utteranceStart = Date.now();
        if (r.isFinal) {
          if (text.trim()) cb.current.onFinal(text.trim(), utteranceStart);
          utteranceStart = null;
          cb.current.onInterim("");
        } else interim += text;
      }
      if (interim) cb.current.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        active = false;
        cb.current.onError?.("Speech recognition was blocked. Allow the microphone for this site.");
      } else if (e.error === "network" || e.error === "audio-capture") {
        clearTimeout(cleared);
        wait = Math.min(30_000, wait ? wait * 2 : 2_000);
        troubled = true;
        cb.current.onTrouble?.(
          e.error === "network" ? "the browser's speech service can't be reached" : "the browser can't hear your mic",
        );
      }
    };
    const start = () => {
      try {
        rec.start();
      } catch {
        /* already started */
      }
      // No new error a few seconds into a retry: it's working again.
      if (troubled) cleared = setTimeout(fine, 6_000);
    };
    // Chrome stops recognition after a pause; keep it running while the mic is on.
    rec.onend = () => {
      if (!active) return;
      if (wait) restart = setTimeout(start, wait);
      else start();
    };
    rec.start();
    return () => {
      active = false;
      clearTimeout(restart);
      clearTimeout(cleared);
      rec.onend = null;
      rec.abort();
      cb.current.onInterim("");
      if (troubled) cb.current.onTrouble?.(null);
    };
  }, [enabled]);
}
