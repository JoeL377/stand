import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Discussion, DiscussionOutcome, Note, Segment } from "../shared/protocol.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { NoteList } from "./room/SidePanel.tsx";
import { DecidedIcon, InfoIcon, QuestionIcon, TodoIcon } from "./NoteIcons.tsx";
import { colorFor, fmtDate, fmtTime, initials } from "./util.ts";

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
  live?: boolean;
  titleOnly?: boolean;
  /** Live panel: point at this topic's to-dos in the To do card. */
  onShowTodos?: (ids: string[]) => void;
}) {
  const { d, notes, turns } = props;
  const [showTurns, setShowTurns] = useState(false);
  const [turnsPop, setTurnsPop] = useState(false);
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
  // The live panel shows remarks and to-dos as pills below instead.
  const meta = props.titleOnly ? [] : [people.join(", "), remarks, !props.live ? todoLabel : null].filter(Boolean);
  const overview = (
    <>
      {headline && (
        <span className={headline.doneAt ? "disc-outcome done" : "disc-outcome"}>
          {headline.text}
          {headline.kind === "action" && headline.owner && <span className="disc-owner"> · {headline.owner}</span>}
        </span>
      )}
      {(meta.length > 0 || props.live) && (
        <span className="disc-meta">
          {meta.join(" · ")}
          {props.live && <span className="disc-now">{meta.length ? " · " : ""}Talking now</span>}
        </span>
      )}
    </>
  );
  return (
    <details
      className={props.titleOnly ? "disc title-only" : "disc"}
      open={props.open}
      onToggle={(e) => {
        const el = e.currentTarget;
        if (props.titleOnly && el.open) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      }}
    >
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
        {!props.titleOnly && d.positions.length > 0 && (
          <div className="disc-section">
            <div className="disc-label">Where people landed</div>
            {d.positions.map((p, i) => (
              <p key={i} className="disc-position">
                <span className="who">{p.speaker}</span> {p.position}
              </p>
            ))}
          </div>
        )}
        {!props.titleOnly && rest.length > 0 && (
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
        {props.titleOnly ? (
          <div className="disc-foot">
            <span className="disc-pills">
              {people.length > 0 && (
                <span className="disc-people" title={people.join(", ")} aria-label={people.join(", ")}>
                  {people.slice(0, 4).map((name) => (
                    <span
                      key={name}
                      className="disc-avatar"
                      style={{ background: colorFor(turns.find((t) => t.speakerName === name)?.speakerId ?? name) }}
                    >
                      {initials(name)}
                    </span>
                  ))}
                  {people.length > 4 && <span className="disc-avatar more">+{people.length - 4}</span>}
                </span>
              )}
              {remarks && (
                <button className="disc-pill" onClick={() => setTurnsPop(true)}>
                  {remarks}
                </button>
              )}
              {todoLabel && props.onShowTodos && (
                <button
                  className="disc-pill"
                  onClick={() =>
                    props.onShowTodos!(
                      by("action")
                        .filter((n) => !n.doneAt)
                        .map((n) => n.id),
                    )
                  }
                  title="Show in To do"
                >
                  {todoLabel}
                </button>
              )}
            </span>
            <CopyForAgent kind="topic" id={d.id} />
          </div>
        ) : (
          <div className="disc-foot">
            {turns.length > 0 && (
              <button className="link small" onClick={() => setShowTurns((s) => !s)}>
                {showTurns ? "Hide remarks" : `Show ${turns.length} remark${turns.length === 1 ? "" : "s"}`}
              </button>
            )}
            <CopyForAgent kind="topic" id={d.id} label />
          </div>
        )}
        {turnsPop && <RemarksPopup topic={d.topic} turns={turns} onClose={() => setTurnsPop(false)} />}
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

/** Everything said in one topic, over the page. Esc or a click outside closes it. */
function RemarksPopup(props: { topic: string; turns: Segment[]; onClose: () => void }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog remarks-pop" role="dialog" aria-modal="true" aria-label={`Remarks: ${props.topic}`}>
        <div className="remarks-pop-head">
          <strong>{props.topic}</strong>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="disc-turns remarks-pop-body">
          {props.turns.map((s) => (
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
      </div>
    </div>
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
type EditableKind = "action" | "decision" | "question";

/** What the meeting's host can do to the agent's notes. Absent for everyone else. */
export type NoteEditing = {
  change: (n: Note, text: string, owner: string | null) => void;
  remove: (n: Note) => void;
  add: (kind: EditableKind, text: string, owner: string | null) => void;
};

/** Inline form for one note: its wording, plus an owner for a to-do. */
function NoteForm(props: {
  kind: EditableKind;
  text?: string;
  owner?: string | null;
  onSave: (text: string, owner: string | null) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [text, setText] = useState(props.text ?? "");
  const [owner, setOwner] = useState(props.owner ?? "");
  const save = () => {
    if (text.trim()) props.onSave(text.trim(), owner.trim() || null);
  };
  return (
    <form
      className="note-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={text}
        maxLength={500}
        aria-label="Note"
        placeholder={props.kind === "action" ? "What needs doing" : props.kind === "decision" ? "What was decided" : "What's still open"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      {props.kind === "action" && (
        <label className="note-form-owner">
          <span>Owner</span>
          <input value={owner} maxLength={60} placeholder="Anyone" onChange={(e) => setOwner(e.target.value)} />
        </label>
      )}
      <div className="note-form-row">
        {props.onDelete && (
          <button type="button" className="note-form-delete" onClick={props.onDelete}>
            Delete
          </button>
        )}
        <span className="note-form-gap" />
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!text.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

function EditButton(props: { onClick: () => void }) {
  return (
    <button className="note-edit-btn" onClick={props.onClick} title="Edit or delete" aria-label="Edit or delete">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function LiveItemNotes(props: {
  notes: Note[];
  discussions: Discussion[];
  segments: Segment[];
  onToggle?: (n: Note, done: boolean) => void;
  editing?: NoteEditing;
}) {
  const { notes, discussions, segments, onToggle, editing } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<EditableKind | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [flash, setFlash] = useState<string[]>([]);
  useEffect(() => {
    if (!flash.length) return;
    document.querySelector(`[data-note-id="${flash[0]}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = setTimeout(() => setFlash([]), 2200);
    return () => clearTimeout(t);
  }, [flash]);
  const todo = notes.filter((n) => n.kind === "action" && !n.doneAt);
  const done = notes.filter((n) => n.kind === "action" && n.doneAt);
  const decided = notes.filter((n) => n.kind === "decision");
  const open = notes.filter((n) => n.kind === "question");
  const summary = notes.filter((n) => n.kind === "summary");
  const empty = !todo.length && !done.length && !decided.length && !open.length;
  const liveId = talkingNow(discussions, segments);

  /** A note being edited turns into its form; otherwise the host gets an edit button beside it. */
  const editRow = (n: Note) =>
    editing && editingId === n.id ? (
      <li key={n.id} className="tk editing">
        <NoteForm
          kind={n.kind as EditableKind}
          text={n.text}
          owner={n.owner}
          onSave={(text, owner) => {
            editing.change(n, text, owner);
            setEditingId(null);
          }}
          onDelete={() => {
            editing.remove(n);
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      </li>
    ) : null;
  const edited = (n: Note) =>
    n.editedBy ? (
      <span className="note-edited" title={`Edited by ${n.editedBy}`}>
        edited
      </span>
    ) : null;
  const editBtn = (n: Note) => (editing ? <EditButton onClick={() => setEditingId(n.id)} /> : null);

  const action = (n: Note) =>
    editRow(n) ?? (
      <li key={n.id} data-note-id={n.id} className={`tk action${n.doneAt ? " done" : ""}${flash.includes(n.id) ? " flash" : ""}`}>
        <input
          type="checkbox"
          checked={!!n.doneAt}
          disabled={!onToggle}
          onChange={(e) => onToggle?.(n, e.target.checked)}
          aria-label={n.doneAt ? "Mark not done" : "Mark done"}
        />
        <span className="tk-text">
          {n.text}
          {edited(n)}
        </span>
        {n.owner && <span className="owner">{n.owner}</span>}
        {editBtn(n)}
        <CopyForAgent kind="action" id={n.id} />
      </li>
    );

  return (
    <div className="live-notes">
      {empty && !adding && notes.length > 0 && <p className="tk-empty">Nothing decided or assigned yet.</p>}
      {(todo.length > 0 || done.length > 0 || (editing && !adding)) && (
        <section className="tk-group tk-card">
          <h4 className="tk-card-head">
            To do
            {editing && !adding && (
              <span className="add-menu-wrap">
                <button
                  className="note-add-btn"
                  title="Add a to-do, decision or question"
                  aria-expanded={addMenu}
                  onClick={() => setAddMenu((m) => !m)}
                >
                  +
                </button>
                {addMenu && (
                  <div className="add-menu note-add-menu" role="menu" onMouseLeave={() => setAddMenu(false)}>
                    {(["action", "decision", "question"] as const).map((k) => (
                      <button
                        key={k}
                        role="menuitem"
                        onClick={() => {
                          setAdding(k);
                          setAddMenu(false);
                        }}
                      >
                        {k === "action" ? "To-do" : k === "decision" ? "Decision" : "Open question"}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            )}
          </h4>
          {todo.length === 0 && done.length === 0 && <p className="tk-none">Nothing yet</p>}
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
            {decided.map(
              (n) =>
                editRow(n) ?? (
                  <li key={n.id} className="tk decision">
                    <span className="tk-icon">✓</span>
                    <span className="tk-text">
                      {n.text}
                      {edited(n)}
                    </span>
                    {editBtn(n)}
                    <CopyForAgent kind="decision" id={n.id} />
                  </li>
                ),
            )}
          </ul>
        </section>
      )}
      {open.length > 0 && (
        <section className="tk-group tk-card">
          <h4>Open questions</h4>
          <ul>
            {open.map(
              (n) =>
                editRow(n) ?? (
                  <li key={n.id} className="tk question">
                    <span className="tk-icon">?</span>
                    <span className="tk-text">
                      {n.text}
                      {edited(n)}
                    </span>
                    {editBtn(n)}
                    <CopyForAgent kind="question" id={n.id} />
                  </li>
                ),
            )}
          </ul>
        </section>
      )}
      {editing &&
        (adding ? (
          <section className="tk-group tk-card note-add">
            <h4>{adding === "action" ? "New to-do" : adding === "decision" ? "New decision" : "New open question"}</h4>
            <NoteForm
              key={adding}
              kind={adding}
              onSave={(text, owner) => {
                editing.add(adding, text, owner);
                setAdding(null);
              }}
              onCancel={() => setAdding(null)}
            />
          </section>
        ) : null)}
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
                onShowTodos={setFlash}
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
  <svg
    className="disc-chevron"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
);
