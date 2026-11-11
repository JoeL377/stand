// A design review slide on the middle screen: a part of the spec the team is going through. The
// Overview and each section say what the spec decides; a point shows the passage with the question
// about it and ends Settled or Still open; the Verdict lists how the points ended and takes the
// team's call on the spec. Full spec opens the plan at that part, for one person or, by the host,
// for everyone. The host flips slides, and so does the spec's author within their spec.

import { useEffect, useState } from "react";
import { POINT_OUTCOMES, VERDICTS, designOutcomeLabel, type DesignOutcome, type DesignSlideInfo } from "../../shared/designReview.ts";
import type { PlanThread } from "../../shared/planReview.ts";
import type { Item, Note } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { CloseIcon } from "../icons.tsx";
import { Markdown } from "../Markdown.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { PlanReviewBody } from "../PlanReview.tsx";
import { AddLine } from "./ReviewStage.tsx";
import { errorToast } from "../Toasts.tsx";

const KINDS = [
  { kind: "action", label: "To do", Icon: TodoIcon },
  { kind: "decision", label: "Decided", Icon: DecidedIcon },
  { kind: "question", label: "Open", Icon: QuestionIcon },
] as const;

const ROLE_LABEL: Record<DesignSlideInfo["role"], string> = { overview: "Overview", section: "Section", point: "Point", verdict: "Verdict" };
/** The colors the product review's outcomes already have: went well, went with a caveat, didn't. */
const TONE: Record<DesignOutcome, string> = { settled: "ship", open: "fixes", approve: "ship", changes: "fixes", not_yet: "not_yet" };

