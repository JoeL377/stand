// The alignment board: what an alignment meeting shows in the middle of the screen. One card:
// what's on the table (the agreement Stand hears forming, written as something the group could
// say yes to) and everyone's answer to it, Agree / Can live with it / Concern / Block. Stand's
// guess from what someone said shows dashed until they tap their own. Under it, the one concern
// holding it up. Wrap-up freezes the same card with the outcome and who does what next, and
// the recap opens with it. Everything else the agent keeps (stances, where they differ, what's
// agreed, waiting and parked) is one click away under More.
import { type CSSProperties, createContext, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AlignmentState, AlignmentVote, AlignmentView } from "../../shared/protocol.ts";
import { toast, undoing } from "../Toasts.tsx";
import { colorFor, fmtTime, initials } from "../util.ts";

const ANSWERS: Array<{ vote: AlignmentVote; label: string }> = [
  { vote: "agree", label: "Agree" },
  { vote: "live_with", label: "Can live with it" },
  { vote: "concern", label: "Concern" },
  { vote: "block", label: "Block" },
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
const samePerson = (a: string, b: string) => a === b || first(a).toLowerCase() === first(b).toLowerCase();

/** Live boards mark what just changed. Things already on the board when it opens don't count. */
const Live = createContext<{ live: boolean; opened: RefObject<boolean>; more: boolean }>({ live: false, opened: { current: false }, more: false });
/** Until when things appearing are only being revealed (More was clicked), not new. */
let revealing = 0;

/** True for a moment after `text` changes (or the thing first appears, once the board is open). */
function useFlash(text: string) {
  const { live, opened } = useContext(Live);
  const prev = useRef<string | null>(opened.current && Date.now() > revealing ? null : text);
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

type BoardProps = {
  state: AlignmentState;
  votes: AlignmentView["votes"];
  /** Who's in the meeting (live) or took part (recap): id for the color, name to match positions. */
  people: Person[];
  /** Your user id: which answer is yours. */
  me: string;
  /** Live: the question can be set and the suggestion kept. Absent in the recap. Return false
   *  when it couldn't be sent. */
  onQuestion?: (text: string) => boolean;
  onKeep?: () => void;
  /** Answer what's on the table; a promise that rejects (or false) puts your answer back. */
  onVote?: (vote: AlignmentVote) => boolean | Promise<unknown>;
  /** The host is having it written again: answers wait. */
  wrapping?: boolean;
  /** Live only: "now", for how long things have been going. */
  now?: number;
};

export function AlignmentBoard(props: BoardProps) {
  const { state: s } = props;
  const live = Boolean(props.onQuestion);
  const now = props.now ?? Date.now();
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);
  const [more, setMore] = useState(() => readMore());
  const toggle = () => {
    revealing = Date.now() + 300;
    setMore((m) => {
      writeMore(!m);
      return !m;
    });
  };
  // The color for a person: by their id when they're here, else by name.
  const idOf = (name: string) => props.people.find((p) => samePerson(p.name, name))?.id ?? name;
  const table = s.landing ? { text: s.landing.text } : s.proposal;
  const concern = s.proposal?.concern ?? null;
  const counts = [
    s.positions.length > 0 && `${s.positions.length} stance${s.positions.length === 1 ? "" : "s"}`,
    s.agreed.length > 0 && `✓ ${s.agreed.length} agreed`,
    s.unanswered.length > 0 && `${s.unanswered.length} unanswered`,
    s.parked.length > 0 && `${s.parked.length} parked`,
  ].filter(Boolean);
  const terms = s.landing && (s.landing.reopens || s.landing.changesIf || s.landing.stillOpen);
  const hidden = counts.length > 0 || s.differ.length > 0 || Boolean(s.settleTest) || Boolean(terms) || Boolean(table && s.question?.whyNow);
  return (
    <Live.Provider value={{ live, opened, more }}>
      <div className="align-board">
        {/* The recap has no tab row to carry the question: it sits small above the card. */}
        {table && !live && s.question && <p className="align-asked">{s.question.text}</p>}
        {table ? (
          <Table {...props} text={table.text} idOf={idOf} now={now} />
        ) : (
          <section className="align-card align-table">
            <Question state={s} now={now} live={live} onQuestion={props.onQuestion} onKeep={props.onKeep} />
            {live && (
              <p className="align-forming">
                <span className="agent-mark small">✦</span> Stand will put a proposal here once one forms
              </p>
            )}
          </section>
        )}
        {table && concern && <Concern c={concern} id={idOf(concern.person)} />}
        {s.landing && s.landing.nextSteps.length > 0 && (
          <div className="align-next" aria-label="Next steps">
            <span className="align-label">Next</span>
            {s.landing.nextSteps.map((n) => (
              <span key={n.text} className="align-next-step">
                {n.owner ? <Dot id={idOf(n.owner)} name={n.owner} size={18} title={n.owner} /> : <span className="align-dot none" aria-hidden />}
                {n.text}
              </span>
            ))}
          </div>
        )}
        {more && <Rest state={s} idOf={idOf} now={now} live={live} terms={Boolean(terms)} showWhy={Boolean(table)} />}
        {hidden && (
          <button className="align-more" onClick={toggle} aria-expanded={more}>
            {!more && counts.length > 0 && <span>{counts.join(" · ")}</span>}
            <span className="align-more-label">{more ? "Less" : "More"}</span>
          </button>
        )}
      </div>
    </Live.Provider>
  );
}

/** What's on the table, and everyone's answer to it. Live, Stand's guesses show dashed for
 *  whoever hasn't answered; once it's landed only people's own answers count. */
function Table(props: BoardProps & { text: string; idOf: (name: string) => string; now: number }) {
  const s = props.state;
  const l = s.landing;
  const ref = useRef<HTMLElement>(null);
  const { live } = useContext(Live);
  const fresh = useFlash(props.text);
  // Landing is the moment of the meeting: bring it into view, wherever people had scrolled.
  const landed = useRef(l?.text);
  useEffect(() => {
    if (landed.current === l?.text) return;
    landed.current = l?.text;
    if (!live || !l) return;
    const box = ref.current?.closest(".align-tab");
    box?.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [l?.text, live]);
  // Your answer shows as soon as you tap; the server's copy replaces it.
  const [picked, setPicked] = useState<AlignmentVote | null>(null);
  const saved = props.votes.find((v) => v.userId === props.me)?.vote;
  useEffect(() => setPicked(null), [saved]);
  const mine = picked ?? saved;
  const answer = (v: AlignmentVote) => {
    if (!props.onVote || props.wrapping) return;
    setPicked(v);
    const sent = props.onVote(v);
    if (sent === false) setPicked(null);
    else if (sent instanceof Promise) sent.catch(() => setPicked(null));
  };
  // Everyone here, everyone Stand has a read on, and anyone who answered from elsewhere.
  const who: Person[] = [];
  const add = (p: Person) => {
    if (!who.some((x) => x.id === p.id || samePerson(x.name, p.name))) who.push(p);
  };
  for (const p of props.people) add(p);
  for (const p of s.positions) add({ id: props.idOf(p.person), name: p.person });
  for (const g of s.proposal?.guesses ?? []) add({ id: props.idOf(g.person), name: g.person });
  for (const v of props.votes) add({ id: v.userId, name: v.name });
  const tapOf = (p: Person): AlignmentVote | undefined =>
    p.id === props.me && mine ? mine : (props.votes.find((v) => v.userId === p.id) ?? props.votes.find((v) => samePerson(v.name, p.name)))?.vote;
  const guessOf = (p: Person) => (l ? undefined : s.proposal?.guesses.find((g) => samePerson(g.person, p.name))?.answer);
  const tapped = who.filter((p) => tapOf(p));
  const behind = tapped.filter((p) => tapOf(p) === "agree" || tapOf(p) === "live_with").length;
  const rewritten = !l && s.proposal?.rewrittenAt ? (fmtSpan(props.now - s.proposal.rewrittenAt) ?? "just now") : null;
  return (
    <section ref={ref} className={["align-card align-table", l && "landed", fresh && (l ? "align-in" : "align-new")].filter(Boolean).join(" ")} aria-label={l ? "Where we landed" : "On the table"}>
      <div className="align-head">
        {l ? (
          <>
            <span className={`align-outcome ${l.outcome}`}>{OUTCOME[l.outcome]}</span>
            <span className={tapped.length && tapped.length === who.length ? "align-meta ok" : "align-meta"}>
              {props.wrapping ? "Writing it again…" : `${behind} of ${who.length} agree or can live with it`}
            </span>
          </>
        ) : (
          <span className="align-label">
            <span className="agent-mark small">✦</span> On the table
          </span>
        )}
        {rewritten && (
          <span className="align-rewritten" title={s.proposal?.rewrittenAt ? `Rewritten at ${fmtTime(s.proposal.rewrittenAt)}` : undefined}>
            Rewritten {rewritten === "just now" ? rewritten : `${rewritten} ago`}
          </span>
        )}
      </div>
      <p className="align-proposal">{props.text}</p>
      <div className={live ? "align-answers" : "align-answers compact"} role="group" aria-label="Your answer">
        {ANSWERS.map((a) => {
          const taps = who.filter((p) => tapOf(p) === a.vote);
          const guesses = who.filter((p) => !tapOf(p) && guessOf(p) === a.vote);
          const names = [...taps.map((p) => first(p.name)), ...guesses.map((p) => `${first(p.name)} (Stand's guess)`)];
          return (
            <button
              key={a.vote}
              className={mine === a.vote ? `align-answer mine ${a.vote}` : `align-answer ${a.vote}`}
              aria-pressed={mine === a.vote}
              disabled={!props.onVote || props.wrapping}
              title={names.length ? `${a.label}: ${names.join(", ")}` : undefined}
              onClick={() => answer(a.vote)}
            >
              <span>{a.label}</span>
              {(live || taps.length > 0 || guesses.length > 0) && (
                <span className="align-stack" aria-hidden>
                  {taps.map((p) => (
                    <Dot key={p.id} id={p.id} name={p.name} size={live ? 22 : 18} />
                  ))}
                  {guesses.map((p) => (
                    <Dot key={p.id} id={p.id} name={p.name} size={live ? 22 : 18} guess />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Concern({ c, id }: { c: { person: string; text: string }; id: string }) {
  const flash = useFlash(c.person + c.text);
  return (
    <p className={flash ? "align-concern align-new" : "align-concern"} aria-label="Holding it up">
      <Dot id={id} name={c.person} size={18} />
      <span>
        <b>{first(c.person)}:</b> {c.text}
      </span>
    </p>
  );
}

/** Behind More: where each person stands, where they differ and what would settle it, what's
 *  agreed, what's waiting and parked; once landed, its terms. */
function Rest(props: { state: AlignmentState; idOf: (name: string) => string; now: number; live: boolean; terms: boolean; showWhy: boolean }) {
  const { state: s, now, live } = props;
  const l = s.landing;
  return (
    <>
      {props.showWhy && s.question?.whyNow && <p className="align-why">Why it matters now: {s.question.whyNow}</p>}
      {l && props.terms && (
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
      {s.positions.length > 0 && (
        <section className="align-positions" aria-label="Where each person stands">
          {s.positions.map((p) => (
            <Position key={p.person} p={p} id={props.idOf(p.person)} />
          ))}
        </section>
      )}
      {(s.differ.length > 0 || s.settleTest) && (
        <section className="align-pair">
          {s.differ.length > 0 && (
            <div className="align-col" aria-label="Where you differ">
              <span className="align-label differ">Where you differ</span>
              {s.differ.map((d) => (
                <Differ key={d.question} d={d} />
              ))}
            </div>
          )}
          {s.settleTest && <Settle t={s.settleTest} />}
        </section>
      )}
      {s.agreed.length > 0 && (
        <section className="align-col" aria-label="Agreed so far">
          <span className="align-label agreed">Agreed so far · {s.agreed.length}</span>
          <ul className="align-agreed">
            {s.agreed.map((a) => (
              <Agreed key={a.text} a={a} />
            ))}
          </ul>
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
    </>
  );
}

// Whether you keep More open: yours alone, remembered in this browser.
const MORE_KEY = "stand.alignMore";
function readMore() {
  try {
    return localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMore(on: boolean) {
  try {
    localStorage.setItem(MORE_KEY, on ? "1" : "0");
  } catch {
    // Private windows: More just isn't remembered.
  }
}

/** A person's initials in their color. A guess (Stand's read, not their own answer) is dashed. */
function Dot({ id, name, size = 22, title, guess }: { id: string; name: string; size?: number; title?: string; guess?: boolean }) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.45)), "--who": colorFor(id) } as CSSProperties;
  return (
    <span className={guess ? "align-dot guess" : "align-dot"} style={guess ? style : { ...style, background: colorFor(id) }} title={title} aria-hidden={title ? undefined : true}>
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
          <span className="align-moved" title={[`Moved at ${fmtTime(p.movedAt)}`, p.movedBecause].filter(Boolean).join(": ")}>
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

function Settle({ t }: { t: NonNullable<AlignmentState["settleTest"]> }) {
  const flash = useFlash(t.text + t.answered);
  return (
    <div className={flash ? "align-col align-settle align-new" : "align-col align-settle"} aria-label="What would settle it">
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

/** Editing the question, shared by the big version (before anything's on the table) and the
 *  small one in the tab row: emptying it is a cancel, switching apps isn't done editing, and
 *  a change can be undone. */
function useQuestionEdit(q: AlignmentState["question"], onQuestion?: (text: string) => boolean) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = () => {
    setEditing(false);
    const next = text.trim().replace(/\s+/g, " ");
    // The question is everyone's, so it's never wiped by accident.
    if (!next || next === (q?.text ?? "")) return;
    const before = q?.text;
    if (!onQuestion?.(next) || !before) return;
    toast({ text: "Question changed", action: { label: "Undo", run: undoing(() => onQuestion?.(before) ?? false) } });
  };
  const open = () => {
    if (!onQuestion) return;
    setText(q?.text ?? "");
    setEditing(true);
  };
  const field = {
    ref: input,
    value: text,
    maxLength: 300,
    placeholder: "What are we aligning on?",
    "aria-label": "What are we aligning on?",
    onChange: (e: { target: { value: string } }) => setText(e.target.value.replace(/\n/g, " ")),
    onBlur: () => document.hasFocus() && save(),
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") setEditing(false);
    },
  };
  return { editing, text, open, field, input };
}

/** The question, small, for the tab row once something is on the table. Click to change it. */
export function QuestionLine({ state, onQuestion, now }: { state: AlignmentState; onQuestion?: (text: string) => boolean; now: number }) {
  const q = state.question;
  const { editing, open, field } = useQuestionEdit(q, onQuestion);
  if (editing) return <input className="align-q-line-input" {...field} />;
  if (!q) return null;
  const on = q.at ? fmtSpan(now - q.at) : null;
  const meta = [q.suggested ? "✦ Suggested from the talk" : q.askedBy && `Asked by ${first(q.askedBy)}`, on && `${on} on it`, onQuestion && "Click to change"].filter(Boolean);
  return (
    <button className="align-q-line" onClick={open} disabled={!onQuestion} title={meta.join(" · ")}>
      {q.suggested && <span className="agent-mark small">✦</span>} {q.text}
    </button>
  );
}

/** Before anything's on the table: the question, big. Anyone can set or change it; the
 *  agent's suggestion is marked ✦ until someone keeps it. */
function Question(props: { state: AlignmentState; now: number; live: boolean; onQuestion?: (text: string) => boolean; onKeep?: () => void }) {
  const q = props.state.question;
  const { editing, text, open, field, input } = useQuestionEdit(q, props.onQuestion);
  const flash = useFlash(q?.text ?? "");
  // The box grows with the question, at the same size as the question itself.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, text]);
  const on = q?.at && props.live ? fmtSpan(props.now - q.at) : null;
  const meta = q && [q.askedBy && `Asked by ${first(q.askedBy)}`, on && `${on} on it`].filter(Boolean);
  return (
    <div className={flash ? "align-question align-new" : "align-question"} aria-label="The question">
      {q?.suggested && (
        <span className="align-meta">
          <span className="agent-mark small">✦</span> Suggested from the talk
          {props.onKeep && (
            <button className="link" onClick={props.onKeep}>
              Keep
            </button>
          )}
        </span>
      )}
      {editing ? (
        <textarea className="align-question-input" rows={1} {...field} />
      ) : (
        <h2 className="align-question-h">
          {q && props.onQuestion ? (
            <button className="align-question-text editable" onClick={open} title={[...(meta ?? []), "Click to change"].join(" · ")}>
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
    </div>
  );
}
