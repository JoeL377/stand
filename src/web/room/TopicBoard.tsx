// The topic board: what the middle screen shows while nobody shares or presents. One card for
// the thread of discussion the group is on (server/board.ts): a title that stays put, a paragraph
// Stand keeps up to date every 30 seconds as the talk moves on, then fixed sections (where each
// person stands, decided, to do, open), and the point being made right now at its foot. An update
// changes single sentences and lines and leaves the rest where it is: a new line slides in with a
// green mark, a reworded one gets a short underline, so people see what changed without rereading. Underneath, a chapter bar runs from the start of the
// meeting to now, one stretch per thread; hovering or clicking one opens it on your own screen.
// The Decided, To do and Open tabs keep the whole meeting: they read the running list
// (server/liveList.ts), which has a line up about 5 s after it's said and never rewords or regroups
// it (the live notes when there's no list). The current topic's lines come first, oldest at the top,
// so a new one joins at the foot of the list with a short glow and nothing moves; the rest fold into
// "Earlier". While someone's pointer is on a list, new lines wait behind a "2 new" pill. An answered
// question folds into its decision and a checked to-do into "Done", each after a moment in place.
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import type { Board, BoardDetail, BoardThread, FollowUp, Item, ListNote, Note, Participant, Segment } from "../../shared/protocol.ts";
import { barSpan } from "../../shared/chapters.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtDuration, initials, keyOf } from "../util.ts";

/** Talk older than this isn't "now" any more. */
const NOW_MS = 120_000;
/** Remarks the middle shows before the first card. */
const WARMUP_REMARKS = 4;
const PEEK_DETAILS = 3;
/** How long "New topic" or "Back to" stays up after the board switches. */
const ARRIVAL_MS = 8_000;
/** How long a new line keeps its green mark, and a reworded one its underline. */
const NEW_MS = 10_000;
const CHANGED_MS = 4_000;
/** Live notes write a line down a little after it's said; this much past a stretch still counts as its topic. */
const TOPIC_SLACK_MS = 45_000;
/** Lines of the topic on screen shown before the older ones join "Earlier". */
const HERE_SHOWN = 5;
/** How long a new to-do, decision or question glows. */
const TASK_NEW_MS = 3_000;
/** How long an answered question or a checked to-do stays in place before it leaves: the
 *  question for its decision, the to-do for the Done fold. */
