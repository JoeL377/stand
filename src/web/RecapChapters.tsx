// The recap's chapters: the same chapters people saw on the meeting's chapter bar (shared/chapters.ts),
// as a bar for the whole meeting under the recap's header, a chip on every to-do, decision and open
// question that leads to the chapter it came out of, and the Chapters section itself.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ChapterRecap, Discussion, DiscussionOutcome, Note, NoteFrom, Quote, Segment, Snap } from "../shared/protocol.ts";
import type { MeetingChapter } from "../shared/chapters.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { SnapFigures } from "./Snaps.tsx";
import { DecidedIcon, InfoIcon, QuestionIcon, TodoIcon } from "./NoteIcons.tsx";
import { colorFor, fmtDate, fmtTime, initials, itemLabel } from "./util.ts";
import type { Item } from "../shared/protocol.ts";
import { Linkified } from "./Linkified.tsx";

/** Time into the meeting, like 15:21 or 1:02:04. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A small quote mark after a line the agent wrote (a position, a decision, a moment): the words
 *  behind it, as said, show on hover or focus. The line stays as it was; this is for checking it. */
export function QuoteMark({ quote, startedAt, onJump }: { quote: Quote; startedAt?: number; onJump?: (segmentId: string) => void }) {
  const at = startedAt ? clock(quote.ts - startedAt) : fmtTime(quote.ts);
  const who = quote.speaker.split(" ")[0];
  return (
    <span className="qm">
      <button
        type="button"
        className="qm-mark"
        aria-label={`What ${who} said: “${quote.text}”`}
        onClick={(e) => {
          e.preventDefault();
          onJump?.(quote.segmentId);
        }}
      >
        “
      </button>
      <span className="qm-pop" role="tooltip">
        <span className="qm-text">“{quote.text}”</span>
        <span className="qm-meta">
          {who} · {at}
        </span>
      </span>
    </span>
  );
}

export const chapterAnchor = (i: number) => `chapter-${i + 1}`;

const OUTCOME: Record<DiscussionOutcome, { label: string; Icon: (p: { size?: number }) => React.ReactElement }> = {
  decided: { label: "Decided", Icon: DecidedIcon },
  action: { label: "To do", Icon: TodoIcon },
  open: { label: "Open", Icon: QuestionIcon },
  info: { label: "FYI", Icon: InfoIcon },
};

/** A short FYI aside with nothing to show for it folds into one line under the chapters. */
const isAside = (c: MeetingChapter, notes: Note[]) => c.outcome === "info" && c.minutes <= 1 && !notes.length;

/** A person as a small round avatar, colored as they are in the transcript. */
export function Face({ name, color, title, size = 20 }: { name: string; color: string; title?: string; size?: number }) {
  return (
    <span className="rc-face" style={{ background: color, width: size, height: size, fontSize: size * 0.48 }} title={title ?? name} aria-label={title ?? name}>
      {initials(name)}
    </span>
  );
}

/** Where a to-do, decision or open question came from: a small time pill after its text, with the chapter in a pop-up.
 *  The pill shows when it was said (`at`, see saidAt) when that's known, else when its chapter started. */
export function ChapterChip({ c, i, startedAt, at, crux, onPick }: { c: MeetingChapter; i: number; startedAt: number; at?: number | null; crux?: string; onPick?: (i: number) => void }) {
  const o = OUTCOME[c.outcome];
  const when = clock((at ?? c.start) - startedAt);
  return (
    <span className="rc-pill-wrap">
      <a className="rc-pill" href={`#${chapterAnchor(i)}`} onClick={() => onPick?.(i)} aria-label={at != null ? `Said at ${when}, in the chapter "${c.title}"` : `From the chapter "${c.title}" at ${when}`}>
        {when}
      </a>
      <span className="rc-pop" role="tooltip">
        <span className="rc-pop-title">{c.title}</span>
        <span className="rc-pop-meta">
          <span className={`rc-ch-dot ${c.outcome}`} aria-hidden />
          {o.label} · {clock(c.start - startedAt)} · {Math.max(1, Math.round(c.minutes))} min
        </span>
        {crux && (
          <span className="rc-pop-crux">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>{" "}
            {crux}
          </span>
        )}
      </span>
    </span>
  );
}

