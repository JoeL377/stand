import { useState } from "react";
import { Link } from "react-router-dom";
import type { Discussion, DiscussionOutcome, Note, Segment } from "../shared/protocol.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { NoteList } from "./room/SidePanel.tsx";
import { DecidedIcon, InfoIcon, QuestionIcon, TodoIcon } from "./NoteIcons.tsx";
import { fmtDate, fmtTime } from "./util.ts";
import { QuoteMark } from "./RecapChapters.tsx";

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

/** The note that says what a topic came to, matched to its outcome. */
const HEADLINE_KIND: Record<DiscussionOutcome, Note["kind"] | null> = {
  decided: "decision",
  action: "action",
  open: "question",
  info: null,
};

function DiscussionBlock(props: {
  d: Discussion;
  notes: Note[];
  turns: Segment[];
  compact?: boolean;
  open: boolean;
}) {
  const { d, notes, turns } = props;
  const [showTurns, setShowTurns] = useState(false);
  const o = OUTCOME_META[d.outcome];
  const by = (k: Note["kind"]) => notes.filter((n) => n.kind === k);
  const ranked = [...by("decision"), ...by("action"), ...by("question")];
  const want = HEADLINE_KIND[d.outcome];
  const headline = (want && ranked.find((n) => n.kind === want)) ?? ranked[0] ?? null;
  const rest = ranked.filter((n) => n !== headline);
  const people = d.positions.length ? d.positions.map((p) => p.speaker) : [...new Set(turns.map((t) => t.speakerName))];
  const todos = by("action").filter((n) => !n.doneAt).length;
  const remarks = turns.length ? `${turns.length} remark${turns.length === 1 ? "" : "s"}` : null;
  const todoLabel = todos ? `${todos} to-do${todos === 1 ? "" : "s"}` : null;
  const meta = [people.join(", "), remarks, todoLabel].filter(Boolean);
  return (
    <details className="disc" open={props.open}>
      <summary>
        <span className="disc-head">
          <span className="disc-topic">{d.topic}</span>
          <span className={`rc-outcome ${d.outcome}`}>
            <o.Icon size={13} /> {o.label}
          </span>
        </span>
        {headline && (
          <span className={headline.doneAt ? "disc-outcome done" : "disc-outcome"}>
            {headline.text}
            {headline.kind === "action" && headline.owner && <span className="disc-owner"> · {headline.owner}</span>}
          </span>
        )}
        {meta.length > 0 && <span className="disc-meta">{meta.join(" · ")}</span>}
      </summary>
      <div className="disc-body">
        {d.continues && (
          <p className="disc-continues">
            Continues from <Link to={`/meetings/${d.continues.meetingId}`}>{fmtDate(d.continues.startedAt)}</Link>
            {d.continues.topic !== d.topic && <> · “{d.continues.topic}”</>}
          </p>
        )}
        {d.positions.length > 0 && (
          <div className="disc-section">
            <div className="disc-label">Where people landed</div>
            {d.positions.map((p, i) => (
              <p key={i} className="disc-position">
                <span className="who">{p.speaker}</span> {p.position}
                {p.quote && <QuoteMark quote={p.quote} />}
              </p>
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <div className="disc-section">
            <div className="disc-label">Came out of it</div>
            <ul className="disc-points">
              {rest.map((n) => {
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
          </div>
        )}
        <div className="disc-foot">
          {turns.length > 0 && (
            <button className="link small" onClick={() => setShowTurns((s) => !s)}>
              {showTurns ? "Hide remarks" : `Show ${turns.length} remark${turns.length === 1 ? "" : "s"}`}
            </button>
          )}
          <CopyForAgent kind="topic" id={d.id} label />
        </div>
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
  action: { label: "To do", Icon: TodoIcon },
  open: { label: "Open", Icon: QuestionIcon },
  info: { label: "FYI", Icon: InfoIcon },
};
