// A soft sound when someone joins the call or leaves it, so nobody has to watch the faces to know.
// Two short notes made in the browser (no audio file): rising for a join, falling for a leave.

import { useEffect, useRef } from "react";

/** Someone who drops and is back within this long (a reload, a network blip) makes no sound. */
export const LEAVE_GRACE_MS = 3000;

/** Who came and went between two lists of who's in the room, leaving out the person listening.
 *  The first list (prev null) is who was already there, so nobody "joins". */
export function presenceChange(prev: ReadonlySet<string> | null, next: readonly string[], me: string): { joined: string[]; left: string[] } {
  if (!prev) return { joined: [], left: [] };
  const now = new Set(next);
  return {
    joined: next.filter((id) => id !== me && !prev.has(id)),
    left: [...prev].filter((id) => id !== me && !now.has(id)),
  };
}

type Chime = "join" | "leave";
const NOTES: Record<Chime, [number, number]> = { join: [587.33, 880], leave: [659.25, 440] };
let ctx: AudioContext | null = null;

/** Plays the sound. Quiet when the browser won't let the page make sound yet. */
export function chime(kind: Chime) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.01;
    NOTES[kind].forEach((hz, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const at = t0 + i * 0.11;
      osc.type = "sine";
      osc.frequency.value = hz;
      // A quick rise and a soft tail, well under speech level.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.09, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    });
  } catch {
    // No audio here (an old browser, or a test): the faces still show who's in.
  }
}

/** Plays the join and leave sounds as the room's people change. ids: null until the room is known. */
export function usePresenceSounds(ids: string[] | null, me: string, on: boolean, play: (kind: Chime) => void = chime) {
  const known = useRef<Set<string> | null>(null);
  const leaving = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const onRef = useRef(on);
  onRef.current = on;
  const key = ids ? [...ids].sort().join(",") : null;
  useEffect(() => {
    if (!ids) return;
    const { joined, left } = presenceChange(known.current, ids, me);
    known.current = new Set(ids);
    // Back within the grace: neither sound. One sound however many people came in together.
    const fresh = joined.filter((id) => {
      const t = leaving.current.get(id);
      if (!t) return true;
      clearTimeout(t);
      leaving.current.delete(id);
      return false;
    });
    if (fresh.length && onRef.current) play("join");
    for (const id of left)
      leaving.current.set(
        id,
        setTimeout(() => {
          leaving.current.delete(id);
          if (onRef.current) play("leave");
        }, LEAVE_GRACE_MS),
      );
  }, [key]);
  useEffect(() => () => leaving.current.forEach((t) => clearTimeout(t)), []);
}
