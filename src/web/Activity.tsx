// The space's Activity tab: one quiet timeline of what agents did, grouped by day. A row is a face,
// a line and a time; what the agent wrote, and what a burst folds, open under the row. Rows come a
// page at a time as the list is scrolled, and a row that hasn't changed isn't drawn again.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type ActivityEvent, type ActivityPage, type ActivityRow, type ActivityTarget, type ActivityWho, burstTarget, dayStart, groupActivity } from "../shared/activity.ts";
import { Avatar } from "./Avatar.tsx";
import { ConxtLogo } from "./ConxtLogo.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "./NoteIcons.tsx";
import { api } from "./api.ts";
import { ChevronIcon } from "./icons.tsx";
import { fmtDate, fmtDay, fmtTime, linkLabel } from "./util.ts";

/** How often the newest page is read again while the tab is open. */
const REFRESH_MS = 30_000;

const MergeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="4.5" cy="3.5" r="1.75" />
    <circle cx="4.5" cy="12.5" r="1.75" />
    <circle cx="11.5" cy="8" r="1.75" />
    <path d="M4.5 5.25v5.5M4.5 5.25c0 2 2 2.75 5.25 2.75" />
  </svg>
);

function Face({ who, size = 20 }: { who: ActivityWho | undefined; size?: number }) {
  if (!who || who.kind === "stand")
    return (
      <span className="ac-face stand" style={{ width: size, height: size }} aria-hidden>
        <ConxtLogo height={Math.round(size * 0.55)} />
      </span>
    );
  if (who.kind === "github")
    return (
      <span className="ac-face github" style={{ width: size, height: size }} aria-hidden>
        <MergeIcon />
      </span>
    );
  return <Avatar id={who.personId ?? who.key} name={who.person ?? who.short} picture={who.picture} size={size} />;
}

const KIND_ICON = { action: TodoIcon, decision: DecidedIcon, question: QuestionIcon } as const;

/** The thing an event is about: a to-do opens in the drawer, anything else goes to its page. */
function Target({ target, onOpenTask }: { target: ActivityTarget; onOpenTask: (id: string) => void }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (target.taskId) {
    const id = target.taskId;
    return (
      <a
        className="ac-target"
        href={target.href}
        title={target.text}
        dir="auto"
        onClick={(e) => {
          e.stopPropagation();
          // A plain click opens the drawer here; a new-tab click follows the link.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpenTask(id);
        }}
      >
        {target.text}
      </a>
    );
  }
  if (target.href)
    return (
      <Link className="ac-target" to={target.href} title={target.text} dir="auto" onClick={stop}>
        {target.text}
      </Link>
    );
  return <span className="ac-target plain" dir="auto">{target.text}</span>;
}

function Items({ items, onOpenTask }: { items: ActivityTarget[]; onOpenTask: (id: string) => void }) {
  return (
    <ul className="ac-items">
      {items.map((t, i) => {
        const Icon = t.kind && t.kind in KIND_ICON ? KIND_ICON[t.kind as keyof typeof KIND_ICON] : null;
        return (
          <li key={i} className={t.kind}>
            {Icon && <Icon />}
            <Target target={t} onOpenTask={onOpenTask} />
          </li>
        );
      })}
    </ul>
  );
}

/** What an event says beyond its line: the agent's words, its links, and what it folds. */
function Detail({ event, onOpenTask, inBurst }: { event: ActivityEvent; onOpenTask: (id: string) => void; inBurst?: boolean }) {
  const model = inBurst ? undefined : event.model;
  return (
    <>
      {event.detail && <p className="ac-said" dir="auto">{event.detail}</p>}
      {event.items && <Items items={event.items} onOpenTask={onOpenTask} />}
      {(event.links?.length || model) && (
        <p className="ac-meta">
          {event.links?.map((l) => (
            <a key={l} href={l} target="_blank" rel="noreferrer">{linkLabel(l)}</a>
          ))}
          {model && <span>{model}</span>}
        </p>
      )}
    </>
  );
}

