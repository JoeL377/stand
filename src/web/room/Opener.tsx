// The Kickoff card: the meeting's first card on the board. It's built like a topic card: what the space
// got done since its last meeting, with Claude's opening line and its pages as the card's tabs (written
// ahead of time, server/doneDeck.ts), and the "Since last time" check-in on what's still open as the last
// tab. Anyone on the call switches tabs, for everyone (arrow keys too). When the talk has a topic of its
// own the card offers it the way the board offers a move ("Looks like you've moved to …"); a click, Move
// on, or that topic being up a while with nobody on the card hands the middle to it. It stays on the
// chapter bar as the Kickoff chapter, so anyone can look back at it on their own screen.
// In the meeting's card list the done pages and the check-in are two cards ("Done since" and "Still open
// from earlier", the part prop); the space page's pop-up shows them together.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DoneDeck, DoneSlide, FollowUp, Snap } from "../../shared/protocol.ts";
import { SnapGallery } from "../Snaps.tsx";
import { CHECKIN_IDLE_MS, CheckIn, type CheckInActs, checkInRows, unanswered } from "./CheckIn.tsx";
import { colorFor } from "../util.ts";
import { Face } from "../RecapChapters.tsx";

export interface OpenerActs extends CheckInActs {
  onPage: (page: number) => void;
}

type CheckInState = {
  closed: boolean;
  answeredAt: number | null;
  page?: number;
  closedAt?: number | null;
  held?: boolean;
};

const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });

/** The Kickoff card's tabs: the done pages, and the check-in when anything carried over. */
export function openerPages(deck: DoneDeck | null | undefined, followUps: FollowUp[], meetingStartedAt: number) {
  const done = deck?.slides.length ?? 0;
  return { done, checkIn: checkInRows(followUps, meetingStartedAt).length > 0 };
}

/** Whether the meeting has a Kickoff card at all. */
export const hasKickoff = (deck: DoneDeck | null | undefined, followUps: FollowUp[], meetingStartedAt: number) =>
  !!deck?.slides.length || unanswered(followUps, meetingStartedAt).length > 0 || checkInRows(followUps, meetingStartedAt).length > 0;

/** Whether the middle shows the Kickoff card now. */
export function showOpener(p: {
  deck: DoneDeck | null | undefined;
  followUps: FollowUp[];
  meetingStartedAt: number;
  checkIn?: CheckInState;
  /** When the first topic card came up; null before. */
  cardSince: number | null;
  now: number;
}): boolean {
  if (p.checkIn?.closed) return false;
  // Brought back on purpose: up until someone moves on again.
  if (p.checkIn?.held) return hasKickoff(p.deck, p.followUps, p.meetingStartedAt);
  const { done } = openerPages(p.deck, p.followUps, p.meetingStartedAt);
  const left = unanswered(p.followUps, p.meetingStartedAt).length;
  // Nothing to show, or the check-in at the end is through.
  if (!left && (!done || (p.checkIn?.page ?? 0) >= done)) return false;
  if (p.cardSince === null) return true;
  return p.now - Math.max(p.cardSince, p.checkIn?.answeredAt ?? 0) < CHECKIN_IDLE_MS;
}

/** Where the Kickoff chapter ends on the bar: null while it's on screen. */
export function kickoffEnd(p: Parameters<typeof showOpener>[0]): number | null {
  if (showOpener(p)) return null;
  if (p.checkIn?.closedAt) return p.checkIn.closedAt;
  const answered = p.checkIn?.answeredAt ?? 0;
  // Through the check-in: when the last answer came. Left alone: when the idle rule gave the middle back.
  if (!unanswered(p.followUps, p.meetingStartedAt).length && answered) return answered;
  return Math.min(p.now, Math.max(p.cardSince ?? p.meetingStartedAt, answered) + CHECKIN_IDLE_MS);
}

