// Watches the presenter's shared screen and sends a snapshot to the agent
// when it changes and then settles (e.g. after scrolling to the next ticket),
// so the agent reads each new view once instead of every frame.

import { useEffect, useRef } from "react";

const TICK_MS = 1000;
const THUMB_W = 64;
const THUMB_H = 36;
/** Mean per-channel difference (0-255) that counts as "the screen changed". */
const CHANGE = 6;
const MAX_W = 1280;
const MAX_UNSETTLED_MS = 4000;

export function useFrameSampler(stream: MediaStream | null, onFrame: (jpegDataUrl: string) => void) {
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    if (!stream) return;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Some browsers don't decode frames for a video that isn't in the page.
    Object.assign(video.style, { position: "fixed", width: "2px", height: "2px", opacity: "0", pointerEvents: "none", left: "0", top: "0" });
    document.body.appendChild(video);
    void video.play().catch(() => {});

    const thumb = document.createElement("canvas");
    thumb.width = THUMB_W;
    thumb.height = THUMB_H;
    const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
    const full = document.createElement("canvas");
    const fctx = full.getContext("2d")!;

    let prev: Uint8ClampedArray | null = null;
    let sent: Uint8ClampedArray | null = null;
    let dirtySince: number | null = null;

    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return sum / ((a.length / 4) * 3);
    };

    const timer = setInterval(() => {
      if (video.readyState < 2 || !video.videoWidth) return;
      tctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
      const cur = tctx.getImageData(0, 0, THUMB_W, THUMB_H).data.slice();
      const settled = prev ? diff(cur, prev) < CHANGE / 2 : false;
      const changedSinceSent = !sent || diff(cur, sent) > CHANGE;
      prev = cur;
      if (!changedSinceSent) {
        dirtySince = null;
        return;
      }
      dirtySince ??= Date.now();
      // Send once the view settles, or anyway if it keeps moving (video, animation).
      if (settled || Date.now() - dirtySince >= MAX_UNSETTLED_MS) {
        dirtySince = null;
        const scale = Math.min(1, MAX_W / video.videoWidth);
        full.width = Math.round(video.videoWidth * scale);
        full.height = Math.round(video.videoHeight * scale);
        fctx.drawImage(video, 0, 0, full.width, full.height);
        cb.current(full.toDataURL("image/jpeg", 0.7));
        sent = cur;
      }
    }, TICK_MS);

    return () => {
      clearInterval(timer);
      video.srcObject = null;
      video.remove();
    };
  }, [stream]);
}