const opens = (row: ActivityRow) => !!row.burst || !!row.event.detail || !!row.event.items?.length || !!row.event.links?.length;

const Row = memo(function Row(props: { row: ActivityRow; who: ActivityWho | undefined; open: boolean; onToggle: (id: string) => void; onOpenTask: (id: string) => void }) {
  const { row, who, open, onToggle, onOpenTask } = props;
  const target = burstTarget(row);
  const can = opens(row);
  // A burst is flagged when anything in it still waits.
  const flag = row.burst ? row.burst.find((e) => e.flag)?.flag : row.event.flag;
  return (
    <li className={["ac-row", can && "can-open", open && "open"].filter(Boolean).join(" ")}>
      <div
        className="ac-line"
        role={can ? "button" : undefined}
        tabIndex={can ? 0 : undefined}
        aria-expanded={can ? open : undefined}
        onClick={can ? () => onToggle(row.id) : undefined}
        onKeyDown={can ? (e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), onToggle(row.id)) : undefined}
      >
        <Face who={who} />
        <span className="ac-text">
          <span className="ac-who" title={who?.name}>
            <span className="ac-who-long">{who?.name ?? "An agent"}</span>
            {/* A phone has the face for whose it is, so the name is the agent's alone. */}
            <span className="ac-who-short">{who?.short ?? "An agent"}</span>
          </span> <span className="ac-verb">{row.verb}</span>
          {target && <> <Target target={target} onOpenTask={onOpenTask} /></>}
        </span>
        {flag && <span className="ac-flag" title={flag}><span>{flag}</span></span>}
        {can && <span className="ac-chev" aria-hidden><ChevronIcon size={11} /></span>}
        <time className="ac-time" dateTime={new Date(row.ts).toISOString()}>{fmtTime(row.ts)}</time>
      </div>
      {open && (
        <div className="ac-detail">
          {row.burst ? (
            <ul className="ac-burst">
              {row.burst.map((e) => (
                <li key={e.id}>
                  <p className="ac-burst-line">
                    <time>{fmtTime(e.ts)}</time>
                    <span className="ac-text">
                      <span className="ac-verb">{e.verb}</span>
                      {e.target && <> <Target target={e.target} onOpenTask={onOpenTask} /></>}
                    </span>
                    {e.flag && <span className="ac-flag"><span>{e.flag}</span></span>}
                  </p>
                  <Detail event={e} onOpenTask={onOpenTask} inBurst />
                </li>
              ))}
              {/* The model once for the burst, when all of it said the same one. */}
              {row.event.model && row.burst.every((e) => e.model === row.event.model) && <li className="ac-meta">{row.event.model}</li>}
            </ul>
          ) : (
            <Detail event={row.event} onOpenTask={onOpenTask} />
          )}
        </div>
      )}
    </li>
  );
});

const dayLabel = (start: number, today: number) => (start === today ? "Today" : start === dayStart(today - 1) ? "Yesterday" : fmtDate(start));

