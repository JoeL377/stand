// "Since last time": what the middle shows when a meeting starts with tasks still open from earlier
// ones. Grouped by owner, oldest first, each with Done, Still on it and Drop. What closed on its own
// since the last meeting (a merged PR, an agent's report) sits at the top already ticked, for a
// glance. Stand listens while people go through it: a task someone says they finished gets a Said
// done pill (server/liveList.ts) and its Done button lights up. Answered rows stay in place, muted,
// with Undo, until the list is through; then, or when someone presses Move on, the topic card takes over.
import type { FollowUp } from "../../shared/protocol.ts";
import { ClosedPill, SaidDonePill } from "../TaskMarks.tsx";
import { useWork } from "../WorkLog.tsx";
import { colorFor } from "../util.ts";
import { Face } from "../RecapChapters.tsx";

/** With the topic card up this long and nobody answering, the check-in gives the middle back. */
export const CHECKIN_IDLE_MS = 3 * 60_000;

export interface CheckInActs {
  onState: (noteId: string, state: "done" | "dropped" | "open", still?: boolean) => void;
  onUndoSaid: (noteId: string) => void;
  onClose: () => void;
  onOpen: () => void;
}

/** Carried tasks nobody has answered on in this meeting. */
export const unanswered = (followUps: FollowUp[], meetingStartedAt: number) =>
  followUps.filter((f) => !f.doneAt && !((f.checkedAt ?? 0) >= meetingStartedAt));

/** Whether the middle shows the check-in now. */
export function showCheckIn(p: {
  followUps: FollowUp[];
  meetingStartedAt: number;
  checkIn?: { closed: boolean; answeredAt: number | null };
  /** When the first topic card came up; null before. */
  cardSince: number | null;
  now: number;
}): boolean {
  if (p.checkIn?.closed || !unanswered(p.followUps, p.meetingStartedAt).length) return false;
  if (p.cardSince === null) return true;
  return p.now - Math.max(p.cardSince, p.checkIn?.answeredAt ?? 0) < CHECKIN_IDLE_MS;
}

const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });

/** The tasks the check-in lists: still open, or answered on in this meeting. */
export const checkInRows = (followUps: FollowUp[], meetingStartedAt: number) => followUps.filter((f) => !f.doneAt || f.doneAt >= meetingStartedAt);

/** embedded: a page of the opening board (Opener.tsx), which has the header and shows what closed since. */
export function CheckIn(props: { followUps: FollowUp[]; meetingStartedAt: number; acts: CheckInActs | null; embedded?: boolean }) {
  const start = props.meetingStartedAt;
  const work = useWork(props.followUps.filter((f) => !f.doneAt).map((f) => f.id));
  // Closed between the last meeting and this one: news to glance at.
  const news = props.embedded ? [] : props.followUps.filter((f) => f.doneAt && f.doneAt < start);
  // Everything still to talk about, and what people answered on here (muted, with Undo).
  const here = checkInRows(props.followUps, start);
  const left = unanswered(props.followUps, start).length;
  const groups = new Map<string, FollowUp[]>();
  for (const f of here) {
    const k = f.owner?.split(" ")[0] ?? "";
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  // Owners in the order of their oldest open task; nobody's last.
  const owners = [...groups.keys()].sort((a, b) => (a === "") !== (b === "") ? (a === "" ? 1 : -1) : groups.get(a)![0].ts - groups.get(b)![0].ts);
  const acts = props.acts;
  return (
    <section className={props.embedded ? "checkin embedded" : "checkin"} aria-label="Since last time">
      {!props.embedded && (
        <header className="checkin-head">
          <h2>Since last time</h2>
          <span className="checkin-count">{left} to check</span>
          {acts && (
            <button type="button" className="checkin-close" onClick={acts.onClose}>
              Move on
            </button>
          )}
        </header>
      )}
      {news.length > 0 && (
        <ul className="checkin-rows news" aria-label="Closed since the last meeting">
          {news.map((f) => (
            <li key={f.id} className="checkin-row closed">
              <span className="checkin-tick" aria-hidden>
                ✓
              </span>
              <span className="checkin-text">{f.text}</span>
              <ClosedPill note={f} />
              {f.owner && <Face name={f.owner} color={colorFor(f.owner)} size={18} />}
              {acts && (
                <button type="button" className="checkin-btn quiet" onClick={() => acts.onState(f.id, "open")}>
                  Reopen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {owners.map((o) => (
        <div key={o || "nobody"} className="checkin-group">
          <h3>
            {o ? <Face name={o} color={colorFor(o)} size={18} /> : <span className="rc-face none">?</span>}
            {o || "No owner"}
          </h3>
          <ul className="checkin-rows">
            {groups.get(o)!.map((f) => {
              const still = (f.checkedAt ?? 0) >= start && !f.doneAt;
              const answered = !!f.doneAt || still;
              const ready = work[f.id]?.ready;
              const lit = !!f.saidDone || !!ready;
              return (
                <li key={f.id} className={answered ? "checkin-row answered" : "checkin-row"}>
                  <span className="checkin-text">{f.text}</span>
                  {f.saidDone && !answered && <SaidDonePill quote={f.saidDone} onUndo={acts ? () => acts.onUndoSaid(f.id) : undefined} />}
                  {ready && !answered && (
                    <a className="rc-pill task-ready" href={ready.pr ?? undefined} target="_blank" rel="noreferrer" title={ready.text}>
                      Ready to ship
                    </a>
                  )}
                  <span className="checkin-at">{day(f.meetingStartedAt)}</span>
                  {answered ? (
                    <>
                      <span className="checkin-answer">{f.state === "dropped" ? "Dropped" : f.doneAt ? "Done" : "Still on it"}</span>
                      {acts && (
                        <button type="button" className="checkin-btn quiet" onClick={() => acts.onState(f.id, "open")}>
                          Undo
                        </button>
                      )}
                    </>
                  ) : (
                    acts && (
                      <span className="checkin-btns">
                        <button type="button" className={lit ? "checkin-btn lit" : "checkin-btn"} onClick={() => acts.onState(f.id, "done")}>
                          Done
                        </button>
                        <button type="button" className="checkin-btn" onClick={() => acts.onState(f.id, "open", true)}>
                          Still on it
                        </button>
                        <button type="button" className="checkin-btn" onClick={() => acts.onState(f.id, "dropped")}>
                          Drop
                        </button>
                      </span>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
