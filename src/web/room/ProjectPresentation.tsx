// A project open on the call's board: its to-dos by where they stand, its open questions and its
// decisions. What's said while it is up is filed under the project. Whoever steers can put one of its
// to-dos up from here, and closing that comes back to the project.

import { useEffect, useState } from "react";
import { Check, FolderOpen } from "lucide-react";
import { useDismiss } from "../useDismiss.ts";
import type { Note } from "../../shared/protocol.ts";
import type { Project } from "../../shared/projects.ts";
import { stateOf } from "../../shared/tasks.ts";
import { api } from "../api.ts";
import { useWork } from "../WorkLog.tsx";

export function ProjectPresentation(props: {
  roomId: string;
  projectId: string;
  /** What this call has caught so far: what lands in the project shows at once. */
  live: Note[];
  canSteer: boolean;
  disabled?: boolean;
  onTask: (taskId: string) => void;
  onClose: () => void;
  /** The call's bar closes it (ProjectControl), so the heading has no button of its own. */
  closeInBar?: boolean;
}) {
  const { roomId, projectId } = props;
  const [project, setProject] = useState<Project | null>(null);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [decided, setDecided] = useState<Note[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.projects(roomId).then((all) => active && setProject(all.find((p) => p.id === projectId) ?? null), (e) => active && setError(e.message));
    return () => { active = false; };
  }, [roomId, projectId]);
  useEffect(() => {
    let active = true;
    // The same lists the space page reads, so a to-do is in the project here when it is there.
    Promise.all([api.room(roomId), api.feed(roomId)]).then(([room, feed]) => {
      if (!active) return;
      setNotes([...room.followUps, ...(feed.open ?? [])].filter((n) => n.project === projectId && !n.doneAt && n.state !== "dropped"));
      setDecided((feed.decided ?? []).filter((n) => n.project === projectId && !n.replacedBy));
    }, (e) => active && setError(e.message));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, projectId, props.live.length]);
  const here = (n: Note) => n.project === projectId && !n.doneAt && n.state !== "dropped";
  const open = notes && [...new Map([...notes, ...props.live.filter(here)].map((n) => [n.id, n])).values()];
  const work = useWork((open ?? []).map((n) => n.id));
  const todos = (open ?? []).filter((n) => n.kind === "action");
  const asked = (open ?? []).filter((n) => n.kind === "question");
  const ready = todos.filter((n) => work[n.id]?.ready);
  const doing = todos.filter((n) => !work[n.id]?.ready && stateOf(n, work[n.id]) === "doing");
  const rest = todos.filter((n) => !ready.includes(n) && !doing.includes(n));
  const tag = (n: Note) => (ready.includes(n) ? "Ready to ship" : doing.includes(n) ? "In progress" : null);
  const row = (n: Note) => (
    <li key={n.id}>
      {props.canSteer ? (
        <button type="button" disabled={props.disabled} onClick={() => props.onTask(n.id)} title="Put this on the board">
          {n.text}
        </button>
      ) : (
        <span>{n.text}</span>
      )}
      {tag(n) && <span className={ready.includes(n) ? "pp-tag ready" : "pp-tag"}>{tag(n)}</span>}
      {n.owner && <span className="pp-owner">{n.owner.split(" ")[0]}</span>}
    </li>
  );
  const group = (label: string, kind: string, rows: Note[]) =>
    rows.length > 0 && (
      <div className={`pp-group ${kind}`}>
        <p className="pp-label">
          {label} · {rows.length}
        </p>
        <ul>{rows.map(row)}</ul>
      </div>
    );
  return (
    <section className="project-presentation" aria-label="Open project">
      <header className="pp-head">
        <strong className="pp-name" dir="auto">{project?.name ?? "Project"}</strong>
        {project?.goal && <span className="pp-goal" dir="auto">{project.goal}</span>}
        <span className="pp-count">{open ? `${open.length} open` : ""}</span>
        {props.canSteer && !props.closeInBar && (
          <button type="button" disabled={props.disabled} onClick={props.onClose}>
            Close project
          </button>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {!notes && !error && <p role="status">Loading the project…</p>}
      {open && (
        <div className="pp-body">
          <div className="pp-main">
            {group("To-dos", "todo", [...ready, ...doing, ...rest])}
            {!todos.length && <p className="muted">No open to-dos.</p>}
          </div>
          {(asked.length > 0 || decided.length > 0) && (
            <div className="pp-side">
              {group("Questions", "questions", asked)}
              {decided.length > 0 && (
                <div className="pp-group decisions">
                  <p className="pp-label">Decisions · {decided.length}</p>
                  <ul>
                    {decided.slice(0, 6).map((n) => (
                      <li key={n.id}>
                        <span>{n.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** "Open project" on the call's bar, beside Share screen and Start review: the space's projects in the
 *  team's order, one click puts one on the board for everyone. While one is up the button is lit, the
 *  menu marks it, another project swaps in, and "Close project" goes back to where the call was. */
export function ProjectControl(props: { roomId: string; shown: string | null; disabled?: boolean; onOpen: (projectId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  // Read when the menu opens: projects are made and reordered between calls, and in this one.
  useEffect(() => {
    if (open) api.projects(props.roomId).then((all) => setProjects(all.filter((p) => !p.archived)), () => setProjects([]));
  }, [open, props.roomId]);
  const pick = (id: string | null) => () => {
    setOpen(false);
    if (id !== props.shown) props.onOpen(id);
  };
  return (
    <div className="xp" ref={box}>
      <button className={props.shown ? "control on" : "control"} disabled={props.disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Put a project on the board for everyone. What's said while it's up is filed under it.">
        <FolderOpen size={20} strokeWidth={1.6} aria-hidden />
        <span>{props.shown ? "Project" : "Open project"}</span>
      </button>
      {open && (
        <div className="rp-menu sh-start-menu xp-menu pc-menu" role="menu">
          {!projects && <p className="muted pc-note">…</p>}
          {projects?.length === 0 && <p className="muted pc-note">This space has no projects yet.</p>}
          {projects?.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === props.shown} onClick={pick(p.id)}>
              <strong dir="auto">{p.name}</strong>
              {p.id === props.shown ? <Check size={14} aria-label="On the board" /> : <span className="muted">{p.openTodos} open</span>}
            </button>
          ))}
          {props.shown && (
            <button type="button" role="menuitem" className="pc-close" onClick={pick(null)}>
              Close project
            </button>
          )}
        </div>
      )}
    </div>
  );
}