const LEAVE_MS = 4_000;
const MARK: Record<BoardDetail["kind"], string> = { position: "", decided: "✓", todo: "○", open: "?" };
const MARK_LABEL: Record<BoardDetail["kind"], string> = { position: "", decided: "Decided", todo: "To do", open: "Open question" };
const DETAIL_ORDER: Record<BoardDetail["kind"], number> = { position: 0, decided: 1, todo: 2, open: 3 };
const SECTIONS = [
  { kind: "decided", label: "Decided" },
  { kind: "todo", label: "To do" },
  { kind: "open", label: "Open" },
] as const;

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
  /** Make the move the board is waiting to confirm, for everyone. */
  onAcceptMove?: (title: string) => void;
  /** This meeting's to-dos, decisions and questions so far, as live notes caught them. */
  notes?: Note[];
  /** Open to-dos from earlier meetings in this space. */
  followUps?: FollowUp[];
  /** Check a to-do off, or back on. Anyone on the call. */
  onDone?: (noteId: string, done: boolean) => void;
  /** Host only: take a line off that Stand got wrong (with Undo). */
  onRemove?: (note: Note) => void;
}) {
  const now = useNow(15_000);
  const board = props.board;
  const threads = board?.threads ?? [];
  const onBoard = threads.find((t) => t.id === board?.currentId) ?? null;
  // After the host moves to another agenda item, the old card steps aside until that item has its own.
  const current = onBoard && onBoard.itemId === props.focusItemId ? onBoard : null;
  const arrival = useArrival(current?.id ?? null);
  const [view, setView] = useBoardView();
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
  const tasks = useTasks(props.notes ?? [], props.followUps ?? [], current, live ? now : 0, start);
  const acts: TaskActs = { onDone: props.onDone, onRemove: props.onRemove, start };

  return (
    <div ref={boardRef} className={shown ? "topic-board peeking" : "topic-board"}>
      {current ? (
        <Card
          t={current}
          live={live}
          updating={!!board?.busy}
          pending={board?.pending ?? null}
          onAcceptMove={props.onAcceptMove}
          view={view}
          onView={setView}
          threads={threads}
          meetingStart={start}
          arrival={arrival}
          tasks={tasks}
          acts={acts}
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
    <div className={board?.busy ? "topic-strip updating" : "topic-strip"} role="status" title={t.card.summary.join(" ")}>
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
  /** A move the board waits one more pass to confirm: shown faintly, a click makes it now. */
  pending: Board["pending"];
  onAcceptMove?: (title: string) => void;
  /** How this person likes the board laid out; the same data either way. */
  view: BoardView;
  onView: (v: BoardView) => void;
  /** Every thread so far, for the running feed. */
  threads: BoardThread[];
  meetingStart: number;
  /** The meeting's to-dos, decisions and questions for the tabs and columns. */
  tasks: Tasks;
  acts: TaskActs;
  speaking: { name: string; id: string; text: string } | null;
  idOf: (name: string) => string;
  nameOf: (name: string) => string;
}) {
  const { t } = props;
  const label = props.arrival === "new" ? "New topic" : props.arrival === "back" ? "Back to" : props.live ? "Now" : "Last";
  const marks = useChanges(t);
  const positions = t.card.details.filter((d) => d.kind === "position");
  const said = splitNow(t.card.now);
  const foot = props.speaking
    ? { name: props.speaking.name, id: props.speaking.id, text: props.speaking.text, now: true }
    : said.text
      ? { name: said.who ? props.nameOf(said.who) : null, id: said.who ? props.idOf(said.who) : "", text: said.text, now: false }
      : null;
  return (
    <section
      key={t.id}
      className={["topic-now", props.arrival && "topic-in", props.updating && "updating", props.view === "feed" && "feed"].filter(Boolean).join(" ")}
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
        <ViewSwitch view={props.view} onView={props.onView} />
      </div>
      {props.view === "feed" ? (
        <Feed threads={props.threads} current={t} marks={marks} start={props.meetingStart} idOf={props.idOf} nameOf={props.nameOf} />
      ) : (
        <>
      <h2 className="topic-now-title" aria-live="polite">
        {t.title}
      </h2>
      <p className="topic-summary" title="Stand writes this from the talk and keeps it up to date">
        <span className="agent-mark" aria-hidden>
          ✦
        </span>{" "}
        {t.card.summary.map((x, i) => (
          <span key={i} className={mark(marks.get(`s${i}`))}>
            {x}{" "}
          </span>
        ))}
      </p>
      {props.view === "card" ? (
        <CardTabs t={t} marks={marks} tasks={props.tasks} acts={props.acts} idOf={props.idOf} nameOf={props.nameOf} />
      ) : (
        <div className="topic-sections columns">
          <div className="topic-section position">
            <span className="topic-section-label">People</span>
            {positions.length ? <Details details={positions} marks={marks} idOf={props.idOf} nameOf={props.nameOf} /> : <span className="topic-section-empty">–</span>}
          </div>
          {SECTIONS.map((sec) => (
            <div key={sec.kind} className={`topic-section ${sec.kind}`}>
              <span className="topic-section-label">
                {sec.label} {props.tasks.count[sec.kind] > 0 && <span className="topic-tab-count">{props.tasks.count[sec.kind]}</span>}
              </span>
              <TaskList kind={sec.kind} tasks={props.tasks} acts={props.acts} idOf={props.idOf} nameOf={props.nameOf} compact />
            </div>
          ))}
        </div>
      )}
        </>
      )}
      {props.pending && (
        <button
          key={props.pending.title}
          type="button"
          className="topic-moving"
          disabled={!props.onAcceptMove}
          onClick={() => props.onAcceptMove?.(props.pending!.title)}
          title="Switch the board to it now, for everyone"
        >
          <span className="agent-mark" aria-hidden>
            ✦
          </span>{" "}
          {props.pending.kind === "return" ? "Looks like you're back on " : "Looks like you've moved to "}
          <strong>{props.pending.title}</strong>
          <span className="topic-moving-go" aria-hidden>
            Switch →
          </span>
        </button>
      )}
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

type Mark = "new" | "changed";
const mark = (m: Mark | undefined) => (m === "new" ? "topic-new" : m === "changed" ? "topic-changed" : undefined);

/** What the last updates added or reworded on a card, by sentence ("s0") and line id, while each
 *  keeps its mark. The first version of a card on this screen isn't a change. */
function useChanges(t: BoardThread): Map<string, Mark> {
  const prev = useRef<{ id: string; text: Map<string, string> } | null>(null);
  const [marks, setMarks] = useState<Map<string, { mark: Mark; until: number }>>(new Map());
  const text = new Map<string, string>([...t.card.summary.map((x, i) => [`s${i}`, x] as const), ...t.card.details.map((d) => [d.id, d.text] as const)]);
  const sig = [...text].map(([k, v]) => `${k}\u0000${v}`).join("\u0001");
  useEffect(() => {
    const before = prev.current;
    prev.current = { id: t.id, text };
    if (!before || before.id !== t.id) return setMarks(new Map());
    const now = Date.now();
    setMarks((m) => {
      const next = new Map([...m].filter(([k, v]) => v.until > now && text.has(k)));
      for (const [k, v] of text) {
        if (!before.text.has(k)) next.set(k, { mark: "new", until: now + NEW_MS });
        else if (before.text.get(k) !== v) next.set(k, { mark: "changed", until: now + CHANGED_MS });
      }
      return next;
    });
  }, [t.id, sig]);
  // Clear each mark when its time is up.
  useEffect(() => {
    if (!marks.size) return;
    const soonest = Math.min(...[...marks.values()].map((v) => v.until));
    const timer = setTimeout(() => setMarks((m) => new Map([...m].filter(([, v]) => v.until > Date.now()))), Math.max(0, soonest - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [marks]);
  return new Map([...marks].map(([k, v]) => [k, v.mark]));
}

function Details(props: { details: BoardDetail[]; marks?: Map<string, Mark>; idOf: (name: string) => string; nameOf: (name: string) => string; small?: boolean; feed?: boolean }) {
  return (
    <ul className={["topic-details", props.small && "small", props.feed && "feed"].filter(Boolean).join(" ")}>
      {props.details.map((d) => (
        <li key={d.id} className={[d.kind, mark(props.marks?.get(d.id))].filter(Boolean).join(" ")}>
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

const TABS = [{ kind: "position", label: "People" }, ...SECTIONS] as const;
type Tab = (typeof TABS)[number]["kind"];
const TAB_KEY = "stand.boardTab";

/** Under the summary: one tab per part of the card, each with its count, so only one list is
 *  on screen at a time. A tab that got a new line has a green dot until it's opened or the mark
 *  runs out. The open tab is this person's, remembered in this browser. */
function CardTabs(props: { t: BoardThread; marks: Map<string, Mark>; tasks: Tasks; acts: TaskActs; idOf: (name: string) => string; nameOf: (name: string) => string }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return TABS.some((x) => x.kind === v) ? (v as Tab) : "position";
    } catch {
      return "position";
    }
  });
  const pick = (k: Tab) => {
    setTab(k);
    try {
      localStorage.setItem(TAB_KEY, k);
    } catch {
      // Not remembered; it still switches.
    }
  };
  const people = props.t.card.details.filter((d) => d.kind === "position");
  return (
    <div className="topic-tabs-wrap">
      <div className="topic-tabs" role="tablist" aria-label="Details">
        {TABS.map((x) => {
          const n = x.kind === "position" ? people.length : props.tasks.count[x.kind];
          const fresh =
            x.kind !== tab &&
            (x.kind === "position" ? people.some((d) => props.marks.get(d.id) === "new") : props.tasks.rows[x.kind].some((r) => props.tasks.fresh.has(r.note.id)));
          return (
            <button key={x.kind} type="button" role="tab" aria-selected={tab === x.kind} className={[tab === x.kind && "on", !n && "empty"].filter(Boolean).join(" ")} onClick={() => pick(x.kind)}>
              {x.label}
              <span className="topic-tab-count">{n}</span>
              {fresh && <span className="topic-tab-new" aria-label="new" />}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="topic-tab-panel">
        {tab === "position" ? (
          people.length ? <Details details={people} marks={props.marks} idOf={props.idOf} nameOf={props.nameOf} /> : <span className="topic-section-empty">Nothing yet</span>
        ) : (
          <TaskList kind={tab} tasks={props.tasks} acts={props.acts} idOf={props.idOf} nameOf={props.nameOf} />
        )}
      </div>
    </div>
  );
}

type TaskKind = Exclude<BoardDetail["kind"], "position">;
const TASK_KIND: Partial<Record<Note["kind"], TaskKind>> = { decision: "decided", action: "todo", question: "open" };
interface TaskRow {
  note: Note;
  kind: TaskKind;
  /** When it was said, as near as Stand knows: the quote's time, else when live notes caught it. */
  at: number;
  /** Said while the group was on the topic on screen. */
  here: boolean;
  /** Answered or dropped a moment ago: on its way off. */
  leaving: boolean;
  /** A to-do checked off a while ago: in the Done fold. */
  done: boolean;
  /** A decision that settled an open question: the question. */
  answers: string | null;
}
interface Tasks {
  rows: Record<TaskKind, TaskRow[]>;
  /** What each tab's count says: open to-dos, every decision and question. */
  count: Record<TaskKind, number>;
  /** Lines that came in since this screen first showed the meeting, while each keeps its mark. */
  fresh: Set<string>;
  /** To-dos from earlier meetings still open, and any checked off during this one. */
  earlier: FollowUp[];
}
interface TaskActs {
  onDone?: (noteId: string, done: boolean) => void;
  onRemove?: (note: Note) => void;
  start: number;
}

/** The meeting's to-dos, decisions and questions, sorted for the board: the topic on screen
 *  first, oldest at the top, then the rest of the meeting, newest first. An answered or dropped
 *  line stays LEAVE_MS before it goes; a checked to-do LEAVE_MS before it folds into Done. */
function useTasks(notes: Note[], followUps: FollowUp[], current: BoardThread | null, liveNow: number, start: number): Tasks {
  const fresh = useFresh(notes.filter((n) => TASK_KIND[n.kind]).map((n) => n.id), TASK_NEW_MS);
  const now = useUntil([...notes.map((n) => (n as Partial<ListNote>).closed?.at ?? 0), ...notes.map((n) => n.doneAt ?? 0)].map((t) => t + LEAVE_MS));
  const spans = (current?.spans ?? []).map(([a, b], i, all) => [a, i === all.length - 1 && liveNow ? Math.max(b, liveNow) : b] as const);
  const here = (n: Note, at: number) => n.itemId === current?.itemId && spans.some(([a, b]) => at >= a && at <= b + TOPIC_SLACK_MS);
  const rows: Tasks["rows"] = { decided: [], todo: [], open: [] };
  const questions = new Map(notes.filter((n) => n.kind === "question").map((n) => [n.id, n.text]));
  for (const note of notes) {
    const kind = TASK_KIND[note.kind];
    if (!kind) continue;
    const closed = (note as Partial<ListNote>).closed;
    const leaving = !!closed && now - closed.at < LEAVE_MS;
    if (closed && !leaving) continue;
    const answers = (note as Partial<ListNote>).answers;
    const at = note.quote?.ts ?? note.ts;
    rows[kind].push({
      note,
      kind,
      at: Math.max(at, start),
      here: here(note, at),
      leaving,
      done: !!note.doneAt && now - note.doneAt >= LEAVE_MS,
      answers: answers ? (questions.get(answers) ?? null) : null,
    });
  }
  for (const k of Object.keys(rows) as TaskKind[]) rows[k].sort((a, b) => a.at - b.at);
  return {
    rows,
    count: { decided: rows.decided.length, todo: rows.todo.filter((r) => !r.note.doneAt).length, open: rows.open.filter((r) => !r.leaving).length },
    fresh,
    earlier: followUps,
  };
}

/** The time now, brought up to date again at each of these moments as it passes. */
function useUntil(moments: number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = Math.min(...moments.filter((t) => t > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 30);
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}

/** Ids that weren't there when this screen first had the list, for NEW_MS after they arrive. */
function useFresh(ids: string[], ms = NEW_MS): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const sig = ids.join(" ");
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current!.has(id));
    if (!added.length) return;
    for (const id of added) seen.current.add(id);
    const until = Date.now() + ms;
    setFresh((m) => new Map([...m, ...added.map((id) => [id, until] as const)]));
  }, [sig]);
  useEffect(() => {
    if (!fresh.size) return;
    const soonest = Math.min(...fresh.values());
    const timer = setTimeout(() => setFresh((m) => new Map([...m].filter(([, until]) => until > Date.now()))), Math.max(0, soonest - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [fresh]);
  return new Set(fresh.keys());
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** One tab's or column's lines: the topic on screen first, oldest at the top so a new line joins
 *  at the foot, then "Earlier" (folded) and "Done" (folded). To-dos get a box anyone can tick; the
 *  host can take off a line Stand got wrong. While the pointer is on the list, new lines wait behind
 *  a pill so nothing moves under it. */
function TaskList(props: { kind: TaskKind; tasks: Tasks; acts: TaskActs; idOf: (name: string) => string; nameOf: (name: string) => string; compact?: boolean }) {
  const [openEarlier, setOpenEarlier] = useState(false);
  const [openDone, setOpenDone] = useState(false);
  const [past, setPast] = useState(false);
  // Lines on screen when the pointer came onto the list; null while it's elsewhere.
  const [held, setHeld] = useState<Set<string> | null>(null);
  const all = props.tasks.rows[props.kind];
  const rows = held ? all.filter((r) => held.has(r.note.id)) : all;
  const waiting = held ? all.filter((r) => !held.has(r.note.id) && !r.leaving).length : 0;
  const live = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done);
  const hereAll = live.filter((r) => r.here);
  const here = hereAll.slice(-HERE_SHOWN);
  // Older lines of this topic past HERE_SHOWN join the rest of the meeting, newest first.
  const rest = [...hereAll.slice(0, -HERE_SHOWN || hereAll.length), ...live.filter((r) => !r.here)].sort((a, b) => b.at - a.at);
  // Nothing from this topic yet: the rest of the meeting shows, without a fold to open first.
  const restOpen = openEarlier || !here.length;
  const earlier = props.kind === "todo" ? props.tasks.earlier : [];
  const earlierOpen = earlier.filter((f) => !f.doneAt).length;
  if (!all.length && !earlier.length) return <span className="topic-section-empty">{props.compact ? "–" : "Nothing yet"}</span>;
  const row = (note: Note, opts: { at: string; r?: TaskRow; removable?: boolean }) => (
    <li
      key={note.id}
      className={[props.kind, "topic-task", opts.r?.here && "here", note.doneAt && "done", opts.r?.leaving && "leaving", props.tasks.fresh.has(note.id) && "topic-new"].filter(Boolean).join(" ")}
    >
      {props.kind === "todo" ? (
        <button
          type="button"
          className="topic-check"
          aria-pressed={!!note.doneAt}
          aria-label={note.doneAt ? `Done${note.doneBy ? ` (${note.doneBy})` : ""}. Mark not done` : "Mark done"}
          title={note.doneAt ? `Done${note.doneBy ? ` by ${note.doneBy}` : ""}` : "Mark done"}
          disabled={!props.acts.onDone}
          onClick={() => props.acts.onDone?.(note.id, !note.doneAt)}
        />
      ) : (
        <span className="topic-note-mark" aria-label={opts.r?.leaving ? "Answered" : MARK_LABEL[props.kind]}>
          {opts.r?.leaving ? "✓" : MARK[props.kind]}
        </span>
      )}
      <span className="topic-task-text">{note.text}</span>
      {opts.r?.answers && (
        <span className="topic-task-answers" title={`Answers: ${opts.r.answers}`}>
          Answered
        </span>
      )}
      {note.owner && <Dot id={props.idOf(note.owner)} name={props.nameOf(note.owner)} size={18} />}
      <span className="topic-task-at">{opts.at}</span>
      {opts.removable && props.acts.onRemove && !opts.r?.leaving && (
        <button type="button" className="topic-task-remove" aria-label="Remove" title="Remove: Stand got this wrong" onClick={() => props.acts.onRemove?.(note)}>
          ×
        </button>
      )}
    </li>
  );
  const atOf = (r: TaskRow) => clock(r.at - props.acts.start);
  const fold = (label: string, n: number, open: boolean, toggle: () => void) => (
    <li className="topic-tasks-more">
      <button type="button" aria-expanded={open} onClick={toggle}>
        {label} · {n} <span aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
    </li>
  );
  return (
    <ul
      className={["topic-details", "topic-tasks", props.compact && "compact", here.length > 0 && "has-here"].filter(Boolean).join(" ")}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHeld(new Set(all.map((r) => r.note.id)))}
      onPointerLeave={() => setHeld(null)}
    >
      {here.map((r) => row(r.note, { at: atOf(r), r, removable: true }))}
      {waiting > 0 && (
        <li className="topic-tasks-waiting">
          <button type="button" onClick={() => setHeld(null)}>
            {waiting} new
          </button>
        </li>
      )}
      {rest.length > 0 && here.length > 0 && fold("Earlier", rest.length, openEarlier, () => setOpenEarlier((o) => !o))}
      {restOpen && rest.map((r) => row(r.note, { at: atOf(r), r, removable: true }))}
      {done.length > 0 && fold("Done", done.length, openDone, () => setOpenDone((o) => !o))}
      {openDone && done.map((r) => row(r.note, { at: atOf(r), r }))}
      {earlier.length > 0 && fold("From earlier meetings", earlierOpen, past, () => setPast((p) => !p))}
      {past && earlier.map((f) => row(f, { at: shortDate(f.meetingStartedAt) }))}
    </ul>
  );
}

export type BoardView = "card" | "columns" | "feed";
const VIEWS: Array<{ id: BoardView; label: string }> = [
  { id: "card", label: "Card" },
  { id: "columns", label: "Columns" },
  { id: "feed", label: "Feed" },
];
const VIEW_KEY = "stand.boardView";

/** The layout this person picked, remembered in this browser. */
function useBoardView(): [BoardView, (v: BoardView) => void] {
  const [view, setView] = useState<BoardView>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return VIEWS.some((x) => x.id === v) ? (v as BoardView) : "card";
    } catch {
      return "card";
    }
  });
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        // Not remembered; it still switches.
      }
    },
  ];
}

function ViewSwitch(props: { view: BoardView; onView: (v: BoardView) => void }) {
  return (
    <span className="topic-views" role="group" aria-label="Board layout, on your screen only">
      {VIEWS.map((v) => (
        <button key={v.id} type="button" className={props.view === v.id ? "on" : undefined} aria-pressed={props.view === v.id} onClick={() => props.onView(v.id)}>
          {v.label}
        </button>
      ))}
    </span>
  );
}

/** The running feed: every thread so far in order, each line where it came in, newest at the bottom. */
function Feed(props: { threads: BoardThread[]; current: BoardThread; marks: Map<string, Mark>; start: number; idOf: (name: string) => string; nameOf: (name: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const order = [...props.threads].sort((a, b) => (a.spans[0]?.[0] ?? 0) - (b.spans[0]?.[0] ?? 0));
  const shown = [...order.filter((t) => t !== props.current), props.current];
  const count = shown.reduce((n, t) => n + t.card.details.length + t.card.summary.length, 0);
  // Stay at the newest unless the person has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count, props.current.id]);
  const byArrival = (a: BoardDetail, b: BoardDetail) => (Number(a.id.slice(1)) || 0) - (Number(b.id.slice(1)) || 0);
  return (
    <div ref={ref} className="topic-feed" onScroll={(e) => (pinned.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)}>
      {shown.map((t) => {
        const isCurrent = t === props.current;
        return (
          <section key={t.id} className={isCurrent ? "topic-feed-thread current" : "topic-feed-thread"}>
            <div className="topic-feed-head">
              <span className="topic-peek-at">{clock((t.spans[0]?.[0] ?? props.start) - props.start)}</span>
              <strong>{t.title}</strong>
            </div>
            {isCurrent && (
              <p className="topic-feed-summary">
                <span className="agent-mark" aria-hidden>
                  ✦
                </span>{" "}
                {t.card.summary.map((x, i) => (
                  <span key={i} className={mark(props.marks.get(`s${i}`))}>
                    {x}{" "}
                  </span>
                ))}
              </p>
            )}
            {t.card.details.length > 0 && (
              <Details details={[...t.card.details].sort(byArrival)} marks={isCurrent ? props.marks : undefined} idOf={props.idOf} nameOf={props.nameOf} feed />
            )}
          </section>
        );
      })}
    </div>
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
      <p className="topic-peek-summary">{t.card.summary.join(" ")}</p>
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
