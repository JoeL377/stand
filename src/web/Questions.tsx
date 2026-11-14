// Closing open questions by hand: the answer box under a question (the answer is kept as a
// decision the question points to), and the sweep, where Stand has proposed which of a space's open
// questions a decision answers or nobody needs any more, and a person closes the ones they agree with.

import { useEffect, useState } from "react";
import type { Note, QuestionClosed, QuestionSweep } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { CloseIcon } from "./icons.tsx";
import { errorToast, toast } from "./Toasts.tsx";
import { fmtAgo, fmtDate } from "./util.ts";

const ANSWER_MAX = 500;

/** "Answered", with Undo: the question opens again and the decision the answer made goes. */
export function answeredToast(roomId: string, closed: QuestionClosed, reload: () => void) {
  const undoAnswer = closed.decision?.made ? closed.decision.id : undefined;
  toast({
    text: "Answered. Kept as a decision.",
    action: { label: "Undo", run: () => void api.setTask(roomId, closed.note.id, { state: "open", undoAnswer }).then(reload, errorToast("Couldn't undo it")) },
  });
}

/** The answer to one open question, in a line. Saving keeps it as a decision and closes the question. */
export function AnswerForm(props: { roomId: string; note: Pick<Note, "id" | "text">; onDone: (closed: QuestionClosed) => void; onCancel?: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (saving || !text.trim()) return;
    setSaving(true);
    setError("");
    try {
      const { closed } = await api.closeQuestions(props.roomId, [{ id: props.note.id, answer: text.trim() }]);
      if (!closed[0]) throw new Error("That question is already closed.");
      props.onDone(closed[0]);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };
  return (
    <form
      className="answer-form"
      aria-label={`Answer: ${props.note.text}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && props.onCancel) {
          e.preventDefault();
          props.onCancel();
        }
      }}
    >
      <input
        autoFocus={!!props.onCancel}
        aria-label="The answer"
        placeholder="Answer…"
        title="Kept as a decision"
        maxLength={ANSWER_MAX}
        value={text}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="primary" disabled={saving || !text.trim()}>
        {saving ? "Saving…" : "Answer"}
      </button>
      {props.onCancel && (
        <button type="button" className="link" onClick={props.onCancel}>
          Cancel
        </button>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/** The sweep: what Stand's last read of the open questions proposes to close, each ticked until
 *  someone unticks it. An unticked one stays open, and Stand doesn't propose it again. */
export function SweepPop(props: { roomId: string; count: number; sweep: QuestionSweep; onClose: () => void; onClosed: () => void }) {
  // As it was when the list opened: the page reads the space again while this is up.
  const [{ at, proposals }] = useState(props.sweep);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const { roomId, onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const picked = proposals.filter((p) => !off.has(p.id));
  const toggle = (id: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const close = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { closed } = await api.closeQuestions(
        roomId,
        picked.map((p) => (p.how === "answered" && p.decision ? { id: p.id, decisionId: p.decision.id } : { id: p.id, drop: p.why })),
        [...off],
      );
      toast({
        text: picked.length
          ? `Closed ${closed.length} ${closed.length === 1 ? "question" : "questions"}. They are under Done and Dropped.`
          : "Kept open. Stand won't propose them again.",
      });
      props.onClosed();
      onClose();
    } catch (err) {
      errorToast(picked.length ? "Couldn't close them" : "Couldn't save that")(err);
      setSaving(false);
    }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog sweep-pop" role="dialog" aria-modal="true" aria-label="Sweep open questions">
        <div className="sweep-head">
          <h2>
            Sweep open questions
          </h2>
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <p className="muted sweep-lead">
          Stand read the open questions {fmtAgo(at)} and thinks these {proposals.length} of {props.count} are settled or no longer matter. Untick the ones to keep open: Stand
          won't propose those again. Nothing closes until you say so.
        </p>
        <ul className="sweep-list">
          {proposals.map((p) => (
            <li key={p.id}>
              <label>
                <input type="checkbox" checked={!off.has(p.id)} disabled={saving} onChange={() => toggle(p.id)} />
                <span className="sweep-row">
                  <span className="sweep-q">
                    {p.text} <span className="muted">· {fmtDate(p.askedAt)}</span>
                  </span>
                  <span className="sweep-why">
                    <span className={`rc-pill task-closed${p.how === "drop" ? " dropped" : ""}`}>{p.how === "drop" ? "Drop" : "Answered"}</span>{" "}
                    {p.how === "answered" && p.decision ? p.decision.text : p.why}
                  </span>
                  {p.how === "answered" && p.why && <span className="sweep-note muted">{p.why}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="sweep-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={saving} onClick={() => void close()}>
            {saving ? "Saving…" : picked.length ? `Close ${picked.length} ${picked.length === 1 ? "question" : "questions"}` : "Keep them all open"}
          </button>
        </div>
      </div>
    </div>
  );
}
