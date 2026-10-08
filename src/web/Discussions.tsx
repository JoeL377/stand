import { useState } from "react";
import { Link } from "react-router-dom";
import type { Discussion, DiscussionOutcome, Note, Segment } from "../shared/protocol.ts";
import { NoteList } from "./room/SidePanel.tsx";
import { DecidedIcon, InfoIcon, QuestionIcon, TodoIcon } from "./NoteIcons.tsx";
import { fmtDate, fmtTime } from "./util.ts";


/** An item's notes as the agent grouped them: the summary, then one block per
 *  discussion with who argued what and what came of it. Notes that belong to
 *  no discussion (or were written before discussions existed) follow. */
export function ItemNotes(props: { notes: Note[]; discussions: Discussion[]; segments: Segment[]; compact?: boolean }) {
  const { notes, discussions, segments } = props;
  if (!discussions.length) return <NoteList notes={notes} />;
  const ids = new Set(discussions.map((d) => d.id));
  const summary = notes.filter((n) => n.kind === "summary");
  const loose = notes.filter((n) => n.kind !== "summary" && !(n.discussionId && ids.has(n.discussionId)));
  return (
    <>
      {summary.length > 0 && <NoteList notes={summary} />}
      <div className={props.compact ? "discussions compact" : "discussions"}>
        {discussions.map((d) => (
          <DiscussionBlock
            key={d.id}
            d={d}
            notes={notes.filter((n) => n.discussionId === d.id)}
            turns={d.segmentIds.flatMap((id) => segments.filter((s) => s.id === id))}
            compact={props.compact}
            open={discussions.length === 1}
          />
        ))}
      </div>
      {loose.length > 0 && <NoteList notes={loose} />}
    </>
  );
}

