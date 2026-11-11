import { Check, ChevronDown, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Passage, PlanReview } from "../shared/planReview.ts";
import { TASK_COMMENT_MAX } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { fmtAgo } from "./util.ts";

function passageAt(element: Node, document: HTMLElement) {
  const block = (element instanceof Element ? element : element.parentElement)?.closest<HTMLElement>("[data-plan-start]");
  return block && document.contains(block) ? block : null;
}

/** `initial`: where the plan opens, as a comment thread or a passage (a design review slide's part of the spec). */
export function PlanReviewBody({ task, initial }: { task: string; initial?: { thread?: string | null; passage?: Passage | null } }) {
  const [review, setReview] = useState<PlanReview | null>(null);
  const version = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const switching = useRef(false);
  const document = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Passage | null>(null);
  const [active, setActive] = useState<string | null>(initial?.thread ?? null);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [notice, setNotice] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"plan" | "comments">("plan");
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draftStore = `stand.planReview.${task}`;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { return JSON.parse(sessionStorage.getItem(draftStore) ?? "{}"); } catch { return {}; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(draftStore, JSON.stringify(drafts)); } catch {}
  }, [drafts, draftStore]);
  const thread = review?.threads.find((entry) => entry.id === active && entry.resolved === (filter === "resolved"));
  const plan = review?.plan;
  const draftKey = composing ? `new:${plan?.id}:${selection?.start}:${selection?.end}` : active ?? "";
  const draft = drafts[draftKey] ?? "";

  async function load(id = version.current) {
    const current = ++request.current;
    try {
      const data = await api.planReview(task, id);
      if (current !== request.current) return;
      // Opened on a thread that is resolved: show it where it is.
      if (!version.current && data.threads.find((entry) => entry.id === initial?.thread)?.resolved) setFilter("resolved");
      version.current = data.plan.id;
      setReview(data);
    } catch (e) {
      if (current === request.current) setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (version.current && !switching.current) void load(); }, 20_000);
    return () => { request.current++; clearInterval(timer); };
  }, [task]);

  const captureSelection = useCallback(() => {
    const range = window.getSelection();
    const root = document.current;
    if (composing || busy || !root || !range?.rangeCount || range.isCollapsed) return;
    const dom = range.getRangeAt(0);
    const first = passageAt(dom.startContainer, root);
    const last = passageAt(dom.endContainer, root);
    if (!first || !last) return;
    const start = Number(first.dataset.planStart);
    const end = Number(last.dataset.planEnd);
    setSelection((previous) => previous?.start === start && previous.end === end ? previous : { start, end });
  }, [composing, busy]);

  useEffect(() => {
    // Touch selection handles can move after touchend (especially in Safari).
    window.document.addEventListener("selectionchange", captureSelection);
    return () => window.document.removeEventListener("selectionchange", captureSelection);
  }, [captureSelection]);

  function startComment() {
    setActive(null);
    setComposing(true);
    setMobilePanel("comments");
    window.getSelection()?.removeAllRanges();
  }

  async function showVersion(id: string) {
    switching.current = true;
    setBusy(true);
    setSelection(null);
    setComposing(false);
    setError("");
    await load(id);
    switching.current = false;
    setBusy(false);
  }

  async function change(action: string) {
    if (!plan || busy) return;
    setBusy(true);
    setError("");
    try {
      const changed = await api.changePlanReview(task, {
        action, version: plan.id, thread: active, text: draft,
        ...(selection ?? {}),
      });
      if (action === "create" || action === "reply") setDrafts((prev) => ({ ...prev, [draftKey]: "" }));
      setComposing(false);
      setSelection(null);
      // Apply the server result immediately; a delayed refresh must not leave a resolved thread open.
      request.current++;
      setReview((prev) => prev ? { ...prev, threads: prev.threads.some((entry) => entry.id === changed.id)
        ? prev.threads.map((entry) => entry.id === changed.id ? { ...entry, ...changed } : entry)
        : prev.threads } : prev);
      if (action === "resolve" || action === "reopen") {
        setActive(null);
        setNotice(action === "resolve" ? "Thread moved to Resolved." : "Thread moved to Open.");
      } else {
        setFilter("open");
        setActive(changed.id);
        setNotice("");
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openThread(id: string) {
    if (busy) return;
    setOpened(true);
    setMobilePanel("comments");
    setFilter("open");
    setNotice("");
    setActive(id);
    setComposing(false);
    setSelection(null);
  }

  const [opened, setOpened] = useState(false);
  const highlight = selection ?? thread?.placement ?? (!opened && !active ? (initial?.passage ?? null) : null);
  const marked = review?.threads.flatMap((entry) => entry.placement && !entry.resolved
    ? [{ ...entry.placement, id: entry.id }] : []);
  useEffect(() => {
    if (!selection) document.current?.querySelector("[data-plan-highlight]")?.scrollIntoView({ block: "nearest" });
  }, [active, plan?.id, thread?.placement?.start, selection, mobilePanel]);

  function composer(isNew: boolean) {
    return (
      <form className="td-review-form" onSubmit={(e) => { e.preventDefault(); void change(isNew ? "create" : "reply"); }}>
        <textarea aria-label={isNew ? "Write a comment" : "Write a reply"} placeholder={isNew ? "Write a comment…" : "Write a reply…"} rows={3}
          autoFocus={isNew} maxLength={TASK_COMMENT_MAX} value={draft} readOnly={busy}
          onChange={(e) => setDrafts({ ...drafts, [draftKey]: e.target.value })} />
        <div className="td-review-controls">
          {isNew && <button className="ghost" type="button" disabled={busy} onClick={() => { setComposing(false); setSelection(null); }}><X size={14} aria-hidden="true" /> Cancel</button>}
          <button className="primary" type="submit" disabled={busy || !draft.trim()}>{isNew ? "Post comment" : "Reply"}</button>
        </div>
      </form>
    );
  }

  if (!review || !plan) return <p className="td-plan-content" role="status">{error || "Loading plan…"}</p>;
  return (
    <div className={`td-review mobile-${mobilePanel}`}>
      <div className="td-review-mobile-nav" role="group" aria-label="Plan view">
        <button type="button" aria-pressed={mobilePanel === "plan"} onClick={() => setMobilePanel("plan")}>Plan</button>
        <button type="button" aria-pressed={mobilePanel === "comments"} onClick={() => setMobilePanel("comments")}>
          Comments · {review.threads.filter((entry) => !entry.resolved).length}
        </button>
        {selection && !composing && <button type="button" className="primary" disabled={busy} onClick={startComment}>Add comment</button>}
      </div>
      <div className="td-plan-content" tabIndex={0}>
        <div ref={document} onMouseUp={captureSelection} onKeyUp={captureSelection} onTouchEnd={captureSelection}
          onClick={(e) => {
            if (window.getSelection()?.isCollapsed === false || !(e.target instanceof Element) ||
                e.target.closest("a,button,input")) return;
            const marker = e.target.closest<HTMLElement>("[data-plan-thread]");
            if (marker?.dataset.planThread) openThread(marker.dataset.planThread);
          }}>
          <Markdown className="td-plan-document" text={plan.text} review={{ highlight, marked }} />
        </div>
      </div>
      <aside className="td-review-comments" aria-label="Plan comments">
        <header className="td-review-heading">
          <h3><MessageSquare size={16} aria-hidden="true" /> Comments</h3>
          <p>Select text in the plan to leave a comment.</p>
        </header>
        {review.latest !== plan.id && <button className="small" type="button" disabled={busy} onClick={() => showVersion(review.latest)}>View latest version</button>}
        <div className="td-review-filters" role="group" aria-label="Filter comments">
          {(["open", "resolved"] as const).map((value) => (
            <button type="button" key={value} aria-pressed={filter === value} disabled={busy}
              onClick={() => { setFilter(value); setActive(null); setNotice(""); }}>
              {value === "open" ? "Open" : "Resolved"}
              <span>{review.threads.filter((entry) => entry.resolved === (value === "resolved")).length}</span>
            </button>
          ))}
        </div>
        {notice && <p className="td-review-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p>}
        {selection && !composing && (
          <div className="td-review-selection">
            <span className="td-review-label">Selected passage</span>
            <blockquote>{plan.text.slice(selection.start, selection.end)}</blockquote>
            <div className="td-review-controls">
              <button className="primary" type="button" disabled={busy} onClick={startComment}>Add comment</button>
              <button className="ghost" type="button" disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
            </div>
          </div>
        )}
        {composing && selection && (
          <section className="td-review-card td-review-compose" aria-label="New comment">
            <span className="td-review-label">Commenting on</span>
            <blockquote>{plan.text.slice(selection.start, selection.end)}</blockquote>
            {composer(true)}
          </section>
        )}
        <div className="td-review-list">
          {review.threads.filter((entry) => entry.resolved === (filter === "resolved")).map((entry) => {
            const expanded = thread?.id === entry.id;
            const first = entry.messages[0];
            return (
              <section className={`td-review-card${expanded ? " is-active" : ""}${entry.resolved ? " is-resolved" : ""}`} key={entry.id}>
                <button type="button" className="td-review-thread" disabled={busy} aria-expanded={expanded}
                  onClick={() => { setActive(expanded ? null : entry.id); setComposing(false); setSelection(null); }}>
                  <span className="td-review-thread-heading">
                    <span className="td-review-author">{first.by}</span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                  <span className="td-review-meta">{fmtAgo(first.ts)}{entry.resolved && <span className="td-review-resolved"><Check size={12} aria-hidden="true" /> Resolved</span>}</span>
                  {!expanded && <span className="td-review-preview">{first.text}</span>}
                  {!expanded && entry.messages.length > 1 && <span className="td-review-replies">{entry.messages.length - 1} {entry.messages.length === 2 ? "reply" : "replies"}</span>}
                </button>
                {expanded && (
                  <div className="td-review-detail">
                    {(!entry.placement || entry.original.version !== plan.id) && <div className="td-review-context">
                      {!entry.placement && <blockquote>{entry.original.quote}</blockquote>}
                      {!entry.placement && <p className="td-review-meta">This passage has changed in this version.</p>}
                      {entry.original.version !== plan.id && <button className="link small" type="button" disabled={busy} onClick={() => showVersion(entry.original.version)}>View original version</button>}
                    </div>}
                    <div className="td-review-messages">
                      {entry.messages.map((message, index) => (
                        <div className="td-review-message" key={message.id}>
                          {index > 0 && <div className="td-review-meta"><strong>{message.by}</strong><span>{fmtAgo(message.ts)}</span></div>}
                          <Markdown text={message.text} breaks />
                        </div>
                      ))}
                    </div>
                    <div className="td-review-controls">
                      <button className="td-review-resolve" type="button" disabled={busy} onClick={() => void change(entry.resolved ? "reopen" : "resolve")}>
                        <Check size={14} aria-hidden="true" />{entry.resolved ? "Reopen thread" : "Resolve thread"}
                      </button>
                    </div>
                    {entry.resolved ? <p className="td-review-meta">Reopen this thread to continue the conversation.</p> : composer(false)}
                  </div>
                )}
              </section>
            );
          })}
          {!composing && !review.threads.some((entry) => entry.resolved === (filter === "resolved")) && (
            <div className="td-review-empty">
              {filter === "open" ? <MessageSquare size={22} aria-hidden="true" /> : <Check size={22} aria-hidden="true" />}
              <strong>{filter === "open" ? "No open comments" : "No resolved comments"}</strong>
              <p>{filter === "open" ? "Select a passage in the plan to start a conversation." : "Threads you resolve will appear here. You can reopen them anytime."}</p>
            </div>
          )}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </aside>
    </div>
  );
}
