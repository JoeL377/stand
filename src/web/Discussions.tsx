import { useState } from "react";
import { Link } from "react-router-dom";
import type { Discussion, DiscussionOutcome, Note, Segment } from "../shared/protocol.ts";
import { NoteList } from "./room/SidePanel.tsx";
import { colorFor, fmtDate, fmtTime } from "./util.ts";

const OUTCOME: Record<DiscussionOutcome, string> = { decided: "Decided", action: "Action", open: "Open", info: "Update" };

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
  // Same color per person as in the transcript, which keys colors by speaker id.
  const idOf = (name: string) => turns.find((s) => s.speakerName === name)?.speakerId ?? name;
  return (
    <details className="disc" open={props.open}>
      <summary>
        <span className="disc-head">
          <span className="disc-topic">{d.topic}</span>
          <span className={`disc-outcome ${d.outcome}`}>{OUTCOME[d.outcome]}</span>
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
        {d.positions.length > 0 && (
          <ul className="disc-positions">
            {d.positions.map((p, i) => (
              <li key={i}>
                <span className="who" style={{ color: colorFor(idOf(p.speaker)) }}>
                  {p.speaker}
                </span>
                <span>{p.position}</span>
              </li>
            ))}
          </ul>
        )}
        {notes.length > 0 && <NoteList notes={notes} />}
        {turns.length > 0 && (
          <button className="link small" onClick={() => setShowTurns((s) => !s)}>
            {showTurns ? "Hide what was said" : `What was said (${turns.length})`}
          </button>
        )}
        {showTurns && (
          <div className="transcript static disc-turns">
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
