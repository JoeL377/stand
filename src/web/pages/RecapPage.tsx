import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConxtPanel } from "../ConxtPanel.tsx";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { SnapFigures, SnapStrip } from "../Snaps.tsx";
import type { Discussion, DiscussionOutcome, MeetingRecap, Note, Segment, Snap, UpNext } from "../../shared/protocol.ts";
import { meetingChapters } from "../../shared/chapters.ts";
import { ChapterBar, ChapterChip, ChapterList, Face, QuoteMark } from "../RecapChapters.tsx";
import { api, request, type RoomInfo } from "../api.ts";
import { errorToast, toast } from "../Toasts.tsx";
import { FollowUpList, itemHref, saveFollowUp, sourceLabel } from "../FollowUps.tsx";
import { Markdown } from "../Synthesis.tsx";
import { CarryIcon, DecidedIcon, InfoIcon, QuestionIcon, TodoIcon, TopicIcon } from "../NoteIcons.tsx";
import { colorFor, fmtDate, fmtDuration, fmtTime, keyOf } from "../util.ts";

export function RecapPage() {
  const { meetingId = "" } = useParams();
  const [data, setData] = useState<MeetingRecap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open_, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  // Chapters someone opened or closed; the rest follow the default (long ones open).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const here = useSectionInView(["todo", "decided", "open", "chapters"], Boolean(data));

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    api
      .meeting(meetingId)
      .then((m) => {
        setData(m);
        api
          .suggested(m.roomId)
          .then((s) => setUpNext(s.upNext))
          .catch(() => {});
        return api.room(m.roomId).then(setRoom);
      })
      .catch((e) => setError(e.message));
  }, [meetingId, attempt]);

  if (error)
    return (
      <div className="home">
        <div className="home-card">
          <p className="error">{error}</p>
          <div className="row">
            <button
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
            <Link to="/">Back to spaces</Link>
          </div>
        </div>
      </div>
    );
  if (!data) return <div className="loading">Loading…</div>;

  const people = [...new Set(data.items.flatMap((g) => g.segments.map((s) => s.speakerName)))];
  const actions = data.items.flatMap((g) => g.notes.filter((n) => n.kind === "action"));
  const items = [...(room?.items ?? []), ...data.items.flatMap((g) => (g.item ? [g.item] : []))];
  const source = (n: { itemId: string | null }) => ({ label: sourceLabel(n.itemId, items, room?.decks), href: itemHref(n.itemId, items) });
  // Action items from earlier meetings that were still open when this one ran.
  const carried = (room?.followUps ?? []).filter((f) => f.meetingStartedAt < data.startedAt);
  const briefUrl = (fmt: "json" | "md") => `/api/meetings/${data.meetingId}/brief.${fmt}`;
  const copyBrief = async () => {
    let md: string;
    try {
      const res = await request(briefUrl("md"));
      if (!res.ok) throw new Error("Stand couldn't put it together just now.");
      md = await res.text();
    } catch (err) {
      errorToast("Couldn't copy the brief", () => void copyBrief())(err);
      return;
    }
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ text: "Your browser blocked copying.", action: { label: "Open the brief", run: () => window.open(briefUrl("md"), "_blank") } });
    }
  };

  const groups = data.items;
  const all = groups.flatMap((g) => g.notes);
  const decided = all.filter((n) => n.kind === "decision");
  const questions = all.filter((n) => n.kind === "question");
  const open = actions.filter((n) => !n.doneAt).length;
  // Each screenshot has one home: under the to-do, decision or question it
  // backs; otherwise under the topic it was discussed in; otherwise its item.
  const snaps = groups.flatMap((g) => g.snaps ?? []);
  const noteIds = new Set(all.map((n) => n.id));
  const onNote = (id: string) => snaps.filter((p) => p.noteId === id);
  const unplaced = (p: Snap) => !(p.noteId && noteIds.has(p.noteId));
  const onTopic = (id: string) => snaps.filter((p) => unplaced(p) && p.discussionId === id);
  const shots = (n: Note) => <SnapFigures snaps={onNote(n.id)} />;

  // The meeting's chapters, as the chapter bar showed them, and what the recap wrote about each.
  const discussions = groups.flatMap((g) => g.discussions ?? []);
  const segments = groups.flatMap((g) => g.segments).sort((a, b) => a.ts - b.ts);
  const lastTs = segments.at(-1)?.ts ?? data.startedAt;
  const endAt = data.endedAt ?? lastTs;
  const chapters = meetingChapters(discussions, segments, endAt);
  const written = new Map((data.chapters ?? []).map((c) => [c.key, c]));
  const chapterIndex = new Map(chapters.flatMap((c, i) => c.topicIds.map((id) => [id, i] as const)));
  const chipFor = (n: Note) => {
    const i = n.discussionId ? chapterIndex.get(n.discussionId) : undefined;
    return i === undefined ? null : <ChapterChip c={chapters[i]} i={i} startedAt={data.startedAt} crux={written.get(chapters[i].key)?.crux} onPick={jumpTo} />;
  };
  // Topics no chapter shows (notes carried in, nothing said this meeting) keep the old row.
  const inChapters = new Set(chapters.flatMap((c) => c.topicIds));
  const leftover = groups.flatMap((g) => (g.discussions ?? []).filter((d) => !inChapters.has(d.id)).map((d) => ({ d, g })));
  const looseSnaps = snaps.filter((p) => unplaced(p) && !(p.discussionId && discussions.some((d) => d.id === p.discussionId)));
  // Chapters start folded: a row is its time, how it ended, its title and its length.
  const isOpen = (key: string) => toggled[key] ?? false;
  const openSet = new Set(chapters.filter((c) => isOpen(c.key)).map((c) => c.key));
  const jumpTo = (i: number) => setToggled((t) => ({ ...t, [chapters[i].key]: true }));
  // People in the colors the transcript gives them.
  const speakerId = new Map(segments.map((s) => [s.speakerName, s.speakerId]));
  const colorOf = (name: string) => colorFor(speakerId.get(name) ?? name);
  const owner = (n: Note) =>
    n.owner ? (
      <Face name={n.owner} color={colorOf(n.owner)} title={`${n.owner}${n.doneAt && n.doneBy ? ` · done by ${n.doneBy}` : ""}`} />
    ) : (
      <span className="rc-face none" title="Unassigned">
        ?
      </span>
    );
  const nextCount = upNext && upNext.since === data.startedAt ? upNext.suggestions.length + upNext.parked.length : 0;

  return (
    <div className="doc recap">
      <nav className="crumbs">
        <Link to={`/r/${data.roomId}`}>← {data.roomName}</Link>
      </nav>
      <header className="doc-head">
        <h1>
          {data.roomName} · {fmtDate(data.startedAt)}
        </h1>
        <p className="muted rc-meta">
          {fmtTime(data.startedAt)}
          {data.endedAt ? ` · ${fmtDuration(data.endedAt - data.startedAt)}` : " · in progress"}
          {people.length > 0 && (
            <>
              {" · "}
              <span className="rc-ch-faces">
                {people.map((p) => (
                  <Face key={p} name={p} color={colorOf(p)} size={18} />
                ))}
              </span>{" "}
              {people.map((p) => p.split(/\s+/)[0]).join(", ")}
            </>
          )}
        </p>
        {data.summary && <p className="lede">{data.summary}</p>}
        {(actions.length > 0 || decided.length > 0 || questions.length > 0 || chapters.length > 0) && (
          <nav className="glance" aria-label="Jump to">
            {actions.length > 0 && (
              <a href="#todo" className={`glance-chip todo${here === "todo" ? " here" : ""}`}>
                <TodoIcon /> <b>{open}</b> to do{open < actions.length && <span className="muted"> · {actions.length - open} done</span>}
              </a>
            )}
            {decided.length > 0 && (
              <a href="#decided" className={`glance-chip decided${here === "decided" ? " here" : ""}`}>
                <DecidedIcon /> <b>{decided.length}</b> decided
              </a>
            )}
            {questions.length > 0 && (
              <a href="#open" className={`glance-chip question${here === "open" ? " here" : ""}`}>
                <QuestionIcon /> <b>{questions.length}</b> open
              </a>
            )}
            {chapters.length > 0 && (
              <a href="#chapters" className={`glance-chip topic${here === "chapters" ? " here" : ""}`}>
                <TopicIcon /> <b>{chapters.length}</b> chapter{chapters.length === 1 ? "" : "s"}
              </a>
            )}
          </nav>
        )}
        {chapters.length > 1 && <ChapterBar chapters={chapters} from={data.startedAt} to={Math.max(endAt, lastTs)} onPick={jumpTo} />}
      </header>

      {groups.length === 0 && <p className="muted">Nothing was recorded in this meeting.</p>}

      {data.synthesis && (
        <section id="synthesis" className="doc-section rc-section rc-synthesis">
          <h2 className="rc-h synth">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>{" "}
            Synthesis
          </h2>
          <Markdown text={data.synthesis} />
        </section>
      )}

      {actions.length > 0 && (
        <section id="todo" className="doc-section rc-section">
          <h2 className="rc-h todo">
            <TodoIcon /> To do
          </h2>
          <FollowUpList
            notes={actions}
            onToggle={saveFollowUp(data.roomId)}
            below={shots}
            oneLine
            after={chipFor}
            tail={owner}
          />
        </section>
      )}
      {decided.length > 0 && (
        <section id="decided" className="doc-section rc-section">
          <h2 className="rc-h decided">
            <DecidedIcon /> Decided
          </h2>
          <PointList notes={decided} kind="decided" chip={chipFor} below={shots} startedAt={data.startedAt} />
        </section>
      )}
      {questions.length > 0 && (
        <section id="open" className="doc-section rc-section">
          <h2 className="rc-h question">
            <QuestionIcon /> Open questions
          </h2>
          <PointList notes={questions} kind="question" chip={chipFor} below={shots} />
        </section>
      )}
      {carried.length > 0 && (
        <section className="doc-section rc-section">
          <h2 className="rc-h carry">
            <CarryIcon /> Still open from earlier meetings <span className="count">{carried.length}</span>
          </h2>
          <FollowUpList notes={carried} onToggle={saveFollowUp(data.roomId)} source={source} showDate />
        </section>
      )}

      {groups.length > 0 && (
        <section id="chapters" className="doc-section rc-section">
          <div className="rc-group-head">
            <h2 className="rc-h topic">
              <TopicIcon /> Chapters
            </h2>
            <button className="link small" onClick={() => setOpen((o) => ({ ...o, all: !o.all }))}>
              {open_.all ? "Hide transcript" : `Whole transcript (${segments.length})`}
            </button>
          </div>
          <SnapStrip snaps={looseSnaps} />
          <ChapterList
            chapters={chapters}
            written={written}
            discussions={discussions}
            notes={all}
            segments={segments}
            items={groups.map((g) => g.item)}
            snapsOnTopic={onTopic}
            startedAt={data.startedAt}
            open={openSet}
            setOpen={(key, o) => setToggled((t) => (isOpen(key) === o ? t : { ...t, [key]: o }))}
            colorOf={colorOf}
          />
          {leftover.map(({ d, g }) => (
            <TopicRow key={d.id} d={d} segments={g.segments} snaps={onTopic(d.id)} />
          ))}
          {open_.all && <Turns segments={segments} />}
        </section>
      )}

      {/* Only the latest meeting knows what carries: the draft moves on once the next one starts. */}
      {upNext && nextCount > 0 && (
        <details id="next" className="doc-section rc-section rc-next-fold">
          <summary className="rc-h carry">
            <span className="upnext-mark" aria-hidden>
              ↻
            </span>{" "}
            {nextCount} carr{nextCount === 1 ? "ies" : "y"} to the next agenda
          </summary>
          <ul className="rc-next">
            {[...upNext.suggestions, ...upNext.parked].map((s) => (
              <li key={s.key}>
                <span className="upnext-mark" aria-hidden>
                  ✦
                </span>
                <span className="rc-next-title">{s.title}</span>
                <span className="muted small">{s.reason}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">The agent suggests these for the next agenda. The host adds the ones worth talking about.</p>
        </details>
      )}

      <ConxtPanel roomId={data.roomId} meetingId={data.meetingId} />

      <footer className="brief-bar rc-brief">
        <span className="muted small">Follow-up brief for people and agents</span>
        <button className="brief-btn" onClick={() => void copyBrief()}>
          {copied ? "Copied" : "Copy as Markdown"}
        </button>
        <a className="brief-btn" href={briefUrl("json")} target="_blank" rel="noreferrer">
          JSON
        </a>
      </footer>
    </div>
  );
}

/** Decisions or open questions, one line each with its icon. */
function PointList(props: {
  notes: Note[];
  kind: "decided" | "question";
  /** Where it came from: its chapter. */
  chip?: (n: Note) => React.ReactNode;
  below?: (n: Note) => React.ReactNode;
  startedAt?: number;
}) {
  const Icon = props.kind === "decided" ? DecidedIcon : QuestionIcon;
  return (
    <ul className={`rc-points ${props.kind}`}>
      {props.notes.map((n) => {
        return (
          <li key={n.id}>
            <Icon />
            <span className="rc-point-body">
              <span>
                {n.text}
                {n.quote && <QuoteMark quote={n.quote} startedAt={props.startedAt} />}
                {props.chip?.(n)}
              </span>
              {props.below?.(n)}
            </span>
            <CopyForAgent kind={props.kind === "decided" ? "decision" : "question"} id={n.id} />
          </li>
        );
      })}
    </ul>
  );
}

const OUTCOME: Record<DiscussionOutcome, { label: string; Icon: (p: { size?: number }) => React.ReactElement }> = {
  decided: { label: "Decided", Icon: DecidedIcon },
  action: { label: "Action", Icon: TodoIcon },
  open: { label: "Open", Icon: QuestionIcon },
  info: { label: "FYI", Icon: InfoIcon },
};

/** One topic: a single line with its outcome; who said what opens below it.
 *  Screenshots discussed under it show below the line, with what was said around them. */
function TopicRow({ d, segments, snaps }: { d: Discussion; segments: Segment[]; snaps: Snap[] }) {
  const [showTurns, setShowTurns] = useState(false);
  const turns = d.segmentIds.flatMap((id) => segments.filter((s) => s.id === id));
  const idOf = (name: string) => turns.find((s) => s.speakerName === name)?.speakerId ?? name;
  const o = OUTCOME[d.outcome];
  return (
    <>
      <details className="rc-topic">
        <summary>
          <span className="rc-topic-title">{d.topic}</span>
          <span className={`rc-outcome ${d.outcome}`}>
            <o.Icon size={13} /> {o.label}
          </span>
          <span className="rc-people">{d.positions.map((p) => p.speaker).join(", ")}</span>
        </summary>
        <div className="rc-topic-body">
          {d.continues && (
            <p className="muted small">
              Continues from <Link to={`/meetings/${d.continues.meetingId}`}>{fmtDate(d.continues.startedAt)}</Link>
            </p>
          )}
          {d.positions.map((p, i) => (
            <p key={i} className="rc-position">
              <span className="who" style={{ color: colorFor(idOf(p.speaker)) }}>
                {p.speaker}
              </span>
              {p.position}
              {p.quote && <QuoteMark quote={p.quote} />}
            </p>
          ))}
          <div className="disc-foot">
            {turns.length > 0 && (
              <button className="link small" onClick={() => setShowTurns((s) => !s)}>
                {showTurns ? "Hide what was said" : `What was said (${turns.length})`}
              </button>
            )}
            <CopyForAgent kind="topic" id={d.id} label />
          </div>
          {showTurns && <Turns segments={turns} />}
        </div>
      </details>
      {snaps.length > 0 && (
        <div className="rc-topic-shots">
          <SnapFigures snaps={snaps} segments={segments} />
        </div>
      )}
    </>
  );
}

function Turns({ segments }: { segments: Segment[] }) {
  return (
    <div className="transcript static">
      {segments.map((s) => (
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
  );
}

/** Which of these sections the reader is in: the last one whose top has scrolled past the upper part of the screen. */
function useSectionInView(ids: string[], ready: boolean): string | null {
  const [here, setHere] = useState<string | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    if (!ready) return;
    const pick = () => {
      let at: string | null = null;
      for (const id of key.split(",")) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < window.innerHeight * 0.35) at = id;
      }
      setHere(at);
    };
    pick();
    document.addEventListener("scroll", pick, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", pick, { capture: true });
  }, [key, ready]);
  return here;
}
