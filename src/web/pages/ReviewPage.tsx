// A product review's own page: its slides, how each one ended and what the team raised on it.
// The call is one way through a review; this is where it stays, before the call and after it,
// so anyone can come back, flip through it and send someone the link.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useBack } from "../backLink.ts";
import { IDEA_OUTCOMES, REVIEW_OUTCOMES, type IdeaOutcome, type ReviewCaught, type ReviewOutcome, type ReviewSummary, type ReviewView } from "../../shared/protocol.ts";
import { IdeaCard } from "../room/IdeaCard.tsx";
import { brainstormHref } from "./brainstormHref.ts";
import { api } from "../api.ts";
import { ChevronIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { ShotZoom } from "../room/ReviewStage.tsx";
import { errorToast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { joinHref, spaceHref } from "./SpacesShell.tsx";
import { fmtDay } from "../util.ts";

export const reviewHref = (roomId: string, reviewId: string, slide?: number) => `/s/${roomId}/review/${reviewId || "next"}${slide ? `?slide=${slide}` : ""}`;

const KINDS = [
  { kind: "action", label: "To do", Icon: TodoIcon },
  { kind: "decision", label: "Decided", Icon: DecidedIcon },
  { kind: "question", label: "Open", Icon: QuestionIcon },
] as const;

const day = (ts: number | null) => (ts ? fmtDay(ts) : "");
const outcomeLabel = (o: ReviewOutcome | IdeaOutcome) => [...REVIEW_OUTCOMES, ...IDEA_OUTCOMES].find((x) => x.id === o)!.label;
/** How a slide ended, in the words of its kind of review. */
const endOf = (s: ReviewView["slides"][number]) => (s.idea ? { outcome: s.idea.outcome, by: s.idea.outcomeBy } : { outcome: s.outcome, by: s.outcomeBy });
const prLabel = (url: string) => {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : "Link";
};

/** How a review's slides ended, as small counts: "3 Ship · 1 Not yet". */
export function OutcomeCounts({ outcomes }: { outcomes: ReviewSummary["outcomes"] }) {
  const some = REVIEW_OUTCOMES.filter((o) => outcomes[o.id] > 0);
  if (!some.length) return null;
  return (
    <span className="rp-counts">
      {some.map((o) => (
        <span key={o.id} className={`rp-count ${o.id}`}>
          {outcomes[o.id]} {o.label}
        </span>
      ))}
    </span>
  );
}

export function ReviewPage() {
  const back = useBack();
  const { roomId = "", reviewId = "next" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<{ roomName: string; review: ReviewView | null; reviews: ReviewSummary[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [shotAt, setShotAt] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setData(null);
    setFailed(false);
    api.review(roomId, reviewId).then(setData, () => setFailed(true));
  }, [roomId, reviewId]);

  const review = data?.review ?? null;
  const count = review?.slides.length ?? 0;
  const at = Math.min(Math.max(1, Number(params.get("slide")) || 1), Math.max(1, count)) - 1;
  const go = (i: number) => {
    if (i < 0 || i >= count) return;
    setShotAt(0);
    setParams(i ? { slide: String(i + 1) } : {}, { replace: true });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (zoomed || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") go(at + 1);
      if (e.key === "ArrowLeft") go(at - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  // The slide you're on stays in view in the strip.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On a phone an idea review's strip is a list under the slide: a pick brings the slide back up.
    if (strip.current && getComputedStyle(strip.current).flexDirection === "column") return void window.scrollTo({ top: 0 });
    strip.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [at, count]);

  if (failed) {
    return (
      <div className="rp rp-empty">
        <p>This review isn't here, or isn't yours to see.</p>
        <Link to={spaceHref(roomId)}>← Back to the space</Link>
      </div>
    );
  }
  if (!data) return <div className="rp rp-empty muted">Loading…</div>;

  const slide = review?.slides[at];
  const shots = slide?.shots ?? [];
  const shot = shots[Math.min(shotAt, shots.length - 1)] ?? null;
  const ran = review?.status === "done";
  const live = review?.status === "live";
  const ideas = review?.kind === "ideas";
  const end = slide ? endOf(slide) : null;

  return (
    <div className="rp">
      <header className={ideas ? "rp-head ideas" : "rp-head"}>
        <Link className="rp-back" to={back?.to ?? spaceHref(roomId)}>
          ← <span className="rp-back-name">{back?.label ?? data.roomName}</span>
        </Link>
        <strong>{ran ? "Deck" : ideas ? "Idea review" : "Product review"}</strong>
        {ideas ? (
          <>
            <span className="rp-pill">{ran ? day(review!.startedAt) : live ? "On now" : "Waiting"}</span>
            {review!.brainstormId && (
              <Link className="rp-pill rp-from" to={`${brainstormHref(roomId, review!.brainstormId)}?view=ideas`} title="The brainstorm these ideas came from" dir="auto">
                {review!.title}
              </Link>
            )}
            {ran && (
              <span className="rp-counts">
                {IDEA_OUTCOMES.filter((o) => review!.slides.some((s) => s.idea?.outcome === o.id)).map((o) => (
                  <span key={o.id} className={`rp-count ${o.id}`}>
                    {review!.slides.filter((s) => s.idea?.outcome === o.id).length} {o.label}
                  </span>
                ))}
              </span>
            )}
          </>
        ) : (
          <ReviewPicker roomId={roomId} current={review} reviews={data.reviews} />
        )}
        {review && ran && !ideas && <OutcomeCounts outcomes={countOutcomes(review)} />}
        {ran && !!review?.general?.length && <OffSlide caught={review.general} />}
        <span className="rp-grow" />
        {ran && review?.meetingId && (
          <Link className="rp-link" to={`/meetings/${review.meetingId}`}>
            Recap
          </Link>
        )}
        {review && !ran && (
          <button
            className="primary"
            disabled={starting}
            onClick={async () => {
              if (live) return navigate(joinHref(roomId));
              setStarting(true);
              try {
                await (ideas ? api.startIdeaReview(roomId, review.id) : api.startReview(roomId));
                navigate(joinHref(roomId));
              } catch (err) {
                errorToast("Couldn't start the review")(err);
                setStarting(false);
              }
            }}
          >
            {live ? "Join the review" : starting ? "Starting…" : "Start review"}
          </button>
        )}
      </header>

      {!review || !slide ? (
        <div className="rp-empty muted">
          <p>Nothing to review yet. Slides appear here as work is finished, or when an agent adds one.</p>
        </div>
      ) : (
        <>
          <main className="rp-main">
            <div className="rp-pic">
              {shot ? (
                <button type="button" className="rp-shot" title="See it bigger" onClick={() => setZoomed(true)}>
                  <img key={shot.url} src={shot.url} alt={shot.caption ?? slide.title} />
                </button>
              ) : slide.idea ? (
                <IdeaCard title={slide.title} detail={slide.body} idea={slide.idea} />
              ) : (
                <div className="rp-nopic">
                  <h2 dir="auto">{slide.title}</h2>
                  <span className="muted">No picture on this slide</span>
                </div>
              )}
              {shots.length > 1 && (
                <div className="rv-strip" role="tablist" aria-label="Pictures of this feature">
                  {shots.map((s, i) => (
                    <button key={s.url} type="button" role="tab" aria-selected={s === shot} className={s === shot ? "on" : undefined} title={s.caption ?? `Picture ${i + 1}`} onClick={() => setShotAt(i)}>
                      <img src={s.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              <button className="rp-flip prev" aria-label="Previous slide" disabled={at <= 0} onClick={() => go(at - 1)}>
                ←
              </button>
              <button className="rp-flip next" aria-label="Next slide" disabled={at >= count - 1} onClick={() => go(at + 1)}>
                →
              </button>
            </div>
            <div className="rp-about">
              <div className="rp-title">
                {/* A slide with no picture already says its name where the picture would be. */}
                {shot && <h1 dir="auto">{slide.title}</h1>}
                {end?.outcome && (
                  <span className={`rv-wrap-outcome ${end.outcome}`} title={end.by ? `${end.by} said so` : undefined}>
                    {outcomeLabel(end.outcome)}
                  </span>
                )}
                {slide.idea?.became && (
                  <Link className="rp-pill" to={`/ref/${slide.idea.became.kind}/${slide.idea.became.id}`}>
                    {slide.idea.became.kind === "action" ? "To-do" : "Open question"}
                  </Link>
                )}
                {slide.owner && <span className="rp-pill">{slide.owner}</span>}
                {slide.pr && (
                  <a className="rp-pill" href={slide.pr} target="_blank" rel="noreferrer">
                    {prLabel(slide.pr)}
                  </a>
                )}
                {slide.taskId && (
                  <Link className="rp-pill" to={`/ref/action/${slide.taskId}`}>
                    To-do
                  </Link>
                )}
              </div>
              {slide.body && !slide.idea && (
                <p className="rp-body" dir="auto">
                  {slide.body}
                </p>
              )}
              {ran && (
                <div className="rp-caught">
                  {(slide.caught ?? []).map((c) => (
                    <CaughtLine key={c.id} c={c} />
                  ))}
                  {!slide.caught?.length && <p className="muted rp-none">Nothing was raised on this slide</p>}
                </div>
              )}
            </div>
          </main>
          <div className={ideas ? "rp-strip ideas" : "rp-strip"} ref={strip} role="tablist" aria-label="Slides">
            {review.slides.map((s, i) => (
              <button key={s.id} type="button" role="tab" aria-selected={i === at} className={i === at ? "on" : undefined} title={s.title} onClick={() => go(i)}>
                <span className="rp-num">{i + 1}</span>
                <span className={s.shots[0] ? "rp-thumb" : "rp-thumb text"}>{s.shots[0] ? <img src={s.shots[0].url} alt="" loading="lazy" /> : <span>{s.title}</span>}</span>
                <span className="rp-thumb-foot">
                  {s.shots[0] && <span className="rp-n">{s.name ?? i + 1}</span>}
                  {endOf(s).outcome && <span className={`rp-dot ${endOf(s).outcome}`} title={outcomeLabel(endOf(s).outcome!)} />}
                  {!!s.caught?.length && <span className="count" title={`${s.caught.length} raised on this slide`}>{s.caught.length}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {zoomed && shot && slide && <ShotZoom url={shot.url} alt={shot.caption ?? slide.title} onClose={() => setZoomed(false)} />}
    </div>
  );
}

const countOutcomes = (review: ReviewView) => {
  const n = { ship: 0, fixes: 0, not_yet: 0 };
  for (const s of review.slides) if (s.outcome) n[s.outcome]++;
  return n;
};

/** Which review this is, as a pill that opens the others: the next one, then each that ran. */
function CaughtLine({ c }: { c: ReviewCaught }) {
  const k = KINDS.find((x) => x.kind === c.kind)!;
  return (
    <Link to={`/ref/${c.kind}/${c.id}`} className={`rp-line ${c.kind}${c.done ? " done" : ""}`} title={k.label}>
      <k.Icon />
      <span dir="auto">{c.text}</span>
      {c.owner && <span className="rv-who">{c.owner.split(" ")[0]}</span>}
    </Link>
  );
}

/** What the review raised that isn't about one slide, behind a pill. */
function OffSlide({ caught }: { caught: ReviewCaught[] }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div className="rp-picker" ref={box}>
      <button type="button" className="rp-pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {caught.length} off the slides <ChevronIcon size={10} />
      </button>
      {open && (
        <div className="rp-menu rp-off" role="dialog" aria-label="Raised outside the slides">
          {caught.map((c) => (
            <CaughtLine key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewPicker(props: { roomId: string; current: ReviewView | null; reviews: ReviewSummary[] }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const ran = props.current?.status === "done";
  const label = ran ? day(props.current!.startedAt) : props.current?.status === "live" ? "On now" : "Next";
  if (!props.reviews.length) return <span className="rp-pill">{label}</span>;
  return (
    <div className="rp-picker" ref={box}>
      <button type="button" className="rp-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} <ChevronIcon size={10} />
      </button>
      {open && (
        <div className="rp-menu" role="menu">
          <Link role="menuitem" to={reviewHref(props.roomId, "next")} className={ran ? undefined : "on"} onClick={() => setOpen(false)}>
            Next review
          </Link>
          {props.reviews.map((r) => (
            <Link key={r.id} role="menuitem" to={reviewHref(props.roomId, r.id)} className={props.current?.id === r.id ? "on" : undefined} onClick={() => setOpen(false)}>
              <span>{day(r.startedAt)}</span>
              <span className="muted">{r.slides} slides</span>
              <OutcomeCounts outcomes={r.outcomes} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
