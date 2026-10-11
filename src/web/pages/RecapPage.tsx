import { type CSSProperties, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConxtPanel } from "../ConxtPanel.tsx";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { SnapFigures, SnapStrip } from "../Snaps.tsx";
import type { Discussion, DiscussionOutcome, MeetingRecap, Note, Segment, Snap, UpNext } from "../../shared/protocol.ts";
import { api, request, type RoomInfo } from "../api.ts";
import { errorToast, toast } from "../Toasts.tsx";
import { FollowUpList, itemHref, saveFollowUp, sourceLabel } from "../FollowUps.tsx";
import { Markdown } from "../Synthesis.tsx";
import { CarryIcon, DecidedIcon, InfoIcon, QuestionIcon, TodoIcon, TopicIcon } from "../NoteIcons.tsx";
import { colorFor, fmtDate, fmtDuration, fmtTime, keyOf } from "../util.ts";
import { AlignmentBoard } from "../room/AlignmentBoard.tsx";
import { useAuth } from "../auth.tsx";

export function RecapPage() {
  const { meetingId = "" } = useParams();
  const [data, setData] = useState<MeetingRecap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open_, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const { user } = useAuth();

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
  const topicCount = groups.reduce((k, g) => k + (g.discussions?.length ?? 0), 0);
  // Only label where something came from when there was more than one place it could be.
  const many = groups.length > 1;
  const src = many ? source : undefined;
  const open = actions.filter((n) => !n.doneAt).length;
  // Each screenshot has one home: under the to-do, decision or question it
  // backs; otherwise under the topic it was discussed in; otherwise its item.
  const snaps = groups.flatMap((g) => g.snaps ?? []);
  const noteIds = new Set(all.map((n) => n.id));
  const onNote = (id: string) => snaps.filter((p) => p.noteId === id);
  const unplaced = (p: Snap) => !(p.noteId && noteIds.has(p.noteId));
  const onTopic = (id: string) => snaps.filter((p) => unplaced(p) && p.discussionId === id);
  const topicIds = new Set(groups.flatMap((g) => (g.discussions ?? []).map((d) => d.id)));
  const shots = (n: Note) => <SnapFigures snaps={onNote(n.id)} />;

  // An alignment meeting's recap opens with where it landed and who's aligned with it, in place
  // of the summary and the counts (which count notes, not where people stand); the notes follow.
  const align = data.alignment;
  const alignFirst = Boolean(align && (align.state.question || align.state.positions.length > 0 || align.state.landing));
  const overview = (
    <>
      {data.summary && <p className="lede">{data.summary}</p>}
      {(actions.length > 0 || decided.length > 0 || questions.length > 0 || topicCount > 0) && (
        <div className="glance">
          {actions.length > 0 && (
            <a href="#todo" className="glance-chip todo">
              <TodoIcon /> <b>{open}</b> to do{open < actions.length && <span className="muted"> · {actions.length - open} done</span>}
            </a>
          )}
          {decided.length > 0 && (
            <a href="#decided" className="glance-chip decided">
              <DecidedIcon /> <b>{decided.length}</b> decided
            </a>
          )}
          {questions.length > 0 && (
            <a href="#open" className="glance-chip question">
              <QuestionIcon /> <b>{questions.length}</b> open
            </a>
          )}
          {topicCount > 0 && (
            <a href="#topics" className="glance-chip topic">
              <TopicIcon /> <b>{topicCount}</b> topic{topicCount === 1 ? "" : "s"}
            </a>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="doc recap">
      <nav className="crumbs">
        <Link to={`/r/${data.roomId}`}>← {data.roomName}</Link>
      </nav>
      <header className="doc-head">
        <h1>
          {data.roomName} · {fmtDate(data.startedAt)}
        </h1>
        <p className="muted">
          {fmtTime(data.startedAt)}
          {data.endedAt ? ` · ${fmtDuration(data.endedAt - data.startedAt)}` : " · in progress"}
          {people.length > 0 && ` · ${people.join(", ")}`}
        </p>
        {!alignFirst && overview}
      </header>

      {alignFirst && data.alignment && (
        <section id="alignment" className="doc-section rc-section rc-alignment">
          <AlignmentBoard
            state={data.alignment.state}
            votes={data.alignment.votes}
            people={[...new Map(groups.flatMap((g) => g.segments).map((s) => [s.speakerId, { id: s.speakerId, name: s.speakerName }])).values()]}
            me={user.id}
            onVote={
              data.alignment.state.landing
                ? (vote) =>
                    api.alignmentVote(data.meetingId, vote).then(
                      (r) => setData((d) => d && d.alignment && { ...d, alignment: { ...d.alignment, votes: r.votes } }),
                      (err) => {
                        errorToast("Couldn't save your answer")(err);
                        throw err;
                      },
                    )
                : undefined
            }
          />
        </section>
      )}

      <ConxtPanel roomId={data.roomId} meetingId={data.meetingId} />

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
          <FollowUpList notes={actions} onToggle={saveFollowUp(data.roomId)} source={src} below={shots} />
        </section>
      )}
      {decided.length > 0 && (
        <section id="decided" className="doc-section rc-section">
          <h2 className="rc-h decided">
            <DecidedIcon /> Decided
          </h2>
          <PointList notes={decided} kind="decided" source={src} below={shots} />
        </section>
      )}
      {questions.length > 0 && (
        <section id="open" className="doc-section rc-section">
          <h2 className="rc-h question">
            <QuestionIcon /> Open questions
          </h2>
          <PointList notes={questions} kind="question" source={src} below={shots} />
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
        <section id="topics" className="doc-section rc-section">
          <h2 className="rc-h topic">
            <TopicIcon /> What was discussed
          </h2>
          {groups.map((g) => {
            const key = g.item?.id ?? "general";
            const gist = g.notes.find((n) => n.kind === "summary");
            return (
              <div key={key} className="rc-group">
                <div className="rc-group-head">
                  <h3>
                    {keyOf(g.item) && <span className="key">{keyOf(g.item)}</span>}
                    {g.item ? <Link to={`/items/${g.item.id}`}>{g.item.title}</Link> : "General / off-agenda"}
                  </h3>
                  <button className="link small" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                    {open_[key] ? "Hide transcript" : `Transcript (${g.segments.length})`}
                  </button>
                </div>
                {gist && <p className="rc-gist">{gist.text}</p>}
                <SnapStrip snaps={(g.snaps ?? []).filter((p) => unplaced(p) && !(p.discussionId && topicIds.has(p.discussionId)))} />
                {(g.discussions ?? []).map((d) => (
                  <TopicRow key={d.id} d={d} segments={g.segments} snaps={onTopic(d.id)} />
                ))}
                {open_[key] && <Turns segments={g.segments} />}
              </div>
            );
          })}
        </section>
      )}

      {/* Only the latest meeting knows what carries: the draft moves on once the next one starts. */}
      {upNext && upNext.since === data.startedAt && upNext.suggestions.length + upNext.parked.length > 0 && (
        <section id="next" className="doc-section rc-section">
          <h2 className="rc-h carry">
            <span className="upnext-mark" aria-hidden>
              ↻
            </span>{" "}
            Carries to next time <span className="count">{upNext.suggestions.length + upNext.parked.length}</span>
          </h2>
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
        </section>
      )}

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
  source?: (n: Note) => { label: string; href: string | null } | null;
  below?: (n: Note) => React.ReactNode;
}) {
  const Icon = props.kind === "decided" ? DecidedIcon : QuestionIcon;
  return (
    <ul className={`rc-points ${props.kind}`}>
      {props.notes.map((n) => {
        const src = props.source?.(n);
        return (
          <li key={n.id}>
            <Icon />
            <span className="rc-point-body">
              <span>{n.text}</span>
              {src && <span className="rc-src">{src.href ? <Link to={src.href}>{src.label}</Link> : src.label}</span>}
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
            <span className="seg-who" style={{ "--who": colorFor(s.speakerId) } as CSSProperties}>
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
