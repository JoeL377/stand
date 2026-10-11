// The alignment board: what an alignment meeting shows in the middle of the screen. The
// question, where each person stands, where they differ and what would settle it, what they
// already agree on, and what's waiting on an answer. Once the host wraps up, where it landed
// comes first, as one card with the question it answers and each person's answer to "Are you
// aligned with this?". The recap shows the same board, as it ended.
import { type CSSProperties, createContext, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AlignmentState, AlignmentVote, AlignmentView } from "../../shared/protocol.ts";
import { toast, undoing } from "../Toasts.tsx";
import { colorFor, fmtTime, initials } from "../util.ts";

const VOTES: Array<{ vote: AlignmentVote; label: string; counted: string }> = [
  { vote: "aligned", label: "Aligned", counted: "aligned" },
  { vote: "commit", label: "Disagree, but I'll commit", counted: "committing" },
  { vote: "not_aligned", label: "Not aligned yet", counted: "not aligned yet" },
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

type Person = { id: string; name: string };
const first = (name: string) => name.split(/\s+/)[0];

/** Live boards mark what just changed. Things already on the board when it opens don't count. */
const Live = createContext<{ live: boolean; opened: RefObject<boolean> }>({ live: false, opened: { current: false } });

/** True for a moment after `text` changes (or the thing first appears, once the board is open). */
function useFlash(text: string) {
  const { live, opened } = useContext(Live);
  const prev = useRef<string | null>(opened.current ? null : text);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === text) return;
    prev.current = text;
    if (!live) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(t);
  }, [text, live]);
  return on;
}

