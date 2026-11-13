import { useId, useState } from "react";
import type { Note } from "../shared/protocol.ts";
import { normalizeProjectName, PROJECT_NAME_MAX, type Project, projectKey } from "../shared/projects.ts";
import { api } from "./api.ts";
import { useDismiss } from "./useDismiss.ts";

/** A task's, question's or decision's project: pick one, type a new name, set Unassigned, or follow the agenda. */
export function ProjectPicker({ note, roomId, projects, onSaved, own }: {
  note: Note; roomId: string; projects: Project[]; onSaved: () => void;
  /** Shown inside its own project: a suggestion reads "Suggested", not the project's name again. */
  own?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const ref = useDismiss<HTMLSpanElement>(open, () => {
    if (!saving) setOpen(false);
  });
  const current = projects.find((p) => p.id === note.project) ?? null;
  const ruled = projects.find((p) => p.id === note.ruledProject) ?? null;
  const byHand = note.projectSetBy != null;
  const suggested = note.projectSuggested ? current : null;
  const active = projects.filter((p) => !p.archived);
  const typed = normalizeProjectName(value);
  const shown = typed ? active.filter((p) => projectKey(p.name).includes(projectKey(typed))) : active;
  const exact = typed ? projects.find((p) => projectKey(p.name) === projectKey(typed)) : undefined;

  async function save(next: string | null | "auto") {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api.setNoteProject(roomId, note.id, next);
      onSaved();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function create() {
    if (!typed || saving) return;
    if (exact) return void save(exact.id);
    setSaving(true);
    setError("");
    try {
      const p = await api.createProject(roomId, { name: typed });
      await api.setNoteProject(roomId, note.id, p.id);
      onSaved();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="project-picker" ref={ref}>
      <button
        type="button"
        className={`rc-pill project-pill${current ? "" : " unset"}${suggested ? " suggested" : ""}`}
        aria-label={suggested ? `Suggested project: ${suggested.name}. Confirm or change` : `Change project: ${current?.name ?? "Unassigned"}`}
        aria-expanded={open}
        title={suggested ? `Suggested project: ${suggested.name}. Confirm or change` : "Change project"}
        onClick={() => {
          setValue("");
          setError("");
          setOpen(!open);
        }}
      >
        {suggested ? (own ? "Suggested" : `${suggested.name}?`) : (current?.name ?? "+ Project")}
      </button>
      {open && (
        <span
          className="project-pop"
          role="dialog"
          aria-label="Change project"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (!saving) setOpen(false);
            }
            if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void create();
            }
          }}
        >
          {suggested && (
            <span className="project-suggest">
              <span>Stand suggests {suggested.name}</span>
              <button type="button" disabled={saving} onClick={() => void save(suggested.id)}>
                Confirm
              </button>
            </span>
          )}
          <label htmlFor={inputId}>Project</label>
          <input
            id={inputId}
            autoFocus
            placeholder="Find or make a project"
            value={value}
            maxLength={PROJECT_NAME_MAX}
            disabled={saving}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="project-options" role="listbox" aria-label="Projects">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === note.project && !suggested}
                className={p.id === note.project && !suggested ? "on" : undefined}
                disabled={saving}
                onClick={() => void save(p.id)}
              >
                {p.name}
              </button>
            ))}
            {typed && !exact && (
              <button type="button" className="project-new" disabled={saving} onClick={() => void create()}>
                {saving ? "Saving…" : `+ Make project “${typed}”`}
              </button>
            )}
          </span>
          {ruled && byHand && (
            <button type="button" className="project-default" disabled={saving} onClick={() => void save("auto")}>
              Follow the agenda: {ruled.name}
            </button>
          )}
          {!byHand && ruled && <span className="project-default muted">From the agenda: {ruled.name}</span>}
          <button type="button" className={`project-default${byHand && !note.projectId ? " on" : ""}`} disabled={saving} onClick={() => void save(null)}>
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
