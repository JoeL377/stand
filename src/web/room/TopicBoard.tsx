// The topic board: what the middle screen shows while nobody shares or presents. The topic
// being talked about now fills the screen, with where each person stands on it, what it came
// to, and the latest remark. Underneath, a chapter bar runs from the start of the meeting to
// now, like chapters on a video: each stretch is a chapter, at the time it was talked about.
// A chapter is a main topic with the smaller topics placed inside it, or a small group of
// topics (see server/topicMerge.ts), so a long call reads as a few chapters, not dozens of
// slivers. Hovering or clicking a stretch opens that chapter on your own screen. The topics are
// the discussions live notes already group the talk into; the current one holds the latest remark.
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import type { Discussion, DiscussionOutcome, Item, Note, Participant, Segment } from "../../shared/protocol.ts";
import { barSpan, type ChapterTopic, chapterOf, remarkTimes, stretches as chapterStretches, type Stretch } from "../../shared/chapters.ts";
import { type Focus, pickFocus } from "../../shared/boardFocus.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtDuration, initials, keyOf } from "../util.ts";

const OUTCOME: Record<DiscussionOutcome, string> = { open: "Open", action: "To do", decided: "Decided", info: "FYI" };
/** Talk older than this isn't "now" any more. */
const NOW_MS = 120_000;
const MAX_POSITIONS = 3;
const MAX_NOTES = 4;
const PEEK_NOTES = 3;
/** Topics placed inside a chapter that its peek lists, with a note or two each. */
const PEEK_TOPICS = 3;
const PEEK_TOPIC_NOTES = 2;
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
  /** The chapter it draws in on the bar. */
  chapter: string;
  /** Time spent on it. */
  spent: number;
}
/** A main topic with the topics placed inside it, or a small group of topics. */
interface Chapter {
  key: string;
  /** The main topic; null for a group. */
  head: Topic | null;
  title: string;
  /** The topics placed inside it, or the group's topics. */
  inside: Topic[];
  itemId: string | null;
  spent: number;
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
  /** A live notes run for the item in focus is reading the latest talk. */
  updating: boolean;
}) {
  const now = useNow(15_000);
  const turnsById = new Map(props.segments.map((s) => [s.id, s]));
  const held = remarkTimes(props.segments);
  const latest = props.segments.reduce<Segment | null>((a, s) => (!a || s.ts > a.ts ? s : a), null);
  const shapes: ChapterTopic[] = props.discussions.map((d) => ({
    id: d.id,
    itemId: d.itemId,
    mergedInto: d.mergedInto,
    group: d.group,
    times: d.segmentIds.flatMap((id) => turnsById.get(id)?.ts ?? []),
  }));
  const shapeById = new Map(shapes.map((t) => [t.id, t]));
  const topics: Topic[] = props.discussions.map((d, i) => {
    const turns = d.segmentIds.flatMap((id) => turnsById.get(id) ?? []).sort((a, b) => a.ts - b.ts);
    // A topic with no remarks of its own (notes carried in from earlier) is never the latest one.
    return { d, turns, last: turns.at(-1)?.ts ?? -Infinity, chapter: chapterOf(shapes[i], shapeById), spent: turns.reduce((ms, t) => ms + (held.get(t.id) ?? 0), 0) };
  });
  const chapters = new Map<string, Chapter>();
  for (const t of topics) {
    const c = chapters.get(t.chapter) ?? { key: t.chapter, head: null, title: t.d.group ?? t.d.topic, inside: [], itemId: t.d.itemId, spent: 0 };
    if (t.d.id === t.chapter) {
      c.head = t;
      c.title = t.d.topic;
    } else c.inside.push(t);
    c.spent += t.spent;
    chapters.set(t.chapter, c);
  }
  const here = topics.filter((t) => t.d.itemId === props.focusItemId);
  const latestTopic = (latest && here.find((t) => t.d.segmentIds.includes(latest.id))) ?? [...here].sort((a, b) => b.last - a.last)[0] ?? null;
  // The board waits a few remarks before it follows a new topic (shared/boardFocus.ts).
  const onScreen = useRef<Focus | null>(null);
  const focus = pickFocus(
    onScreen.current,
    latestTopic?.d.id ?? null,
    here.map((t) => ({ id: t.d.id, lines: t.turns.map((s) => ({ id: s.id, ts: s.ts })) })),
    latest?.ts ?? now,
  );
  useEffect(() => {
    onScreen.current = focus;
  });
  const current = here.find((t) => t.d.id === focus?.id) ?? latestTopic;
  const arrival = useArrival(current?.d.id ?? null);
  const currentChapter = current ? chapters.get(current.chapter)! : null;
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.participants.find((p) => same(p.name, name))?.id ?? name;
  const notesOf = (t: Topic) =>
    props.notes.filter((n) => n.discussionId === t.d.id && n.kind !== "summary").sort((a, b) => NOTE_ORDER[a.kind] - NOTE_ORDER[b.kind] || a.ts - b.ts);
  const [peek, setPeek] = useState<{ id: string; key: string; pinned: boolean } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const live = !!current && now - current.last < NOW_MS;
  const bar: Stretch[] = chapterStretches(shapes, live && current ? current.chapter : null, now);
  const start = Math.min(props.meetingStartedAt, bar[0]?.from ?? Infinity);
  // The bar spans a set length, longer as the meeting runs on, so talk fills it from the left.
  const span = barSpan(now - start);
  // A chapter that's only the topic on screen has nothing more to show.
  const peekable = (c: Chapter) => !(c.head === current && !c.inside.length);
  const peeked = peek ? chapters.get(peek.id) : undefined;
  const shown = peeked && peekable(peeked) ? peeked : null;
  const speaking = live ? Object.values(props.interims).find((i) => i.text.trim()) : undefined;
  const lastTurn = current?.turns.at(-1);
  const item = props.focusItem;

  return (
    <div ref={boardRef} className={shown ? "topic-board peeking" : "topic-board"}>
      {current ? (
        <Current
          t={current}
          notes={notesOf(current)}
          spent={current.spent}
          partOf={currentChapter && currentChapter.head !== current ? currentChapter.title : null}
          live={live}
          updating={props.updating}
          arrival={arrival}
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
          <p className={props.updating ? "topic-hint updating" : "topic-hint"}>
            <span className="agent-mark small">✦</span> Topics show up here as people talk
          </p>
        </div>
      )}
      {bar.length > 0 && (
        <div className="topic-chapters">
          <div className="topic-bar" role="group" aria-label="Chapters so far">
            <div className="topic-bar-elapsed" style={{ width: `${pct(now - start, span)}%` }} />
            {bar.map((s) => {
              const c = chapters.get(s.chapter)!;
              const isCurrent = c === currentChapter;
              const canPeek = peekable(c);
              const at = clock(s.from - start);
              const key = `${s.chapter}-${s.from}`;
              const open = (pinned: boolean) => setPeek((p) => (p?.pinned && !pinned ? p : { id: s.chapter, key, pinned }));
              return (
                <button
                  key={key}
                  data-key={key}
                  type="button"
                  className={["topic-stretch", isCurrent && "current", isCurrent && arrival && "arrived", canPeek && "peekable", peek?.id === s.chapter && "on"].filter(Boolean).join(" ")}
                  style={{ left: `${pct(s.from - start, span)}%`, width: `${pct(s.to - s.from, span)}%` }}
                  aria-label={`${at}, ${c.title}${c.head ? `, ${OUTCOME[c.head.d.outcome]}` : ""}${isCurrent ? ", now" : ""}`}
                  aria-expanded={canPeek ? peek?.id === s.chapter : undefined}
                  onMouseEnter={() => canPeek && open(false)}
                  onMouseLeave={() => setPeek((p) => (p?.pinned ? p : null))}
                  onFocus={() => canPeek && open(false)}
                  onBlur={() => setPeek((p) => (p?.pinned ? p : null))}
                  onClick={() => canPeek && (peek?.key === key && peek.pinned ? setPeek(null) : open(true))}
                />
              );
            })}
          </div>
          <div className="topic-bar-times" aria-hidden="true">
            {pct(now - start, span) >= 15 && <span>0:00</span>}
            {/* Shifted back by as much of its width as the bar is full, so it never hangs off either end. */}
            <span className="topic-bar-now" style={{ left: `${pct(now - start, span)}%`, transform: `translateX(-${pct(now - start, span)}%)` }}>
              {clock(now - start)}
            </span>
          </div>
        </div>
      )}
      {shown && peek && (
        <Peek
          c={shown}
          notesOf={notesOf}
          at={clock((bar.find((s) => `${s.chapter}-${s.from}` === peek.key)?.from ?? shown.head?.d.ts ?? start) - start)}
          anchor={peek.key}
          headOnScreen={shown.head === current}
          elsewhere={shown.itemId !== props.focusItemId ? (props.items.find((i) => i.id === shown.itemId)?.title ?? "General") : null}
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
  /** The chapter it was placed in, when that's another topic or a group. */
  partOf: string | null;
  live: boolean;
  /** The notes are being redrawn from the latest talk: a light runs along the top edge. */
  updating: boolean;
  /** Just switched to: a topic new to this meeting, or one it came back to. */
  arrival: Arrival;
  remark: { name: string; id: string; text: string; now: boolean } | undefined;
  idOf: (name: string) => string;
}) {
  const { d } = props.t;
  const positions = d.positions.slice(0, MAX_POSITIONS);
  const label = props.arrival === "new" ? "New topic" : props.arrival === "back" ? "Back to" : props.live ? "Now" : "Last";
  return (
    <section
      className={["topic-now", props.arrival && "topic-in", props.updating && "updating"].filter(Boolean).join(" ")}
      aria-label="Current topic"
      aria-busy={props.updating}
    >
      <div className="topic-now-head">
        <span key={label} className={["topic-now-label", props.live && "live", props.arrival && "arrived"].filter(Boolean).join(" ")}>
          {label}
        </span>
        <span className={`topic-outcome ${d.outcome}`}>{OUTCOME[d.outcome]}</span>
        {props.spent >= 60_000 && <span className="topic-mins">{fmtDuration(props.spent)}</span>}
        {props.partOf && <span className="topic-mins topic-part-of">· part of {props.partOf}</span>}
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

/** A chapter, opened from the bar on your own screen: its main topic, where people stood and what
 *  it came to, then the topics placed inside it. A group lists its topics. */
function Peek(props: {
  c: Chapter;
  notesOf: (t: Topic) => Note[];
  /** When talk turned to it, into the meeting, at the stretch it was opened from. */
  at: string;
  /** The stretch of the bar it was opened from. */
  anchor: string;
  /** Its main topic is the one on screen: only the topics inside it are new. */
  headOnScreen: boolean;
  /** The agenda item it was under, when that isn't the one in focus. */
  elsewhere: string | null;
  pinned: boolean;
  idOf: (name: string) => string;
  boardRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const { c } = props;
  const head = c.head?.d;
  const showHead = !!c.head && !props.headOnScreen;
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const ref = useRef<HTMLDivElement>(null);
  const { onClose, pinned } = props;
  // Sit just above its stretch of the bar, centered on it, kept inside the board.
  useEffect(() => {
    const board = props.boardRef.current;
    const stretch = board?.querySelector<HTMLElement>(`.topic-stretch[data-key="${CSS.escape(props.anchor)}"]`);
    if (!board || !stretch || !ref.current) return;
    const b = board.getBoundingClientRect();
    const r = stretch.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    setPos({ left: Math.max(16, Math.min(r.left - b.left + r.width / 2 - w / 2, b.width - w - 16)), bottom: b.bottom - r.top + 6 });
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
  const inside = [...c.inside].sort((a, b) => b.spent - a.spent);
  return (
    <div ref={ref} className="topic-peek" role="dialog" aria-label={c.title} style={pos}>
      <div className="topic-now-head">
        <span className="topic-peek-at">{props.at}</span>
        {head ? (
          <span className={`topic-outcome ${head.outcome}`}>{OUTCOME[head.outcome]}</span>
        ) : (
          <span className="topic-outcome">{c.inside.length} topics</span>
        )}
        {c.spent >= 60_000 && <span className="topic-mins">{fmtDuration(c.spent)}</span>}
        {props.elsewhere && <span className="topic-mins topic-peek-item">· {props.elsewhere}</span>}
      </div>
      <strong className="topic-peek-title">{c.title}</strong>
      {showHead && head!.positions.length > 0 && (
        <div className="topic-peek-positions">
          {head!.positions.slice(0, MAX_POSITIONS).map((p) => (
            <div key={p.speaker}>
              <Dot id={props.idOf(p.speaker)} name={p.speaker} size={18} />
              <span>{p.position}</span>
            </div>
          ))}
        </div>
      )}
      {showHead && props.notesOf(c.head!).length > 0 && <NoteList notes={props.notesOf(c.head!)} max={PEEK_NOTES} />}
      {inside.length > 0 && (
        <div className={showHead ? "topic-peek-inside" : "topic-peek-inside group"}>
          {inside.slice(0, PEEK_TOPICS).map((t) => (
            <div key={t.d.id} className="topic-peek-sub">
              <span className="topic-peek-sub-title">{t.d.topic}</span>
              {props.notesOf(t).length > 0 && <NoteList notes={props.notesOf(t)} max={PEEK_TOPIC_NOTES} />}
            </div>
          ))}
          {inside.length > PEEK_TOPICS && <span className="topic-more">+{inside.length - PEEK_TOPICS} more topics</span>}
        </div>
      )}
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

type Arrival = "new" | "back" | null;
/** How long "New topic" or "Back to" stays up after the board switches. */
const ARRIVAL_MS = 8_000;

/** For a few seconds after the board switches topic: "new" for a topic this screen hasn't shown
 *  before, "back" for one it showed earlier. The first topic of the meeting counts as new. */
function useArrival(id: string | null): Arrival {
  const prev = useRef(id);
  const seen = useRef(new Set<string>(id ? [id] : []));
  const [arrival, setArrival] = useState<Arrival>(null);
  useEffect(() => {
    if (prev.current === id) return;
    const had = prev.current;
    prev.current = id;
    if (!id) return setArrival(null);
    // A rename keeps the id; a run regrouping it under a new id while nothing was on screen isn't a switch.
    const kind: Arrival = seen.current.has(id) ? "back" : "new";
    seen.current.add(id);
    if (!had && kind === "back") return;
    setArrival(kind);
    const t = setTimeout(() => setArrival(null), ARRIVAL_MS);
    return () => clearTimeout(t);
  }, [id]);
  return arrival;
}

function Dot({ id, name, size }: { id: string; name: string; size: number }) {
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.5)), background: colorFor(id) } as CSSProperties;
  return (
    <span className="topic-dot" style={style} title={name}>
      {initials(name)}
    </span>
  );
}
