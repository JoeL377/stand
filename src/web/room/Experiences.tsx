// Experiences inside a call. A call starts as plain talk; the host can put a product review, a design
// review, a brainstorm or a design session on its board from here, one at a time, and "Finish" takes
// it off again so the call goes on as plain talk. Each keeps what it would have kept at the end of
// the call. The same four start from the space page's menu, beside Start talking.

import { useEffect, useState } from "react";
import type { BrainstormView, Item, SpaceFeed } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { errorToast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { BrainstormPop, DesignSessionPop } from "../pages/SpaceHome.tsx";

/** What is on the call's board now, in the words people use for it. */
export function runningExperience(items: Item[], brainstorm: BrainstormView | null | undefined): string | null {
  if (brainstorm?.status === "live") return brainstorm.design ? "design session" : "brainstorm";
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
      errorToast(`Couldn't start the ${what}`)(err);
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
      <button className="control" disabled={props.disabled || busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Put a review, a brainstorm or a design session on the board">
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
          <span className="xp-group">Working sessions</span>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), setPop("brainstorm"))}>
            <strong>Brainstorm</strong>
            <span className="muted">from a topic or a question</span>
          </button>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), setPop("session"))}>
            <strong>Design session</strong>
            <span className="muted">draw it as you talk</span>
          </button>
        </div>
      )}
      {pop === "brainstorm" && (
        <BrainstormPop
          onClose={() => setPop(null)}
          onStart={async (prompt) => {
            await run("brainstorm", () => api.startBrainstorm(roomId, prompt))();
            setPop(null);
          }}
        />
      )}
      {pop === "session" && (
        <DesignSessionPop
          todos={[]}
          onClose={() => setPop(null)}
          onStart={async (prompt, seed, taskId) => {
            await run("design session", () => api.startBrainstorm(roomId, prompt, { seed, taskId }))();
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
