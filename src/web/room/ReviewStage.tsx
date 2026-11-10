// A product review slide on the middle screen: the feature's picture, big, with who built it,
// how the slide ended (Ship, Ship with fixes, Not yet) and what the team said about it so far.
// The host flips slides and everyone follows; anyone can set the outcome.

import { useEffect, useRef, useState } from "react";
import { REVIEW_OUTCOMES, type Deck, type Item, type Note, type ReviewOutcome } from "../../shared/protocol.ts";
import { CloseIcon } from "../icons.tsx";
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
  // To-dos, decisions and open questions: the notes agent's other lines aren't something to act on.
  const caught = props.notes.filter((n) => n.itemId === item.id && KINDS.some((k) => k.kind === n.kind));
  const [open, setOpen] = useState<Note["kind"] | null>(null);
  useEffect(() => setOpen(null), [item.id]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [item.id]);
  const latest = caught.at(-1);
  const listed = open ? caught.filter((n) => n.kind === open) : [];

  return (
    <div className={`review-stage ${props.className ?? ""}`}>
      <div className="rv-pic">
        {shot ? (
          <button type="button" className="rv-shot" title="See it bigger" onClick={() => setZoomed(true)}>
            <img key={shot.url} src={shot.url} alt={shot.caption ?? item.title} />
          </button>
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
                {o.id === "fixes" ? (
                  <>
                    <span className="rv-wide">{o.label}</span>
                    <span className="rv-narrow" aria-hidden>
                      Fixes
                    </span>
                  </>
                ) : (
                  o.label
                )}
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
      {/* On a phone there's room under the picture, so what was caught is simply listed. */}
      <div className="rv-list">
        {caught.map((n) => {
          const Icon = KINDS.find((k) => k.kind === n.kind)?.Icon ?? TodoIcon;
          return (
            <p key={n.id} className={`${n.kind}${n.doneAt ? " done" : ""}`}>
              <Icon />
              <span dir="auto">{n.text}</span>
              {n.owner && <span className="rv-who">{n.owner.split(" ")[0]}</span>}
            </p>
          );
        })}
        {props.busy && (
          <p className="muted">
            <span className="agent-mark">✦</span> Writing
          </p>
        )}
      </div>
      {zoomed && shot && <ShotZoom url={shot.url} alt={shot.caption ?? item.title} onClose={() => setZoomed(false)} />}
    </div>
  );
}

const MAX_ZOOM = 5;

/** A slide's picture over the whole screen. Pinch or double tap to zoom, drag to move around. Yours alone. */
function ShotZoom({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  // Zooming keeps the middle of what's in view in the middle.
  const zoomTo = (next: number) => {
    const el = box.current;
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    if (el) {
      const cx = (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
      const cy = (el.scrollTop + el.clientHeight / 2) / el.scrollHeight;
      requestAnimationFrame(() => el.scrollTo(cx * el.scrollWidth - el.clientWidth / 2, cy * el.scrollHeight - el.clientHeight / 2));
    }
    setZoom(z);
  };
  return (
    <div className="rv-zoom" role="dialog" aria-modal="true" aria-label={alt}>
      <div
        ref={box}
        className="rv-zoom-box"
        onClick={(e) => e.target === e.currentTarget && onClose()}
        onDoubleClick={() => zoomTo(zoom > 1 ? 1 : 2.5)}
        onTouchStart={(e) => {
          if (e.touches.length === 2) pinch.current = { dist: dist(e.touches), zoom };
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 2 && pinch.current) zoomTo(pinch.current.zoom * (dist(e.touches) / pinch.current.dist));
        }}
        onTouchEnd={() => (pinch.current = null)}
      >
        <img src={url} alt={alt} style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: "none", maxHeight: "none" } : undefined} draggable={false} />
      </div>
      <button className="rv-zoom-close" aria-label="Close" onClick={onClose}>
        <CloseIcon size={18} />
      </button>
    </div>
  );
}