export function ActivityTab({ roomId, onOpenTask }: { roomId: string; onOpenTask: (id: string) => void }) {
  const [who, setWho] = useState("");
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [agents, setAgents] = useState<ActivityWho[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // What the list shows now, so an answer that comes back for another filter or space is dropped.
  const showing = useRef("");
  showing.current = `${roomId}|${who}`;

  const take = useCallback((page: ActivityPage, how: "first" | "newer" | "older", key: string) => {
    if (showing.current !== key) return;
    setAgents((old) => (page.agents.length >= old.length || how === "first" ? page.agents : old));
    setEvents((old) => {
      if (how === "first" || !old) return page.events;
      if (how === "older") {
        const have = new Set(old.map((e) => e.id));
        return [...old, ...page.events.filter((e) => !have.has(e.id))];
      }
      // Newer: the first page again. What it has replaces the copy on screen (a flag may have cleared), and anything new leads.
      const fresh = new Map(page.events.map((e) => [e.id, e]));
      const same = old.length >= page.events.length && page.events.every((e, i) => old[i].id === e.id && old[i].flag === e.flag && old[i].verb === e.verb);
      if (same) return old;
      const oldest = page.events.length ? page.events[page.events.length - 1].ts : Infinity;
      return [...page.events, ...old.filter((e) => !fresh.has(e.id) && e.ts <= oldest)];
    });
    if (how !== "newer") setNext(page.next);
  }, []);

  useEffect(() => {
    const key = `${roomId}|${who}`;
    setEvents(null);
    setNext(null);
    setError("");
    setOpen(new Set());
    api.activity(roomId, { who }).then((p) => take(p, "first", key), (e: Error) => showing.current === key && setError(e.message));
    const t = setInterval(() => {
      if (document.visibilityState === "visible") api.activity(roomId, { who }).then((p) => take(p, "newer", key), () => {});
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [roomId, who, take]);

  const more = useCallback(() => {
    if (busy || next === null) return;
    const key = showing.current;
    setBusy(true);
    api.activity(roomId, { who, before: next }).then((p) => take(p, "older", key), () => {}).finally(() => setBusy(false));
  }, [busy, next, roomId, who, take]);
  // The next page loads as the end of the list comes near.
  const moreRef = useRef(more);
  moreRef.current = more;
  const [end, setEnd] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!end || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && moreRef.current(), { rootMargin: "400px" });
    io.observe(end);
    return () => io.disconnect();
  }, [end, events?.length]);

  const toggle = useCallback((id: string) => setOpen((old) => {
    const now = new Set(old);
    if (!now.delete(id)) now.add(id);
    return now;
  }), []);

  const whoOf = useMemo(() => new Map(agents.map((a) => [a.key, a])), [agents]);
  const days = useMemo(() => {
    const out: Array<{ start: number; rows: ActivityRow[] }> = [];
    for (const row of groupActivity(events ?? [])) {
      const start = dayStart(row.ts);
      if (out[out.length - 1]?.start === start) out[out.length - 1].rows.push(row);
      else out.push({ start, rows: [row] });
    }
    return out;
  }, [events]);
  const today = dayStart(Date.now());
  // Two people's agents can share a name: then the pill says whose.
  const shared = new Set(agents.map((a) => a.short).filter((s, i, all) => all.indexOf(s) !== i));

  return (
    <>
      {agents.length > 1 && (
        <div className="sh-kinds ac-pills" role="group" aria-label="Whose activity">
          <button type="button" className={who === "" ? "rp-pill on" : "rp-pill"} aria-pressed={who === ""} onClick={() => setWho("")}>All</button>
          {agents.map((a) => (
            <button key={a.key} type="button" className={who === a.key ? "rp-pill on" : "rp-pill"} aria-pressed={who === a.key} title={a.name} onClick={() => setWho(who === a.key ? "" : a.key)}>
              <Face who={a} size={16} />
              {shared.has(a.short) ? a.name : a.short}
            </button>
          ))}
        </div>
      )}
      {error && !events && <p className="error">{error}</p>}
      {events && !days.length && <p className="sh-card-empty">{who ? "Nothing from this agent yet." : "Nothing yet. What agents do in this space shows here."}</p>}
      {days.map((d) => (
        <section key={d.start} className={d.start === today ? "ac-day today" : "ac-day"}>
          <h3>
            <span className="sh-day-long">{dayLabel(d.start, today)}</span>
            <span className="sh-day-short">{d.start === today ? "Today" : fmtDay(d.start)}</span>
          </h3>
          <ul className="ac-rows">
            {d.rows.map((row) => (
              <Row key={row.id} row={row} who={whoOf.get(row.who)} open={open.has(row.id)} onToggle={toggle} onOpenTask={onOpenTask} />
            ))}
          </ul>
        </section>
      ))}
      {events && next !== null && (
        <p className="ac-end" ref={setEnd}>
          <button type="button" className="link" onClick={more} disabled={busy}>{busy ? "Loading…" : "Show older"}</button>
        </p>
      )}
    </>
  );
}
