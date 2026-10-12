// The topic board: what the middle screen shows while nobody shares or presents. The topic
// being talked about now fills the screen, with where each person stands on it, what it came
// to, and the latest remark. Underneath, a chapter bar runs from the start of the meeting to
// now, like chapters on a video: each stretch is a topic, at the time it was talked about.
// Hovering or clicking a stretch opens that topic on your own screen. The topics are the
// discussions live notes already group the talk into; the current one holds the latest remark.
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import type { Discussion, DiscussionOutcome, Item, Note, Participant, Segment } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtDuration, initials, keyOf } from "../util.ts";

const OUTCOME: Record<DiscussionOutcome, string> = { open: "Open", action: "To do", decided: "Decided", info: "FYI" };
/** Talk older than this isn't "now" any more. */
const NOW_MS = 120_000;
/** A pause longer than this between two topics shows as a gap in the chapter bar. */
const GAP_MS = 180_000;
/** How long a stretch lasts past its last remark when a gap follows it. */
const TAIL_MS = 30_000;
const MAX_POSITIONS = 3;
const MAX_NOTES = 4;
const PEEK_NOTES = 3;
const NOTE_ORDER: Record<Note["kind"], number> = { decision: 0, action: 1, question: 2, summary: 3 };
const MARK: Record<Note["kind"], string> = { decision: "✓", action: "○", question: "?", summary: "" };
const MARK_LABEL: Record<Note["kind"], string> = { decision: "Decided", action: "To do", question: "Open question", summary: "" };

const first = (name: string) => name.split(/\s+/)[0];
const same = (a: string, b: string) => a === b || first(a).toLowerCase() === first(b).toLowerCase();
/** A time into the meeting, the way video players write it: 4:05, 1:02:09. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

interface Topic {
  d: Discussion;
  turns: Segment[];
  /** When it was last talked about. */
  last: number;
}
/** One stretch of the chapter bar: a topic, from when talk turned to it until it moved on. */
interface Stretch {
  topic: Topic;
  from: number;
  to: number;
}

