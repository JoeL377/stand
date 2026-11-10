// A product review slide on the middle screen: the feature's picture, big, with who built it,
// how the slide ended (Ship, Ship with fixes, Not yet) and what the team said about it so far.
// The host flips slides and everyone follows; anyone can set the outcome.

import { useEffect, useState } from "react";
import { REVIEW_OUTCOMES, type Deck, type Item, type Note, type ReviewOutcome } from "../../shared/protocol.ts";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { NativeSlide } from "../slides.tsx";

const KINDS = [
  { kind: "action", label: "To do", Icon: TodoIcon },
  { kind: "decision", label: "Decided", Icon: DecidedIcon },
  { kind: "question", label: "Open", Icon: QuestionIcon },
] as const;

const prLabel = (url: string) => {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : "Link";
};

export function ReviewStage(props: {
  item: Item;
  deck: Deck | undefined;
  /** Where this slide is in the review, from 0, and how many there are. */
  index: number;
  count: number;
  /** What the meeting has caught so far, on any item. */
  notes: Note[];
  /** The notes for this slide are being written right now. */
  busy: boolean;
  canSteer: boolean;
  disabled: boolean;
  /** The picture the host has up, and choosing another. */
  shot: number;
  onShot: (i: number) => void;
  onFlip: (delta: number) => void;
  onOutcome: (outcome: ReviewOutcome | null) => void;
  className?: string;
}) {
  const { item, deck, index, count, canSteer, disabled } = props;
  const review = item.slide?.review;
  const shots = review?.shots ?? [];
  const shot = shots[Math.min(props.shot, shots.length - 1)] ?? null;
  const caught = props.notes.filter((n) => n.itemId === item.id);
  const [open, setOpen] = useState<Note["kind"] | null>(null);
  useEffect(() => setOpen(null), [item.id]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const latest = caught.at(-1);
  const listed = open ? caught.filter((n) => n.kind === open) : [];

  return (
    <div className={`review-stage ${props.className ?? ""}`}>
      <div className="rv-pic">
        {shot ? (
          <img key={shot.url} src={shot.url} alt={shot.caption ?? item.title} />
        ) : (
          <NativeSlide deckId={item.deckId!} theme={deck?.theme ?? "paper"} title={item.title} slide={item.slide!} className="slide-main" />
        )}
        {shots.length > 1 && (
          <div className="rv-strip" role="tablist" aria-label="Pictures of this feature">
            {shots.map((s, i) => (
              <button
                key={s.url}
                type="button"
                role="tab"
                aria-selected={s === shot}
                className={s === shot ? "on" : undefined}
                title={s.caption ?? `Picture ${i + 1}`}
                onClick={() => props.onShot(i)}
              >
                <img src={s.url} alt="" />
              </button>
            ))}
          </div>
        )}
        {open && (
          <div className="rv-caught-pop" role="dialog" aria-label={KINDS.find((k) => k.kind === open)?.label}>
            {listed.map((n) => (
              <p key={n.id} className={n.doneAt ? "done" : undefined}>
                <span dir="auto">{n.text}</span>
                {n.owner && <span className="rv-who">{n.owner.split(" ")[0]}</span>}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="rv-meta">
        {review?.owner && <span className="rv-owner">{review.owner}</span>}
        {shot && (item.slide?.body || shot.caption) && (
          <span className="rv-summary" dir="auto" title={item.slide?.body || shot.caption || undefined}>
            {item.slide?.body || shot.caption}
          </span>
        )}
        {review?.pr && (
          <a className="rv-pr" href={review.pr} target="_blank" rel="noreferrer">
            {prLabel(review.pr)}
          </a>
        )}
      </div>
      <div className="rv-caught">
        {KINDS.map(({ kind, label, Icon }) => {
          const n = caught.filter((x) => x.kind === kind).length;
          return (
            <button key={kind} type="button" className={`rv-count${open === kind ? " on" : ""}`} disabled={!n} aria-expanded={open === kind} onClick={() => setOpen(open === kind ? null : kind)}>
              <Icon />
              {label} <span className="count">{n}</span>
            </button>
          );
        })}
        {props.busy ? (
          <span className="rv-latest muted">
            <span className="agent-mark">✦</span> Writing
          </span>
        ) : (
          latest && (
            <span className="rv-latest" dir="auto" title={latest.text}>
              <span className="agent-mark">✦</span> {latest.text}
            </span>
          )
        )}
      </div>
      <div className="slide-bar rv-bar">
        {canSteer && (
          <button className="ghost" onClick={() => props.onFlip(-1)} disabled={disabled || index <= 0} aria-label="Previous slide">
            ←
          </button>
        )}
        <span className="muted small rv-pos">
          {index + 1} of {count}
        </span>
        <div className="rv-outcomes" role="group" aria-label="How this slide ended">
          {REVIEW_OUTCOMES.map((o) => {
            const on = review?.outcome === o.id;
            return (
              <button
                key={o.id}
                type="button"
                className={`rv-outcome ${o.id}${on ? " on" : ""}`}
                aria-pressed={on}
                disabled={disabled}
                title={on && review?.outcomeBy ? `${review.outcomeBy} said so. Click to take it back` : undefined}
                onClick={() => props.onOutcome(on ? null : o.id)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {canSteer && (
          <button className="ghost" onClick={() => props.onFlip(1)} disabled={disabled || index < 0 || index >= count - 1} aria-label="Next slide">
            →
          </button>
        )}
      </div>
    </div>
  );
}
