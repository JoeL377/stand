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
) {
  const cb = useRef({ onFinal, onInterim, onError });
  cb.current = { onFinal, onInterim, onError };

  useEffect(() => {
    if (!enabled || !browserSpeechSupported()) return;
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec: SR = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let active = true;
    let utteranceStart: number | null = null;

    rec.onresult = (e) => {
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
      }
    };
    // Chrome stops recognition after a pause; keep it running while the mic is on.
    rec.onend = () => {
      if (active) {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };
    rec.start();
    return () => {
      active = false;
      rec.onend = null;
      rec.abort();
      cb.current.onInterim("");
    };
  }, [enabled]);
}
