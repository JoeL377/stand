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

/** The note that says what a topic came to, matched to its outcome. */
const HEADLINE_KIND: Record<DiscussionOutcome, Note["kind"] | null> = { decided: "decision", action: "action", open: "question", info: null };

function DiscussionBlock(props: { d: Discussion; notes: Note[]; turns: Segment[]; compact?: boolean; open: boolean; live?: boolean; titleOnly?: boolean }) {
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
  const meta = [
    people.join(", "),
    turns.length ? `${turns.length} remark${turns.length === 1 ? "" : "s"}` : null,
    !props.live && todos ? `${todos} to-do${todos === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const overview = (
    <>
      {headline && (
        <span className={headline.doneAt ? "disc-outcome done" : "disc-outcome"}>
          {headline.text}
          {headline.kind === "action" && headline.owner && <span className="disc-owner"> · {headline.owner}</span>}
        </span>
      )}
      <span className="disc-meta">
        {meta.join(" · ")}
        {props.live && <span className="disc-now"> · Talking now</span>}
      </span>
    </>
  );
  return (
    <details className={props.titleOnly ? "disc title-only" : "disc"} open={props.open}>
      <summary>
        <span className="disc-head">
          <span className="disc-topic">{d.topic}</span>
          {!props.titleOnly && (
            <span className={`rc-outcome ${d.outcome}`}>
              <o.Icon size={13} /> {o.label}
            </span>
          )}
          {props.titleOnly && <ChevronIcon />}
        </span>
        {!props.titleOnly && overview}
      </summary>
      <div className="disc-body">
        {props.titleOnly && (
          <div className="disc-overview">
            <span className={`rc-outcome ${d.outcome}`}>
              <o.Icon size={13} /> {o.label}
            </span>
            {overview}
          </div>
        )}
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
        {turns.length > 0 && (
          <button className="link small" onClick={() => setShowTurns((s) => !s)}>
            {showTurns ? "Hide remarks" : `Show ${turns.length} remark${turns.length === 1 ? "" : "s"}`}
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
  action: { label: "To do", Icon: TodoIcon },
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
  const liveId = talkingNow(discussions, segments);

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
        <section className="tk-group tk-card">
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
        <section className="tk-group tk-card">
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
        <section className="tk-group tk-card">
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
      {discussions.length > 0 ? (
        <section className="tk-group tk-card live-topics">
          <h4>Topics</h4>
          <div className="discussions compact">
            {rankTopics(discussions, segments).map(({ d, turns }) => (
              <DiscussionBlock
                key={d.id}
                d={d}
                notes={notes.filter((n) => n.discussionId === d.id)}
                turns={turns}
                compact
                open={false}
                live={d.id === liveId}
                titleOnly
              />
            ))}
          </div>
        </section>
      ) : (
        summary.length > 0 && (
          <section className="tk-group tk-card live-topics">
            <h4>Summary</h4>
            {summary.map((n) => (
              <p key={n.id} className="live-gist">
                {n.text}
              </p>
            ))}
          </section>
        )
      )}
    </div>
  );
}

const TOPIC_ORDER: Record<DiscussionOutcome, number> = { open: 0, action: 1, decided: 2, info: 3 };

/** Topics that still need something first (open, then to-do, decided, FYI); newest first within each. */
function rankTopics(discussions: Discussion[], segments: Segment[]) {
  return discussions
    .map((d) => {
      const turns = d.segmentIds.flatMap((id) => segments.filter((s) => s.id === id));
      return { d, turns, last: turns.at(-1)?.ts ?? d.ts };
    })
    .sort((a, b) => TOPIC_ORDER[a.d.outcome] - TOPIC_ORDER[b.d.outcome] || b.last - a.last);
}

/** The topic holding the meeting's latest remark, if that remark was in the last two minutes. */
function talkingNow(discussions: Discussion[], segments: Segment[]): string | null {
  const latest = segments.reduce<Segment | null>((a, s) => (!a || s.ts > a.ts ? s : a), null);
  if (!latest || Date.now() - latest.ts > 120_000) return null;
  return discussions.find((d) => d.segmentIds.includes(latest.id))?.id ?? null;
}

const ChevronIcon = () => (
  <svg className="disc-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
