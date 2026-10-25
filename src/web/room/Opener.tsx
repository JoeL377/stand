// The opening board: what the space got done since its last meeting, as pages Claude laid out ahead of
// time (server/doneDeck.ts), then the "Since last time" check-in on what's still open as the last page.
// Anyone on the call turns the pages, for everyone (arrow keys too). Move on, or the topic card being up
// a while with nobody turning or answering, gives the middle back; going through the check-in does too.
import { useEffect } from "react";
import type { DoneDeck, DoneSlide, FollowUp } from "../../shared/protocol.ts";
import { CHECKIN_IDLE_MS, CheckIn, type CheckInActs, checkInRows, unanswered } from "./CheckIn.tsx";
import { colorFor } from "../util.ts";
import { Face } from "../RecapChapters.tsx";

export interface OpenerActs extends CheckInActs {
  onPage: (page: number) => void;
}

type CheckInState = { closed: boolean; answeredAt: number | null; page?: number };

const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });

/** How many pages the opening board has: the done pages, and the check-in when anything carried over. */
export function openerPages(deck: DoneDeck | null | undefined, followUps: FollowUp[], meetingStartedAt: number) {
  const done = deck?.slides.length ?? 0;
  return { done, checkIn: checkInRows(followUps, meetingStartedAt).length > 0 };
}

/** Whether the middle shows the opening board now. */
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

export function Opener(props: {
  deck: DoneDeck | null | undefined;
  followUps: FollowUp[];
  meetingStartedAt: number;
  page: number;
  acts: OpenerActs | null;
}) {
  const { deck, acts } = props;
  const { done, checkIn } = openerPages(deck, props.followUps, props.meetingStartedAt);
  const total = done + (checkIn ? 1 : 0);
  const page = Math.max(0, Math.min(props.page, total - 1));
  const onCheckIn = page >= done;
  const left = unanswered(props.followUps, props.meetingStartedAt).length;
  const last = page === total - 1;

  useEffect(() => {
    if (!acts || total < 2) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight" && page < total - 1) acts.onPage(page + 1);
      else if (e.key === "ArrowLeft" && page > 0) acts.onPage(page - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [acts, page, total]);

  return (
    <section className="checkin opener" aria-label={onCheckIn ? "Since last time" : "Done since last time"}>
      <header className="checkin-head">
        {onCheckIn ? (
          <>
            <h2>Still open</h2>
            <span className="checkin-count">{left} to check</span>
          </>
        ) : (
          <>
            <h2>
              {deck!.by === "claude" && (
                <span className="agent-mark small" aria-hidden>
                  ✦{" "}
                </span>
              )}
              Done since {day(deck!.sinceStartedAt)}
            </h2>
            <span className="checkin-count">
              {deck!.closed} closed{deck!.dropped ? ` · ${deck!.dropped} dropped` : ""}
            </span>
          </>
        )}
        {total > 1 && (
          <nav className="opener-pager" aria-label="Pages">
            <button type="button" className="opener-arrow" disabled={!acts || page === 0} onClick={() => acts?.onPage(page - 1)} aria-label="Previous page">
              ‹
            </button>
            {Array.from({ length: total }, (_, i) => (
              <button
                key={i}
                type="button"
                className={["opener-dot", i === page && "on", i >= done && "open"].filter(Boolean).join(" ")}
                disabled={!acts}
                onClick={() => acts?.onPage(i)}
                aria-label={i >= done ? "Still open" : `Page ${i + 1}: ${deck!.slides[i].title}`}
                aria-current={i === page ? "page" : undefined}
                title={i >= done ? "Still open" : deck!.slides[i].title}
              />
            ))}
            <button type="button" className="opener-arrow" disabled={!acts || last} onClick={() => acts?.onPage(page + 1)} aria-label="Next page">
              ›
            </button>
          </nav>
        )}
        {acts && (
          <button type="button" className="checkin-close" onClick={acts.onClose}>
            Move on
          </button>
        )}
      </header>
      {onCheckIn ? (
        <CheckIn followUps={props.followUps} meetingStartedAt={props.meetingStartedAt} acts={acts} embedded />
      ) : (
        <Slide key={page} s={deck!.slides[page]} />
      )}
      {!onCheckIn && acts && last && (
        <button type="button" className="opener-next" onClick={acts.onClose}>
          Move on →
        </button>
      )}
      {!onCheckIn && acts && !last && (
        <button type="button" className="opener-next" onClick={() => acts.onPage(page + 1)}>
          {page + 1 === done ? `Still open · ${left} →` : `${deck!.slides[page + 1].title} →`}
        </button>
      )}
    </section>
  );
}

function Slide({ s }: { s: DoneSlide }) {
  return (
    <div className="done-slide">
      <h3 className="done-title">{s.title}</h3>
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
        <a className="done-shot" href={s.shot.url} target="_blank" rel="noreferrer" title={s.shot.caption ?? undefined}>
          <img src={s.shot.url} alt={s.shot.caption ?? "Screenshot"} />
        </a>
      )}
    </div>
  );
}
