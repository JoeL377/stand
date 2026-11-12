// What a call can start. A call is plain talk. A review is the one structured thing: it goes on the
// board from here, and "Finish" takes it off again so the call goes on as plain talk. A map or a
// diagram is a view of the talk, not a mode: it opens in a tab beside the board, anyone closes it
// from its tab, and nothing else in the call moves. The same start from the space page's menu.

import { useEffect, useState } from "react";
import type { BrainstormView, Item, SpaceFeed } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { errorToast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { BrainstormPop, DesignSessionPop } from "../pages/SpaceHome.tsx";

/** The review on the call's board now, in the words people use for it. A view is never "running". */
export function runningExperience(items: Item[], _brainstorm?: BrainstormView | null): string | null {
  if (items.some((i) => i.slide?.layout === "review" && i.slide.review?.idea)) return "idea review";
  if (items.some((i) => i.slide?.layout === "review")) return "product review";
  if (items.some((i) => i.slide?.layout === "design")) return "design review";
  return null;
}

export function ExperienceControl(props: { roomId: string; running: string | null; disabled?: boolean }) {
  const { roomId, running } = props;
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<SpaceFeed | null>(null);
  const [pop, setPop] = useState<"brainstorm" | "session" | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  // What there is to start is read when the menu opens: slides and specs arrive between calls.
  useEffect(() => {
    if (open) api.feed(roomId).then(setFeed, () => setFeed(null));
  }, [open, roomId]);

  const run = (what: string, start: () => Promise<unknown>) => async () => {
    setOpen(false);
    setBusy(true);
    try {
      await start();
    } catch (err) {
      errorToast(`Couldn't ${what === "map" || what === "diagram" ? "open" : "start"} the ${what}`)(err);
    }
    setBusy(false);
  };
  const finish = async () => {
    if (!running || !confirm(`Finish the ${running}? The call goes on, and what it caught is kept.`)) return;
    setBusy(true);
    try {
      await api.finishExperience(roomId);
    } catch (err) {
      errorToast(`Couldn't finish the ${running}`)(err);
    }
    setBusy(false);
  };

  if (running)
    return (
      <button className="control" disabled={props.disabled || busy} onClick={() => void finish()} title={`Takes the ${running} off the board. The call goes on as plain talk.`}>
        <DoneIcon />
        <span>
          {busy ? "Finishing…" : "Finish"}
          {!busy && <i className="xp-what"> {running}</i>}
        </span>
      </button>
    );

  const slides = feed?.review?.slides.length ?? 0;
  const specs = feed?.designReview?.specs ?? 0;
  const ideas = feed?.ideaReviews?.filter((r) => r.status === "draft") ?? [];
  return (
    <div className="xp" ref={box}>
      <button className="control" disabled={props.disabled || busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Start a review, or open a map or a diagram beside the board">
        <StartIcon />
        <span>{busy ? "Starting…" : "Start"}</span>
      </button>
      {open && (
        <div className="rp-menu sh-start-menu xp-menu" role="menu">
          <span className="xp-group">Reviews</span>
          <button type="button" role="menuitem" disabled={!slides} onClick={run("product review", () => api.startReview(roomId))}>
            <strong>Product review</strong>
            <span className="muted">{!feed ? "…" : slides ? `${slides} ${slides === 1 ? "slide" : "slides"}` : "nothing to show yet"}</span>
          </button>
          <button type="button" role="menuitem" disabled={!specs} onClick={run("design review", () => api.startDesignReview(roomId))}>
            <strong>Design review</strong>
            <span className="muted">{!feed ? "…" : specs ? `${specs} ${specs === 1 ? "spec" : "specs"}` : "no spec waiting"}</span>
          </button>
          {ideas.slice(0, 3).map((r) => (
            <button key={r.id} type="button" role="menuitem" onClick={run("idea review", () => api.startIdeaReview(roomId, r.id))}>
              <strong>Idea review</strong>
              <span className="muted xp-idea" dir="auto">
                {r.slides} {r.slides === 1 ? "idea" : "ideas"} · {r.title}
              </span>
            </button>
          ))}
          <span className="xp-group">Views of this call</span>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), setPop("brainstorm"))}>
            <strong>Map</strong>
            <span className="muted xp-hint">ideas, as you brainstorm</span>
          </button>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), setPop("session"))}>
            <strong>Diagram</strong>
            <span className="muted xp-hint">boxes and arrows, as you design</span>
          </button>
        </div>
      )}
      {pop === "brainstorm" && (
        <BrainstormPop
          onClose={() => setPop(null)}
          onStart={async (prompt) => {
            await run("map", () => api.startBrainstorm(roomId, prompt))();
            setPop(null);
          }}
        />
      )}
      {pop === "session" && (
        <DesignSessionPop
          todos={[]}
          onClose={() => setPop(null)}
          onStart={async (prompt, seed, taskId) => {
            await run("diagram", () => api.startBrainstorm(roomId, prompt, { seed, taskId }))();
            setPop(null);
          }}
        />
      )}
    </div>
  );
}

const StartIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="14" height="10" rx="2" />
    <path d="M10 7v4M8 9h4M7 17h6" />
  </svg>
);
const DoneIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="14" height="10" rx="2" />
    <path d="M7.5 9.2l1.8 1.8 3.2-3.4M7 17h6" />
  </svg>
);
