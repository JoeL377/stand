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
  /** The host takes a line off that Stand got wrong, or adds one it missed. */
  onRemove?: (note: Note) => void;
  onAdd?: (kind: "action" | "decision" | "question", text: string) => void;
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
  // A capture that just arrived shows over the foot of the picture for a few seconds, so people
  // see Stand heard it without looking away from the slide. Not the ones already there on arrival.
  // A line is known by what it says, not its id: a notes run can hand the same line back under a new one.
  const seen = useRef<{ item: string; said: Set<string> } | null>(null);
  const [landed, setLanded] = useState<Note[]>([]);
  const caughtKey = caught.map(saidKey).join("\n");
  useEffect(() => {
    const before = seen.current;
    seen.current = { item: item.id, said: new Set([...(before?.item === item.id ? before.said : []), ...caught.map(saidKey)]) };
    if (!before || before.item !== item.id) return setLanded([]);
    const fresh = caught.filter((n, i) => !before.said.has(saidKey(n)) && caught.findIndex((x) => saidKey(x) === saidKey(n)) === i);
    if (!fresh.length) return;
    setLanded((l) => [...l, ...fresh].slice(-LANDED_MAX));
    const gone = new Set(fresh.map(saidKey));
    setTimeout(() => setLanded((l) => l.filter((n) => !gone.has(saidKey(n)))), LANDED_MS);
  }, [item.id, caughtKey]);
  // Setting how a slide ended opens what was caught on it, for everyone: the moment to fix the list before moving on.
  const outcomeSeen = useRef<{ item: string; outcome: ReviewOutcome | null } | null>(null);
  const [wrap, setWrap] = useState(false);
  const outcome = review?.outcome ?? null;
  useEffect(() => {
    const before = outcomeSeen.current;
    outcomeSeen.current = { item: item.id, outcome };
    if (!before || before.item !== item.id) return setWrap(false);
    if (before.outcome !== outcome) setWrap(Boolean(outcome));
  }, [item.id, outcome]);
  useEffect(() => {
    if (!wrap) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setWrap(false);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [wrap]);
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
        {!wrap && !open && landed.length > 0 && (
          <div className="rv-landed" aria-live="polite">
            {landed.map((n) => {
              const k = KINDS.find((x) => x.kind === n.kind)!;
              return (
                <p key={saidKey(n)} className={n.kind}>
                  <k.Icon />
                  <span className="rv-landed-kind">{k.label}</span>
                  <span dir="auto">{n.text}</span>
                  {n.owner && <span className="rv-who">{n.owner.split(" ")[0]}</span>}
                </p>
              );
            })}
          </div>
        )}
        {wrap && outcome && (
          <Wrap
            outcome={outcome}
            by={review?.outcomeBy ?? null}
            caught={caught}
            onRemove={disabled ? undefined : props.onRemove}
            onAdd={disabled ? undefined : props.onAdd}
            onClose={() => setWrap(false)}
          />
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
              {props.onRemove && !disabled && (
                <button className="rv-wrap-x" aria-label={`Remove "${n.text}"`} onClick={() => props.onRemove!(n)}>
                  <CloseIcon size={12} />
                </button>
              )}
            </p>
          );
        })}
        {props.busy && (
          <p className="muted">
            <span className="agent-mark">✦</span> Writing
          </p>
        )}
        {props.onAdd && !disabled && <AddLine onAdd={props.onAdd} />}
      </div>
      {zoomed && shot && <ShotZoom url={shot.url} alt={shot.caption ?? item.title} onClose={() => setZoomed(false)} />}
    </div>
  );
}

const saidKey = (n: Note) => `${n.kind}:${n.text.trim().toLowerCase()}`;
const LANDED_MS = 4500;
const LANDED_MAX = 3;

/** What was caught on a slide, opened when its outcome is set: the outcome, then every line by kind. */
function Wrap(props: {
  outcome: ReviewOutcome;
  by: string | null;
  caught: Note[];
  onRemove?: (note: Note) => void;
  onAdd?: (kind: "action" | "decision" | "question", text: string) => void;
  onClose: () => void;
}) {
  const label = REVIEW_OUTCOMES.find((o) => o.id === props.outcome)?.label;
  return (
    <div className="rv-wrap" role="dialog" aria-label={`${label}: what was caught on this slide`}>
      <div className="rv-wrap-head">
        <span className={`rv-wrap-outcome ${props.outcome}`}>{label}</span>
        {props.by && <span className="rv-who">{props.by.split(" ")[0]}</span>}
        <button className="rv-wrap-x" aria-label="Close" onClick={props.onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      {KINDS.map(({ kind: k, label: name, Icon }) => {
        const lines = props.caught.filter((n) => n.kind === k);
        if (!lines.length) return null;
        return (
          <div key={k} className={`rv-wrap-group ${k}`}>
            <h3>
              <Icon /> {name} <span className="count">{lines.length}</span>
            </h3>
            {lines.map((n) => (
              <p key={n.id} className={n.doneAt ? "done" : undefined}>
                <span dir="auto">{n.text}</span>
                {n.owner && <span className="rv-who">{n.owner.split(" ")[0]}</span>}
                {props.onRemove && (
                  <button className="rv-wrap-x" aria-label={`Remove "${n.text}"`} title="Remove" onClick={() => props.onRemove!(n)}>
                    <CloseIcon size={12} />
                  </button>
                )}
              </p>
            ))}
          </div>
        );
      })}
      {!props.caught.length && !props.onAdd && <p className="rv-wrap-none">Nothing caught on this slide</p>}
      {props.onAdd && <AddLine onAdd={props.onAdd} />}
    </div>
  );
}

/** The host writes in a line Stand missed: pick its kind, type, Enter. */
export function AddLine({ onAdd }: { onAdd: (kind: "action" | "decision" | "question", text: string) => void }) {
  const [kind, setKind] = useState<"action" | "decision" | "question">("action");
  const [text, setText] = useState("");
  return (
    <form
      className="rv-wrap-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd(kind, text.trim());
        setText("");
      }}
    >
      <div role="group" aria-label="What to add">
        {KINDS.map(({ kind: k, label: name, Icon }) => (
          <button key={k} type="button" className={kind === k ? "on" : undefined} aria-pressed={kind === k} title={name} aria-label={name} onClick={() => setKind(k)}>
            <Icon />
          </button>
        ))}
      </div>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "action" ? "Add a to-do" : kind === "decision" ? "Add a decision" : "Add an open question"} maxLength={500} enterKeyHint="done" />
    </form>
  );
}

const MAX_ZOOM = 5;

/** A slide's picture over the whole screen. Pinch or double tap to zoom, drag to move around. Yours alone. */
export function ShotZoom({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
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