export function Opener(props: {
  deck: DoneDeck | null | undefined;
  followUps: FollowUp[];
  meetingStartedAt: number;
  page: number;
  acts: OpenerActs | null;
  /** The topic the talk has moved to, once there is one: offered at the card's foot. */
  next?: string | null;
  /** Opened from the chapter bar: tabs switch on this screen only, nothing can be answered. */
  rewound?: boolean;
  /** The card's label; the space page's pop-up calls it "Done since". */
  label?: string;
  /** Opened from the board after it moved on: puts it back on everyone's board, on this page. */
  onShowAll?: (page: number) => void;
  /** In the meeting's card list the done pages and the check-in are cards of their own: which this is.
   *  Turning past the end of one goes on to the other (page numbers count across both). */
  part?: "done" | "checkin";
  /** The "Done since" card when nothing closed: when the last meeting started. */
  since?: number | null;
}) {
  const { deck, acts } = props;
  const { done, checkIn } = openerPages(deck, props.followUps, props.meetingStartedAt);
  const all = done + (checkIn ? 1 : 0);
  // The pages this card shows, [lo, hi); live, turning goes on across both cards.
  const lo = props.part === "checkin" ? done : 0;
  const hi = props.part === "done" ? done : all;
  const total = hi - lo;
  const empty = props.part === "done" && !done;
  const page = Math.max(lo, Math.min(props.page, hi - 1));
  const onCheckIn = page >= done;
  const left = unanswered(props.followUps, props.meetingStartedAt).length;
  const slide = onCheckIn ? null : deck!.slides[page];
  const card = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const [first, last] = acts && !props.rewound ? [0, all - 1] : [lo, hi - 1];
  const turn = acts && !empty ? (to: number) => to >= first && to <= last && to !== page && acts.onPage(to) : null;
  const label = props.label ?? (props.part === "done" ? "Done since" : props.part === "checkin" ? "Since last time" : "Kickoff");
  const sinceAt = deck?.sinceStartedAt ?? props.since ?? null;
  const titleOf = (i: number) => (i < done ? deck!.slides[i].title : "Still open");
  // On a phone the pages turn with a swipe, like a deck; the tabs' own sideways scroll is left alone.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipe.current = e.touches.length === 1 && !(e.target as HTMLElement).closest(".opener-tabs, .done-shot") ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const from = swipe.current;
    swipe.current = null;
    const t = e.changedTouches[0];
    if (!from || !turn || !t) return;
    const dx = t.clientX - from.x;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(t.clientY - from.y)) turn(dx < 0 ? page + 1 : page - 1);
  };
  // The tab on screen stays in view when the strip is wider than the card.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = strip.current?.querySelector<HTMLElement>(".on");
    if (on && strip.current)
      strip.current.scrollTo({
        left: on.offsetLeft - (strip.current.clientWidth - on.offsetWidth) / 2,
        behavior: "smooth",
      });
  }, [page]);

  useEffect(() => {
    if (!turn || last - first < 1) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      // A screenshot open in the pop-up has the arrow keys (the card can sit in a pop-up of its own).
      const pops = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const top = pops[pops.length - 1];
      if (top && !top.contains(card.current)) return;
      if (e.key === "ArrowRight" && page < last) turn(page + 1);
      else if (e.key === "ArrowLeft" && page > first) turn(page - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [acts, page, first, last, empty]);

  const closed = deck && props.part !== "checkin" ? `${deck.closed} closed${deck.dropped ? ` · ${deck.dropped} dropped` : ""}` : null;
  return (
    <section
      ref={card}
      className={`topic-now opener${props.part ? ` ${props.part}` : ""}${props.rewound ? " rewound" : ""}${page > 0 ? " later" : ""}`}
      aria-label={label}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="topic-now-head">
        <span className={props.rewound ? "topic-now-label" : "topic-now-label live"}>{label}</span>
        {sinceAt !== null && props.part !== "checkin" && <span className="topic-mins opener-since">since {day(sinceAt)}</span>}
        {closed && <span className="topic-mins opener-count">{closed}</span>}
        {props.part === "done" && checkIn && acts && !props.rewound && page >= done - 1 && (
          // On a desk the pager is phone-only: the last done page hands on to the check-in card, for everyone.
          <button type="button" className="opener-close opener-on" onClick={() => acts.onPage(done)} title="Turn everyone's board to what's still open from earlier">
            Still open ({left}) →
          </button>
        )}
        {acts &&
          !props.rewound &&
          // Once the talk has a topic of its own, Move on becomes the board's offer to switch to it.
          (props.next ? (
            <button type="button" className="topic-moving opener-next" onClick={acts.onClose} title="Switch the board to it now, for everyone">
              <span className="agent-mark" aria-hidden>
                ✦
              </span>{" "}
              Looks like you've moved to <strong>{props.next}</strong>
              <span className="topic-moving-go" aria-hidden>
                Switch →
              </span>
            </button>
          ) : (
            <button type="button" className="opener-close" onClick={acts.onClose}>
              Move on
            </button>
          ))}
        {props.rewound && props.onShowAll && (
          <button type="button" className="opener-close" onClick={() => props.onShowAll!(page)} title="Put it back on everyone's board">
            Show everyone
          </button>
        )}
      </div>
      <h2 className="topic-now-title">{props.part === "checkin" ? "Still open from earlier" : sinceAt !== null ? `Since ${day(sinceAt)}` : "Since last time"}</h2>
      {empty && <p className="topic-summary">Nothing was closed since the last meeting.</p>}
      {deck && props.part !== "checkin" && (
        // In a meeting on a phone the opening line keeps to two lines until it's tapped.
        <p className={props.label || full ? "topic-summary" : "topic-summary clamped"} onClick={() => setFull(true)}>
          {deck.by === "claude" && (
            <>
              <span className="agent-mark" aria-hidden>
                ✦
              </span>{" "}
            </>
          )}
          {deck.summary ?? `${deck.closed} ${deck.closed === 1 ? "task" : "tasks"} closed since the last meeting.`}
        </p>
      )}
      <div className="topic-tabs-wrap">
        {total > 1 && (
          <div ref={strip} className="topic-tabs opener-tabs" role="tablist" aria-label={`${label} pages`}>
            {Array.from({ length: total }, (_, j) => {
              const i = lo + j;
              const s = i < done ? deck!.slides[i] : null;
              return (
                <button key={i} type="button" role="tab" aria-selected={i === page} className={i === page ? "on" : undefined} disabled={!acts} onClick={() => acts?.onPage(i)}>
                  {titleOf(i)}
                  <span className="topic-tab-count">{s ? s.points.length : left}</span>
                </button>
              );
            })}
          </div>
        )}
        {total > 1 && (
          // On a phone the tabs give way to a deck's steps and the page's title.
          <div className="opener-steps" aria-hidden>
            {Array.from({ length: total }, (_, j) => (
              <span key={j} className={lo + j <= page ? "on" : undefined} />
            ))}
          </div>
        )}
        {total > 1 && <h3 className="opener-page-title">{titleOf(page)}</h3>}
        {!empty && (
          <div role="tabpanel" className="topic-tab-panel">
            {slide ? (
              <Slide key={page} s={slide} at={deck!.at} />
            ) : (
              <CheckIn followUps={props.followUps} meetingStartedAt={props.meetingStartedAt} acts={props.rewound ? null : acts} embedded />
            )}
          </div>
        )}
        {last > first && turn && (
          <div className="opener-pager">
            <button type="button" className="opener-back" aria-label="Previous page" disabled={page === first} onClick={() => turn(page - 1)}>
              ‹
            </button>
            {page < last ? (
              <button type="button" className="opener-fwd" onClick={() => turn(page + 1)}>
                <span className="opener-fwd-next">Next</span> {titleOf(page + 1)} ›
              </button>
            ) : (
              <span className="opener-fwd last">
                {page - first + 1} of {last - first + 1}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** A page's screenshot as the snap pop-up shows one. */
const asSnap = (shot: NonNullable<DoneSlide["shot"]>, at: number): Snap => ({
  id: shot.url,
  meetingId: null,
  itemId: null,
  itemSuggested: false,
  // Pages written before screenshots carried who and when: when the pages were written.
  ts: shot.ts ?? at,
  url: shot.url,
  width: 0,
  height: 0,
  source: "person",
  takenById: null,
  takenBy: shot.by ?? "Attached to a task",
  sharerId: null,
  sharerName: null,
  caption: shot.caption,
  line: null,
  screenText: null,
  noteId: null,
  discussionId: null,
  segmentIds: [],
});

/** One page of what got done: its lead, its lines, and the screenshot it picked. */
export function Slide({ s, at }: { s: DoneSlide; at: number }) {
  const [viewing, setViewing] = useState(false);
  return (
    <div className="done-slide">
      {s.lead && <p className="done-lead">{s.lead}</p>}
      <ul className="done-points">
        {s.points.map((p, i) => {
          const pr = p.pr ? /\/pull\/(\d+)/.exec(p.pr)?.[1] : null;
          return (
            <li key={i} className={p.dropped ? "done-point dropped" : "done-point"}>
              <span className="checkin-tick" aria-hidden>
                {p.dropped ? "–" : "✓"}
              </span>
              <span className="done-text">{p.text}</span>
              {p.dropped && <span className="rc-pill">Dropped</span>}
              {p.pr && (
                <a className="rc-pill" href={p.pr} target="_blank" rel="noreferrer">
                  {pr ? `#${pr}` : "PR"}
                </a>
              )}
              {/* By first name, like the check-in's groups, so a person has the same face on every page. */}
              {p.who && <Face name={p.who.split(" ")[0]} color={colorFor(p.who.split(" ")[0])} size={20} />}
            </li>
          );
        })}
      </ul>
      {s.shot && (
        // Opens in the snap pop-up, like a work log's screenshots; a middle-click still opens a tab.
        <a
          className="done-shot"
          href={s.shot.url}
          target="_blank"
          rel="noreferrer"
          title={s.shot.caption ?? undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            setViewing(true);
          }}
        >
          <img src={s.shot.url} alt={s.shot.caption ?? "Screenshot"} />
        </a>
      )}
      {/* On the page's body, so it sits over a pop-up the page is in too. */}
      {viewing && s.shot && createPortal(<SnapGallery snaps={[asSnap(s.shot, at)]} me="" isHost={false} onClose={() => setViewing(false)} />, document.body)}
    </div>
  );
}
