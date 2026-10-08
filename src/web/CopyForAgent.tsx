import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api.ts";

export type RefKind = "action" | "decision" | "question" | "topic";

// Whether this person has made an agent token yet, asked once per page load.
let hasToken: Promise<boolean> | null = null;
const checkToken = () =>
  (hasToken ??= api.tokens().then(
    (t) => t.length > 0,
    () => true,
  ));

/** Copies a short, self-contained prompt for Claude Code, Cursor or Codex with
 *  this to-do, decision, question or topic's Stand reference in it. */
export function CopyForAgent({ kind, id, label }: { kind: RefKind; id: string; label?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "nudge" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const text = api.refPrompt(kind, id).then((r) => r.text);
    try {
      // Safari only allows a clipboard write inside the click, so hand it the pending text.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else await navigator.clipboard.writeText(await text);
      const nudge = !(await checkToken());
      setState(nudge ? "nudge" : "copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), nudge ? 7000 : 1800);
    } catch {
      setState("failed");
      timer.current = setTimeout(() => setState("idle"), 2500);
    }
  };

  return (
    <span className="cfa">
      <button
        type="button"
        className={label ? "cfa-btn labelled" : "cfa-btn"}
        onClick={copy}
        title="Copy for agent: a prompt with this item's Stand reference, to paste into Claude Code, Cursor or Codex"
        aria-label="Copy for agent"
      >
        {state === "copied" || state === "nudge" ? <CheckIcon /> : <AgentIcon />}
        {label && <span>{state === "copied" || state === "nudge" ? "Copied" : "Copy for agent"}</span>}
      </button>
      {state !== "idle" && (
        <span className="cfa-pop" role="status">
          {state === "failed" ? (
            "Couldn't copy. Try again."
          ) : state === "nudge" ? (
            <>
              Copied. Paste it into Claude Code, Cursor or Codex. <Link to="/agents">Connect an agent</Link> so it can pull the full
              context.
            </>
          ) : (
            "Copied for your agent"
          )}
        </span>
      )}
    </span>
  );
}

const AgentIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);
const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
