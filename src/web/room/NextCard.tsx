// The meeting agent's next step (server/nextSteps.ts): someone said out loud that they want a
// brainstorm, a design session or a review, and Stand offers it on one small card. Everyone sees
// it, anyone takes it or waves it off, and nothing switches by itself.

import { useState } from "react";
import type { ClientMessage, NextStep } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { errorToast, toast } from "../Toasts.tsx";

const first = (name: string) => name.trim().split(/\s+/)[0];

export function NextCard(props: { next: NextStep; roomId: string; offline?: boolean; send: (m: ClientMessage) => boolean }) {
  const { next, send } = props;
  const [busy, setBusy] = useState(false);
  const review = next.kind === "design-review" || next.kind === "product-review";
  const what = next.kind === "map" ? "a map" : next.kind === "diagram" ? "a diagram" : next.kind === "design-review" ? "Design review" : "Product review";
  const ready = next.ready ?? 0;
  const waiting = next.kind === "design-review" ? `${ready} ${ready === 1 ? "spec" : "specs"} waiting` : `${ready} ${ready === 1 ? "slide" : "slides"} waiting`;
  const take = () => {
    if (!send({ type: "next.take", id: next.id })) return;
    if (review) toast({ text: `Noted for the recap: ${what.toLowerCase()}${next.topic ? ` on ${next.topic}` : ""}` });
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
    <div className="nudge next-card" role="status" title={`${first(next.by)} asked for it`}>
      <span className="agent-mark" aria-hidden>
        ✦
      </span>
      <span className="nudge-text">
        {review ? `${what}${next.topic ? " on " : ""}` : `Open ${what} ${next.topic ? "for " : "for this"}`}
        {next.topic && <strong dir="auto">{next.topic}</strong>}?{review && ready > 0 && <span className="muted"> · {waiting}</span>}
      </span>
      {review && ready > 0 && (
        <button className="link" onClick={() => void start()} disabled={props.offline || busy}>
          {busy ? "Starting…" : "Start now"}
        </button>
      )}
      <button className={review && ready > 0 ? "link muted" : "link"} onClick={take} disabled={props.offline || busy} title={review ? "Keeps it in the recap as a suggested next step" : "Opens it in a tab beside the board. Nothing else moves."}>
        {review ? (ready > 0 ? "Later" : "Add to recap") : next.kind === "map" ? "Open map" : "Open diagram"}
      </button>
      <button className="link muted" onClick={() => send({ type: "next.wave", id: next.id })} aria-label="No thanks">
        ✕
      </button>
    </div>
  );
}
