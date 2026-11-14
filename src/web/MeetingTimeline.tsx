import { useState } from "react";
import { Link } from "react-router-dom";
import type { SpaceFeed } from "../shared/protocol.ts";
import { ArchiveIcon } from "./icons.tsx";
import { dayLabel, isShortCall, wasIn } from "./meetingList.ts";

type Meeting = SpaceFeed["meetings"][number];
type Kind = { name: string; open: string; to: string };

/**
 * The space's meetings as a timeline: a line down the left with a point for each meeting and a slim
 * card of its name beside it, under the day it happened. The one under the pointer (the latest, to begin
 * with) shows on the right: when, who talked, what came out of it and the way in. A list of names
 * to scan, and one summary to read at a time. A phone has the line alone.
 */
export function MeetingTimeline(props: {
  meetings: Meeting[];
  kindOf: Map<string, Kind>;
  madeIn: Map<string, number>;
  me: string;
  phone: boolean;
  /** While searching, short calls show with the rest. */
  showShort: boolean;
  onArchive: (id: string) => void;
}) {
  const { meetings, kindOf, madeIn } = props;
  const [picked, setPicked] = useState<string | null>(null);
  const [shortOpen, setShortOpen] = useState<ReadonlySet<string>>(new Set());
  const isShort = (m: Meeting) => isShortCall(m, !!kindOf.get(m.id), madeIn.get(m.id) ?? 0);
  const nameOf = (m: Meeting) => m.title ?? kindOf.get(m.id)?.name ?? "Meeting";

  const days: Array<{ label: string; rows: Meeting[]; short: number }> = [];
  for (const m of meetings) {
    const label = dayLabel(m.endedAt);
    if (days.at(-1)?.label !== label) days.push({ label, rows: [], short: 0 });
    const day = days.at(-1)!;
    const short = !props.showShort && isShort(m);
    if (short) day.short += 1;
    if (!short || shortOpen.has(label)) day.rows.push(m);
  }
  const shown = meetings.find((m) => m.id === picked) ?? meetings.find((m) => !isShort(m)) ?? meetings[0];

  return (
    <div className="tl">
      <div className="tl-line">
        {days.map((d) => (
          <section key={d.label} className="tl-day">
            <h3>
              {d.label}
              {d.short > 0 && (
                <button
                  type="button"
                  className="tl-short"
                  aria-expanded={shortOpen.has(d.label)}
                  onClick={() =>
                    setShortOpen((was) => {
                      const next = new Set(was);
                      if (!next.delete(d.label)) next.add(d.label);
                      return next;
                    })
                  }
                >
                  {shortOpen.has(d.label) ? "Hide short" : `+${d.short} short`}
                </button>
              )}
            </h3>
            <ul>
              {d.rows.map((m) => {
                const short = isShort(m);
                const missed = !short && !wasIn(m.people, props.me);
                return (
                  <li key={m.id} className={`tl-row${m.id === shown?.id && !props.phone ? " on" : ""}${missed ? " missed" : ""}${short ? " short" : ""}`}>
                    <Link to={`/meetings/${m.id}`} onMouseEnter={() => setPicked(m.id)} onFocus={() => setPicked(m.id)}>
                      <span className="tl-dot" title={missed ? "You weren't in this one" : undefined} />
                      <span className="tl-card">
                        <span className="tl-name" dir="auto">{nameOf(m)}</span>
                        {kindOf.get(m.id) && m.title && <KindTag name={kindOf.get(m.id)!.name} />}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {!props.phone && shown && <Preview m={shown} name={nameOf(shown)} kind={kindOf.get(shown.id)} me={props.me} onArchive={() => props.onArchive(shown.id)} />}
    </div>
  );
}

/** Each kind of call keeps its own color, so a review or a brainstorm stands out in the line. */
const TONE: Record<string, string> = { "Product review": "review", "Design review": "design", "Design session": "design", Brainstorm: "brainstorm", "Idea review": "idea" };

function KindTag({ name }: { name: string }) {
  return <span className={`tl-kind t-${TONE[name] ?? "review"}`}>{name}</span>;
}


/**
 * The meeting under the pointer, in order of what matters: its name, what was said, what came of it,
 * then who talked. The day, kind and length are already on the timeline, so they stay there.
 */
function Preview({ m, name, kind, me, onArchive }: { m: Meeting; name: string; kind?: Kind; me: string; onArchive: () => void }) {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const came = [
    m.todos > 0 && plural(m.todos, "to-do"),
    m.open > 0 && plural(m.open, "open question"),
    m.decided > 0 && plural(m.decided, "decision"),
  ].filter(Boolean);
  const missed = m.people.length > 0 && !wasIn(m.people, me);
  return (
    <aside className="tl-preview" key={m.id} aria-live="polite">
      <h2 dir="auto">{name}</h2>
      <p className="tl-people">
        {m.people.length > 0 && <span>{m.people.map((p) => p.split(" ")[0]).join(", ")}</span>}
        {missed && <span className="tl-missed">you weren't in it</span>}
      </p>
      {m.summary && <p className="tl-sum" dir="auto">{m.summary}</p>}
      {came.length > 0 && <p className="tl-came">{came.join(" · ")}</p>}
      <p className="tl-go">
        <Link className="tl-open" to={`/meetings/${m.id}`}>
          Open recap
        </Link>
        {kind && (
          <Link className="tl-also" to={kind.to}>
            {kind.open}
          </Link>
        )}
        <button type="button" className="tl-archive" title="Archive" aria-label="Archive" onClick={onArchive}>
          <ArchiveIcon />
        </button>
      </p>
    </aside>
  );
}
