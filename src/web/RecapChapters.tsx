// The recap's chapters: the same chapters people saw on the meeting's chapter bar (shared/chapters.ts),
// as a bar for the whole meeting under the recap's header, a chip on every to-do, decision and open
// question that leads to the chapter it came out of, and the Chapters section itself.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ChapterRecap, Discussion, DiscussionOutcome, Note, Segment, Snap } from "../shared/protocol.ts";
import type { MeetingChapter } from "../shared/chapters.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { SnapFigures } from "./Snaps.tsx";
import { DecidedIcon, InfoIcon, QuestionIcon, TodoIcon } from "./NoteIcons.tsx";
import { colorFor, fmtDate, fmtTime, initials, itemLabel } from "./util.ts";
import type { Item } from "../shared/protocol.ts";

/** Time into the meeting, like 15:21 or 1:02:04. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
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

/** Where a to-do, decision or open question came from: its chapter's start and name. */
export function ChapterChip({ c, i, startedAt }: { c: MeetingChapter; i: number; startedAt: number }) {
  return (
    <a className="rc-chip" href={`#${chapterAnchor(i)}`} title={`From the chapter "${c.title}"`}>
      <span className="rc-chip-at">{clock(c.start - startedAt)}</span>
      <span className="rc-chip-title">{c.title}</span>
    </a>
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
  const o = OUTCOME[c.outcome];
  const topics = c.topicIds.flatMap((id) => props.discussions.find((d) => d.id === id) ?? []);
  const head = topics.find((d) => d.id === c.headId) ?? null;
  const inside = topics.filter((d) => d !== head);
  const segById = new Map(props.segments.map((s) => [s.id, s]));
  const turns = c.segmentIds.flatMap((id) => segById.get(id) ?? []);
  const firstOf = (d: Discussion) => Math.min(...d.segmentIds.flatMap((id) => segById.get(id)?.ts ?? []));
  const count = (kind: Note["kind"]) => props.notes.filter((n) => n.kind === kind).length;
  const shots = topics.flatMap((d) => props.snapsOnTopic(d.id));
  // A group has no main topic: where people stood is what each of its topics says.
  const positions = head?.positions ?? (inside.length === 1 ? inside[0].positions : []);
  return (
    <details id={chapterAnchor(props.i)} className="rc-ch" open={props.open} onToggle={(e) => props.onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="rc-ch-at">{clock(c.start - startedAt)}</span>
        <span className={`rc-ch-dot ${c.outcome}`} title={o.label} aria-label={o.label} />
        <span className="rc-ch-title">{c.title}</span>
        <span className="rc-ch-mins">{Math.max(1, Math.round(c.minutes))} min</span>
      </summary>
      <div className="rc-ch-body">
        <div className="rc-ch-meta">
          <span className={`rc-outcome ${c.outcome}`}>
            <o.Icon size={13} /> {o.label}
          </span>
          {(["action", "decision", "question"] as const).map((k) => {
            const n = count(k);
            const Icon = NOTE_ICON[k]!;
            return n ? (
              <span key={k} className={`rc-ch-count ${k}`} title={`${n} ${k === "action" ? "to do" : k === "decision" ? "decided" : "open"}`}>
                <Icon size={12} />
                {n}
              </span>
            ) : null;
          })}
          <span className="rc-ch-faces" aria-label={c.speakers.join(", ")}>
            {c.speakers.slice(0, 4).map((name) => (
              <Face key={name} name={name} color={props.colorOf(name)} size={18} />
            ))}
          </span>
        </div>
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
        {props.crux && props.crux.moments.length > 0 && (
          <div className="rc-ch-sub">
            <h4>Moments</h4>
            <ul className="rc-ch-times">
              {props.crux.moments.map((m) => (
                <li key={m.segmentId}>
                  <span className="rc-ch-at">{clock(m.ts - startedAt)}</span>
                  <span>{m.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {positions.length > 0 && (
          <div className="rc-ch-sub">
            <h4>Where people stood</h4>
            {positions.map((p, k) => (
              <p key={k} className="rc-ch-pos">
                <Face name={p.speaker} color={props.colorOf(p.speaker)} size={18} />
                <span>{p.position}</span>
              </p>
            ))}
          </div>
        )}
        {props.notes.length > 0 && (
          <div className="rc-ch-sub">
            <h4>What came of it</h4>
            <ul className="rc-ch-notes">
              {props.notes.map((n) => {
                const Icon = NOTE_ICON[n.kind]!;
                return (
                  <li key={n.id} className={n.kind}>
                    <Icon size={13} />
                    <span>
                      {n.text}
                      {n.owner && n.kind === "action" && <span className="muted"> · {n.owner}</span>}
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
                  <span>{d.topic}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {shots.length > 0 && <SnapFigures snaps={shots} segments={props.segments} />}
        <div className="disc-foot">
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
              <div key={s.id} className={s.kind === "chat" ? "seg chat" : "seg"}>
                <div className="seg-head">
                  <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
                    {s.speakerName}
                  </span>
                  {s.kind === "chat" && <span className="seg-kind">chat</span>}
                  <span className="seg-time">{fmtTime(s.ts)}</span>
                </div>
                <div className="seg-text">{s.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
