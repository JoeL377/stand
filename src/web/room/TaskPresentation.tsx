import { useEffect, useState } from "react";
import type { PlanBrief } from "../../shared/designReview.ts";
import type { Note, TaskDetail } from "../../shared/protocol.ts";
import { STATE_LABEL, stateOf } from "../../shared/tasks.ts";
import { api } from "../api.ts";
import { PlanReviewBody } from "../PlanReview.tsx";

type Presentation = { id: string; mode: "brief" | "spec" };

export function TaskPicker({ roomId, notes, disabled, onPick }: {
  roomId: string; notes: Note[]; disabled?: boolean; onPick: (task: Presentation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    api.presentationTasks(roomId).then((tasks) => { if (active) setTasks(tasks); }, (e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [roomId, open]);
  const all = [...new Map([...tasks, ...notes].filter((n) => n.kind === "action" || n.kind === "question").map((n) => [n.id, n])).values()];
  return <div className="task-picker">
    <button disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>Present task</button>
    {open && <div className="task-picker-menu" role="dialog" aria-label="Choose a task to present">
      <div className="row"><input autoFocus aria-label="Search tasks" placeholder="Search tasks…" value={query} onChange={(e) => setQuery(e.target.value)} /><button onClick={() => setOpen(false)} aria-label="Close task picker">✕</button></div>
      {error && <p className="error">{error}</p>}
      <div className="task-picker-list">{all.filter((n) => `${n.text} ${n.owner ?? ""}`.toLowerCase().includes(query.toLowerCase())).map((n) =>
        <button key={n.id} onClick={() => { onPick({ id: n.id, mode: "brief" }); setOpen(false); }}><strong>{n.text}</strong><span className="muted small">{n.owner ?? "Unassigned"} · {STATE_LABEL[stateOf(n)]}</span></button>
      )}</div>
      {!all.length && !error && <p className="muted">No tasks available yet.</p>}
    </div>}
  </div>;
}

export function TaskPresentation({ presentation, canSteer, disabled, onChange }: {
  presentation: Presentation; canSteer: boolean; disabled?: boolean; onChange: (task: Presentation | null) => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [brief, setBrief] = useState<PlanBrief | null>(null);
  const [error, setError] = useState("");
  const [briefError, setBriefError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setTask(null); setError(""); setBrief(null); setBriefError("");
    api.task(presentation.id).then((next) => { if (active) setTask(next); }, (e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [presentation.id]);
  useEffect(() => {
    if (!task?.work.plan || presentation.mode !== "brief") return;
    let active = true;
    setBriefError("");
    if (attempt > 0) setBrief(null);
    api.taskBrief(task.note.id, attempt > 0).then((next) => { if (active) setBrief(next); }, (e) => { if (active) setBriefError(e.message); });
    return () => { active = false; };
  }, [task, presentation.mode, attempt]);
  return <section className="task-presentation" aria-label="Presented task">
    <header className="task-presentation-toolbar">
      <span className="muted small">Task walkthrough</span>
      {canSteer && <div className="row">
        <button disabled={disabled} aria-pressed={presentation.mode === "brief"} onClick={() => onChange({ ...presentation, mode: "brief" })}>Discussion brief</button>
        <button disabled={disabled} aria-pressed={presentation.mode === "spec"} onClick={() => onChange({ ...presentation, mode: "spec" })}>Full spec</button>
        <button disabled={disabled} onClick={() => onChange(null)}>Stop presenting</button>
      </div>}
    </header>
    {error && <p className="error">{error}</p>}
    {!task && !error && <p role="status">Loading task…</p>}
    {task?.work.plan && presentation.mode === "spec" ? <>
      <div className="task-presentation-spec">
        <strong>{task.note.text}</strong>
        <span className="muted small">{task.note.owner ?? "Unassigned"} · {STATE_LABEL[stateOf(task.note, task.work)]} · Spec by {task.work.plan.by}</span>
      </div>
      <PlanReviewBody task={task.note.id} />
    </> : task && <article className="task-presentation-body">
      <p className="muted small">{task.note.owner ?? "Unassigned"} · {STATE_LABEL[stateOf(task.note, task.work)]}</p>
      <h1>{task.note.text}</h1>
      {task.note.doneWhen && <p><strong>Done when:</strong> {task.note.doneWhen}</p>}
      {!task.work.plan ? <p className="muted">No spec attached to this task yet.</p> : <>
        {briefError ? <p className="error">{briefError} <button onClick={() => retry((n) => n + 1)}>Try again</button></p> : !brief ? <p role="status">Preparing the summary and the sections…</p> : <>
          {brief.status === "failed" && <p className="error">Stand couldn’t write the brief. <button onClick={() => retry((n) => n + 1)}>Try again</button></p>}
          {brief.status === "none" && <p className="muted small">AI briefs are unavailable. These are the sections of the spec; open Full spec to read them.</p>}
          {brief.summary && <><h2>Summary</h2><p>{brief.summary}</p></>}
          {brief.sections.filter((s) => !s.off).map((s) => <section key={s.heading}>
            <h2>{s.heading}{!s.edited && s.lines.length > 0 && <span className="muted small" title="Written by Stand from the spec"> ✦</span>}</h2>
            {s.lines.length > 0 && <ul>{s.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>}
          </section>)}
          {brief.suggestions.some((q) => q.state === "open") && <>
            <h2>Questions Stand suggests <span className="muted small">✦</span></h2>
            <ol>{brief.suggestions.filter((q) => q.state === "open").map((q) => <li key={q.id}>{q.text}</li>)}</ol>
          </>}
        </>}
      </>}
    </article>}
  </section>;
}
