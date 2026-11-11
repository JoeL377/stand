// One to-do or open question opened beside the space's task list: what it is, where it came from,
// its spec, what it waits on and what waits on it, and what's been reported on it. The page's
// ?task=<id> opens it, so a link can land on it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import type { DesignReviewState } from "../shared/designReview.ts";
import { TASK_COMMENT_MAX, type TaskDetail, type TaskLink } from "../shared/protocol.ts";
import { STATE_LABEL, VERB_LABEL, stateOf, verbOf } from "../shared/tasks.ts";
import { api } from "./api.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { CloseIcon } from "./icons.tsx";
import { LastReview, designReviewHref } from "./pages/DesignReviewPage.tsx";
import { PlanReviewBody } from "./PlanReview.tsx";
import { fmtAgo, fmtDate } from "./util.ts";
import { WorkCard } from "./WorkLog.tsx";

export function TaskDrawer({ id, onOpen, onClose }: { id: string; onOpen: (id: string) => void; onClose: () => void }) {
  const [params, setParams] = useSearchParams();
  const planOpen = params.get("view") === "plan";
  const setPlanOpen = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set("view", "plan");
    else next.delete("view");
    setParams(next, { replace: !open });
  };
  const draftKey = `stand.taskComment.${id}`;
  const [draft, setDraft] = useState(() => {
    try { return sessionStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  const [posting, setPosting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const activity = useRef<HTMLElement>(null);
  const request = useRef(0);

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await api.task(id);
      if (current !== request.current) return;
      setTask(next);
      setError(null);
    } catch (e) {
      if (current === request.current) setError((e as Error).message);
    }
  }, [id]);

  async function postComment() {
    if (posting || !draft.trim()) return;
    setPosting(true);
    setCommentError(null);
    try {
      const comment = await api.commentOnTask(id, draft.trim());
      request.current++;
      setTask((prev) => prev && {
        ...prev,
        work: { ...prev.work, log: [comment, ...prev.work.log.filter((entry) => entry.id !== comment.id)] },
      });
      setDraft("");
      try {
        if (sessionStorage.getItem(draftKey) === draft) sessionStorage.removeItem(draftKey);
      } catch {}
      activity.current?.scrollIntoView({ block: "nearest" });
    } catch (e) {
      setCommentError((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  useEffect(() => {
    setTask(null);
    void load();
    // Agents report while it's open; keep up as the space page does.
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    // A screenshot open over the drawer closes first.
    const key = (e: KeyboardEvent) => e.key === "Escape" && !planOpen && !document.querySelector('[role="dialog"][aria-modal="true"]') && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, planOpen]);

  const n = task?.note;
  const state = n && stateOf(n, task.work);
  // On the body, so the page panel's own layering can't put the page over it.
  return createPortal(
    <>
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
              <h3>Plan</h3>
              {task.work.plan ? (
                <button type="button" className="td-plan-card" onClick={() => setPlanOpen(true)}>
                  <strong>Open plan</strong>
                  <span className="muted">{task.work.plan.by} · {fmtAgo(task.work.plan.ts)}</span>
                </button>
              ) : <p className="muted">No plan yet.</p>}
            </section>

            <Links title="Waits on" links={task.waitsOn} onOpen={onOpen} />
            <Links title="Blocking" links={task.blocking} onOpen={onOpen} />

            <section className="td-section" ref={activity}>
              <h3>Activity</h3>
              {task.work.log.length ? <WorkCard work={task.work} noPlan /> : <p className="muted">Nothing reported yet.</p>}
            </section>

            <div className="td-foot">
              <CopyForAgent kind={n.kind === "question" ? "question" : "action"} id={n.id} label />
            </div>
          </div>
        )}
        {task && (
          <form className="td-compose" onSubmit={(e) => { e.preventDefault(); void postComment(); }}>
            <textarea
              aria-label="Write a comment"
              placeholder="Write a comment…"
              value={draft}
              rows={2}
              maxLength={TASK_COMMENT_MAX}
              readOnly={posting}
              onChange={(e) => {
                const value = e.target.value;
                setDraft(value);
                try { sessionStorage.setItem(draftKey, value); } catch {}
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void postComment();
                }
              }}
            />
            {commentError && <p className="error" role="alert">{commentError}</p>}
            <button type="submit" disabled={posting || !draft.trim()}>{posting ? "Posting…" : "Post comment"}</button>
          </form>
        )}
      </aside>
      {planOpen && (task || error) && <PlanViewer task={task} onClose={() => setPlanOpen(false)} />}
    </>,
    document.body,
  );
}

function PlanViewer({ task, onClose }: { task: TaskDetail | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [copyStatus, setCopyStatus] = useState("");
  const plan = task?.work.plan;
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    // Older mobile webviews may expose <dialog> without the modal API.
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyStatus("Link copied");
    } catch {
      setCopyStatus("Copy the link from the address bar.");
    }
  }

  return (
    <dialog
      ref={dialog}
      className={`td-plan-dialog${expanded ? " expanded" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="td-plan-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <header className="td-plan-head">
        <div>
          <h2 id="td-plan-title">Plan</h2>
          {task && <p>{task.note.text}</p>}
        </div>
        <button type="button" onClick={onClose}>Back to task</button>
      </header>
      {plan && task ? <PlanReviewBody key={task.note.id} task={task.note.id} /> :
        <div className="td-plan-content"><p className="muted">{task ? "No plan yet." : "This task couldn’t be loaded."}</p></div>}
      {plan && (
        <footer className="td-plan-actions">
          <button type="button" onClick={() => void copyLink()}>Copy link</button>
          <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? "Restore size" : "Expand"}</button>
          <span role="status">{copyStatus}</span>
          {task && <RequestReview taskId={task.note.id} roomId={task.roomId} />}
        </footer>
      )}
    </dialog>
  );
}

/** Puts the plan on the space's next design review; once it is there, the way to that review. */
function RequestReview({ taskId, roomId }: { taskId: string; roomId: string }) {
  const [state, setState] = useState<DesignReviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.designReviewState(taskId).then((next) => { if (active) setState(next); }, () => {});
    return () => { active = false; };
  }, [taskId]);
  if (!state) return null;
  if (state.queued) {
    return (
      <Link className="td-plan-review" to={designReviewHref(roomId, taskId)}>
        {state.live ? "In the design review, on now" : "In the next design review"}{state.points > 0 && ` · ${state.points} ${state.points === 1 ? "point" : "points"}`}
      </Link>
    );
  }
  return (
    <span className="td-plan-review">
      {error && <span className="error" role="alert">{error}</span>}
      {state.last && <LastReview roomId={roomId} last={state.last} />}
      <button
        type="button"
        className="primary"
        disabled={busy}
        title="Put this plan on the space's next design review"
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setState(await api.requestDesignReview(taskId));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Requesting…" : state.last ? "Request review again" : "Request review"}
      </button>
    </span>
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
