// The space's next design review, before the call: each spec waiting on it, laid out as the slides
// the call will go through. The spec's author prepares it here: rewrites what Stand wrote, takes
// sections and points off the call, asks the questions the team has to decide.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BRIEF_LINES_MAX, BRIEF_LINE_MAX, BRIEF_SUMMARY_MAX, VERDICTS, designOutcomeLabel, pointsOnDeck,
  type BriefChange, type BriefSection, type DesignCaught, type DesignOutcome, type DesignPoint, type DesignReviewRan, type DesignReviewRecord, type DesignReviewView, type DesignSpec,
  type LastDesignReview,
} from "../../shared/designReview.ts";
import { TASK_COMMENT_MAX } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { ChevronIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { errorToast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { joinHref, spaceHref } from "./SpacesShell.tsx";

export const designReviewHref = (roomId: string, taskId?: string) => `/s/${roomId}/design-review${taskId ? `?spec=${taskId}` : ""}`;
/** The page a design review that ran keeps. */
export const designRecordHref = (roomId: string, reviewId: string) => `/s/${roomId}/design-review/${reviewId}`;
const day = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const TONE: Record<DesignOutcome, string> = { settled: "ship", open: "fixes", approve: "ship", changes: "fixes", not_yet: "not_yet" };

/** How a review's specs ended, as small counts: "1 Approve · 1 Not yet". */
export function VerdictCounts({ verdicts }: { verdicts: DesignReviewRan["verdicts"] }) {
  const some = VERDICTS.filter((v) => verdicts[v.id] > 0);
  if (!some.length) return null;
  return (
    <span className="rp-counts">
      {some.map((v) => (
        <span key={v.id} className={`rp-count ${TONE[v.id]}`}>
          {verdicts[v.id]} {v.label}
        </span>
      ))}
    </span>
  );
}

/** When a spec was last reviewed and how that ended, with whether the plan has changed since. */
export function LastReview({ roomId, last }: { roomId: string; last: LastDesignReview }) {
  return (
    <Link className="rp-pill" to={designRecordHref(roomId, last.reviewId)} title="Open that review">
      Reviewed {day(last.at)}
      {last.verdict && <span className={`rp-count ${TONE[last.verdict]}`}>{designOutcomeLabel(last.verdict)}</span>}
      {last.changed && <span className="dr-changed">Changed since</span>}
    </Link>
  );
}
const planHref = (roomId: string, taskId: string) => `/s/${roomId}?task=${taskId}&view=plan`;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** How many slides the call goes through for a spec: the overview, its sections and points, and the verdict. */
const slidesOf = (spec: DesignSpec) => 2 + spec.brief.sections.filter((s) => !s.off).length + pointsOnDeck(spec.points).length;

export function DesignReviewPage() {
  const { reviewId } = useParams();
  return reviewId ? <RecordPage reviewId={reviewId} /> : <NextPage />;
}

function NextPage() {
  const { roomId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ roomName: string; review: DesignReviewView | null; reviews: DesignReviewRan[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  const load = () => api.designReview(roomId).then(setData, () => setFailed(true));
  useEffect(() => {
    setData(null);
    setFailed(false);
    void load();
  }, [roomId]);
  // Stand is still writing a spec's slides: look again until it has.
  const writing = !!data?.review?.specs.some((s) => s.brief.status === "writing");
  useEffect(() => {
    if (!writing) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [writing, roomId]);

  if (failed) {
    return (
      <div className="rp rp-empty">
        <p>This review isn't here, or isn't yours to see.</p>
        <Link to={spaceHref(roomId)}>← Back to the space</Link>
      </div>
    );
  }
  if (!data) return <div className="rp rp-empty muted">Loading…</div>;

  const specs = data.review?.specs ?? [];
  const spec = specs.find((s) => s.taskId === params.get("spec")) ?? specs[0];
  const points = specs.reduce((n, s) => n + pointsOnDeck(s.points).length, 0);
  const live = data.review?.status === "live";
  const change = async (taskId: string, c: BriefChange) => {
    try {
      const { spec: next } = await api.prepareDesignReview(taskId, c);
      setData((d) => (d?.review && next ? { ...d, review: { ...d.review, specs: d.review.specs.map((s) => (s.taskId === taskId ? next : s)) } } : d));
    } catch (err) {
      errorToast("Couldn't save that")(err);
    }
  };

  return (
    <div className="rp dr">
      <header className="rp-head">
        <Link className="rp-back" to={spaceHref(roomId)}>
          ← {data.roomName}
        </Link>
        <strong>Design review</strong>
        <Picker roomId={roomId} label={live ? "On now" : "Next"} reviews={data.reviews} />
        {specs.length > 0 && (
          <span className="muted small">
            {plural(specs.length, "spec")} · {plural(points, "point")}
          </span>
        )}
        <span className="rp-grow" />
        {specs.length > 0 && (
          <button
            className="primary"
            disabled={starting}
            onClick={async () => {
              if (live) return navigate(joinHref(roomId));
              setStarting(true);
              try {
                await api.startDesignReview(roomId);
                navigate(joinHref(roomId));
              } catch (err) {
                errorToast("Couldn't start the review")(err);
                setStarting(false);
              }
            }}
          >
            {live ? "Join the review" : starting ? "Starting…" : "Start design review"}
          </button>
        )}
      </header>
      {!spec ? (
        <div className="rp-empty muted">
          <p>No spec is waiting for a review. Open a to-do's plan and click Request review, or have your agent ask for one.</p>
        </div>
      ) : (
        <div className="dr-body">
          {specs.length > 1 && (
            <nav className="dr-specs" aria-label="Specs on this review">
              {specs.map((s) => (
                <button key={s.taskId} type="button" aria-current={s === spec} onClick={() => setParams({ spec: s.taskId }, { replace: true })}>
                  <strong dir="auto">{s.title}</strong>
                  <span className="muted small">
                    {s.owner ?? "Unassigned"} · {plural(pointsOnDeck(s.points).length, "point")}
                  </span>
                </button>
              ))}
            </nav>
          )}
          <SpecPrep
            key={spec.taskId}
            roomId={roomId}
            spec={spec}
            live={live}
            change={(c) => change(spec.taskId, c)}
            onRemove={async () => {
              try {
                await api.removeDesignReview(spec.taskId);
                await load();
              } catch (err) {
                errorToast("Couldn't take it off the review")(err);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function SpecPrep({ roomId, spec, live, change, onRemove }: { roomId: string; spec: DesignSpec; live: boolean; change: (c: BriefChange) => Promise<void>; onRemove: () => void }) {
  const { brief, mine } = spec;
  const whole = spec.points.filter((p) => p.placed && !p.section);
  const lost = spec.points.filter((p) => !p.placed);
  const open = brief.suggestions.filter((s) => s.state === "open");
  return (
    <main className="dr-spec">
      <div className="rp-title">
        <h1 dir="auto">{spec.title}</h1>
        {spec.owner && <span className="rp-pill">{spec.owner}</span>}
        <span className="rp-pill">{plural(slidesOf(spec), "slide")}</span>
        <Link className="rp-pill" to={planHref(roomId, spec.taskId)}>
          Open the spec
        </Link>
        {spec.last && <LastReview roomId={roomId} last={spec.last} />}
        <span className="rp-grow" />
        {mine && !live && (
          <button type="button" className="ghost small" onClick={onRemove}>
            Take off the review
          </button>
        )}
      </div>
      <p className="muted small">
        {spec.requestedBy ? `Review requested by ${spec.requestedBy}. ` : ""}
        {mine ? "You prepare this spec: what each slide says, and which sections and points go to the call." : "Comment on a passage of the spec to add a point. Its author prepares the slides."}
      </p>
      {brief.status === "writing" && <p className="dr-note" role="status">✦ Stand is writing the slides from the spec…</p>}
      {brief.status === "failed" && (
        <p className="dr-note error">
          Stand couldn't write the slides.{" "}
          {mine && (
            <button type="button" className="link" onClick={() => void change({ rewrite: true })}>
              Try again
            </button>
          )}
        </p>
      )}
      {brief.status === "none" && <p className="dr-note">Stand can't write the slides on this server. The sections come from the spec{mine ? "; write their lines yourself" : ""}.</p>}

      <ol className="dr-slides">
        <li className="dr-slide">
          <header>
            <span className="dr-kind">Overview</span>
            {brief.summary && !brief.summaryEdited && <Stand />}
            {brief.summaryChanged && <span className="dr-changed">The spec changed after this was written</span>}
          </header>
          <Editable
            mine={mine}
            label="Summary"
            value={brief.summary}
            max={BRIEF_SUMMARY_MAX}
            rows={3}
            empty="No summary yet."
            onSave={(summary) => change({ summary })}
          />
          <Points points={whole} mine={mine} change={change} />
          {mine && <Ask label="Ask the team a question about the whole spec" onAsk={(question) => change({ question })} />}
        </li>
        {brief.sections.map((s) => (
          <SectionSlide key={s.heading} section={s} points={spec.points.filter((p) => p.placed && p.section === s.heading)} mine={mine} change={change} />
        ))}
        <li className="dr-slide">
          <header>
            <span className="dr-kind">Verdict</span>
          </header>
          <p className="muted">Each point with how it ended, then the team's call: Approve, Approve with changes, or Not yet.</p>
          {lost.length > 0 && (
            <>
              <p className="muted small">These comments are on a passage this version of the spec no longer has. They have no slide and show here.</p>
              <Points points={lost} mine={false} change={change} />
            </>
          )}
        </li>
      </ol>

      {open.length > 0 && (
        <section className="dr-suggest" aria-label="Questions Stand suggests">
          <h2>
            Questions Stand suggests <Stand />
          </h2>
          <p className="muted small">{mine ? "A suggestion goes to the call only when you accept it." : "A suggestion goes to the call only when the author accepts it."}</p>
          {open.map((s) => (
            <div key={s.id} className="dr-point">
              <blockquote dir="auto">{s.quote}</blockquote>
              <p dir="auto">{s.text}</p>
              {mine && (
                <div className="dr-row">
                  <button type="button" className="small primary" onClick={() => void change({ suggestion: s.id, accept: true })}>
                    Accept
                  </button>
                  <button type="button" className="small ghost" onClick={() => void change({ suggestion: s.id, accept: false })}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

const Stand = () => (
  <span className="dr-stand" title="Written by Stand from the spec. The author can rewrite it.">
    ✦ Stand
  </span>
);

function SectionSlide({ section: s, points, mine, change }: { section: BriefSection; points: DesignPoint[]; mine: boolean; change: (c: BriefChange) => Promise<void> }) {
  return (
    <li className={`dr-slide${s.off ? " off" : ""}`}>
      <header>
        <span className="dr-kind">Section</span>
        <h2 dir="auto">{s.heading}</h2>
        {!s.off && s.lines.length > 0 && !s.edited && <Stand />}
        {!s.off && s.changed && <span className="dr-changed">The spec changed after this was written</span>}
        <span className="rp-grow" />
        {s.off && <span className="muted small">Off the call</span>}
        {mine && (
          <button type="button" className="ghost small" onClick={() => void change({ section: s.heading, off: !s.off })}>
            {s.off ? "Put back" : "Take off the call"}
          </button>
        )}
      </header>
      {!s.off && (
        <>
          <Editable
            mine={mine}
            label={`Lines for ${s.heading}`}
            value={s.lines.join("\n")}
            max={BRIEF_LINES_MAX * (BRIEF_LINE_MAX + 1)}
            rows={BRIEF_LINES_MAX}
            list
            hint={`Up to ${BRIEF_LINES_MAX} lines, one on each row`}
            empty="No lines: the slide shows the heading."
            onSave={(text) => change({ section: s.heading, lines: text.split("\n") })}
          />
          <Points points={points} mine={mine} change={change} />
          {mine && <Ask label={`Ask the team a question about ${s.heading}`} onAsk={(question) => change({ question, section: s.heading })} />}
        </>
      )}
      {s.off && points.length > 0 && <Points points={points} mine={mine} change={change} />}
    </li>
  );
}

/** What a slide says, with the author's way to rewrite it. */
function Editable(props: { mine: boolean; label: string; value: string; max: number; rows: number; list?: boolean; hint?: string; empty: string; onSave: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft === null) {
    const lines = props.value.split("\n").filter(Boolean);
    return (
      <div className="dr-text">
        {!lines.length ? <p className="muted">{props.empty}</p> : props.list ? <ul>{lines.map((l, i) => <li key={i} dir="auto">{l}</li>)}</ul> : <p dir="auto">{props.value}</p>}
        {props.mine && (
          <button type="button" className="link small" onClick={() => setDraft(props.value)}>
            Edit
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="dr-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await props.onSave(draft);
        setBusy(false);
        setDraft(null);
      }}
    >
      <textarea aria-label={props.label} autoFocus rows={props.rows} maxLength={props.max} value={draft} readOnly={busy} onChange={(e) => setDraft(e.target.value)} dir="auto" />
      <div className="dr-row">
        <button type="submit" className="small primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="small ghost" disabled={busy} onClick={() => setDraft(null)}>
          Cancel
        </button>
        {props.hint && <span className="muted small">{props.hint}</span>}
      </div>
    </form>
  );
}

/** The points under a slide: each gets a slide of its own after it, unless the author takes it off the call. */
function Points({ points, mine, change }: { points: DesignPoint[]; mine: boolean; change: (c: BriefChange) => Promise<void> }) {
  if (!points.length) return null;
  return (
    <div className="dr-points">
      {points.map((p) => (
        <div key={p.threadId} className={`dr-point${p.off ? " off" : ""}`}>
          <span className="dr-kind">Point</span>
          <blockquote dir="auto">{p.quote}</blockquote>
          <p dir="auto">
            {p.text} <span className="muted small">{p.by}</span>
          </p>
          {p.off && <span className="muted small">Off the call. The comment stays open on the spec.</span>}
          {mine && (
            <button type="button" className="link small" onClick={() => void change({ point: p.threadId, off: !p.off })}>
              {p.off ? "Put back" : "Take off the call"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Ask({ label, onAsk }: { label: string; onAsk: (question: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="dr-ask"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        await onAsk(text.trim());
        setBusy(false);
        setText("");
      }}
    >
      <input aria-label={label} placeholder="Ask the team a question here…" maxLength={TASK_COMMENT_MAX} value={text} readOnly={busy} onChange={(e) => setText(e.target.value)} dir="auto" />
      <button type="submit" className="small" disabled={busy || !text.trim()}>
        Add point
      </button>
    </form>
  );
}

/** Which review this is, as a pill that opens the others: the next one, then each that ran. */
function Picker(props: { roomId: string; label: string; current?: string; reviews: DesignReviewRan[] }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  if (!props.reviews.length) return <span className="rp-pill">{props.label}</span>;
  return (
    <div className="rp-picker" ref={box}>
      <button type="button" className="rp-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.label} <ChevronIcon size={10} />
      </button>
      {open && (
        <div className="rp-menu" role="menu">
          <Link role="menuitem" to={designReviewHref(props.roomId)} className={props.current ? undefined : "on"} onClick={() => setOpen(false)}>
            Next review
          </Link>
          {props.reviews.map((r) => (
            <Link key={r.id} role="menuitem" to={designRecordHref(props.roomId, r.id)} className={props.current === r.id ? "on" : undefined} onClick={() => setOpen(false)}>
              <span>{day(r.startedAt)}</span>
              <span className="muted">{plural(r.titles.length, "spec")}</span>
              <VerdictCounts verdicts={r.verdicts} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const KINDS = [
  { kind: "action", label: "To do", Icon: TodoIcon },
  { kind: "decision", label: "Decided", Icon: DecidedIcon },
  { kind: "question", label: "Open", Icon: QuestionIcon },
] as const;

function Caught({ caught }: { caught: DesignCaught[] }) {
  if (!caught.length) return null;
  return (
    <div className="rp-caught">
      {caught.map((c) => {
        const k = KINDS.find((x) => x.kind === c.kind)!;
        return (
          <Link key={c.id} to={`/ref/${c.kind}/${c.id}`} className={`rp-line ${c.kind}${c.done ? " done" : ""}`} title={k.label}>
            <k.Icon />
            <span dir="auto">{c.text}</span>
            {c.owner && <span className="rv-who">{c.owner.split(" ")[0]}</span>}
          </Link>
        );
      })}
    </div>
  );
}

/** A design review that ran: the verdict on each spec, how its points ended, and what the team raised. */
function RecordPage({ reviewId }: { reviewId: string }) {
  const { roomId = "" } = useParams();
  const [data, setData] = useState<{ roomName: string; review: DesignReviewRecord; reviews: DesignReviewRan[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [again, setAgain] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    setData(null);
    setFailed(false);
    api.designReviewRecord(roomId, reviewId).then(setData, () => setFailed(true));
  }, [roomId, reviewId]);
  if (failed) {
    return (
      <div className="rp rp-empty">
        <p>This review isn't here, or isn't yours to see.</p>
        <Link to={spaceHref(roomId)}>← Back to the space</Link>
      </div>
    );
  }
  if (!data) return <div className="rp rp-empty muted">Loading…</div>;
  const { review } = data;
  return (
    <div className="rp dr">
      <header className="rp-head">
        <Link className="rp-back" to={spaceHref(roomId)}>
          ← {data.roomName}
        </Link>
        <strong>Design review</strong>
        <Picker roomId={roomId} label={day(review.startedAt)} current={review.id} reviews={data.reviews} />
        <span className="rp-grow" />
        {review.meetingId && (
          <Link className="rp-link" to={`/meetings/${review.meetingId}`}>
            Recap
          </Link>
        )}
      </header>
      <div className="dr-body">
        <main className="dr-spec">
          {review.specs.map((spec) => {
            const points = spec.slides.filter((s) => s.role === "point");
            const others = spec.slides.filter((s) => s.role !== "point" && s.caught.length > 0);
            return (
              <section key={spec.taskId} className="dr-record" aria-label={spec.title}>
                <div className="rp-title">
                  <h1 dir="auto">{spec.title}</h1>
                  <span className={`ds-result ${spec.verdict ? TONE[spec.verdict] : ""}`} title={spec.verdictBy ? `${spec.verdictBy} said so` : undefined}>
                    {spec.verdict ? designOutcomeLabel(spec.verdict) : "No verdict"}
                  </span>
                  {spec.owner && <span className="rp-pill">{spec.owner}</span>}
                  <Link className="rp-pill" to={planHref(roomId, spec.taskId)}>
                    Open the spec
                  </Link>
                  <button
                    type="button"
                    className="rp-pill"
                    disabled={again === spec.taskId}
                    onClick={async () => {
                      setAgain(spec.taskId);
                      try {
                        await api.requestDesignReview(spec.taskId);
                        navigate(designReviewHref(roomId));
                      } catch (err) {
                        errorToast("Couldn't put it on the next review")(err);
                        setAgain(null);
                      }
                    }}
                  >
                    {again === spec.taskId ? "Adding…" : "Review again"}
                  </button>
                </div>
                {points.length === 0 && <p className="muted">No points were on this spec.</p>}
                {points.map((p) => (
                  <div key={p.id} className="dr-slide">
                    <header>
                      <span className="dr-kind">{p.name}</span>
                      <h2 dir="auto">{p.title}</h2>
                      <span className="rp-grow" />
                      <span className={`ds-result ${p.outcome ? TONE[p.outcome] : ""}`} title={p.outcomeBy ? `${p.outcomeBy} said so` : undefined}>
                        {p.outcome ? designOutcomeLabel(p.outcome) : "Not called"}
                      </span>
                    </header>
                    {p.quote && (
                      <div className="dr-point">
                        <blockquote dir="auto">{p.quote}</blockquote>
                        {p.by && <span className="muted small">Asked by {p.by}</span>}
                      </div>
                    )}
                    {p.caught.length ? <Caught caught={p.caught} /> : <p className="muted small">Nothing was raised on this point.</p>}
                  </div>
                ))}
                {others.map((s) => (
                  <div key={s.id} className="dr-slide">
                    <header>
                      <span className="dr-kind">{s.role === "section" ? "Section" : s.name}</span>
                      {s.role === "section" && <h2 dir="auto">{s.title}</h2>}
                    </header>
                    <Caught caught={s.caught} />
                  </div>
                ))}
                {spec.lost.length > 0 && (
                  <div className="dr-slide">
                    <header>
                      <span className="dr-kind">Comments on a passage that version no longer had</span>
                    </header>
                    {spec.lost.map((l, i) => (
                      <p key={i} dir="auto">
                        {l.text} <span className="muted small">{l.by}</span>
                      </p>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {review.general.length > 0 && (
            <section className="dr-record" aria-label="Raised outside the slides">
              <h2 className="dr-kind">Raised outside the slides</h2>
              <Caught caught={review.general} />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
