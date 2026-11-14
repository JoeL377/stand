// A sketch artifact drawn as itself: the same board its own page draws (room/Sketch.tsx), read once
// and kept. A card shows it small and still; the open panel shows it whole, with its subjects.

import { useEffect, useRef, useState } from "react";
import type { BrainstormView } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { SketchBoard } from "./room/Sketch.tsx";

/** Sketches already read, by "room/id": a card and its panel share one read. */
const read = new Map<string, Promise<BrainstormView>>();
const sketchOf = (roomId: string, id: string) => {
  const key = `${roomId}/${id}`;
  let p = read.get(key);
  if (!p) {
    p = api.brainstorm(roomId, id).then((d) => d.brainstorm);
    p.catch(() => read.delete(key));
    read.set(key, p);
  }
  return p;
};

/** `small`: a card's picture, drawn large and shrunk to fit, with nothing to press. */
export default function SketchPicture(props: { roomId: string; id: string; small?: boolean; fallback: React.ReactNode }) {
  const [b, setB] = useState<BrainstormView | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  // A card off screen waits: a grid of sketches draws only the ones looked at.
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(!props.small);
  useEffect(() => {
    const el = box.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (!seen) return;
    let on = true;
    sketchOf(props.roomId, props.id).then((v) => on && setB(v), () => {});
    return () => {
      on = false;
    };
  }, [seen, props.roomId, props.id]);
  return (
    <span ref={box} className={props.small ? "af-sketch small" : "af-sketch"} aria-hidden={props.small || undefined} {...(props.small ? { inert: true } : {})}>
      {b ? (
        <span className="af-sketch-fit">
          <SketchBoard brainstorm={{ ...b, status: "done" }} as="picture" subject={subject} onSubject={setSubject} />
        </span>
      ) : (
        props.fallback
      )}
    </span>
  );
}
