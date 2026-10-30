// The topic board: what the middle screen shows while nobody shares or presents. A stack of cards,
// one in focus at a time: the Kickoff, one card per thread of discussion (server/board.ts), and one per
// question asked to ✦ Stand (push-to-talk or @stand), its follow-ups landing on the same card. The card
// in focus follows the talk: the current topic, or an answer while it's being asked and for a few
// minutes after it lands, unless the talk moves to a new topic meanwhile. A topic card has a title that
// stays put, a paragraph Stand keeps up to date every 30 seconds, then the People/Decided/To do/Open tabs,
// and the point being made right now at its foot. An update changes single sentences and lines and
// leaves the rest where it is: a new line slides in with a green mark, a reworded one gets a short
// underline. A list down the left names every card, with the Running list (the whole meeting's to-dos,
// decisions and questions) pinned on top; clicking one, the arrow keys, or scrolling past the end of a
// card opens another on your own screen only (as it stood when it ended), until "Back to live" (which
// names a new card that went live meanwhile), Escape, or a click on the live one. The right-hand side
// stays folded. On a phone the list is a sheet behind a button over the card.
// The tabs keep the whole meeting: they read the running list (server/liveList.ts), which has a line up
// about 5 s after it's said and never rewords or regroups it (the live notes when there's no list). The
// current topic's lines come first, oldest at the top, so a new one joins at the foot of the list with a
// short glow and nothing moves; the rest fold into "Earlier". While someone's pointer is on a list, new
// lines wait behind a "2 new" pill. An answered question folds into its decision and a checked to-do
// into "Done", each after a moment in place.
import { type CSSProperties, Fragment, useEffect, useRef, useState } from "react";
import type { AgentCard, Board, BoardDetail, BoardMove, BoardThread, DoneDeck, FollowUp, Item, ListNote, Note, Participant, Segment } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtDuration, initials, keyOf } from "../util.ts";
import { Opener, type OpenerActs, hasKickoff, kickoffEnd, showOpener } from "./Opener.tsx";
import { SaidDonePill } from "../TaskMarks.tsx";
import { type AgentActs, AgentStatus, AnswerPart, cardFor, FindOptions, OptionsCard, SHOW_CARD } from "./AgentCard.tsx";

const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });

/** Talk older than this isn't "now" any more. */
const NOW_MS = 120_000;
/** Remarks the middle shows before the first card. */
const WARMUP_REMARKS = 4;
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
const SECTIONS = [
  { kind: "decided", label: "Decided" },
  { kind: "todo", label: "To do" },
  { kind: "open", label: "Open" },
] as const;

const first = (name: string) => name.split(/\s+/)[0];
const same = (a: string, b: string) => a === b || first(a).toLowerCase() === first(b).toLowerCase();

/** The move that opened a thread's stretch starting at `from` (or its latest one), unless it was the first thread. */
export function moveInto(moves: BoardMove[] | undefined, threadId: string, from?: number): BoardMove | null {
  const into = (moves ?? []).filter((m) => m.threadId === threadId && (from === undefined || m.from <= from));
  const m = into.at(-1);
  return m && m.via !== "first" ? m : null;
}
/** "Stand moved on", "Janesh moved on", "Joe changed the agenda item". */
export function moverText(m: BoardMove): string {
  const who = m.by ? first(m.by) : "Stand";
  return m.via === "agenda" ? `${who} changed the agenda item` : `${who} moved on`;
}

/** Who moved the board onto this thread: ✦ Stand by itself, or a person. */
function MovedBy({ move, start, nameOf, idOf }: { move: BoardMove | null; start: number; nameOf: (n: string) => string; idOf: (n: string) => string }) {
  if (!move) return null;
  const title = `${move.by ? nameOf(move.by) : "Stand"} ${move.via === "agenda" ? "changed the agenda item" : move.via === "click" ? "took the move Stand offered" : "saw the talk had moved and moved the board by itself"} at ${clock(move.at - start)}`;
  return (
    <span className="topic-moved-by" title={title}>
      {move.by ? <Dot id={idOf(move.by)} name={nameOf(move.by)} size={16} /> : <span className="agent-mark" aria-hidden>✦</span>}
      {moverText(move)}
    </span>
  );
}
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

/** The Kickoff chapter's id on the bar. */
const KICKOFF = "kickoff";

