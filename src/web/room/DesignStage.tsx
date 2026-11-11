// A design review slide on the middle screen: a part of the spec the team is going through. The
// Overview and each section slide say what the spec decides; a section slide can hold several
// sections. A question about a passage is a step on the slide of its section: the slide stays up,
// the question opens with its passage, and it ends Settled or Still open. The Verdict lists how the
// questions ended and takes the team's call on the spec. Full spec opens the plan at that part, for
// one person or, by the host, for everyone. The host flips slides, and so does the spec's author
// within their spec.

import { useEffect, useRef, useState } from "react";
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

const ROLE_LABEL: Record<DesignSlideInfo["role"], string> = { overview: "Overview", section: "Section", point: "Question", verdict: "Verdict" };
/** The colors the product review's outcomes already have: went well, went with a caveat, didn't. */
const TONE: Record<DesignOutcome, string> = { settled: "ship", open: "fixes", approve: "ship", changes: "fixes", not_yet: "not_yet" };
const isQuestion = (s: Item) => s.slide?.design?.role === "point";
const questions = (slides: Item[]) => slides.filter(isQuestion);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function DesignStage(props: {
  item: Item;
  /** Every item of the review's deck, in order: the slides, and each question after its slide. */
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
  /** The host or the author opens a question of the slide, for everyone. */
  onGo: (itemId: string) => void;
  onOutcome: (outcome: DesignOutcome | null) => void;
  /** The host takes a line off that Stand got wrong, or adds one it missed. */
  onRemove?: (note: Note) => void;
  onAdd?: (kind: "action" | "decision" | "question", text: string) => void;
  className?: string;
}) {
  const { item, slides, disabled } = props;
  const design = item.slide!.design!;
  // The items of this spec: the ones its author can move between, and what the Verdict sums up.
  const mine = slides.filter((s) => s.slide?.design?.taskId === design.taskId);
  const at = mine.findIndex((s) => s.id === item.id);
  // A question is a step on the slide before it: that slide stays on screen with the question open.
  const asked = isQuestion(item) ? item : null;
  const pageAt = asked ? mine.slice(0, at).findLastIndex((s) => !isQuestion(s)) : at;
  const page = mine[pageAt] ?? item;
  const shown = page.slide!.design!;
  const steps: Item[] = [];
  for (let i = pageAt + 1; pageAt >= 0 && i < mine.length && isQuestion(mine[i]); i++) steps.push(mine[i]);
  const pages = slides.filter((s) => !isQuestion(s));
  const mayFlip = props.canSteer || props.author;
  const deckAt = slides.findIndex((s) => s.id === item.id);
  const [first, last] = props.canSteer ? [deckAt <= 0, deckAt >= slides.length - 1] : [at <= 0, at >= mine.length - 1];
  // What was caught on the slide and on its questions shows together; the Verdict shows the whole spec's.
  const ids = new Set((shown.role === "verdict" ? mine : [page, ...steps]).map((s) => s.id));
  const caught = props.notes.filter((n) => n.itemId && ids.has(n.itemId) && KINDS.some((k) => k.kind === n.kind));
  const outcomes = asked ? POINT_OUTCOMES : design.role === "verdict" ? VERDICTS : [];
  const parts = shown.parts ?? [];

  return (
    <div className={`design-stage ${props.className ?? ""}`}>
      <div className="ds-card">
        <header className="ds-head">
          <span className="dr-kind">{ROLE_LABEL[shown.role]}</span>
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
          <div className={`ds-main${asked ? " asking" : ""}`}>
            {shown.role === "overview" && (
              <>
                <h1 dir="auto">{page.title}</h1>
                {page.slide?.body ? (
                  <p className="ds-summary" dir="auto">
                    {page.slide.body} {shown.stand && <Stand />}
                  </p>
                ) : (
                  <p className="muted">No summary yet.</p>
                )}
                {!asked && !!shown.sections?.length && (
                  <>
                    <h2>Slides</h2>
                    <ol className="ds-sections">
                      {shown.sections.map((s) => (
                        <li key={s} dir="auto">
                          {s}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                {!asked && <p className="muted small">{plural(questions(mine).length, "question")} to go through</p>}
                {!asked && !!shown.suggestions?.length && <Suggestions design={shown} author={props.author && !disabled} />}
              </>
            )}
            {shown.role === "section" &&
              (parts.length > 1 ? (
                <div className="ds-parts">
                  {parts.map((p) => (
                    <section key={p.heading}>
                      <h1 dir="auto">
                        {p.heading} {p.stand && <Stand />}
                      </h1>
                      {p.lines.length > 0 && (
                        <ul className="ds-lines">
                          {p.lines.map((l, i) => (
                            <li key={i} dir="auto">
                              {l}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <>
                  <h1 dir="auto">
                    {page.title} {shown.stand && <Stand />}
                  </h1>
                  {parts[0]?.lines.length ? (
                    <ul className="ds-lines">
                      {parts[0].lines.map((l, i) => (
                        <li key={i} dir="auto">
                          {l}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">Open Full spec to go through this section.</p>
                  )}
                </>
              ))}
            {shown.role !== "verdict" && steps.length > 0 && (
              <div className="ds-questions" aria-label="Questions on this slide">
                <h2>{steps.length === 1 ? "Question" : "Questions"}</h2>
                {steps.map((q) => (
                  <Question key={q.id} item={q} open={q.id === asked?.id} onOpen={mayFlip && !disabled ? () => props.onGo(q.id) : undefined} />
                ))}
              </div>
            )}
            {design.role === "verdict" && (
              <>
                <h1 dir="auto">{design.spec}</h1>
                {questions(mine).length > 0 ? (
                  <ul className="ds-results">
                    {questions(mine).map((p) => {
                      const o = p.slide!.design!.outcome;
                      return (
                        <li key={p.id}>
                          <span className="dr-kind">{p.slide!.design!.name}</span>
                          {mayFlip && !disabled ? (
                            <button type="button" className="link" dir="auto" title="Go back to this question, for everyone" onClick={() => props.onGo(p.id)}>
                              {p.title}
                            </button>
                          ) : (
                            <span dir="auto">{p.title}</span>
                          )}
                          <span className={`ds-result ${o ? TONE[o] : ""}`}>{o ? designOutcomeLabel(o) : "Not called"}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted">No questions on this spec.</p>
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
              !caught.length && (
                <p className="muted small">What the team says here is filed under this {design.role === "verdict" ? "spec" : asked ? "question" : "slide"}.</p>
              )
            )}
            {props.onAdd && !disabled && <AddLine onAdd={props.onAdd} />}
          </aside>
        </div>
        {props.specOpen && (
          <div className="ds-spec-pane" role="dialog" aria-label="Full spec">
            <header>
              <strong dir="auto">{design.spec}</strong>
              <span className="muted small">Select a passage and comment to add a question to the call</span>
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
          Slide {pages.findIndex((s) => s.id === page.id) + 1} of {pages.length}
          {asked && ` · Question ${steps.findIndex((q) => q.id === asked.id) + 1} of ${steps.length}`}
        </span>
        {outcomes.length > 0 && (
          <div className="rv-outcomes" role="group" aria-label={design.role === "verdict" ? "The verdict on this spec" : "How this question ended"}>
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

/** A question on the slide. Closed, it is one line with how it ended; open, it shows the passage it
 *  is about and its thread. */
function Question({ item, open, onOpen }: { item: Item; open: boolean; onOpen?: () => void }) {
  const design = item.slide!.design!;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const result = design.outcome && <span className={`ds-result ${TONE[design.outcome]}`}>{designOutcomeLabel(design.outcome)}</span>;
  if (!open) {
    const line = (
      <>
        <span className="dr-kind">{design.name}</span>
        <span dir="auto">{item.title}</span>
        {result}
      </>
    );
    return onOpen ? (
      <button type="button" className="ds-q" onClick={onOpen} title="Open this question for everyone">
        {line}
      </button>
    ) : (
      <div className="ds-q">{line}</div>
    );
  }
  return (
    <div className="ds-q open" ref={box} aria-current="step">
      <div className="ds-q-head">
        <span className="dr-kind">{design.name}</span>
        {result}
      </div>
      <blockquote className="ds-passage" dir="auto">
        <Markdown text={design.quote ?? ""} />
      </blockquote>
      <Thread taskId={design.taskId} threadId={design.threadId!} question={item.slide?.body ?? ""} by={design.by ?? ""} />
    </div>
  );
}

const Stand = () => (
  <span className="dr-stand" title="Written by Stand from the spec. The author can rewrite it.">
    ✦ Stand
  </span>
);

/** The question as it was asked, and what people have answered on its thread since. */
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
                Ask the team
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
