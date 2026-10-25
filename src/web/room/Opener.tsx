// The Kickoff card: the meeting's first card on the board. It's built like a topic card: what the space
// got done since its last meeting, with Claude's opening line and its pages as the card's tabs (written
// ahead of time, server/doneDeck.ts), and the "Since last time" check-in on what's still open as the last
// tab. Anyone on the call switches tabs, for everyone (arrow keys too). When the talk has a topic of its
// own the card offers it the way the board offers a move ("Looks like you've moved to …"); a click, Move
// on, or that topic being up a while with nobody on the card hands the middle to it. It stays on the
// chapter bar as the Kickoff chapter, so anyone can look back at it on their own screen.
import { useEffect, useState } from "react";
import type { DoneDeck, DoneSlide, FollowUp, Snap } from "../../shared/protocol.ts";
import { SnapGallery } from "../Snaps.tsx";
import { CHECKIN_IDLE_MS, CheckIn, type CheckInActs, checkInRows, unanswered } from "./CheckIn.tsx";
import { colorFor } from "../util.ts";
import { Face } from "../RecapChapters.tsx";

export interface OpenerActs extends CheckInActs {
  onPage: (page: number) => void;
}

type CheckInState = { closed: boolean; answeredAt: number | null; page?: number; closedAt?: number | null };

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
}) {
  const { deck, acts } = props;
  const { done, checkIn } = openerPages(deck, props.followUps, props.meetingStartedAt);
  const total = done + (checkIn ? 1 : 0);
  const page = Math.max(0, Math.min(props.page, total - 1));
  const onCheckIn = page >= done;
  const left = unanswered(props.followUps, props.meetingStartedAt).length;
  const slide = onCheckIn ? null : deck!.slides[page];

  useEffect(() => {
    if (!acts || total < 2) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      // A screenshot open in the pop-up has the arrow keys.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "ArrowRight" && page < total - 1) acts.onPage(page + 1);
      else if (e.key === "ArrowLeft" && page > 0) acts.onPage(page - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [acts, page, total]);

  const closed = deck ? `${deck.closed} closed${deck.dropped ? ` · ${deck.dropped} dropped` : ""}` : null;
  return (
    <section className={props.rewound ? "topic-now opener rewound" : "topic-now opener"} aria-label="Kickoff">
      <div className="topic-now-head">
        <span className={props.rewound ? "topic-now-label" : "topic-now-label live"}>Kickoff</span>
        {closed && <span className="topic-mins">{closed}</span>}
        {acts && !props.rewound &&
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
      </div>
      <h2 className="topic-now-title">{deck ? `Since ${day(deck.sinceStartedAt)}` : "Since last time"}</h2>
      {deck && (
        <p className="topic-summary">
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
          <div className="topic-tabs opener-tabs" role="tablist" aria-label="Kickoff pages">
            {Array.from({ length: total }, (_, i) => {
              const s = i < done ? deck!.slides[i] : null;
              return (
                <button key={i} type="button" role="tab" aria-selected={i === page} className={i === page ? "on" : undefined} disabled={!acts} onClick={() => acts?.onPage(i)}>
                  {s ? s.title : "Still open"}
                  <span className="topic-tab-count">{s ? s.points.length : left}</span>
                </button>
              );
            })}
          </div>
        )}
        <div role="tabpanel" className="topic-tab-panel">
          {slide ? (
            <Slide key={page} s={slide} at={deck!.at} />
          ) : (
            <CheckIn followUps={props.followUps} meetingStartedAt={props.meetingStartedAt} acts={props.rewound ? null : acts} embedded />
          )}
        </div>
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
      {viewing && s.shot && <SnapGallery snaps={[asSnap(s.shot, at)]} me="" isHost={false} onClose={() => setViewing(false)} />}
    </div>
  );
}