export function DesignStage(props: {
  item: Item;
  /** Every slide of the review's deck, in order. */
  slides: Item[];
  /** What the meeting has caught so far, on any item. */
  notes: Note[];
  /** The notes for this slide are being written right now. */
  busy: boolean;
  /** The host: flips any slide, fixes what Stand caught, opens the spec for everyone. */
  canSteer: boolean;
  /** This person wrote the spec on screen: they flip its slides and accept Stand's suggestions. */
  author: boolean;
  disabled: boolean;
  specOpen: boolean;
  onSpec: (open: boolean) => void;
  onFlip: (delta: number) => void;
  onOutcome: (outcome: DesignOutcome | null) => void;
  /** The host takes a line off that Stand got wrong, or adds one it missed. */
  onRemove?: (note: Note) => void;
  onAdd?: (kind: "action" | "decision" | "question", text: string) => void;
  className?: string;
}) {
  const { item, slides, disabled } = props;
  const design = item.slide!.design!;
  // The slides of this spec: the ones its author can move between, and what the Verdict sums up.
  const mine = slides.filter((s) => s.slide?.design?.taskId === design.taskId);
  const at = mine.findIndex((s) => s.id === item.id);
  const mayFlip = props.canSteer || props.author;
  const deckAt = slides.findIndex((s) => s.id === item.id);
  const [first, last] = props.canSteer ? [deckAt <= 0, deckAt >= slides.length - 1] : [at <= 0, at >= mine.length - 1];
  const ids = new Set(design.role === "verdict" ? mine.map((s) => s.id) : [item.id]);
  const caught = props.notes.filter((n) => n.itemId && ids.has(n.itemId) && KINDS.some((k) => k.kind === n.kind));
  const outcomes = design.role === "point" ? POINT_OUTCOMES : design.role === "verdict" ? VERDICTS : [];
  const lines = (item.slide?.body ?? "").split("\n").filter((l) => l.trim());

  return (
    <div className={`design-stage ${props.className ?? ""}`}>
      <div className="ds-card">
        <header className="ds-head">
          <span className="dr-kind">{design.role === "point" ? design.name : ROLE_LABEL[design.role]}</span>
          <span className="ds-spec" dir="auto" title={design.spec}>
            {design.spec}
          </span>
          {design.owner && <span className="muted small">{design.owner}</span>}
          <span className="rp-grow" />
          <button type="button" className="small" onClick={() => props.onSpec(true)} title={props.canSteer ? "Open the spec at this part, for everyone" : "Open the spec at this part"}>
            Full spec
          </button>
        </header>
        <div className="ds-body">
          <div className="ds-main">
            {design.role === "overview" && (
              <>
                <h1 dir="auto">{item.title}</h1>
                {item.slide?.body ? (
                  <p className="ds-summary" dir="auto">
                    {item.slide.body} {design.stand && <Stand />}
                  </p>
                ) : (
                  <p className="muted">No summary yet.</p>
                )}
                {!!design.sections?.length && (
                  <>
                    <h2>Sections</h2>
                    <ol className="ds-sections">
                      {design.sections.map((s) => (
                        <li key={s} dir="auto">
                          {s}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                <p className="muted small">
                  {points(mine).length === 1 ? "1 point" : `${points(mine).length} points`} to go through
                </p>
                {!!design.suggestions?.length && <Suggestions design={design} author={props.author && !disabled} />}
              </>
            )}
            {design.role === "section" && (
              <>
                <h1 dir="auto">
                  {item.title} {design.stand && <Stand />}
                </h1>
                {lines.length > 0 ? (
                  <ul className="ds-lines">
                    {lines.map((l, i) => (
                      <li key={i} dir="auto">
                        {l}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Open Full spec to go through this section.</p>
                )}
                {points(mine).filter((p) => p.slide!.design!.section === design.section).length > 0 && (
                  <p className="muted small">
                    Points in this section: {points(mine).filter((p) => p.slide!.design!.section === design.section).map((p) => p.slide!.design!.name.replace("Point ", "")).join(", ")}
                  </p>
                )}
              </>
            )}
            {design.role === "point" && (
              <>
                <blockquote className="ds-passage" dir="auto">
                  <Markdown text={design.quote ?? ""} />
                </blockquote>
                <Thread taskId={design.taskId} threadId={design.threadId!} question={item.slide?.body ?? ""} by={design.by ?? ""} />
              </>
            )}
            {design.role === "verdict" && (
              <>
                <h1 dir="auto">{design.spec}</h1>
                {points(mine).length > 0 ? (
                  <ul className="ds-results">
                    {points(mine).map((p) => {
                      const o = p.slide!.design!.outcome;
                      return (
                        <li key={p.id}>
                          <span className="dr-kind">{p.slide!.design!.name}</span>
                          <span dir="auto">{p.title}</span>
                          <span className={`ds-result ${o ? TONE[o] : ""}`}>{o ? designOutcomeLabel(o) : "Not called"}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted">No points on this spec.</p>
                )}
                {!!design.lost?.length && (
                  <>
                    <h2>Comments on a passage this version no longer has</h2>
                    <ul className="ds-lost">
                      {design.lost.map((l, i) => (
                        <li key={i} dir="auto">
                          {l.text} <span className="muted small">{l.by}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
          <aside className="ds-caught" aria-label={design.role === "verdict" ? "What Stand caught on this spec" : "What Stand caught on this slide"}>
            {KINDS.map(({ kind, label, Icon }) => {
              const of = caught.filter((n) => n.kind === kind);
              if (!of.length) return null;
              return (
                <div key={kind} className={`ds-group ${kind}`}>
                  <h3>
                    <Icon /> {label} <span className="count">{of.length}</span>
                  </h3>
                  {of.map((n) => (
                    <p key={n.id} className={n.doneAt ? "done" : undefined}>
                      <span dir="auto">{n.text}</span>
                      {n.owner && <span className="muted small">{n.owner.split(" ")[0]}</span>}
                      {props.onRemove && !disabled && (
                        <button className="rv-wrap-x" aria-label={`Remove "${n.text}"`} title="Remove" onClick={() => props.onRemove!(n)}>
                          <CloseIcon size={12} />
                        </button>
                      )}
                    </p>
                  ))}
                </div>
              );
            })}
            {props.busy ? (
              <p className="muted small">
                <span className="agent-mark">✦</span> Writing
              </p>
            ) : (
              !caught.length && <p className="muted small">What the team says here is filed under this {design.role === "verdict" ? "spec" : "slide"}.</p>
            )}
            {props.onAdd && !disabled && <AddLine onAdd={props.onAdd} />}
          </aside>
        </div>
        {props.specOpen && (
          <div className="ds-spec-pane" role="dialog" aria-label="Full spec">
            <header>
              <strong dir="auto">{design.spec}</strong>
              <span className="muted small">Select a passage and comment to add a point to the call</span>
              <span className="rp-grow" />
              <button type="button" className="small" onClick={() => props.onSpec(false)}>
                Back to the slide
              </button>
            </header>
            <PlanReviewBody key={item.id} task={design.taskId} initial={{ thread: design.threadId ?? null, passage: design.passage ?? null }} />
          </div>
        )}
      </div>
      <div className="slide-bar rv-bar">
        {mayFlip && (
          <button className="ghost" onClick={() => props.onFlip(-1)} disabled={disabled || first} aria-label="Previous slide">
            ←
          </button>
        )}
        <span className="muted small rv-pos">
          {deckAt + 1} of {slides.length}
        </span>
        {outcomes.length > 0 && (
          <div className="rv-outcomes" role="group" aria-label={design.role === "verdict" ? "The verdict on this spec" : "How this point ended"}>
            {outcomes.map((o) => {
              const on = design.outcome === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  className={`rv-outcome ${TONE[o.id]}${on ? " on" : ""}`}
                  aria-pressed={on}
                  disabled={disabled}
                  title={on && design.outcomeBy ? `${design.outcomeBy} said so. Click to take it back` : undefined}
                  onClick={() => props.onOutcome(on ? null : o.id)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        )}
        {mayFlip && (
          <button className="ghost" onClick={() => props.onFlip(1)} disabled={disabled || last} aria-label="Next slide">
            →
          </button>
        )}
      </div>
    </div>
  );
}

const points = (slides: Item[]) => slides.filter((s) => s.slide?.design?.role === "point");

const Stand = () => (
  <span className="dr-stand" title="Written by Stand from the spec. The author can rewrite it.">
    ✦ Stand
  </span>
);

/** The question a point is about, and what people have answered on its thread since. */
function Thread({ taskId, threadId, question, by }: { taskId: string; threadId: string; question: string; by: string }) {
  const [thread, setThread] = useState<PlanThread | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => api.planReview(taskId).then((r) => { if (active) setThread(r.threads.find((t) => t.id === threadId) ?? null); }, () => {});
    void load();
    const timer = setInterval(load, 20_000);
    return () => { active = false; clearInterval(timer); };
  }, [taskId, threadId]);
  return (
    <div className="ds-thread">
      <p className="ds-question" dir="auto">
        {question}
      </p>
      <span className="muted small">{by}</span>
      {(thread?.messages.slice(1) ?? []).map((m) => (
        <div key={m.id} className="ds-reply">
          <span className="muted small">{m.by}</span>
          <Markdown text={m.text} breaks />
        </div>
      ))}
    </div>
  );
}

/** Questions Stand suggests on the spec. One goes in front of the team when its author accepts it. */
function Suggestions({ design, author }: { design: DesignSlideInfo; author: boolean }) {
  const [busy, setBusy] = useState(false);
  const answer = async (suggestion: string, accept: boolean) => {
    setBusy(true);
    try {
      await api.prepareDesignReview(design.taskId, { suggestion, accept });
    } catch (err) {
      errorToast("Couldn't save that")(err);
    }
    setBusy(false);
  };
  return (
    <div className="ds-suggest">
      <h2>
        Questions Stand suggests <Stand />
      </h2>
      {design.suggestions!.map((s) => (
        <div key={s.id} className="dr-point">
          <p dir="auto">{s.text}</p>
          {author && (
            <div className="dr-row">
              <button type="button" className="small primary" disabled={busy} onClick={() => void answer(s.id, true)}>
                Make it a point
              </button>
              <button type="button" className="small ghost" disabled={busy} onClick={() => void answer(s.id, false)}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