/** The Running list's id in the card list. */
const RUNNING = "list";
/** An answer from ✦ Stand stays the live card this long after it lands, unless the talk starts a new topic. */
const ANSWER_HOLD_MS = 3 * 60_000;
/** How far a wheel or trackpad has to push past the end of a card before the next one comes up. */
const WHEEL_STEP = 120;
/** After the board steps to another card, the wheel rests this long so one flick moves one card. */
const WHEEL_REST_MS = 700;
/** How far a finger has to move sideways before a swipe opens the next card. */
const SWIPE_PX = 60;

/** One card in the stack: the Kickoff, a topic of discussion, or a question to ✦ Stand with its follow-ups. */
interface Entry {
  id: string;
  kind: "kickoff" | "topic" | "answer";
  title: string;
  /** When it started. */
  at: number;
  /** The moment the card shows as of when someone opens it from the list. */
  asOf: number;
  meta: string;
  chain?: AgentCard[];
}

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
  /** Anyone: a decision Stand heard is one (confirm), or isn't yet. Missing while the board can't say. */
  onConfirm?: (noteId: string) => void;
  onNotYet?: (noteId: string) => void;
  /** The opening board ("Done since" pages, then the "Since last time" check-in), and what turning and
   *  answering on it does (null while it can't be answered). */
  checkIn?: { closed: boolean; answeredAt: number | null; page?: number };
  checkInActs?: OpenerActs | null;
  doneDeck?: DoneDeck | null;
  /** ✦ Stand's cards (options on open questions, answers to questions asked out loud), and acting on them. */
  agent?: AgentActs;
  /** Following the host: the card they have open (null: live), by name. Unset: this screen goes its own way. */
  follow?: { rewind: Rewind | null; host: string } | null;
  /** Someone following the host opened something else here: their screen goes its own way from now. */
  onOwn?: () => void;
  /** The host: the card open on this screen changed (null: back on live), for everyone following. */
  onRewind?: (r: Rewind | null) => void;
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
  // A card opened from the list (or by the wheel): on this screen only, as it stood then, until "Back to live".
  // live: the card that was live when it was opened, so a new one since can be pointed out.
  // While following the host it's theirs; any look of your own here breaks off from them.
  const [ownRewind, setOwnRewind] = useState<Rewind | null>(null);
  const following = props.follow ?? null;
  const rewind = following ? following.rewind : ownRewind;
  const setRewind = (r: Rewind | null) => {
    setOwnRewind(r);
    if (following) props.onOwn?.();
  };
  const [listOpen, setListOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const latest = props.segments.at(-1);
  const live = !!latest && now - latest.ts < NOW_MS;
  const speaking = Object.values(props.interims).find((i) => i.text.trim());
  // The meeting opens on its Kickoff card: what got done since the last one, then what's still open from
  // earlier ones, until that's through, people move on, or the talk's own topic takes over.
  const cardSince = threads.length ? Math.min(...threads.flatMap((t) => t.spans.map(([a]) => a))) : null;
  const opening = { deck: props.doneDeck, followUps: props.followUps ?? [], meetingStartedAt: props.meetingStartedAt, checkIn: props.checkIn, cardSince, now };
  const checkingIn = showOpener(opening);
  const kickoff = hasKickoff(props.doneDeck, props.followUps ?? [], props.meetingStartedAt) ? { from: props.meetingStartedAt, to: kickoffEnd(opening) ?? now } : null;
  const [ownKickPage, setOwnKickPage] = useState(0);
  const kickPage = following?.rewind?.page ?? ownKickPage;
  const setKickPage = (page: number) => {
    setOwnKickPage(page);
    if (following) setRewind(rewind);
  };
  const start = Math.min(props.meetingStartedAt, cardSince ?? Infinity);
  // Questions asked to ✦ Stand, each with its follow-ups: one card per first question.
  const answers = (props.agent?.cards ?? []).filter((c) => c.kind === "answer" && !(c.status === "failed" && !c.question));
  const chains = new Map<string, AgentCard[]>();
  for (const c of answers) {
    let root = c;
    for (let hops = 0; root.follows && hops < 50; hops++) {
      const up = answers.find((x) => x.id === root.follows);
      if (!up) break;
      root = up;
    }
    chains.set(root.id, [...(chains.get(root.id) ?? []), c]);
  }
  // An answer takes the live card from the topic while it's being asked and for a while after it lands,
  // unless the talk has started a topic since.
  const topicSince = current?.spans.at(-1)?.[0] ?? 0;
  const liveChain = [...chains]
    .filter(([, ch]) => {
      const last = ch.at(-1)!;
      const busy = ch.some((c) => c.status === "listening" || c.status === "working");
      return last.at >= topicSince && (busy || now - (last.readyAt ?? last.at) < ANSWER_HOLD_MS);
    })
    .sort(([, a], [, b]) => a.at(-1)!.at - b.at(-1)!.at)
    .at(-1)?.[0];
  // This meeting's lines, as each card counts them: the ones said while it was the topic.
  const said = (props.notes ?? []).filter((n) => !(n as Partial<ListNote>).heard && !(n as Partial<ListNote>).closed);
  const inThread = (t: BoardThread, n: Note) => {
    const at = n.quote?.ts ?? n.ts;
    return n.itemId === t.itemId && t.spans.some(([a, b]) => at >= a && at <= b + TOPIC_SLACK_MS);
  };
  const counted = (t: BoardThread) => {
    const todo = said.filter((n) => n.kind === "action" && inThread(t, n)).length;
    const decided = said.filter((n) => n.kind === "decision" && inThread(t, n)).length;
    return [todo && `${todo} to do`, decided && `${decided} decided`].filter(Boolean).join(" · ");
  };
  const entries: Entry[] = [
    ...(kickoff
      ? [{ id: KICKOFF, kind: "kickoff" as const, title: props.doneDeck?.slides.length ? `Done since ${day(props.doneDeck.sinceStartedAt)}` : "Since last time", at: kickoff.from, asOf: kickoff.to, meta: "Kickoff" }]
      : []),
    ...threads.map((t) => {
      const at = Math.max(t.spans[0]?.[0] ?? start, kickoff?.to ?? 0);
      return { id: t.id, kind: "topic" as const, title: t.title, at, asOf: t.spans.at(-1)?.[1] ?? at, meta: [clock(at - start), counted(t)].filter(Boolean).join(" · ") };
    }),
    ...[...chains].map(([id, chain]) => ({
      id,
      kind: "answer" as const,
      title: chain[0].question || `${first(chain[0].by)} is asking Stand…`,
      at: chain[0].at,
      asOf: now,
      meta: [clock(chain[0].at - start), `✦ ${first(chain[0].by)}`, chain.length > 1 && `${chain.length} questions`].filter(Boolean).join(" · "),
      chain,
    })),
  ].sort((a, b) => a.at - b.at);
  const liveId = liveChain ?? (checkingIn ? KICKOFF : (current?.id ?? null));
  const shownId = rewind?.id ?? liveId;
  const open = (id: string) => {
    setListOpen(false);
    const e = entries.find((x) => x.id === id);
    if (id === RUNNING) return setRewind(rewind?.id === RUNNING ? null : { id, key: id, at: now, live: liveId });
    if (!e || id === liveId) return setRewind(null);
    setRewind({ id, key: id, at: e.asOf, live: liveId });
  };
  const index = entries.findIndex((e) => e.id === shownId);
  const step = (d: 1 | -1) => {
    const next = index < 0 ? (d < 0 ? entries.at(-1) : undefined) : entries[index + d];
    if (next) open(next.id);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  const shownEntry = entries[index] ?? null;
  const liveEntry = entries.find((e) => e.id === liveId) ?? null;
  const rewound = rewind ? (threads.find((t) => t.id === rewind.id) ?? null) : null;
  const rewoundKickoff = rewind?.id === KICKOFF;
  // A new card went live while this screen looks back: say so.
  const movedOn = rewind && liveEntry && rewind.live !== liveId && liveId !== rewind.id ? liveEntry : null;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Not while typing, while a deck takes the arrows, or while the board is out of sight.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || t?.closest("input, textarea, select, [contenteditable]") || !paneRef.current?.offsetParent) return;
      if (e.key === "Escape" && rewind) setRewind(null);
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        stepRef.current(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [rewind, !!following]);
  // Each card opens at its top.
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [shownId]);
  // The host's own look back goes out to everyone following them.
  const sent = rewind && { ...rewind, page: rewind.id === KICKOFF ? kickPage : undefined };
  const sentKey = JSON.stringify(sent);
  useEffect(() => {
    if (!following) props.onRewind?.(sent);
  }, [sentKey, !!following, !!props.onRewind]);
  const liveTasks = useTasks(props.notes ?? [], props.followUps ?? [], current, live ? now : 0, start);
  const pastTasks = useTasks(asOf(props.notes ?? [], rewind?.at ?? 0), props.followUps ?? [], rewound, 0, start);
  const allTasks = useTasks(props.notes ?? [], props.followUps ?? [], null, 0, start);
  const tasks = rewound ? pastTasks : liveTasks;
  const liveActs: TaskActs = {
    agent: props.agent,
    onDone: props.onDone,
    onRemove: props.onRemove,
    start,
    onCheckIn: props.checkInActs?.onOpen,
    onUndoSaid: props.checkInActs?.onUndoSaid,
    onConfirm: props.onConfirm,
    onNotYet: props.onNotYet,
  };
  const acts: TaskActs = rewound ? { start, agent: props.agent && { cards: props.agent.cards } } : liveActs;
  // The wheel scrolls a long card first; pushed on past its end, it steps to the next card.
  const wheel = useRef({ push: 0, at: 0 });
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const down = e.deltaY > 0;
    const atEnd = down ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2 : el.scrollTop <= 0;
    const w = wheel.current;
    if (!atEnd || Date.now() - w.at < WHEEL_REST_MS) return void (w.push = 0);
    w.push += e.deltaY;
    if (Math.abs(w.push) < WHEEL_STEP) return;
    w.push = 0;
    w.at = Date.now();
    step(down ? 1 : -1);
  };
  // On a phone a sideways swipe moves between cards, like a deck: left for the next, right for the one
  // before. The card follows the finger and the next one slides in from the side it came from. Swipes
  // that start on the Kickoff (its own pages turn sideways) or on a sideways-scrolling tab strip are left alone.
  const touch = useRef<{ x: number; y: number; sideways: boolean | null } | null>(null);
  const [drag, setDrag] = useState(0);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = e.touches.length === 1 && !(e.target as HTMLElement).closest(".opener, .topic-tabs, .opener-tabs, input, textarea") ? { x: t.clientX, y: t.clientY, sideways: null } : null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const from = touch.current;
    const t = e.touches[0];
    if (!from || !t) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    // Decided once per touch: sideways moves the card, anything else is an ordinary scroll.
    if (from.sideways === null && Math.abs(dx) + Math.abs(dy) > 10) from.sideways = Math.abs(dx) > 1.5 * Math.abs(dy);
    if (!from.sideways) return;
    // Past the first or the last card it gives a little and springs back.
    const end = dx < 0 ? !entries[index + 1] && index >= 0 : index <= 0;
    setDrag(end ? dx / 4 : dx);
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const from = touch.current;
    touch.current = null;
    setDrag(0);
    const t = e.changedTouches[0];
    if (!from?.sideways || !t) return;
    const dx = t.clientX - from.x;
    if (Math.abs(dx) > SWIPE_PX) step(dx < 0 ? 1 : -1);
  };
  // Which way the card on screen came in, so it slides from that side.
  const lastIndex = useRef(index);
  const cameFrom = index === lastIndex.current ? null : index > lastIndex.current ? "next" : "prev";
  useEffect(() => {
    lastIndex.current = index;
  }, [index]);
  const totals = `${allTasks.count.todo} to do · ${allTasks.count.decided} decided · ${allTasks.count.open} open`;

  const view =
    rewind?.id === RUNNING ? (
      <RunningList tasks={allTasks} acts={liveActs} idOf={idOf} nameOf={nameOf} />
    ) : shownEntry?.chain ? (
      <AnswerStack chain={shownEntry.chain} live={shownId === liveId} onTodo={rewind ? undefined : props.agent?.onTodo} />
    ) : rewoundKickoff ? (
      <Opener
        deck={props.doneDeck}
        followUps={props.followUps ?? []}
        meetingStartedAt={props.meetingStartedAt}
        page={kickPage}
        acts={{ onPage: setKickPage, onState: () => {}, onUndoSaid: () => {}, onClose: () => setRewind(null), onOpen: () => {} }}
        rewound
        onShowAll={
          props.checkInActs
            ? (page) => {
                props.checkInActs!.onOpen(page);
                setRewind(null);
              }
            : undefined
        }
      />
    ) : rewound ? (
      <Card
        t={rewound}
        live={false}
        rewoundAt={clock(rewind!.at - start)}
        movedBy={moveInto(board?.moves, rewound.id, rewind!.at)}
        updating={false}
        pending={null}
        meetingStart={start}
        arrival={null}
        tasks={tasks}
        acts={acts}
        speaking={null}
        idOf={idOf}
        nameOf={nameOf}
      />
    ) : checkingIn ? (
      <Opener
        deck={props.doneDeck}
        followUps={props.followUps ?? []}
        meetingStartedAt={props.meetingStartedAt}
        page={props.checkIn?.page ?? 0}
        acts={props.checkInActs ?? null}
        next={current?.title ?? null}
      />
    ) : current ? (
      <Card
        t={current}
        live={live}
        movedBy={moveInto(board?.moves, current.id)}
        updating={!!board?.busy}
        pending={board?.pending ?? null}
        onAcceptMove={props.onAcceptMove}
        meetingStart={start}
        arrival={arrival}
        tasks={tasks}
        acts={acts}
        speaking={speaking ? { name: speaking.speakerName, id: speaking.speakerId, text: speaking.text } : null}
        idOf={idOf}
        nameOf={nameOf}
      />
    ) : (
      <Waiting
        remarks={props.segments.filter((s) => s.itemId === props.focusItemId).slice(-WARMUP_REMARKS).map((s) => ({ key: s.id, name: s.speakerName, id: idOf(s.speakerName), text: s.text, now: false }))}
        speaking={speaking && { key: "now", name: speaking.speakerName, id: speaking.speakerId, text: speaking.text, now: true }}
        updating={!!board?.busy}
        item={props.focusItem}
      />
    );
  const before = index > 0 ? entries[index - 1] : null;
  const after = index >= 0 && index < entries.length - 1 ? entries[index + 1] : null;
  return (
    <div className={["topic-board", "stack", rewind && "rewinding", listOpen && "list-open"].filter(Boolean).join(" ")}>
      <nav className="card-list" aria-label="Cards in this meeting">
        <button type="button" className={rewind?.id === RUNNING ? "card-entry running on" : "card-entry running"} onClick={() => open(RUNNING)} aria-pressed={rewind?.id === RUNNING}>
          <span className="card-entry-mark" aria-hidden>
            ☰
          </span>
          <span className="card-entry-body">
            <span className="card-entry-title">Running list</span>
            <span className="card-entry-meta">{totals}</span>
          </span>
        </button>
        <span className="card-list-label">
          Cards <span className="card-list-count">{entries.length}</span>
        </span>
        {entries.map((e, i) => (
          <button
            key={e.id}
            type="button"
            className={["card-entry", e.kind, e.id === shownId && rewind?.id !== RUNNING && "on"].filter(Boolean).join(" ")}
            aria-current={e.id === shownId && rewind?.id !== RUNNING ? "true" : undefined}
            onClick={() => open(e.id)}
            title={e.title}
          >
            <span className="card-entry-mark" aria-hidden>
              {e.kind === "answer" ? "✦" : e.kind === "kickoff" ? "↺" : entries.slice(0, i + 1).filter((x) => x.kind === "topic").length}
            </span>
            <span className="card-entry-body">
              <span className="card-entry-title">{e.title}</span>
              <span className="card-entry-meta">{e.meta}</span>
            </span>
            {e.id === liveId && <span className="card-entry-live" aria-label="live" />}
          </button>
        ))}
      </nav>
      <div className="card-pane" ref={paneRef} onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        <button type="button" className="card-list-toggle" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>
          <span aria-hidden>☰</span>
          <span className="card-list-toggle-title">{rewind?.id === RUNNING ? "Running list" : (shownEntry?.title ?? "Cards")}</span>
          <span className="card-list-count">{index >= 0 ? `${index + 1} of ${entries.length}` : entries.length}</span>
        </button>
        {before && (
          <button type="button" className="card-step up" onClick={() => open(before.id)}>
            ↑ {before.title}
          </button>
        )}
        <div
          key={shownId ?? "none"}
          className={["card-slide", cameFrom && `from-${cameFrom}`, drag !== 0 && "dragging"].filter(Boolean).join(" ")}
          style={drag ? { transform: `translateX(${drag}px)` } : undefined}
        >
          {view}
        </div>
        {rewind ? (
          <button type="button" className={movedOn ? "card-step live moved" : "card-step live"} onClick={() => setRewind(null)} title="Escape">
            {movedOn ? (
              <>
                <span className="agent-mark" aria-hidden>
                  ✦
                </span>{" "}
                New card: <strong>{movedOn.title}</strong> · Back to live ↓
              </>
            ) : following ? (
              <>{first(following.host)} is showing this · Back to live ↓</>
            ) : (
              <>Back to live{liveEntry ? `: ${liveEntry.title}` : ""} ↓</>
            )}
          </button>
        ) : (
          after && (
            <button type="button" className="card-step down" onClick={() => open(after.id)}>
              ↓ {after.title}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** The Running list: everything the meeting has produced so far, To do, Decided and Open side by side. */
function RunningList(props: { tasks: Tasks; acts: TaskActs; idOf: (name: string) => string; nameOf: (name: string) => string }) {
  return (
    <section className="topic-now running-list" aria-label="Running list">
      <div className="topic-now-head">
        <span className="topic-now-label">Running list</span>
        <span className="topic-mins">The whole meeting so far</span>
      </div>
      <div className="topic-sections columns">
        {SECTIONS.map((sec) => (
          <div key={sec.kind} className={`topic-section ${sec.kind}`}>
            <span className="topic-section-label">
              {sec.label} {props.tasks.count[sec.kind] > 0 && <span className="topic-tab-count">{props.tasks.count[sec.kind]}</span>}
            </span>
            <TaskList kind={sec.kind} tasks={props.tasks} acts={props.acts} idOf={props.idOf} nameOf={props.nameOf} compact />
          </div>
        ))}
      </div>
    </section>
  );
}

/** A question to ✦ Stand as a card: the first question is its title, each follow-up lands under the last answer. */
function AnswerStack({ chain, live, onTodo }: { chain: AgentCard[]; live: boolean; onTodo?: (cardId: string) => void }) {
  const root = chain[0];
  return (
    <section className={live ? "topic-now answer-stack live" : "topic-now answer-stack"} aria-label="A question to Stand">
      <div className="topic-now-head">
        <span className="topic-now-label ask">✦ Asked by {first(root.by)}</span>
        {live && <span className="topic-now-label live">Now</span>}
      </div>
      <h2 className="topic-now-title">{root.question ? `“${root.question}”` : `${first(root.by)} is asking Stand…`}</h2>
      {chain.map((c, i) => (
        <AnswerPart key={c.id} card={c} followUp={i > 0} onTodo={onTodo} />
      ))}
      <p className="topic-hint">
        <span className="agent-mark small">✦</span> Hold Ask Stand to follow up; the answer lands here
      </p>
    </section>
  );
}

/** Before the first topic for the item in focus: the talk so far, or the item and a hint. */
function Waiting(props: {
  remarks: Array<{ key: string; name: string; id: string; text: string; now: boolean }>;
  speaking: { key: string; name: string; id: string; text: string; now: boolean } | undefined | false;
  updating: boolean;
  item: Item | null;
}) {
  if (props.remarks.length || props.speaking) return <Warmup remarks={props.remarks} speaking={props.speaking} updating={props.updating} />;
  const item = props.item;
  return (
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
        <span className="agent-mark small">✦</span> The topic shows up here as people talk
      </p>
    </div>
  );
}

/** One line over a shared screen or a deck: the topic and the point being made, so the board
 *  isn't lost while something else has the middle. A click opens the whole board. */
export function BoardStrip({ board, focusItemId, onOpen }: { board: Board | null; focusItemId: string | null; onOpen?: () => void }) {
  const t = board?.threads.find((x) => x.id === board.currentId);
  if (!t || t.itemId !== focusItemId) return null;
  const { who, text } = splitNow(t.card.now);
  return (
    <div
      className={["topic-strip", board?.busy && "updating", onOpen && "opens"].filter(Boolean).join(" ")}
      role="status"
      title={onOpen ? "Open the board" : t.card.summary.join(" ")}
      onClick={onOpen}
    >
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

/** A card opened from the card list (or the Running list): a topic as it stood at `at`. live: the card that was
 *  live when it was opened, so a new one since can be pointed out; page: the Kickoff's page. */
export type Rewind = { id: string; key: string; at: number; live: string | null; page?: number };

/** The time, again every so often, so the card list and answers keep up with the meeting. */
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
  /** Opened from the chapter bar: the meeting time it shows the board as of. */
  rewoundAt?: string;
  /** The board is reading the latest talk: a light runs along the top edge. */
  updating: boolean;
  /** Just switched to: a thread new to this screen, or one it came back to. */
  arrival: Arrival;
  /** A move the board waits one more pass to confirm: shown faintly, a click makes it now. */
  pending: Board["pending"];
  onAcceptMove?: (title: string) => void;
  /** Who moved the board onto this stretch of the thread. */
  movedBy: BoardMove | null;
  meetingStart: number;
  /** The meeting's to-dos, decisions and questions for the tabs and columns. */
  tasks: Tasks;
  acts: TaskActs;
  speaking: { name: string; id: string; text: string } | null;
  idOf: (name: string) => string;
  nameOf: (name: string) => string;
}) {
  const { t } = props;
  const label = props.rewoundAt ? `At ${props.rewoundAt}` : props.arrival === "new" ? "New topic" : props.arrival === "back" ? "Back to" : props.live ? "Now" : "Last";
  const marks = useChanges(t);
  const said = splitNow(t.card.now);
  const foot = props.speaking
    ? { name: props.speaking.name, id: props.speaking.id, text: props.speaking.text, now: true }
    : said.text
      ? { name: said.who ? props.nameOf(said.who) : null, id: said.who ? props.idOf(said.who) : "", text: said.text, now: false }
      : null;
  return (
    <section
      key={t.id}
      className={["topic-now", props.rewoundAt && "rewound", props.arrival && "topic-in", props.updating && "updating"].filter(Boolean).join(" ")}
      aria-label={props.rewoundAt ? `Topic at ${props.rewoundAt}` : "Current topic"}
      aria-busy={props.updating}
    >
      <div className="topic-now-head">
        <span key={label} className={["topic-now-label", props.live && "live", props.arrival && "arrived"].filter(Boolean).join(" ")}>
          {label}
        </span>
        {spent(t) >= 60_000 && <span className="topic-mins">{fmtDuration(spent(t))}</span>}
        <MovedBy move={props.movedBy} start={props.meetingStart} nameOf={props.nameOf} idOf={props.idOf} />
        <span className={props.updating ? "topic-updating on" : "topic-updating"} aria-hidden>
          <span className="agent-mark">✦</span> Updating
        </span>
        {!props.rewoundAt && <AgentStatus cards={props.acts.agent?.cards} />}
      </div>
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
      <CardTabs t={t} marks={marks} tasks={props.tasks} acts={props.acts} idOf={props.idOf} nameOf={props.nameOf} />
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
  // "✦ Options ready" opens the Open tab and brings the card into view.
  useEffect(() => {
    const show = () => setTab("open");
    window.addEventListener(SHOW_CARD, show);
    return () => window.removeEventListener(SHOW_CARD, show);
  }, []);
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
  /** A decision Stand heard that nobody has confirmed yet. */
  heard: boolean;
  /** An open question: the answer Stand heard for it, waiting for a click. */
  heardAnswer: Note | null;
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
  /** Bring back the "Since last time" check-in. */
  onCheckIn?: () => void;
  onUndoSaid?: (noteId: string) => void;
  agent?: AgentActs;
  /** Anyone: a decision Stand heard is one, or isn't yet. */
  onConfirm?: (noteId: string) => void;
  onNotYet?: (noteId: string) => void;
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
  const questions = new Map(notes.filter((n) => n.kind === "question").map((n) => [n.id, n]));
  const isHeard = (n: Note) => !!(n as Partial<ListNote>).heard && !(n as Partial<ListNote>).closed;
  // A heard answer to a question still open sits under that question, not on the Decided tab.
  const heardAnswers = new Map<string, Note>();
  for (const n of notes) {
    const q = (n as Partial<ListNote>).answers;
    if (n.kind === "decision" && isHeard(n) && q && questions.has(q) && !(questions.get(q) as Partial<ListNote>).closed) heardAnswers.set(q, n);
  }
  const under = new Set([...heardAnswers.values()].map((n) => n.id));
  for (const note of notes) {
    const kind = TASK_KIND[note.kind];
    if (!kind || under.has(note.id)) continue;
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
      answers: answers ? (questions.get(answers)?.text ?? null) : null,
      heard: isHeard(note),
      heardAnswer: heardAnswers.get(note.id) ?? null,
    });
  }
  for (const k of Object.keys(rows) as TaskKind[]) rows[k].sort((a, b) => a.at - b.at);
  return {
    rows,
    count: { decided: rows.decided.filter((r) => !r.heard).length, todo: rows.todo.filter((r) => !r.note.doneAt).length, open: rows.open.filter((r) => !r.leaving).length },
    fresh,
    earlier: followUps,
  };
}

/** The meeting's lines as they stood at a moment: only what was said by then, and nothing closed after it. */
function asOf(notes: Note[], at: number): Note[] {
  if (!at) return [];
  return notes
    .filter((n) => (n.quote?.ts ?? n.ts) <= at)
    .map((n) => {
      const closed = (n as Partial<ListNote>).closed;
      return {
        ...n,
        doneAt: n.doneAt && n.doneAt <= at ? n.doneAt : null,
        ...(closed !== undefined ? { closed: closed && closed.at <= at ? closed : null } : {}),
      };
    });
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
  const row = (note: Note, opts: { at: string; r?: TaskRow; removable?: boolean }) => {
    // A picked card stays under its question while the question leaves, so the pick shows first.
    const card = props.kind === "open" ? cardFor(props.acts.agent, note.id) : undefined;
    const heard = props.kind === "open" && !opts.r?.leaving ? (opts.r?.heardAnswer ?? null) : null;
    const line = taskLine(note, opts, card || heard ? null : props.kind === "open" && !opts.r?.leaving && props.acts.agent ? props.acts.agent : null);
    return card || heard ? (
      <Fragment key={note.id}>
        {line}
        {heard && (
          <li className="heard-row">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <span className="heard-label">Sounds settled:</span>
            <span className="heard-text">{heard.text}</span>
            <HeardActs id={heard.id} acts={props.acts} />
          </li>
        )}
        {card && (
          <li className="agent-card-row">
            <OptionsCard card={card} acts={props.acts.agent!} />
          </li>
        )}
      </Fragment>
    ) : (
      line
    );
  };
  const taskLine = (note: Note, opts: { at: string; r?: TaskRow; removable?: boolean }, find: AgentActs | null) => (
    <li
      key={note.id}
      className={[props.kind, "topic-task", opts.r?.here && "here", opts.r?.heard && "heard", note.doneAt && "done", opts.r?.leaving && "leaving", props.tasks.fresh.has(note.id) && "topic-new"].filter(Boolean).join(" ")}
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
        <span className={opts.r?.heard ? "topic-note-mark agent-mark" : "topic-note-mark"} aria-label={opts.r?.leaving ? "Answered" : opts.r?.heard ? "Heard, not confirmed" : MARK_LABEL[props.kind]}>
          {opts.r?.leaving ? "✓" : opts.r?.heard ? "✦" : MARK[props.kind]}
        </span>
      )}
      <span className="topic-task-text">{note.text}</span>
      {opts.r?.heard && <HeardActs id={note.id} acts={props.acts} />}
      {note.saidDone && !note.doneAt && <SaidDonePill quote={note.saidDone} onUndo={props.acts.onUndoSaid && (() => props.acts.onUndoSaid!(note.id))} />}
      {opts.r?.answers && (
        <span className="topic-task-answers" title={`Answers: ${opts.r.answers}`}>
          Answered
        </span>
      )}
      {find && <FindOptions noteId={note.id} acts={find} />}
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
      {past && earlierOpen > 0 && props.acts.onCheckIn && (
        <li className="topic-tasks-more">
          <button type="button" onClick={props.acts.onCheckIn}>
            Check in on these
          </button>
        </li>
      )}
      {past && earlier.map((f) => row(f, { at: shortDate(f.meetingStartedAt) }))}
    </ul>
  );
}

/** Confirm or Not yet on a decision Stand heard. It isn't decided until someone clicks Confirm. */
function HeardActs({ id, acts }: { id: string; acts: TaskActs }) {
  if (!acts.onConfirm || !acts.onNotYet) return <span className="heard-pill" title="Stand heard this; nobody has confirmed it">Heard</span>;
  return (
    <span className="heard-acts">
      <button type="button" title="Lock this in as decided" onClick={() => acts.onConfirm!(id)}>
        Confirm
      </button>
      <button type="button" title="Not decided: take it off" onClick={() => acts.onNotYet!(id)}>
        Not yet
      </button>
    </span>
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