/** The same pill on a page that lists several meetings (the space page): the meeting's day, with
 *  the chapter in the pop-up, and a click opens the recap at that chapter. */
export function FromChip({ from }: { from: NoteFrom }) {
  const c = from.chapter;
  const day = new Date(from.startedAt).toLocaleDateString([], { month: "short", day: "numeric" });
  const o = c && OUTCOME[c.outcome];
  return (
    <span className="rc-pill-wrap">
      <Link className="rc-pill" to={`/meetings/${from.meetingId}${c ? `#${chapterAnchor(c.i)}` : ""}`} aria-label={c ? `From the chapter "${c.title}" on ${day}` : `From the meeting on ${day}`}>
        {day}
      </Link>
      <span className="rc-pop" role="tooltip">
        {c && o ? (
          <>
            <span className="rc-pop-title">{c.title}</span>
            <span className="rc-pop-meta">
              <span className={`rc-ch-dot ${c.outcome}`} aria-hidden />
              {o.label} · {fmtDate(from.startedAt)} · {clock(c.at - from.startedAt)} · {c.minutes} min
            </span>
            {c.crux && (
              <span className="rc-pop-crux">
                <span className="agent-mark" aria-hidden>
                  ✦
                </span>{" "}
                {c.crux}
              </span>
            )}
          </>
        ) : (
          <span className="rc-pop-meta">Meeting on {fmtDate(from.startedAt)}</span>
        )}
      </span>
    </span>
  );
}

/** The whole meeting as a bar, one stretch per run of talk on a chapter, colored by how the chapter ended. */
export function ChapterBar({ chapters, from, to, onPick }: { chapters: MeetingChapter[]; from: number; to: number; onPick: (i: number) => void }) {
  const span = Math.max(1, to - from);
  const used = new Set(chapters.map((c) => c.outcome));
  return (
    <div className="rc-bar" aria-label="The meeting's chapters">
      <div className="rc-bar-track">
        {chapters.flatMap((c, i) =>
          c.stretches.map((s) => (
            <a
              key={`${c.key}-${s.from}`}
              href={`#${chapterAnchor(i)}`}
              className={`rc-stretch ${c.outcome}`}
              style={{ left: `${((s.from - from) / span) * 100}%`, width: `${((s.to - s.from) / span) * 100}%` }}
              aria-label={`${clock(s.from - from)} ${c.title}`}
              onClick={() => onPick(i)}
            >
              <span className={`rc-stretch-tip${s.from - from < span * 0.15 ? " start" : s.to - from > span * 0.85 ? " end" : ""}`}>
                <b>{clock(s.from - from)}</b> {c.title}
              </span>
            </a>
          )),
        )}
      </div>
      <div className="rc-bar-times">
        <span>0:00</span>
        <span className="rc-bar-legend">
          {(["decided", "action", "open", "info"] as const)
            .filter((o) => used.has(o))
            .map((o) => (
              <span key={o}>
                <i className={o} /> {OUTCOME[o].label.toLowerCase()}
              </span>
            ))}
        </span>
        <span>{clock(to - from)}</span>
      </div>
    </div>
  );
}

const NOTE_ORDER: Record<Note["kind"], number> = { action: 0, decision: 1, question: 2, summary: 3 };
const NOTE_ICON: Partial<Record<Note["kind"], (p: { size?: number }) => React.ReactElement>> = {
  action: TodoIcon,
  decision: DecidedIcon,
  question: QuestionIcon,
};

/** The Chapters section's list: one row per chapter in the order talked about, a thin divider when
 *  the agenda item changes, each row opening to where it landed and how it got there. */
export function ChapterList(props: {
  chapters: MeetingChapter[];
  written: Map<string, ChapterRecap>;
  discussions: Discussion[];
  notes: Note[];
  segments: Segment[];
  items: Array<Item | null>;
  snapsOnTopic: (id: string) => Snap[];
  startedAt: number;
  open: Set<string>;
  setOpen: (key: string, open: boolean) => void;
  colorOf: (name: string) => string;
}) {
  const many = new Set(props.chapters.map((c) => c.itemId)).size > 1;
  const notesOf = (c: MeetingChapter) =>
    props.notes
      .filter((n) => n.kind !== "summary" && n.discussionId && c.topicIds.includes(n.discussionId))
      .sort((a, b) => NOTE_ORDER[a.kind] - NOTE_ORDER[b.kind] || a.ts - b.ts);
  const rows: React.ReactNode[] = [];
  const asides: Array<{ c: MeetingChapter; i: number }> = [];
  let lastItem: string | null | undefined;
  props.chapters.forEach((c, i) => {
    const notes = notesOf(c);
    if (isAside(c, notes)) {
      asides.push({ c, i });
      return;
    }
    if (many && c.itemId !== lastItem) {
      const item = props.items.find((it) => (it?.id ?? null) === c.itemId) ?? null;
      rows.push(
        <div key={`item-${i}`} className="rc-ch-item">
          {item ? <Link to={`/items/${item.id}`}>{item.title}</Link> : itemLabel(null)}
        </div>,
      );
      lastItem = c.itemId;
    }
    rows.push(
      <ChapterRow
        key={c.key}
        c={c}
        i={i}
        crux={props.written.get(c.key)}
        notes={notes}
        discussions={props.discussions}
        segments={props.segments}
        snapsOnTopic={props.snapsOnTopic}
        startedAt={props.startedAt}
        open={props.open.has(c.key)}
        onToggle={(o) => props.setOpen(c.key, o)}
        colorOf={props.colorOf}
      />,
    );
  });
  return (
    <>
      {rows}
      {asides.length > 0 && (
        <p className="rc-asides">
          + {asides.map(({ c, i }, k) => (
            <span key={c.key} id={chapterAnchor(i)}>
              {k > 0 && ", "}
              {c.title} ({clock(c.start - props.startedAt)})
            </span>
          ))}
        </p>
      )}
    </>
  );
}


function ChapterRow(props: {
  c: MeetingChapter;
  i: number;
  crux: ChapterRecap | undefined;
  notes: Note[];
  discussions: Discussion[];
  segments: Segment[];
  snapsOnTopic: (id: string) => Snap[];
  startedAt: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  colorOf: (name: string) => string;
}) {
  const { c, startedAt } = props;
  const [said, setSaid] = useState(false);
  // A quote mark clicked: the transcript opens at that line.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const body = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!jumpTo || !said) return;
    const el = body.current?.querySelector(`[data-seg="${jumpTo}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.classList.add("qm-here");
    const t = setTimeout(() => el?.classList.remove("qm-here"), 1600);
    setJumpTo(null);
    return () => clearTimeout(t);
  }, [jumpTo, said]);
  const jump = (id: string) => {
    setSaid(true);
    setJumpTo(id);
  };
  const o = OUTCOME[c.outcome];
  const topics = c.topicIds.flatMap((id) => props.discussions.find((d) => d.id === id) ?? []);
  const head = topics.find((d) => d.id === c.headId) ?? null;
  const inside = topics.filter((d) => d !== head);
  const segById = new Map(props.segments.map((s) => [s.id, s]));
  const turns = c.segmentIds.flatMap((id) => segById.get(id) ?? []);
  // A moment points at the line it starts at: that line, as said.
  const lineAt = (id: string): Quote | null => {
    const s = segById.get(id);
    return s ? { segmentId: s.id, ts: s.ts, speaker: s.speakerName, text: s.text.length > 320 ? `${s.text.slice(0, 319).trimEnd()}…` : s.text } : null;
  };
  const firstOf = (d: Discussion) => Math.min(...d.segmentIds.flatMap((id) => segById.get(id)?.ts ?? []));
  const shots = topics.flatMap((d) => props.snapsOnTopic(d.id));
  // A group has no main topic: where people stood is what each of its topics says.
  const positions = head?.positions ?? (inside.length === 1 ? inside[0].positions : []);
  return (
    <details ref={body} id={chapterAnchor(props.i)} className="rc-ch" open={props.open} onToggle={(e) => props.onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="rc-ch-at">{clock(c.start - startedAt)}</span>
        <span className={`rc-ch-dot ${c.outcome}`} title={o.label} aria-label={o.label} />
        <span className="rc-ch-title">{c.title}</span>
        <span className="rc-ch-mins">{Math.max(1, Math.round(c.minutes))} min</span>
      </summary>
      <div className="rc-ch-body">
        {props.crux?.crux && (
          <p className="rc-ch-crux">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>{" "}
            {props.crux.crux}
          </p>
        )}
        {head?.continues && (
          <p className="muted small">
            Continues from <Link to={`/meetings/${head.continues.meetingId}`}>{fmtDate(head.continues.startedAt)}</Link>
          </p>
        )}
        {props.notes.length > 0 && (
          <div className="rc-ch-sub">
            <h4>What came of it</h4>
            <ul className="rc-ch-notes">
              {props.notes.map((n) => {
                const Icon = NOTE_ICON[n.kind]!;
                return (
                  <li key={n.id} className={n.kind}>
                    <Icon size={14} />
                    <span className="rc-ch-text">
                      {n.text}
                      {n.quote && <QuoteMark quote={n.quote} startedAt={startedAt} onJump={jump} />}
                    </span>
                    {n.owner && n.kind === "action" && <Face name={n.owner} color={props.colorOf(n.owner)} size={18} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {positions.length > 0 && (
          <div className="rc-ch-sub">
            <h4>Where people stood</h4>
            <ul className="rc-ch-stood">
              {positions.map((p, k) => (
                <li key={k}>
                  <Face name={p.speaker} color={props.colorOf(p.speaker)} size={20} />
                  <span className="rc-ch-text">
                    <b>{p.speaker.split(" ")[0]}</b> {p.position}
                    {p.quote && <QuoteMark quote={p.quote} startedAt={startedAt} onJump={jump} />}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {props.crux && props.crux.moments.length > 0 && (
          <div className="rc-ch-sub">
            <h4>Moments</h4>
            <ul className="rc-ch-times">
              {props.crux.moments.map((m) => {
                const q = lineAt(m.segmentId);
                return (
                  <li key={m.segmentId}>
                    <span className="rc-ch-at">{clock(m.ts - startedAt)}</span>
                    <span className="rc-ch-text">
                      {m.text}
                      {q && <QuoteMark quote={q} startedAt={startedAt} onJump={jump} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {inside.length > 0 && (
          <div className="rc-ch-sub">
            <h4>{head ? "Smaller topics inside" : "Topics"}</h4>
            <ul className="rc-ch-times">
              {inside.map((d) => (
                <li key={d.id}>
                  <span className="rc-ch-at">{clock(firstOf(d) - startedAt)}</span>
                  <span className="rc-ch-text">{d.topic}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {shots.length > 0 && <SnapFigures snaps={shots} segments={props.segments} />}
        <div className="disc-foot rc-ch-foot">
          {turns.length > 0 && (
            <button className="link small" onClick={() => setSaid((s) => !s)}>
              {said ? "Hide what was said" : `What was said (${turns.length}) from ${clock(c.start - startedAt)}`}
            </button>
          )}
          {head && <CopyForAgent kind="topic" id={head.id} label />}
        </div>
        {said && (
          <div className="transcript static">
            {turns.map((s) => (
              <div key={s.id} data-seg={s.id} className={s.kind === "chat" ? "seg chat" : "seg"}>
                <div className="seg-head">
                  <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
                    {s.speakerName}
                  </span>
                  {s.kind === "chat" && <span className="seg-kind">chat</span>}
                  <span className="seg-time">{fmtTime(s.ts)}</span>
                </div>
                <div className="seg-text">
                  <Linkified text={s.text} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
