import { useEffect, useRef, useState } from "react";
import type { Passage, PlanReview } from "../shared/planReview.ts";
import { TASK_COMMENT_MAX } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { fmtAgo } from "./util.ts";

function passageAt(element: Node, document: HTMLElement) {
  const block = (element instanceof Element ? element : element.parentElement)?.closest<HTMLElement>("[data-plan-start]");
  return block && document.contains(block) ? block : null;
}

export function PlanReviewBody({ task }: { task: string }) {
  const [review, setReview] = useState<PlanReview | null>(null);
  const version = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const switching = useRef(false);
  const document = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Passage | null>(null);
  const [active, setActive] = useState<string | null>(null);
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
  const thread = review?.threads.find((entry) => entry.id === active);
  const plan = review?.plan;
  const draftKey = composing ? `new:${plan?.id}:${selection?.start}:${selection?.end}` : active ?? "";
  const draft = drafts[draftKey] ?? "";

  async function load(id = version.current) {
    const current = ++request.current;
    try {
      const data = await api.planReview(task, id);
      if (current !== request.current) return;
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

  function captureSelection() {
    const range = window.getSelection();
    const root = document.current;
    if (composing || busy || !root || !range?.rangeCount || range.isCollapsed) return;
    const dom = range.getRangeAt(0);
    const first = passageAt(dom.startContainer, root);
    const last = passageAt(dom.endContainer, root);
    if (!first || !last) return;
    setSelection({ start: Number(first.dataset.planStart), end: Number(last.dataset.planEnd) });
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
      setActive(changed.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openThread(id: string) {
    if (busy) return;
    setActive(id);
    setComposing(false);
    setSelection(null);
  }

  const highlight = selection ?? thread?.placement ?? null;
  const marked = review?.threads.flatMap((entry) => entry.placement && !entry.resolved
    ? [{ ...entry.placement, id: entry.id }] : []);
  useEffect(() => {
    if (!selection) document.current?.querySelector("[data-plan-highlight]")?.scrollIntoView({ block: "nearest" });
  }, [active, plan?.id, thread?.placement?.start, selection]);

  if (!review || !plan) return <p className="td-plan-content" role="status">{error || "Loading plan…"}</p>;
  return (
    <div className="td-review">
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
        <h3>Plan comments</h3>
        <p className="muted">{plan.by} · {fmtAgo(plan.ts)}</p>
        {review.latest !== plan.id && <button type="button" disabled={busy} onClick={() => showVersion(review.latest)}>View latest version</button>}
        <p className="muted">Select text in the plan to comment on the surrounding paragraph or block.</p>
        {selection && !composing && (
          <div className="td-review-controls">
            <button type="button" disabled={busy} onClick={() => { setActive(null); setComposing(true); }}>Comment on passage</button>
            {thread && <button type="button" disabled={busy} onClick={() => void change("reattach")}>Attach thread here</button>}
            <button type="button" disabled={busy} onClick={() => setSelection(null)}>Clear selection</button>
          </div>
        )}
        {review.threads.map((entry) => (
          <button type="button" className="td-review-thread" key={entry.id} disabled={busy}
            aria-pressed={entry.id === active} onClick={() => openThread(entry.id)}>
            <span>{entry.messages[0].text}</span>
            <small>{entry.resolved ? "Resolved" : "Open"}{!entry.placement && " · No placement on this version"}</small>
          </button>
        ))}
        {thread && (
          <section className="td-review-detail" aria-label="Selected thread">
            <blockquote>{thread.original.quote}</blockquote>
            {thread.original.version !== plan.id && (
              <button type="button" disabled={busy} onClick={() => showVersion(thread.original.version)}>View original version</button>
            )}
            <button type="button" disabled={busy} onClick={() => void change(thread.resolved ? "reopen" : "resolve")}>
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
            {thread.messages.map((message) => (
              <div key={message.id}><small>{message.by} · {fmtAgo(message.ts)}</small><Markdown text={message.text} breaks /></div>
            ))}
          </section>
        )}
        {composing && selection && <blockquote>{plan.text.slice(selection.start, selection.end)}</blockquote>}
        {(composing || thread) && (
          <form onSubmit={(e) => { e.preventDefault(); void change(composing ? "create" : "reply"); }}>
            <textarea aria-label={composing ? "Write a passage comment" : "Reply"} rows={3}
              maxLength={TASK_COMMENT_MAX} value={draft} readOnly={busy}
              onChange={(e) => setDrafts({ ...drafts, [draftKey]: e.target.value })} />
            <button type="submit" disabled={busy || !draft.trim()}>{composing ? "Post comment" : "Reply"}</button>
            {composing && <button type="button" disabled={busy} onClick={() => setComposing(false)}>Cancel</button>}
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </aside>
    </div>
  );
}