function DiscussionBlock(props: { d: Discussion; notes: Note[]; turns: Segment[]; compact?: boolean; open: boolean }) {
  const { d, notes, turns } = props;
  const [showTurns, setShowTurns] = useState(false);
  const o = OUTCOME_META[d.outcome];
  const by = (k: Note["kind"]) => notes.filter((n) => n.kind === k);
  const points = [...by("decision"), ...by("action"), ...by("question")];
  return (
    <details className="disc" open={props.open}>
      <summary>
        <span className="disc-head">
          <span className="disc-topic">{d.topic}</span>
          <span className={`rc-outcome ${d.outcome}`}>
            <o.Icon size={13} /> {o.label}
          </span>
        </span>
        {d.positions.length > 0 && <span className="disc-people">{d.positions.map((p) => p.speaker).join(", ")}</span>}
      </summary>
      <div className="disc-body">
        {d.continues && (
          <p className="disc-continues">
            Continues from <Link to={`/meetings/${d.continues.meetingId}`}>{fmtDate(d.continues.startedAt)}</Link>
            {d.continues.topic !== d.topic && <> · “{d.continues.topic}”</>}
          </p>
        )}
        {points.length > 0 && (
          <ul className="disc-points">
            {points.map((n) => {
              const Icon = n.kind === "decision" ? DecidedIcon : n.kind === "action" ? TodoIcon : QuestionIcon;
              return (
                <li key={n.id} className={`${n.kind}${n.doneAt ? " done" : ""}`}>
                  <Icon />
                  <span className="disc-point-body">
                    <span className="disc-point-text">{n.text}</span>
                    {n.kind === "action" && (n.owner || n.doneAt) && (
                      <span className="disc-point-meta">
                        {n.owner ?? "No owner"}
                        {n.doneAt ? ` · done${n.doneBy ? ` by ${n.doneBy}` : ""}` : ""}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {d.positions.length > 0 && (
          <div className="disc-section">
            <div className="disc-label">Who said what</div>
            {d.positions.map((p, i) => (
              <p key={i} className="disc-position">
                <span className="who">{p.speaker}</span> {p.position}
              </p>
            ))}
          </div>
        )}
        {turns.length > 0 && (
          <button className="link small" onClick={() => setShowTurns((s) => !s)}>
            {showTurns ? "Hide what was said" : `What was said (${turns.length})`}
          </button>
        )}
        {showTurns && (
          <div className="disc-turns">
            {turns.map((s) => (
              <div key={s.id} className="disc-turn">
                <div className="disc-turn-head">
                  <span className="who">{s.speakerName}</span>
                  {s.kind === "chat" && <span className="seg-kind">chat</span>}
                  <span className="seg-time">{fmtTime(s.ts)}</span>
                </div>
                <div>{s.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

const OUTCOME_META: Record<DiscussionOutcome, { label: string; Icon: (p: { size?: number }) => React.ReactElement }> = {
  decided: { label: "Decided", Icon: DecidedIcon },
  action: { label: "Action", Icon: TodoIcon },
  open: { label: "Open", Icon: QuestionIcon },
  info: { label: "FYI", Icon: InfoIcon },
};

/** The live side-panel card, ranked by what helps during the meeting:
 *  1. open action items (checkable), 2. decisions, 3. open questions;
 *  then the gist and one row per topic (name + outcome), whose positions and
 *  raw turns open one level down. Done actions fold
 *  into a single "n done" line. */
export function LiveItemNotes(props: {
  notes: Note[];
  discussions: Discussion[];
  segments: Segment[];
  onToggle?: (n: Note, done: boolean) => void;
}) {
  const { notes, discussions, segments, onToggle } = props;
  const [showDone, setShowDone] = useState(false);
  const todo = notes.filter((n) => n.kind === "action" && !n.doneAt);
  const done = notes.filter((n) => n.kind === "action" && n.doneAt);
  const decided = notes.filter((n) => n.kind === "decision");
  const open = notes.filter((n) => n.kind === "question");
  const summary = notes.filter((n) => n.kind === "summary");
  const empty = !todo.length && !done.length && !decided.length && !open.length;
  const detailCount = discussions.length || summary.length;

  const action = (n: Note) => (
    <li key={n.id} className={n.doneAt ? "tk action done" : "tk action"}>
      <input
        type="checkbox"
        checked={!!n.doneAt}
        disabled={!onToggle}
        onChange={(e) => onToggle?.(n, e.target.checked)}
        aria-label={n.doneAt ? "Mark not done" : "Mark done"}
      />
      <span className="tk-text">{n.text}</span>
      {n.owner && <span className="owner">{n.owner}</span>}
    </li>
  );

  return (
    <div className="live-notes">
      {empty && <p className="tk-empty">Nothing decided or assigned yet.</p>}
      {(todo.length > 0 || done.length > 0) && (
        <section className="tk-group">
          <h4>To do</h4>
          {todo.length > 0 && <ul>{todo.map(action)}</ul>}
          {done.length > 0 && (
            <>
              <button className="link small tk-more" onClick={() => setShowDone((s) => !s)}>
                {showDone ? "Hide done" : `${done.length} done`}
              </button>
              {showDone && <ul className="tk-done">{done.map(action)}</ul>}
            </>
          )}
        </section>
      )}
      {decided.length > 0 && (
        <section className="tk-group">
          <h4>Decided</h4>
          <ul>
            {decided.map((n) => (
              <li key={n.id} className="tk decision">
                <span className="tk-icon">✓</span>
                <span className="tk-text">{n.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {open.length > 0 && (
        <section className="tk-group">
          <h4>Open questions</h4>
          <ul>
            {open.map((n) => (
              <li key={n.id} className="tk question">
                <span className="tk-icon">?</span>
                <span className="tk-text">{n.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {detailCount > 0 && (
        <section className="tk-group live-topics">
          <h4>{discussions.length ? `Topics (${discussions.length})` : "Summary"}</h4>
          {summary.map((n) => (
            <p key={n.id} className="live-gist">
              {n.text}
            </p>
          ))}
          {discussions.length > 0 && (
            <div className="discussions compact">
              {discussions.map((d) => (
                <DiscussionBlock
                  key={d.id}
                  d={d}
                  notes={[]}
                  turns={d.segmentIds.flatMap((id) => segments.filter((s) => s.id === id))}
                  compact
                  open={false}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
