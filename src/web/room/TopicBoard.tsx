// The topic board: what the middle screen shows while nobody shares or presents. One card for
// the thread of discussion the group is on (server/board.ts): a title that stays put, a paragraph
// Stand rewrites every 30 seconds as the talk moves on, a few details under it, and the point being
// made right now at its foot. Sentences new since the last update glow for a moment, so people
// can see what changed without rereading. Underneath, a chapter bar runs from the start of the
// meeting to now, one stretch per thread; hovering or clicking one opens it on your own screen.
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import type { Board, BoardDetail, BoardThread, Item, Participant, Segment } from "../../shared/protocol.ts";
import { barSpan } from "../../shared/chapters.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtDuration, initials, keyOf } from "../util.ts";

/** Talk older than this isn't "now" any more. */
const NOW_MS = 120_000;
/** Remarks the middle shows before the first card. */
const WARMUP_REMARKS = 4;
const MAX_DETAILS = 6;
const PEEK_DETAILS = 3;
/** How long "New topic" or "Back to" stays up after the board switches. */
const ARRIVAL_MS = 8_000;
/** How long a sentence the last update changed keeps its glow. */
const GLOW_MS = 4_000;
const MARK: Record<BoardDetail["kind"], string> = { position: "", decided: "✓", todo: "○", open: "?", ref: "↗" };
const MARK_LABEL: Record<BoardDetail["kind"], string> = { position: "", decided: "Decided", todo: "To do", open: "Open question", ref: "Mentioned" };
const DETAIL_ORDER: Record<BoardDetail["kind"], number> = { position: 0, decided: 1, todo: 2, open: 3, ref: 4 };

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
const spent = (t: BoardThread) => t.spans.reduce((ms, [a, b]) => ms + (b - a), 0);
/** "Andy: building it in Stand means merging" as who and what. */
const splitNow = (now: string) => {
  const m = /^([^:]{1,30}):\s*(.+)$/.exec(now.trim());
  return m ? { who: m[1].trim(), text: m[2] } : { who: null, text: now.trim() };
};

