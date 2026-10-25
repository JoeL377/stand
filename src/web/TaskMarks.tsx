// The marks a task carries on top of its state (shared/tasks.ts): Said done, with the words Stand
// heard, and what closed it. Small pills after the task's text, details in a pop-up.
import type { Note, Quote } from "../shared/protocol.ts";
import { closedLabel, closedPr } from "../shared/tasks.ts";
import { fmtDate, fmtTime } from "./util.ts";

/** "Said done": someone said it's finished and nothing shows it yet. The pop-up has their words;
 *  onUndo takes the mark off when Stand heard it wrong. */
export function SaidDonePill({ quote, onUndo }: { quote: Quote; onUndo?: () => void }) {
  const who = quote.speaker.split(" ")[0];
  return (
    <span className="rc-pill-wrap task-said">
      <span className="rc-pill task-said-pill" tabIndex={0} aria-label={`${who} said it's done: “${quote.text}”`}>
        Said done
      </span>
      <span className="rc-pop" role="tooltip">
        <span className="rc-pop-crux">“{quote.text}”</span>
        <span className="rc-pop-meta">
          {who} · {fmtDate(quote.ts)} {fmtTime(quote.ts)}
        </span>
      </span>
      {onUndo && (
        <button type="button" className="task-said-undo" aria-label="Not done: Stand heard it wrong" title="Not done: Stand heard it wrong" onClick={onUndo}>
          ×
        </button>
      )}
    </span>
  );
}

/** What closed a task: "PR #41 merged" (a link), "Confirmed, no PR", or why it was dropped. */
export function ClosedPill({ note }: { note: Pick<Note, "state" | "closedBy" | "dropReason" | "doneBy" | "doneAt"> }) {
  const dropped = note.state === "dropped";
  const label = dropped ? "Dropped" : closedLabel(note.closedBy);
  if (!label) return null;
  const pr = closedPr(note.closedBy);
  const meta = [note.doneBy, note.doneAt && fmtDate(note.doneAt)].filter(Boolean).join(" · ");
  return (
    <span className="rc-pill-wrap">
      {pr ? (
        <a className={`rc-pill task-closed`} href={pr} target="_blank" rel="noreferrer">
          {label}
        </a>
      ) : (
        <span className={`rc-pill task-closed${dropped ? " dropped" : ""}`} tabIndex={0}>
          {label}
        </span>
      )}
      {(meta || note.dropReason) && (
        <span className="rc-pop" role="tooltip">
          {note.dropReason && <span className="rc-pop-crux">{note.dropReason}</span>}
          {meta && <span className="rc-pop-meta">{meta}</span>}
        </span>
      )}
    </span>
  );
}