export function AlignmentBoard(props: {
  state: AlignmentState;
  votes: AlignmentView["votes"];
  /** Who's in the meeting (live) or took part (recap): id for the color, name to match positions. */
  people: Person[];
  /** Your user id: which vote is yours. */
  me: string;
  /** Live: the question can be set and the suggestion kept. Absent in the recap. Return false
   *  when it couldn't be sent. */
  onQuestion?: (text: string) => boolean;
  onKeep?: () => void;
  /** Answer "Are you aligned with this?"; a promise that rejects (or false) puts your answer back. */
  onVote?: (vote: AlignmentVote) => boolean | Promise<unknown>;
  /** The host is having it written again: answers wait. */
  wrapping?: boolean;
  /** Live only: "now", for how long things have been going. */
  now?: number;
}) {
  const { state: s } = props;
  const live = Boolean(props.onQuestion);
  const now = props.now ?? Date.now();
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.people.find((p) => p.name === name || first(p.name) === first(name))?.id ?? name;
  // Live, before anyone's made their case: a place for each person, filled in as they do.
  const unheard = live && !s.landing && props.people.length <= 8 ? props.people.filter((p) => !s.positions.some((x) => first(x.person) === first(p.name))) : [];
  return (
    <Live.Provider value={{ live, opened }}>
      <div className="align-board">
        {s.landing ? <Landing {...props} idOf={idOf} /> : <Question state={s} now={now} live={live} onQuestion={props.onQuestion} onKeep={props.onKeep} />}
        {(s.positions.length > 0 || unheard.length > 0) && (
          <section className="align-group" aria-label="Where each person stands">
            {s.landing && <h3 className="align-label">How it stood</h3>}
            <div className="align-positions">
              {s.positions.map((p) => (
                <Position key={p.person} p={p} id={idOf(p.person)} />
              ))}
              {unheard.map((p) => (
                <div key={p.id} className="align-card align-person unheard" title={`Where ${first(p.name)} stands shows up here once they make their case`}>
                  <div className="align-person-head">
                    <Dot id={p.id} name={p.name} />
                    <strong>{first(p.name)}</strong>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {(s.differ.length > 0 || s.settleTest || s.agreed.length > 0) && (
          <section className="align-pair">
            {(s.differ.length > 0 || s.settleTest) && (
              <div className="align-col" aria-label="Where you differ">
                {s.differ.length > 0 && <span className="align-label differ">Where you differ</span>}
                {s.differ.map((d) => (
                  <Differ key={d.question} d={d} />
                ))}
                {s.settleTest && <Settle t={s.settleTest} ruled={s.differ.length > 0} />}
              </div>
            )}
            {s.agreed.length > 0 && (
              <div className="align-col" aria-label="Agreed so far">
                <span className="align-label agreed">Agreed so far · {s.agreed.length}</span>
                <ul className="align-agreed">
                  {s.agreed.map((a) => (
                    <Agreed key={a.text} a={a} />
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
              <Chip key={u.question} className="align-chip waiting" title={u.at ? `Asked at ${fmtTime(u.at)}` : undefined} text={u.question}>
                {first(u.asker)}: “{u.question}”{u.at && live && fmtSpan(now - u.at) ? ` · ${fmtSpan(now - u.at)}` : ""}
              </Chip>
            ))}
            {s.unanswered.length > 0 && s.parked.length > 0 && <span className="align-sep" aria-hidden />}
            {s.parked.length > 0 && <span className="align-meta">Parked</span>}
            {s.parked.map((p) => (
              <Chip key={p} className="align-chip" text={p}>
                {p}
              </Chip>
            ))}
          </section>
        )}
      </div>
    </Live.Provider>
  );
}

function Dot({ id, name, size = 22, title }: { id: string; name: string; size?: number; title?: string }) {
  return (
    <span
      className="align-dot"
      style={{ background: colorFor(id), width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.45)) } as CSSProperties}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      {initials(name)}
    </span>
  );
}

function Position({ p, id }: { p: AlignmentState["positions"][number]; id: string }) {
  const flash = useFlash(p.stance + (p.movedAt ?? ""));
  return (
    <div className={flash ? "align-card align-person align-new" : "align-card align-person"}>
      <div className="align-person-head">
        <Dot id={id} name={p.person} />
        <strong>{first(p.person)}</strong>
        {p.movedAt && (
          <span className="align-moved" title={`Moved at ${fmtTime(p.movedAt)}`}>
            ↻ Moved
          </span>
        )}
      </div>
      <p className="align-stance">{p.stance}</p>
      {p.movedBecause && <p className="align-because">{p.movedBecause}</p>}
      {p.reasons.length > 0 && (
        <ul className="align-reasons">
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Differ({ d }: { d: AlignmentState["differ"][number] }) {
  const flash = useFlash(d.question + d.sides.map((x) => x.gist).join());
  return (
    <div className={flash ? "align-differ align-new" : "align-differ"}>
      <p>{d.question}</p>
      {d.sides.length > 0 && <span className="align-meta">{d.sides.map((x) => `${first(x.person)}: ${x.gist}`).join(" · ")}</span>}
    </div>
  );
}

function Settle({ t, ruled }: { t: NonNullable<AlignmentState["settleTest"]>; ruled: boolean }) {
  const flash = useFlash(t.text + t.answered);
  return (
    <div className={["align-settle", ruled && "ruled", flash && "align-new"].filter(Boolean).join(" ")}>
      <div className="align-head">
        <span className="align-label">Would settle it</span>
        <span className={t.answered ? "align-state ok" : "align-state warn"}>{t.answered ? "Answered" : "Not answered yet"}</span>
      </div>
      <p>{t.text}</p>
      {t.proposedBy && (
        <span className="align-meta" title={t.at ? `Proposed at ${fmtTime(t.at)}` : undefined}>
          {first(t.proposedBy)}'s test
        </span>
      )}
    </div>
  );
}

function Agreed({ a }: { a: AlignmentState["agreed"][number] }) {
  const flash = useFlash(a.text);
  const by = a.by.length >= 3 ? `all ${a.by.length}` : a.by.map(first).join(", ");
  return (
    <li className={flash ? "align-new" : undefined} title={a.at ? `Agreed at ${fmtTime(a.at)}` : undefined}>
      <span className="align-check">✓</span>
      <span>
        {a.text} {by && <span className="align-meta">{by}</span>}
      </span>
    </li>
  );
}

function Chip({ className, title, text, children }: { className: string; title?: string; text: string; children: ReactNode }) {
  const flash = useFlash(text);
  return (
    <span className={flash ? `${className} align-new` : className} title={title}>
      {children}
    </span>
  );
}

/** "Aligning on": the question, who asked it and for how long, and why it matters now. Anyone
 *  can set or change it; the agent's suggestion is marked ✦ until someone keeps it. */
function Question(props: { state: AlignmentState; now: number; live: boolean; onQuestion?: (text: string) => boolean; onKeep?: () => void }) {
  const q = props.state.question;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const flash = useFlash(q?.text ?? "");
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  // The box grows with the question, at the same size as the question itself.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, text]);
  const save = () => {
    setEditing(false);
    const next = text.trim().replace(/\s+/g, " ");
    // Emptying it is the same as Esc: the question is everyone's, so it's never wiped by accident.
    if (!next || next === (q?.text ?? "")) return;
    const before = q?.text;
    if (!props.onQuestion?.(next) || !before) return;
    toast({ text: "Question changed", action: { label: "Undo", run: undoing(() => props.onQuestion?.(before) ?? false) } });
  };
  const open = () => {
    if (!props.onQuestion) return;
    setText(q?.text ?? "");
    setEditing(true);
  };
  const on = q?.at && props.live ? fmtSpan(props.now - q.at) : null;
  const meta = q && [q.askedBy && `Asked by ${first(q.askedBy)}`, on && `${on} on it`].filter(Boolean);
  return (
    <section className={flash ? "align-question align-new" : "align-question"} aria-label="The question">
      <div className="align-head">
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
          meta &&
          meta.length > 0 && (
            <span className="align-meta" title={q.at ? `Asked at ${fmtTime(q.at)}` : undefined}>
              {meta.join(" · ")}
            </span>
          )
        )}
      </div>
      {editing ? (
        <textarea
          ref={input}
          className="align-question-input"
          aria-label="What are we aligning on?"
          rows={1}
          value={text}
          maxLength={300}
          placeholder="What are we aligning on?"
          onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
          // Switching apps mid-edit isn't done editing.
          onBlur={() => document.hasFocus() && save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <h2 className="align-question-h">
          {q && props.onQuestion ? (
            <button className="align-question-text editable" onClick={open} title="Change the question">
              {q.text}
            </button>
          ) : q ? (
            <span className="align-question-text">{q.text}</span>
          ) : props.onQuestion ? (
            <button className="align-question-text unset" onClick={open} title="Or let Stand suggest one from the first few minutes of talk">
              What are we aligning on?
            </button>
          ) : (
            <span className="align-question-text unset">No question was set</span>
          )}
        </h2>
      )}
      {q?.whyNow && <p className="align-why">Why it matters now: {q.whyNow}</p>}
    </section>
  );
}

/** Where we landed, as one card: the question it answers, the outcome and its terms, what
 *  happens next, and each person's answer to "Are you aligned with this?". */
function Landing(props: {
  state: AlignmentState;
  votes: AlignmentView["votes"];
  people: Person[];
  me: string;
  onVote?: (v: AlignmentVote) => boolean | Promise<unknown>;
  wrapping?: boolean;
  idOf: (name: string) => string;
}) {
  const l = props.state.landing!;
  const q = props.state.question;
  const ref = useRef<HTMLElement>(null);
  const { live } = useContext(Live);
  // A new landing is the moment of the meeting: bring it into view, wherever people had scrolled.
  const landed = useRef(l.text);
  useEffect(() => {
    if (landed.current === l.text) return;
    landed.current = l.text;
    if (!live) return;
    const box = ref.current?.closest(".align-tab");
    box?.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [l.text, live]);
  const fresh = useFlash(l.text);
  // Your answer shows as soon as you click; the server's copy replaces it.
  const [picked, setPicked] = useState<AlignmentVote | null>(null);
  const saved = props.votes.find((v) => v.userId === props.me)?.vote;
  useEffect(() => setPicked(null), [saved]);
  const mine = picked ?? saved;
  const vote = (v: AlignmentVote) => {
    if (!props.onVote || props.wrapping) return;
    setPicked(v);
    const sent = props.onVote(v);
    if (sent === false) setPicked(null);
    else if (sent instanceof Promise) sent.catch(() => setPicked(null));
  };
  // Everyone who's here or took a position, and anyone who answered from elsewhere.
  const names = new Map<string, Person>();
  for (const p of props.people) names.set(p.name, p);
  for (const p of props.state.positions) if (![...names.keys()].some((n) => first(n) === first(p.person))) names.set(p.person, { id: p.person, name: p.person });
  for (const v of props.votes) if (![...names.values()].some((p) => p.id === v.userId)) names.set(v.name, { id: v.userId, name: v.name });
  const who = [...names.values()];
  const voteOf = (p: Person): AlignmentVote | undefined =>
    p.id === props.me && mine ? mine : (props.votes.find((v) => v.userId === p.id) ?? props.votes.find((v) => v.name === p.name))?.vote;
  const answered = who.filter((p) => voteOf(p));
  const waiting = who.filter((p) => !voteOf(p));
  const all = answered.length > 0 && waiting.length === 0;
  const tally = VOTES.map((v) => ({ ...v, n: answered.filter((p) => voteOf(p) === v.vote).length })).filter((v) => v.n > 0);
  return (
    <section ref={ref} className={fresh ? "align-card align-landing align-in" : "align-card align-landing"} aria-label="Where we landed">
      <div className="align-head">
        <span className="align-label">Aligning on</span>
        <span className="align-landing-q">{q?.text ?? "No question was set"}</span>
        <span className={`align-outcome ${l.outcome}`}>{OUTCOME[l.outcome]}</span>
      </div>
      <h2 className="align-headline">{l.text}</h2>
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
      {l.nextSteps.length > 0 && (
        <div className="align-landing-part" aria-label="Next steps">
          <span className="align-label">
            {l.outcome === "decided" ? "Next steps" : "Before it reopens"} · {l.nextSteps.length}
          </span>
          <ul className="align-steps">
            {l.nextSteps.map((s) => (
              <li key={s.text}>
                {s.owner ? <Dot id={props.idOf(s.owner)} name={s.owner} size={20} title={s.owner} /> : <span className="align-dot none" aria-hidden />}
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="align-landing-part align-check-part" aria-label="Are you aligned with this?">
        <div className="align-head">
          <strong>Are you aligned with this?</strong>
          <span className={all ? "align-meta ok" : "align-meta"}>
            {props.wrapping
              ? "Writing it again…"
              : all
                ? `All ${answered.length} answered · ${tally.map((v) => `${v.n} ${v.counted}`).join(", ")}`
                : `${answered.length} of ${who.length}`}
          </span>
        </div>
        <div className="align-vote-row">
          {VOTES.map((v) => {
            const chose = answered.filter((p) => voteOf(p) === v.vote);
            return (
              <button
                key={v.vote}
                className={mine === v.vote ? `align-vote on ${v.vote}` : `align-vote ${v.vote}`}
                aria-pressed={mine === v.vote}
                disabled={!props.onVote || props.wrapping}
                title={chose.length ? `${v.label}: ${chose.map((p) => first(p.name)).join(", ")}` : undefined}
                onClick={() => vote(v.vote)}
              >
                {v.label}
                {chose.length > 0 && (
                  <span className="align-stack" aria-hidden>
                    {chose.map((p) => (
                      <Dot key={p.id} id={p.id} name={p.name} size={18} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
          {waiting.length > 0 && (
            <span className="align-waiting" aria-label={`Waiting on ${waiting.map((p) => first(p.name)).join(", ")}`}>
              {waiting.map((p) => (
                <Dot key={p.id} id={p.id} name={p.name} size={18} title={`${first(p.name)} · waiting`} />
              ))}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