export function TopicBoard(props: {
  /** Every topic of the meeting, for the chapter bar; the focused item's are the ones that can be current. */
  discussions: Discussion[];
  notes: Note[];
  segments: Segment[];
  /** Words being spoken right now, before they become a remark. */
  interims: Record<string, Interim>;
  participants: Participant[];
  items: Item[];
  focusItem: Item | null;
  focusItemId: string | null;
  meetingStartedAt: number;
}) {
  const now = useNow(15_000);
  const turnsById = new Map(props.segments.map((s) => [s.id, s]));
  const latest = props.segments.reduce<Segment | null>((a, s) => (!a || s.ts > a.ts ? s : a), null);
  const topics: Topic[] = props.discussions.map((d) => {
    const turns = d.segmentIds.flatMap((id) => turnsById.get(id) ?? []).sort((a, b) => a.ts - b.ts);
    return { d, turns, last: turns.at(-1)?.ts ?? d.ts };
  });
  const here = topics.filter((t) => t.d.itemId === props.focusItemId);
  const current = (latest && here.find((t) => t.d.segmentIds.includes(latest.id))) ?? [...here].sort((a, b) => b.last - a.last)[0] ?? null;
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.participants.find((p) => same(p.name, name))?.id ?? name;
  const notesOf = (t: Topic) =>
    props.notes.filter((n) => n.discussionId === t.d.id && n.kind !== "summary").sort((a, b) => NOTE_ORDER[a.kind] - NOTE_ORDER[b.kind] || a.ts - b.ts);
  const [peek, setPeek] = useState<{ id: string; key: string; pinned: boolean } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const live = !!current && now - current.last < NOW_MS;
  const stretches = chapters(topics, live ? current : null, now);
  const start = Math.min(props.meetingStartedAt, stretches[0]?.from ?? Infinity);
  // Time on a topic: its stretches added up, so coming back to it later counts too.
  const spentOn = (t: Topic) => stretches.reduce((sum, s) => (s.topic === t ? sum + s.to - s.from : sum), 0);
  const peeked = peek && topics.find((t) => t.d.id === peek.id && t !== current);
  const speaking = live ? Object.values(props.interims).find((i) => i.text.trim()) : undefined;
  const lastTurn = current?.turns.at(-1);
  const item = props.focusItem;

  return (
    <div ref={boardRef} className={peeked ? "topic-board peeking" : "topic-board"}>
      {current ? (
        <Current
          t={current}
          notes={notesOf(current)}
          spent={spentOn(current)}
          live={live}
          remark={speaking ? { name: speaking.speakerName, id: speaking.speakerId, text: speaking.text, now: true } : lastTurn && { name: lastTurn.speakerName, id: idOf(lastTurn.speakerName), text: lastTurn.text, now: false }}
          idOf={idOf}
        />
      ) : (
        <div className="topic-waiting">
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
      )}
      {stretches.length > 0 && (
        <div className="topic-chapters">
          <div className="topic-bar" role="group" aria-label="Topics so far">
            {stretches.map((s) => {
              const isCurrent = s.topic === current;
              const at = clock(s.from - start);
              const key = `${s.topic.d.id}-${s.from}`;
              const open = (pinned: boolean) => setPeek((p) => (p?.pinned && !pinned ? p : { id: s.topic.d.id, key, pinned }));
              return (
                <button
                  key={key}
                  data-key={key}
                  type="button"
                  className={["topic-stretch", isCurrent && "current", peek?.id === s.topic.d.id && "on"].filter(Boolean).join(" ")}
                  style={{ left: `${pct(s.from - start, now - start)}%`, width: `${pct(s.to - s.from, now - start)}%` }}
                  aria-label={`${at}, ${s.topic.d.topic}, ${OUTCOME[s.topic.d.outcome]}${isCurrent ? ", now" : ""}`}
                  aria-expanded={isCurrent ? undefined : peek?.id === s.topic.d.id}
                  onMouseEnter={() => !isCurrent && open(false)}
                  onMouseLeave={() => setPeek((p) => (p?.pinned ? p : null))}
                  onFocus={() => !isCurrent && open(false)}
                  onBlur={() => setPeek((p) => (p?.pinned ? p : null))}
                  onClick={() => !isCurrent && (peek?.key === key && peek.pinned ? setPeek(null) : open(true))}
                />
              );
            })}
          </div>
          <div className="topic-bar-times" aria-hidden="true">
            <span>0:00</span>
            <span>{clock(now - start)}</span>
          </div>
        </div>
      )}
      {peeked && (
        <Peek
          t={peeked}
          notes={notesOf(peeked)}
          at={clock((stretches.find((s) => `${s.topic.d.id}-${s.from}` === peek.key)?.from ?? peeked.d.ts) - start)}
          spent={spentOn(peeked)}
          anchor={peek.key}
          elsewhere={peeked.d.itemId !== props.focusItemId ? (props.items.find((i) => i.id === peeked.d.itemId)?.title ?? "General") : null}
          idOf={idOf}
          boardRef={boardRef}
          onClose={() => setPeek(null)}
          pinned={peek.pinned}
        />
      )}
    </div>
  );
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

/** The meeting's talk as stretches, one per run of remarks on the same topic, each lasting until the
 * next one starts unless the talk paused. The current topic runs on to now while it's live. */
function chapters(topics: Topic[], liveTopic: Topic | null, now: number): Stretch[] {
  const turns = topics.flatMap((topic) => topic.turns.map((s) => ({ topic, ts: s.ts }))).sort((a, b) => a.ts - b.ts);
  const runs: { topic: Topic; from: number; last: number }[] = [];
  for (const t of turns) {
    const run = runs.at(-1);
    if (run && run.topic === t.topic) run.last = t.ts;
    else runs.push({ topic: t.topic, from: t.ts, last: t.ts });
  }
  return runs.map((r, i) => {
    const next = runs[i + 1];
    const to = next ? (next.from - r.last < GAP_MS ? next.from : r.last + TAIL_MS) : r.topic === liveTopic ? now : r.last + TAIL_MS;
    return { topic: r.topic, from: r.from, to: Math.min(Math.max(to, r.from + 1000), now) };
  });
}

/** The time, again every so often, so the chapter bar keeps up with the meeting. */
function useNow(every: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return Math.max(now, Date.now());
}

/** The topic being talked about now: where each person stands, what it came to, the latest remark. */
function Current(props: {
  t: Topic;
  notes: Note[];
  /** Time on it so far. */
  spent: number;
  live: boolean;
  remark: { name: string; id: string; text: string; now: boolean } | undefined;
  idOf: (name: string) => string;
}) {
  const { d } = props.t;
  const fresh = useArrive(d.id);
  const positions = d.positions.slice(0, MAX_POSITIONS);
  return (
    <section className={fresh ? "topic-now topic-in" : "topic-now"} aria-label="Current topic">
      <div className="topic-now-head">
        <span className={props.live ? "topic-now-label live" : "topic-now-label"}>{props.live ? "Now" : "Last"}</span>
        <span className={`topic-outcome ${d.outcome}`}>{OUTCOME[d.outcome]}</span>
        {props.spent >= 60_000 && <span className="topic-mins">{fmtDuration(props.spent)}</span>}
      </div>
      <h2 className="topic-now-title" aria-live="polite">
        {d.topic}
      </h2>
      {positions.length > 0 && (
        <div className="topic-positions">
          {positions.map((p) => (
            <div key={p.speaker} className="topic-position">
              <span className="topic-position-who">
                <Dot id={props.idOf(p.speaker)} name={p.speaker} size={22} />
                <strong>{first(p.speaker)}</strong>
              </span>
              <span>{p.position}</span>
            </div>
          ))}
        </div>
      )}
      {props.notes.length > 0 && <NoteList notes={props.notes} max={MAX_NOTES} />}
      {props.remark && (
        <p className={props.remark.now ? "topic-remark now" : "topic-remark"}>
          <Dot id={props.remark.id} name={props.remark.name} size={20} />
          <span className="topic-remark-text">
            <strong>{first(props.remark.name)}</strong> · {props.remark.text}
          </span>
        </p>
      )}
    </section>
  );
}

/** Another topic, opened from its chip on your own screen: where people stood and what it came to. */
function Peek(props: {
  t: Topic;
  notes: Note[];
  /** When talk turned to it, into the meeting, at the stretch it was opened from. */
  at: string;
  spent: number;
  /** The stretch of the bar it was opened from. */
  anchor: string;
  /** The agenda item it was under, when that isn't the one in focus. */
  elsewhere: string | null;
  pinned: boolean;
  idOf: (name: string) => string;
  boardRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const { d } = props.t;
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const ref = useRef<HTMLDivElement>(null);
  const { onClose, pinned } = props;
  // Sit just above its stretch of the bar, centered on it, kept inside the board.
  useEffect(() => {
    const board = props.boardRef.current;
    const stretch = board?.querySelector<HTMLElement>(`.topic-stretch[data-key="${props.anchor}"]`);
    if (!board || !stretch || !ref.current) return;
    const b = board.getBoundingClientRect();
    const c = stretch.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    setPos({ left: Math.max(16, Math.min(c.left - b.left + c.width / 2 - w / 2, b.width - w - 16)), bottom: b.bottom - c.top + 6 });
  }, [props.anchor, props.boardRef]);
  useEffect(() => {
    if (!pinned) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const click = (e: MouseEvent) => {
      const el = e.target as Element;
      if (!ref.current?.contains(el) && !el.closest(".topic-stretch")) onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, [pinned, onClose]);
  return (
    <div ref={ref} className="topic-peek" role="dialog" aria-label={d.topic} style={pos}>
      <div className="topic-now-head">
        <span className="topic-peek-at">{props.at}</span>
        <span className={`topic-outcome ${d.outcome}`}>{OUTCOME[d.outcome]}</span>
        {props.spent >= 60_000 && <span className="topic-mins">{fmtDuration(props.spent)}</span>}
        {props.elsewhere && <span className="topic-mins topic-peek-item">· {props.elsewhere}</span>}
      </div>
      <strong className="topic-peek-title">{d.topic}</strong>
      {d.positions.length > 0 && (
        <div className="topic-peek-positions">
          {d.positions.slice(0, MAX_POSITIONS).map((p) => (
            <div key={p.speaker}>
              <Dot id={props.idOf(p.speaker)} name={p.speaker} size={18} />
              <span>{p.position}</span>
            </div>
          ))}
        </div>
      )}
      {props.notes.length > 0 && <NoteList notes={props.notes} max={PEEK_NOTES} />}
    </div>
  );
}

function NoteList({ notes, max }: { notes: Note[]; max: number }) {
  return (
    <ul className="topic-notes">
      {notes.slice(0, max).map((n) => (
        <li key={n.id} className={n.doneAt ? `${n.kind} done` : n.kind}>
          <span className="topic-note-mark" aria-label={MARK_LABEL[n.kind]}>
            {MARK[n.kind]}
          </span>
          <span>
            {n.text}
            {n.owner && <span className="topic-owner"> · {first(n.owner)}</span>}
          </span>
        </li>
      ))}
      {notes.length > max && <li className="topic-more">+{notes.length - max} more</li>}
    </ul>
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
