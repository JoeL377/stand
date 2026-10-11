// The alignment board: what an alignment meeting shows in the middle of the screen. The
// question, where each person stands, where they differ and what would settle it, what they
// already agree on, and what's waiting on an answer. Once the host wraps up, where it landed
// comes first, with each person's answer to "Are you aligned with this?". The recap shows the
// same board, as it ended.
import { useEffect, useRef, useState } from "react";
import type { AlignmentState, AlignmentVote, AlignmentView } from "../../shared/protocol.ts";
import { colorFor, fmtTime, initials } from "../util.ts";

const VOTES: Array<{ vote: AlignmentVote; label: string }> = [
  { vote: "aligned", label: "Aligned" },
  { vote: "commit", label: "Disagree, but I'll commit" },
  { vote: "not_aligned", label: "Not aligned yet" },
];
const OUTCOME: Record<NonNullable<AlignmentState["landing"]>["outcome"], string> = {
  decided: "Decided",
  held: "Held, not decided",
  not_aligned: "Not aligned",
};

/** "47 min", "1 h 12 min": how long something has been going; null under a minute. */
export function fmtSpan(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return null;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export function AlignmentBoard(props: {
  state: AlignmentState;
  votes: AlignmentView["votes"];
  /** Who's in the meeting (live) or took part (recap): id for the color, name to match positions. */
  people: Array<{ id: string; name: string }>;
  /** Your user id: which vote is yours. */
  me: string;
  /** Live: the question can be set and the suggestion kept. Absent in the recap. */
  onQuestion?: (text: string) => void;
  onKeep?: () => void;
  onVote?: (vote: AlignmentVote) => void;
  /** Live only: "now", for how long things have been going. */
  now?: number;
}) {
  const { state: s } = props;
  const now = props.now ?? Date.now();
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.people.find((p) => p.name === name || p.name.split(/\s+/)[0] === name.split(/\s+/)[0])?.id ?? name;
  const first = (name: string) => name.split(/\s+/)[0];
  return (
    <div className="align-board">
      {s.landing && <Landing {...props} />}
      <Question state={s} now={now} onQuestion={props.onQuestion} onKeep={props.onKeep} live={Boolean(props.onQuestion)} />
      {s.landing && s.positions.length > 0 && <h3 className="align-stood">How it stood</h3>}
      {s.positions.length > 0 ? (
        <section className="align-positions" aria-label="Where each person stands">
          {s.positions.map((p) => (
            <div key={p.person} className="align-card align-person">
              <div className="align-person-head">
                <Dot id={idOf(p.person)} name={p.person} />
                <strong>{first(p.person)}</strong>
                {p.movedAt && (
                  <span className="align-moved" title={p.movedBecause ? `Moved because ${p.movedBecause}` : undefined}>
                    Moved {fmtTime(p.movedAt)}
                  </span>
                )}
              </div>
              <p className="align-stance">{p.stance}</p>
              {p.movedBecause && <p className="align-because">↻ {p.movedBecause}</p>}
              {p.reasons.length > 0 && (
                <ul className="align-reasons">
                  {p.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      ) : (
        props.onQuestion && (
          <p className="align-empty">
            <span className="agent-mark">✦</span> Each person's position shows up here as they make their case.
          </p>
        )
      )}
      {(s.differ.length > 0 || s.settleTest || s.agreed.length > 0) && (
        <section className="align-pair">
          {(s.differ.length > 0 || s.settleTest) && (
            <div className="align-card" aria-label="Where you differ">
              <span className="align-label differ">Where you differ</span>
              {s.differ.map((d) => (
                <div key={d.question} className="align-differ">
                  <p>{d.question}</p>
                  {d.sides.length > 0 && <span className="align-meta">{d.sides.map((x) => `${first(x.person)}: ${x.gist}`).join(" · ")}</span>}
                </div>
              ))}
              {s.settleTest && (
                <div className={s.differ.length ? "align-settle ruled" : "align-settle"}>
                  <span className="align-meta">What would settle it</span>
                  <p>{s.settleTest.text}</p>
                  <span className={s.settleTest.answered ? "align-meta ok" : "align-meta"}>
                    {[s.settleTest.proposedBy && `${first(s.settleTest.proposedBy)}'s test`, s.settleTest.at && fmtTime(s.settleTest.at)].filter(Boolean).join(", ")}
                    {s.settleTest.proposedBy || s.settleTest.at ? " · " : ""}
                    {s.settleTest.answered ? "answered" : "not answered yet"}
                  </span>
                </div>
              )}
            </div>
          )}
          {s.agreed.length > 0 && (
            <div className="align-card" aria-label="Agreed so far">
              <span className="align-label agreed">Agreed so far · {s.agreed.length}</span>
              <ul className="align-agreed">
                {s.agreed.map((a) => (
                  <li key={a.text}>
                    <span className="align-check">✓</span>
                    <span>
                      {a.text}{" "}
                      <span className="align-meta">
                        {[a.at && fmtTime(a.at), a.by.length >= 3 ? `all ${a.by.length}` : a.by.map(first).join(", ")].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      {(s.unanswered.length > 0 || s.parked.length > 0) && (
        <section className="align-chips" aria-label="Asked, not answered, and parked">
          {s.unanswered.length > 0 && <span className="align-meta">Waiting on an answer</span>}
          {s.unanswered.map((u) => (
            <span key={u.question} className="align-chip waiting" title={u.at ? `Asked at ${fmtTime(u.at)}` : undefined}>
              {first(u.asker)}: “{u.question}”{u.at && props.onQuestion && fmtSpan(now - u.at) ? ` · ${fmtSpan(now - u.at)}` : ""}
            </span>
          ))}
          {s.unanswered.length > 0 && s.parked.length > 0 && <span className="align-sep" aria-hidden />}
          {s.parked.length > 0 && <span className="align-meta">Parked</span>}
          {s.parked.map((p) => (
            <span key={p} className="align-chip">
              {p}
            </span>
          ))}
        </section>
      )}
    </div>
  );
}

function Dot({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  return (
    <span className="align-dot" style={{ background: colorFor(id), width: size, height: size }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** "Aligning on": the question, who asked it and since when, and why it matters now. Anyone can
 *  set or change it; the agent's suggestion is marked ✦ until someone keeps it. */
function Question(props: { state: AlignmentState; now: number; live: boolean; onQuestion?: (text: string) => void; onKeep?: () => void }) {
  const q = props.state.question;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (text.trim() !== (q?.text ?? "")) props.onQuestion?.(text.trim());
  };
  const open = () => {
    if (!props.onQuestion) return;
    setText(q?.text ?? "");
    setEditing(true);
  };
  const on = q?.at && props.live ? fmtSpan(props.now - q.at) : null;
  const meta = q && [q.askedBy && `Asked by ${q.askedBy.split(/\s+/)[0]}`, q.at && fmtTime(q.at), on && `${on} on it`].filter(Boolean);
  return (
    <section className="align-card align-question" aria-label="The question">
      <div className="align-question-head">
        <span className="align-label">Aligning on</span>
        {q?.suggested ? (
          <span className="align-meta">
            <span className="agent-mark small">✦</span> Suggested from the talk
            {props.onKeep && (
              <button className="link" onClick={props.onKeep}>
                Keep
              </button>
            )}
          </span>
        ) : (
          meta && meta.length > 0 && <span className="align-meta">{meta.join(" · ")}</span>
        )}
      </div>
      {editing ? (
        <input
          ref={input}
          className="align-question-input"
          value={text}
          maxLength={300}
          placeholder="What are we aligning on?"
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : q ? (
        <h1 className={props.onQuestion ? "align-question-text editable" : "align-question-text"} onClick={open} title={props.onQuestion ? "Change the question" : undefined}>
          {q.text}
        </h1>
      ) : props.onQuestion ? (
        <button className="align-question-text unset" onClick={open}>
          What are we aligning on?
        </button>
      ) : (
        <p className="align-meta">No question was set.</p>
      )}
      {!q && props.onQuestion && !editing && (
        <span className="align-meta">
          <span className="agent-mark small">✦</span> Stand suggests one from the first few minutes of talk.
        </span>
      )}
      {q?.whyNow && <p className="align-why">Why it matters now: {q.whyNow}</p>}
    </section>
  );
}

/** Where we landed: the outcome, what reopens it, the next steps, and each person's answer. */
function Landing(props: { state: AlignmentState; votes: AlignmentView["votes"]; people: Array<{ id: string; name: string }>; me: string; onVote?: (v: AlignmentVote) => void }) {
  const l = props.state.landing!;
  const mine = props.votes.find((v) => v.userId === props.me)?.vote;
  // Everyone who's here or took a position, and anyone who answered from elsewhere.
  const names = new Map<string, { id: string; name: string }>();
  for (const p of props.people) names.set(p.name, p);
  for (const p of props.state.positions) if (![...names.keys()].some((n) => n.split(/\s+/)[0] === p.person.split(/\s+/)[0])) names.set(p.person, { id: p.person, name: p.person });
  for (const v of props.votes) if (![...names.values()].some((p) => p.id === v.userId)) names.set(v.name, { id: v.userId, name: v.name });
  const who = [...names.values()];
  const voteOf = (p: { id: string; name: string }) => props.votes.find((v) => v.userId === p.id) ?? props.votes.find((v) => v.name === p.name);
  const label = (v: AlignmentVote) => VOTES.find((x) => x.vote === v)!.label;
  return (
    <>
      <section className="align-card align-landing" aria-label="Where we landed">
        <div className="align-question-head">
          <span className="align-label">Where we landed</span>
          <span className={`align-outcome ${l.outcome}`}>{OUTCOME[l.outcome]}</span>
        </div>
        <h1 className="align-question-text">{l.text}</h1>
        {(l.reopens || l.changesIf || l.stillOpen) && (
          <dl className="align-terms">
            {l.reopens && (
              <div>
                <dt>Reopens</dt>
                <dd>{l.reopens}</dd>
              </div>
            )}
            {l.changesIf && (
              <div>
                <dt>Changes if</dt>
                <dd>{l.changesIf}</dd>
              </div>
            )}
            {l.stillOpen && (
              <div>
                <dt>Still open</dt>
                <dd>{l.stillOpen}</dd>
              </div>
            )}
          </dl>
        )}
      </section>
      {l.nextSteps.length > 0 && (
        <section className="align-card" aria-label="Next steps">
          <span className="align-label">
            {l.outcome === "decided" ? "Next steps" : "Before it reopens"} · {l.nextSteps.length}
          </span>
          <ul className="align-steps">
            {l.nextSteps.map((s) => (
              <li key={s.text}>
                {s.owner ? <Dot id={props.people.find((p) => p.name === s.owner)?.id ?? s.owner} name={s.owner} size={20} /> : <span className="align-dot none" aria-hidden />}
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="align-card align-check-card" aria-label="Alignment check">
        <div className="align-question-head">
          <strong>Are you aligned with this?</strong>
          <span className="align-meta">
            Each person answers for themselves · {props.votes.length} of {Math.max(who.length, props.votes.length)}
          </span>
        </div>
        {props.onVote && (
          <div className="align-vote-row">
            {VOTES.map((v) => (
              <button key={v.vote} className={mine === v.vote ? `align-vote on ${v.vote}` : `align-vote ${v.vote}`} aria-pressed={mine === v.vote} onClick={() => props.onVote!(v.vote)}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        <div className="align-voters">
          {who.map((p) => {
            const v = voteOf(p);
            return (
              <span key={p.id} className={v ? `align-voter ${v.vote}` : "align-voter"}>
                {p.name.split(/\s+/)[0]} · {v ? label(v.vote) : "waiting"}
              </span>
            );
          })}
        </div>
      </section>
    </>
  );
}
