import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { SpaceFeed } from "../shared/protocol.ts";
import { ChevronIcon, EditIcon } from "./icons.tsx";
import { addDays, hourRange, isShortCall, layoutDay, midnight, viewDays, viewTitle, weekStart } from "./meetingList.ts";
import { enter } from "./motion.ts";
import { useDismiss } from "./useDismiss.ts";
import { fmtTime } from "./util.ts";

type Meeting = SpaceFeed["meetings"][number];
type Kind = { name: string; open: string; to: string };

const WEEKDAY = new Intl.DateTimeFormat([], { weekday: "short" });
const HOUR_LABEL = new Intl.DateTimeFormat([], { hour: "numeric" });

/**
 * The color family a meeting's block takes, from what kind of call it was, or else from its name
 * when that says it ("Brainstorm: …", "Product review with …").
 */
export const tone = (kind: Kind | undefined, name: string) => {
  const k = (kind?.name ?? name).toLowerCase();
  if (k.startsWith("product review")) return "review";
  if (k.startsWith("idea review")) return "idea";
  if (k.startsWith("design review")) return "design";
  if (k.startsWith("brainstorm") || k.startsWith("design session")) return "brainstorm";
  return "meeting";
};

/**
 * The space's meetings as a calendar, the way people already read their week: days across, hours
 * down, each meeting a block as tall as it ran. A week on a big screen, three days on a phone.
 * Notes and snaps from the bar wait behind a small count on their day.
 */
export function MeetingCalendar(props: {
  meetings: Meeting[];
  kindOf: Map<string, Kind>;
  madeIn: Map<string, number>;
  phone: boolean;
  /** How many notes and snaps a day has, and their rows for its pop-up. */
  notesOn: (day: number) => number;
  renderNotes: (day: number) => React.ReactNode;
}) {
  const { meetings, kindOf, madeIn, phone } = props;
  const count = phone ? 3 : 7;
  const home = () => (phone ? addDays(midnight(Date.now()), -2) : weekStart(Date.now()));
  const [start, setStart] = useState(home);
  // A phone turning into a wide window (or back) starts again from today.
  useEffect(() => setStart(home()), [phone]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const days = viewDays(start, count);
  const end = addDays(start, count);
  const shown = meetings.filter((m) => m.endedAt > start && m.startedAt < end);
  const hours = hourRange(shown.map((m) => ({ start: m.startedAt, end: m.endedAt })));
  const HOUR = phone ? 46 : 52;
  const oldest = Math.min(...meetings.map((m) => m.startedAt), now);
  const today = midnight(now);
  const atHome = start === home();

  // Another week slides in from the side it comes from.
  const gridRef = useRef<HTMLDivElement>(null);
  const was = useRef(start);
  useLayoutEffect(() => {
    if (was.current === start) return;
    enter(gridRef.current, { x: start > was.current ? 16 : -16 }, 200);
    was.current = start;
  }, [start]);

  const top = (t: number, day: number) => ((t - day) / 3_600_000 - hours.from) * HOUR;

  return (
    <div className={`cal${phone ? " phone" : ""}`} style={{ "--cal-days": count, "--cal-hour": `${HOUR}px` } as React.CSSProperties}>
      <div className="cal-nav">
        <button type="button" className="cal-today" onClick={() => atHome || setStart(home())}>
          Today
        </button>
        <button type="button" className="cal-step back" aria-label={phone ? "Earlier days" : "Previous week"} disabled={start <= oldest} onClick={() => setStart(addDays(start, -count))}>
          <ChevronIcon size={15} />
        </button>
        <button type="button" className="cal-step" aria-label={phone ? "Later days" : "Next week"} disabled={end > now} onClick={() => setStart(addDays(start, count))}>
          <ChevronIcon size={15} />
        </button>
        <h3 className="cal-title">{viewTitle(days)}</h3>
      </div>
      <div ref={gridRef} className="cal-grid">
        <div className="cal-head">
          <span className="cal-gutter" />
          {days.map((d) => (
            <DayHead key={d} day={d} today={d === today} notes={props.notesOn(d)} renderNotes={props.renderNotes} />
          ))}
        </div>
        <div className="cal-body" style={{ height: (hours.to - hours.from) * HOUR }}>
          <div className="cal-gutter">
            {Array.from({ length: hours.to - hours.from }, (_, i) => hours.from + i)
              .slice(1)
              .map((h) => (
                <span key={h} className="cal-hour" style={{ top: (h - hours.from) * HOUR }}>
                  {HOUR_LABEL.format(new Date(2000, 0, 1, h))}
                </span>
              ))}
          </div>
          {days.map((d) => {
            const next = addDays(d, 1);
            const placed = layoutDay(
              shown.filter((m) => m.startedAt >= d && m.startedAt < next).map((m) => ({ item: m, start: m.startedAt, end: Math.min(m.endedAt, next) })),
              (22 / HOUR) * 3_600_000,
            );
            return (
              <div key={d} className={d === today ? "cal-day today" : "cal-day"}>
                {placed.map(({ item: m, start: s, end: e, lane, lanes }) => {
                  const kind = kindOf.get(m.id);
                  const short = isShortCall(m, !!kind, madeIn.get(m.id) ?? 0);
                  const height = Math.max(22, top(e, d) - top(s, d));
                  const name = m.title ?? kind?.name ?? "Meeting";
                  // As many lines of name as fit over the time; a slim block is one line of both.
                  const lines = Math.max(1, Math.floor((height - 8 - 14) / 15));
                  return (
                    <Link
                      key={m.id}
                      to={`/meetings/${m.id}`}
                      className={`cal-block t-${tone(kind, name)}${short ? " short" : ""}${height < 40 ? " slim" : ""}`}
                      style={{ top: top(s, d), height, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 5px)` }}
                      title={[name, `${fmtTime(s)} – ${fmtTime(e)}`, m.summary].filter(Boolean).join("\n")}
                    >
                      <span className="cal-name" dir="auto" style={{ WebkitLineClamp: lines }}>
                        {name}
                      </span>
                      <span className="cal-when">
                        {fmtTime(s)} – {fmtTime(e)}
                      </span>
                    </Link>
                  );
                })}
                {d === today && now >= today + hours.from * 3_600_000 && now < today + hours.to * 3_600_000 && <span className="cal-now" style={{ top: top(now, d) }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DayHead(props: { day: number; today: boolean; notes: number; renderNotes: (day: number) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const date = new Date(props.day);
  return (
    <div ref={ref} className={props.today ? "cal-dayhead today" : "cal-dayhead"}>
      <span className="cal-wd">{WEEKDAY.format(date)}</span>
      <span className="cal-dn">{date.getDate()}</span>
      {props.notes > 0 && (
        <button type="button" className="cal-notes" aria-expanded={open} title={`${props.notes} saved from the bar`} onClick={() => setOpen((o) => !o)}>
          <EditIcon size={11} />
          {props.notes}
        </button>
      )}
      {open && (
        <div className="cal-notes-pop" role="dialog" aria-label="Saved from the bar">
          <ul className="sh-rows">{props.renderNotes(props.day)}</ul>
        </div>
      )}
    </div>
  );
}
