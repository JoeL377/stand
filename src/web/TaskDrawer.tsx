// One to-do or open question opened beside the space's task list: what it is, where it came from,
// its spec, what it waits on and what waits on it, and what's been reported on it. The page's
// ?task=<id> opens it, so a link can land on it.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { TaskDetail, TaskLink } from "../shared/protocol.ts";
import { STATE_LABEL, VERB_LABEL, stateOf, verbOf } from "../shared/tasks.ts";
import { api } from "./api.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { CloseIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { fmtAgo, fmtDate } from "./util.ts";
import { WorkCard } from "./WorkLog.tsx";

export function TaskDrawer({ id, onOpen, onClose }: { id: string; onOpen: (id: string) => void; onClose: () => void }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.task(id).then(
        (t) => {
          setTask(t);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [id],
  );
  useEffect(() => {
    setTask(null);
    void load();
    // Agents report while it's open; keep up as the space page does.
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    // A screenshot open over the drawer closes first.
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]') && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const n = task?.note;
  const state = n && stateOf(n, task.work);
  // On the body, so the page panel's own layering can't put the page over it.
  return createPortal(
    <aside className="task-drawer" role="complementary" aria-label="Task">
      <div className="td-head">
        {n && state && (
          <span className="td-kind">
            {VERB_LABEL[verbOf(n.kind)]} · <span className={`td-state ${state}`}>{STATE_LABEL[state]}</span>
          </span>
        )}
        <button className="icon-btn td-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!task && !error && <p className="muted">Loading…</p>}
      {task && n && (
        <div className="td-body">
          <h2 className="td-title">{n.text}</h2>
          <p className="td-meta">
            <span className={n.owner ? undefined : "muted"}>{n.owner ?? (n.kind === "question" ? "Anyone" : "Unassigned")}</span>
            {task.meeting ? (
              <Link to={`/meetings/${task.meeting.id}`}>From the meeting on {fmtDate(task.meeting.startedAt)}</Link>
            ) : (
              <span>Added{n.editedBy ? ` by ${n.editedBy}` : ""}</span>
            )}
            {n.doneAt && n.doneBy && (
              <span>
                {state === "dropped" ? "Dropped" : "Done"} by {n.doneBy}
              </span>
            )}
          </p>
          {n.doneWhen && (
            <p className="td-done-when">
              <strong>Done when</strong> {n.doneWhen}
            </p>
          )}
          {n.dropReason && (
            <p className="td-done-when">
              <strong>Dropped because</strong> {n.dropReason}
            </p>
          )}

          <section className="td-section">
            <h3>
              Spec
              {task.work.plan && (
                <span className="td-by">
                  {task.work.plan.by} · {fmtAgo(task.work.plan.ts)}
                </span>
              )}
            </h3>
            {task.work.plan ? <Markdown className="td-spec" text={task.work.plan.text} /> : <p className="muted">No spec yet.</p>}
          </section>

          <Links title="Waits on" links={task.waitsOn} onOpen={onOpen} />
          <Links title="Blocking" links={task.blocking} onOpen={onOpen} />

          <section className="td-section">
            <h3>Activity</h3>
            {task.work.log.length ? <WorkCard work={task.work} noPlan /> : <p className="muted">Nothing reported yet.</p>}
          </section>

          <div className="td-foot">
            <CopyForAgent kind={n.kind === "question" ? "question" : "action"} id={n.id} label />
          </div>
        </div>
      )}
    </aside>,
    document.body,
  );
}

function Links({ title, links, onOpen }: { title: string; links: TaskLink[]; onOpen: (id: string) => void }) {
  if (!links.length) return null;
  return (
    <section className="td-section">
      <h3>
        {title} <span className="count">{links.length}</span>
      </h3>
      <ul className="td-links">
        {links.map((l) => (
          <li key={l.id}>
            <button type="button" onClick={() => onOpen(l.id)}>
              <span className={`td-state ${l.state}`}>{STATE_LABEL[l.state]}</span>
              <span className="td-link-text">{l.text}</span>
              {l.owner && <span className="muted">{l.owner}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
