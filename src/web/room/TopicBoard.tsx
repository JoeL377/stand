// The topic board: what the middle screen shows while nobody shares or presents. The topic
// being talked about now sits on top, the width of the screen, with where each person stands
// on it and what it came to. The other topics sit below, three to a row, each just its title,
// how it ended and who took part. The topics are the discussions live notes already group
// the talk into; the current one is the one holding the latest remark.
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Discussion, DiscussionOutcome, Item, Note, Participant, Segment } from "../../shared/protocol.ts";
import { colorFor, initials, keyOf } from "../util.ts";

const OUTCOME: Record<DiscussionOutcome, string> = { open: "Open", action: "To do", decided: "Decided", info: "FYI" };
/** Below the top card: what still needs something first, then newest first. */
const ORDER: Record<DiscussionOutcome, number> = { open: 0, action: 1, decided: 2, info: 3 };
/** Talk older than this isn't "now" any more. */
const NOW_MS = 120_000;
const MAX_POSITIONS = 3;
const MAX_NOTES = 4;
const NOTE_ORDER: Record<Note["kind"], number> = { decision: 0, action: 1, question: 2, summary: 3 };
const MARK: Record<Note["kind"], string> = { decision: "✓", action: "○", question: "?", summary: "" };

const first = (name: string) => name.split(/\s+/)[0];
const same = (a: string, b: string) => a === b || first(a).toLowerCase() === first(b).toLowerCase();

export function TopicBoard(props: {
  /** The focused item's topics and notes. */
  discussions: Discussion[];
  notes: Note[];
  segments: Segment[];
  participants: Participant[];
  focusItem: Item | null;
}) {
  const turnsById = new Map(props.segments.map((s) => [s.id, s]));
  const latest = props.segments.reduce<Segment | null>((a, s) => (!a || s.ts > a.ts ? s : a), null);
  const topics = props.discussions.map((d) => {
    const turns = d.segmentIds.flatMap((id) => turnsById.get(id) ?? []);
    const people: string[] = [];
    for (const name of [...d.positions.map((p) => p.speaker), ...turns.map((t) => t.speakerName)]) {
      if (!people.some((p) => same(p, name))) people.push(name);
    }
    return { d, last: turns.at(-1)?.ts ?? d.ts, people };
  });
  const current = (latest && topics.find((t) => t.d.segmentIds.includes(latest.id))) ?? [...topics].sort((a, b) => b.last - a.last)[0] ?? null;
  const others = topics.filter((t) => t !== current).sort((a, b) => ORDER[a.d.outcome] - ORDER[b.d.outcome] || b.last - a.last);
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.participants.find((p) => same(p.name, name))?.id ?? name;

  if (!current) {
    const item = props.focusItem;
    return (
      <div className="topic-board empty">
        {item && (
          <div key={item.id} className="focus-card arrive">
            {keyOf(item) && <div className="key big">{keyOf(item)}</div>}
            <h2>{item.title}</h2>
            {item.description && <p className="muted pre focus-desc">{item.description}</p>}
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer">
                Open in {item.source === "linear" ? "Linear" : "new tab"} ↗
              </a>
            )}
          </div>
        )}
        <p className="topic-hint">
          <span className="agent-mark small">✦</span> Topics show up here as people talk
        </p>
      </div>
    );
  }
  return (
    <div className="topic-board">
      <Current
        d={current.d}
        notes={props.notes.filter((n) => n.discussionId === current.d.id && n.kind !== "summary")}
        live={Date.now() - current.last < NOW_MS}
        idOf={idOf}
      />
      {others.length > 0 && (
        <div className="topic-grid" aria-label="Other topics">
          {others.map((t) => (
            <div key={t.d.id} className="topic-card" title={t.d.topic}>
              <strong>{t.d.topic}</strong>
              <span className="topic-card-meta">
                <span className={`topic-outcome ${t.d.outcome}`}>{OUTCOME[t.d.outcome]}</span>
                <span className="topic-people" aria-label={t.people.join(", ")}>
                  {t.people.slice(0, 4).map((p) => (
                    <Dot key={p} id={idOf(p)} name={p} size={18} />
                  ))}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The topic being talked about now: where each person stands, and what it came to. */
function Current(props: { d: Discussion; notes: Note[]; live: boolean; idOf: (name: string) => string }) {
  const { d } = props;
  const fresh = useArrive(d.id);
  const notes = [...props.notes].sort((a, b) => NOTE_ORDER[a.kind] - NOTE_ORDER[b.kind] || a.ts - b.ts);
  const positions = d.positions.slice(0, MAX_POSITIONS);
  return (
    <section className={fresh ? "topic-now topic-in" : "topic-now"} aria-label="Current topic" aria-live="polite">
      <div className="topic-now-head">
        <span className={props.live ? "topic-now-label live" : "topic-now-label"}>{props.live ? "Now" : "Last"}</span>
        <span className={`topic-outcome ${d.outcome}`}>{OUTCOME[d.outcome]}</span>
      </div>
      <h2 className="topic-now-title">{d.topic}</h2>
      {positions.length > 0 && (
        <div className="topic-positions">
          {positions.map((p) => (
            <div key={p.speaker} className="topic-position">
              <span className="topic-position-who">
                <Dot id={props.idOf(p.speaker)} name={p.speaker} size={20} />
                <strong>{first(p.speaker)}</strong>
              </span>
              <span>{p.position}</span>
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="topic-notes">
          {notes.slice(0, MAX_NOTES).map((n) => (
            <li key={n.id} className={n.doneAt ? `${n.kind} done` : n.kind}>
              <span className="topic-note-mark" aria-label={n.kind === "decision" ? "Decided" : n.kind === "action" ? "To do" : "Open question"}>
                {MARK[n.kind]}
              </span>
              <span>
                {n.text}
                {n.owner && <span className="topic-owner"> · {first(n.owner)}</span>}
              </span>
            </li>
          ))}
          {notes.length > MAX_NOTES && <li className="topic-more">+{notes.length - MAX_NOTES} more</li>}
        </ul>
      )}
    </section>
  );
}

/** True for a moment when the current topic changes, so the switch is noticed. */
function useArrive(id: string) {
  const prev = useRef(id);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === id) return;
    prev.current = id;
    setOn(true);
    const t = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(t);
  }, [id]);
  return on;
}

function Dot({ id, name, size }: { id: string; name: string; size: number }) {
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.5)), background: colorFor(id) } as CSSProperties;
  return (
    <span className="topic-dot" style={style} title={name}>
      {initials(name)}
    </span>
  );
}
