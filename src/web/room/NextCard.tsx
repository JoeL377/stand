// The meeting agent's next step (server/nextSteps.ts): someone said out loud that they want a
// brainstorm, a design session or a review, and Stand offers it on one small card. Everyone sees
// it, anyone takes it or waves it off, and nothing switches by itself.

import { useState } from "react";
import type { ClientMessage, NextStep } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { errorToast, toast } from "../Toasts.tsx";

const first = (name: string) => name.trim().split(/\s+/)[0];

export function NextCard(props: {
  next: NextStep;
  roomId: string;
  offline?: boolean;
  send: (m: ClientMessage) => boolean;
  /** Draws the map or the diagram the usual way (Stage.tsx); resolves false when it didn't start. */
  onDraw: (what: "map" | "diagram", topic: string) => Promise<boolean>;
}) {
  const { next, send } = props;
  const [busy, setBusy] = useState(false);
  const review = next.kind === "design-review" || next.kind === "product-review";
  const what = next.kind === "map" ? "a map" : next.kind === "diagram" ? "a diagram" : next.kind === "design-review" ? "Design review" : "Product review";
  const ready = next.ready ?? 0;
  const waiting = next.kind === "design-review" ? `${ready} ${ready === 1 ? "spec" : "specs"} waiting` : `${ready} ${ready === 1 ? "slide" : "slides"} waiting`;
  const take = async () => {
    if (!review) {
      setBusy(true);
      const drew = await props.onDraw(next.kind as "map" | "diagram", next.topic);
      setBusy(false);
      if (drew) send({ type: "next.take", id: next.id, started: true });
      return;
    }
    if (!send({ type: "next.take", id: next.id })) return;
    toast({ text: `Noted for the recap: ${what.toLowerCase()}${next.topic ? ` on ${next.topic}` : ""}` });
  };
  const start = async () => {
    setBusy(true);
    try {
      await (next.kind === "design-review" ? api.startDesignReview(props.roomId) : api.startReview(props.roomId));
      send({ type: "next.take", id: next.id, started: true });
    } catch (err) {
      errorToast(`Couldn't start the ${what.toLowerCase()}`)(err);
    }
    setBusy(false);
  };
  return (
    <div className="nudge next-card" role="status" title={next.guessed ? "Stand offers it from the last few minutes of talk" : `${first(next.by)} asked for it`}>
      <span className="agent-mark" aria-hidden>
        ✦
      </span>
      <span className="nudge-text">
        {next.guessed ? `Sounds like a ${next.kind === "map" ? "brainstorm" : "design"}. ` : ""}
        {review ? `${what}${next.topic ? " on " : ""}` : `Draw ${what} ${next.topic ? "of " : "of this"}`}
        {next.topic && <strong dir="auto">{next.topic}</strong>}?{review && ready > 0 && <span className="muted"> · {waiting}</span>}
      </span>
      {review && ready > 0 && (
        <button className="link" onClick={() => void start()} disabled={props.offline || busy}>
          {busy ? "Starting…" : "Start now"}
        </button>
      )}
      <button className={review && ready > 0 ? "link muted" : "link"} onClick={() => void take()} disabled={props.offline || busy} title={review ? "Keeps it in the recap as a suggested next step" : "Draws it beside the board. Nothing else in the call moves."}>
        {review ? (ready > 0 ? "Later" : "Add to recap") : next.kind === "map" ? "Draw map" : "Draw diagram"}
      </button>
      <button className="link muted" onClick={() => send({ type: "next.wave", id: next.id })} aria-label="No thanks">
        ✕
      </button>
    </div>
  );
}
