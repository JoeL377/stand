import { useId, useState } from "react";
import type { Note } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { useDismiss } from "./useDismiss.ts";

const OWNER_MAX = 80;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Who has a to-do: pick someone in the space, type a name, or leave it unassigned. `children` is
 *  what the button shows, such as their face. */
export function OwnerPicker({ note, roomId, people, me, onSaved, className, children }: {
  note: Note;
  roomId: string;
  /** The space's people, by name. */
  people: string[];
  /** The person looking, so they can take it. */
  me: string;
  onSaved: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const ref = useDismiss<HTMLSpanElement>(open, () => {
    if (!saving) setOpen(false);
  });
  const typed = clean(value);
  const key = (s: string) => s.toLowerCase();
  // The owner is a name as said in the meeting, so keep it in the list even when nobody here has it.
  const names = [...new Set([me, ...people, ...(note.owner ? [note.owner] : [])].filter(Boolean))];
  const shown = typed ? names.filter((p) => key(p).includes(key(typed))) : names;
  const exact = typed ? names.find((p) => key(p) === key(typed)) : undefined;

  async function save(next: string | null) {
    if (saving) return;
    if (next === note.owner) return void setOpen(false);
    setSaving(true);
    setError("");
    try {
      await api.setTaskOwner(roomId, note.id, next);
      onSaved();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className={`owner-picker${className ? ` ${className}` : ""}`} ref={ref}>
      <button
        type="button"
        className="owner-btn"
        aria-label={`Change owner: ${note.owner ?? "Unassigned"}`}
        aria-expanded={open}
        title={note.owner ? `${note.owner} · Change owner` : "Unassigned · Give it to someone"}
        onClick={(e) => {
          e.stopPropagation();
          setValue("");
          setError("");
          setOpen(!open);
        }}
      >
        {children}
      </button>
      {open && (
        <span
          className="project-pop owner-pop"
          role="dialog"
          aria-label="Change owner"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (!saving) setOpen(false);
            }
            if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing && typed) {
              e.preventDefault();
              void save(exact ?? typed);
            }
          }}
        >
          <label htmlFor={inputId}>Owner</label>
          <input
            id={inputId}
            autoFocus
            placeholder="Find a person or type a name"
            value={value}
            maxLength={OWNER_MAX}
            disabled={saving}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="project-options" role="listbox" aria-label="People">
            {shown.map((p) => (
              <button
                key={p}
                type="button"
                role="option"
                aria-selected={p === note.owner}
                className={p === note.owner ? "on" : undefined}
                disabled={saving}
                onClick={() => void save(p)}
              >
                {p === me ? `${p} (you)` : p}
              </button>
            ))}
            {typed && !exact && (
              <button type="button" className="project-new" disabled={saving} onClick={() => void save(typed)}>
                {saving ? "Saving…" : `Give it to “${typed}”`}
              </button>
            )}
          </span>
          <button type="button" className={`project-default${note.owner ? "" : " on"}`} disabled={saving} onClick={() => void save(null)}>
            Unassigned
          </button>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
