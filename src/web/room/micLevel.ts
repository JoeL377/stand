// How loud your mic is, for the Mac app's floating bar: its ring moves with your voice, and
// if you talk while muted it says so. It's measured here, on a copy of the mic track (a muted
// mic's own track carries silence), and only a number from 0 to 1 leaves the page, to the bar.

import { useEffect } from "react";

// Runs on the audio thread, so it keeps going while Stand is behind other apps, when the
// page's own timers slow to a crawl. Posts the loudness (RMS) about 23 times a second.
const WORKLET = `registerProcessor("stand-level", class extends AudioWorkletProcessor {
  sum = 0;
  n = 0;
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) this.sum += ch[i] * ch[i];
      this.n += ch.length;
    }
    if (this.n >= 2048) {
      this.port.postMessage(Math.sqrt(this.sum / this.n));
      this.sum = 0;
      this.n = 0;
    }
    return true;
  }
});`;

export function useMicLevel(track: MediaStreamTrack | null, onLevel: ((level: number) => void) | undefined) {
  useEffect(() => {
    if (!track || !onLevel) return;
    let stopped = false;
    const copy = track.clone();
    copy.enabled = true;
    const ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    let level = 0;
    let sent = -1;
    void (async () => {
      try {
        await ctx.audioWorklet.addModule(url);
        if (stopped) return;
        const node = new AudioWorkletNode(ctx, "stand-level");
        node.port.onmessage = (e: MessageEvent<number>) => {
          // -50 dBFS and below is a quiet room (the ring stays still), -20 is talking up close.
          const db = 20 * Math.log10(Math.max(e.data, 1e-6));
          const v = Math.min(1, Math.max(0, (db + 50) / 30));
          level = v > level ? v : level * 0.8 + v * 0.2; // up at once, down gently
          const out = Math.round(level * 20) / 20;
          if (out !== sent) onLevel((sent = out));
        };
        ctx.createMediaStreamSource(new MediaStream([copy])).connect(node);
        // Audio nodes only run when they lead to the speakers; this one sends them silence.
        node.connect(ctx.destination);
        if (ctx.state === "suspended") await ctx.resume();
      } catch {
        // No level: the ring just stays still.
      }
    })();
    return () => {
      stopped = true;
      void ctx.close().catch(() => {});
      copy.stop();
      URL.revokeObjectURL(url);
      onLevel(0);
    };
  }, [track, onLevel]);
}