export function TopicBoard(props: {
  board: Board | null;
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
  const board = props.board;
  const threads = board?.threads ?? [];
  const onBoard = threads.find((t) => t.id === board?.currentId) ?? null;
  // After the host moves to another agenda item, the old card steps aside until that item has its own.
  const current = onBoard && onBoard.itemId === props.focusItemId ? onBoard : null;
  const arrival = useArrival(current?.id ?? null);
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.participants.find((p) => same(p.name, name))?.id ?? name;
  const nameOf = (name: string) => props.participants.find((p) => same(p.name, name))?.name ?? props.segments.find((s) => same(s.speakerName, name))?.speakerName ?? name;
  const [peek, setPeek] = useState<{ id: string; key: string; pinned: boolean } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const latest = props.segments.at(-1);
  const live = !!latest && now - latest.ts < NOW_MS;
  const speaking = Object.values(props.interims).find((i) => i.text.trim());
  const stretches = threads
    .flatMap((t) => t.spans.map(([from, to]) => ({ id: t.id, from, to: t.id === current?.id && live ? Math.max(to, now) : to })))
    .sort((a, b) => a.from - b.from);
  const start = Math.min(props.meetingStartedAt, stretches[0]?.from ?? Infinity);
  // The bar spans a set length, longer as the meeting runs on, so talk fills it from the left.
  const span = barSpan(now - start);
  const peeked = peek ? threads.find((t) => t.id === peek.id) : undefined;
  const shown = peeked && peeked !== current ? peeked : null;
  // Before the first card for the item in focus, the middle shows the talk so far.
  const talkSoFar = current ? [] : props.segments.filter((s) => s.itemId === props.focusItemId).slice(-WARMUP_REMARKS);
  const item = props.focusItem;

  return (
    <div ref={boardRef} className={shown ? "topic-board peeking" : "topic-board"}>
      {current ? (
        <Card
          t={current}
          live={live}
          updating={!!board?.busy}
          arrival={arrival}
          speaking={speaking ? { name: speaking.speakerName, id: speaking.speakerId, text: speaking.text } : null}
          idOf={idOf}
          nameOf={nameOf}
        />
      ) : talkSoFar.length || speaking ? (
        <Warmup
          remarks={talkSoFar.map((s) => ({ key: s.id, name: s.speakerName, id: idOf(s.speakerName), text: s.text, now: false }))}
          speaking={speaking && { key: "now", name: speaking.speakerName, id: speaking.speakerId, text: speaking.text, now: true }}
          updating={!!board?.busy}
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
          <p className={board?.busy ? "topic-hint updating" : "topic-hint"}>
            <span className="agent-mark small">✦</span> The topic shows up here as people talk
          </p>
        </div>
      )}
      {stretches.length > 0 && (
        <div className="topic-chapters">
          <div className="topic-bar" role="group" aria-label="Topics so far">
            <div className="topic-bar-elapsed" style={{ width: `${pct(now - start, span)}%` }} />
            {stretches.map((s) => {
              const t = threads.find((x) => x.id === s.id)!;
              const isCurrent = t === current;
              const key = `${s.id}-${s.from}`;
              const open = (pinned: boolean) => setPeek((p) => (p?.pinned && !pinned ? p : { id: s.id, key, pinned }));
              return (
                <button
                  key={key}
                  data-key={key}
                  type="button"
                  className={["topic-stretch", isCurrent && "current", isCurrent && arrival && "arrived", !isCurrent && "peekable", peek?.id === s.id && "on"].filter(Boolean).join(" ")}
                  style={{ left: `${pct(s.from - start, span)}%`, width: `${pct(s.to - s.from, span)}%` }}
                  aria-label={`${clock(s.from - start)}, ${t.title}${isCurrent ? ", now" : ""}`}
                  aria-expanded={isCurrent ? undefined : peek?.id === s.id}
                  title={isCurrent ? t.title : undefined}
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
          t={shown}
          at={clock((stretches.find((s) => `${s.id}-${s.from}` === peek.key)?.from ?? start) - start)}
          anchor={peek.key}
          elsewhere={shown.itemId !== props.focusItemId ? (props.items.find((i) => i.id === shown.itemId)?.title ?? "General") : null}
          idOf={idOf}
          nameOf={nameOf}
          boardRef={boardRef}
          onClose={() => setPeek(null)}
          pinned={peek.pinned}
        />
      )}
    </div>
  );
}

/** One line over a shared screen or a deck: the topic and the point being made, so the board
 *  isn't lost while something else has the middle. */
export function BoardStrip({ board, focusItemId }: { board: Board | null; focusItemId: string | null }) {
  const t = board?.threads.find((x) => x.id === board.currentId);
  if (!t || t.itemId !== focusItemId) return null;
  const { who, text } = splitNow(t.card.now);
  return (
    <div className={board?.busy ? "topic-strip updating" : "topic-strip"} role="status" title={t.card.summary}>
      <span className="agent-mark" aria-hidden>
        ✦
      </span>
      <strong className="topic-strip-title">{t.title}</strong>
      {text && (
        <span className="topic-strip-now">
          {who && <strong>{first(who)}</strong>} {text}
        </span>
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

/** The thread on screen: its title, the paragraph, the details, and who is saying what now. */
function Card(props: {
  t: BoardThread;
  live: boolean;
  /** The board is reading the latest talk: a light runs along the top edge. */
  updating: boolean;
  /** Just switched to: a thread new to this screen, or one it came back to. */
  arrival: Arrival;
  speaking: { name: string; id: string; text: string } | null;
  idOf: (name: string) => string;
  nameOf: (name: string) => string;
}) {
  const { t } = props;
  const label = props.arrival === "new" ? "New topic" : props.arrival === "back" ? "Back to" : props.live ? "Now" : "Last";
  const details = [...t.card.details].sort((a, b) => DETAIL_ORDER[a.kind] - DETAIL_ORDER[b.kind]).slice(0, MAX_DETAILS);
  const said = splitNow(t.card.now);
  const foot = props.speaking
    ? { name: props.speaking.name, id: props.speaking.id, text: props.speaking.text, now: true }
    : said.text
      ? { name: said.who ? props.nameOf(said.who) : null, id: said.who ? props.idOf(said.who) : "", text: said.text, now: false }
      : null;
  return (
    <section
      key={t.id}
      className={["topic-now", props.arrival && "topic-in", props.updating && "updating"].filter(Boolean).join(" ")}
      aria-label="Current topic"
      aria-busy={props.updating}
    >
      <div className="topic-now-head">
        <span key={label} className={["topic-now-label", props.live && "live", props.arrival && "arrived"].filter(Boolean).join(" ")}>
          {label}
        </span>
        {spent(t) >= 60_000 && <span className="topic-mins">{fmtDuration(spent(t))}</span>}
        <span className={props.updating ? "topic-updating on" : "topic-updating"} aria-hidden>
          <span className="agent-mark">✦</span> Updating
        </span>
      </div>
      <h2 className="topic-now-title" aria-live="polite">
        {t.title}
      </h2>
      <Summary key={t.id} text={t.card.summary} />
      {details.length > 0 && <Details details={details} idOf={props.idOf} nameOf={props.nameOf} />}
      {foot && (
        <p className={foot.now ? "topic-remark now" : "topic-remark"}>
          {foot.name && <Dot id={foot.id} name={foot.name} size={20} />}
          <span className="topic-remark-text">
            {foot.name && <strong>{first(foot.name)}</strong>}
            {foot.name && " · "}
            {foot.text}
          </span>
        </p>
      )}
    </section>
  );
}

/** The paragraph. A sentence that wasn't in the last version glows for a few seconds. */
function Summary({ text }: { text: string }) {
  const prev = useRef<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const before = prev.current;
    prev.current = text;
    // The first version on screen isn't a change.
    if (before === null || before === text) return;
    const had = new Set(sentences(before).map((s) => s.trim()));
    setFresh(new Set(sentences(text).map((s) => s.trim()).filter((s) => !had.has(s))));
    const timer = setTimeout(() => setFresh(new Set()), GLOW_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <p className="topic-summary" title="Stand writes this from the talk and keeps it up to date">
      <span className="agent-mark" aria-hidden>
        ✦
      </span>{" "}
      {sentences(text).map((s, i) => (
        <span key={`${i}-${s}`} className={fresh.has(s.trim()) ? "topic-fresh" : undefined}>
          {s}
        </span>
      ))}
    </p>
  );
}
const sentences = (text: string) => text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];

function Details(props: { details: BoardDetail[]; idOf: (name: string) => string; nameOf: (name: string) => string; small?: boolean }) {
  return (
    <ul className={props.small ? "topic-details small" : "topic-details"}>
      {props.details.map((d, i) => (
        <li key={`${d.kind}-${i}`} className={d.kind}>
          {d.kind === "position" && d.who ? (
            <Dot id={props.idOf(d.who)} name={props.nameOf(d.who)} size={props.small ? 18 : 20} />
          ) : (
            <span className="topic-note-mark" aria-label={MARK_LABEL[d.kind]}>
              {MARK[d.kind]}
            </span>
          )}
          <span>
            {d.kind === "position" && d.who && <strong>{first(props.nameOf(d.who))} </strong>}
            {d.text}
            {d.kind === "todo" && d.who && <span className="topic-owner"> · {first(props.nameOf(d.who))}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Warmup(props: {
  remarks: Array<{ key: string; name: string; id: string; text: string; now: boolean }>;
  speaking: { key: string; name: string; id: string; text: string; now: boolean } | undefined | false;
  updating: boolean;
}) {
  const rows = props.speaking ? [...props.remarks.slice(1 - WARMUP_REMARKS), props.speaking] : props.remarks;
  return (
    <section className={props.updating ? "topic-now topic-warmup updating" : "topic-now topic-warmup"} aria-label="Talk so far" aria-busy={props.updating}>
      <div className="topic-now-head">
        <span className="topic-now-label live">Now</span>
      </div>
      <div className="topic-warmup-talk">
        {rows.map((r) => (
          <p key={r.key} className={r.now ? "topic-remark now" : "topic-remark"}>
            <Dot id={r.id} name={r.name} size={20} />
            <span className="topic-remark-text">
              <strong>{first(r.name)}</strong> · {r.text}
            </span>
          </p>
        ))}
      </div>
      <p className={props.updating ? "topic-hint updating" : "topic-hint"}>
        <span className="agent-mark small">✦</span> Working out the topic
      </p>
    </section>
  );
}

/** A thread from earlier, opened from the bar on your own screen. */
function Peek(props: {
  t: BoardThread;
  /** When talk turned to it, into the meeting, at the stretch it was opened from. */
  at: string;
  /** The stretch of the bar it was opened from. */
  anchor: string;
  /** The agenda item it was under, when that isn't the one in focus. */
  elsewhere: string | null;
  pinned: boolean;
  idOf: (name: string) => string;
  nameOf: (name: string) => string;
  boardRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const { t } = props;
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
  const details = [...t.card.details].sort((a, b) => DETAIL_ORDER[a.kind] - DETAIL_ORDER[b.kind]).slice(0, PEEK_DETAILS);
  return (
    <div ref={ref} className="topic-peek" role="dialog" aria-label={t.title} style={pos}>
      <div className="topic-now-head">
        <span className="topic-peek-at">{props.at}</span>
        {spent(t) >= 60_000 && <span className="topic-mins">{fmtDuration(spent(t))}</span>}
        {props.elsewhere && <span className="topic-mins topic-peek-item">· {props.elsewhere}</span>}
      </div>
      <strong className="topic-peek-title">{t.title}</strong>
      <p className="topic-peek-summary">{t.card.summary}</p>
      {details.length > 0 && <Details details={details} idOf={props.idOf} nameOf={props.nameOf} small />}
    </div>
  );
}

type Arrival = "new" | "back" | null;

/** For a few seconds after the board switches: "new" for a thread this screen hasn't shown
 *  before, "back" for one it showed earlier. The first card of the meeting counts as new. */
function useArrival(id: string | null): Arrival {
  const prev = useRef(id);
  const seen = useRef(new Set<string>(id ? [id] : []));
  const [arrival, setArrival] = useState<Arrival>(null);
  useEffect(() => {
    if (prev.current === id) return;
    const had = prev.current;
    prev.current = id;
    if (!id) return setArrival(null);
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
