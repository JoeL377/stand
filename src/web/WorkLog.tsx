// What agents do on a to-do: a loading mark while one is on it, and a log of
// what it reported (the summary of what changed first, with its screenshots)
// that opens under the to-do. Agents report through the Stand MCP.

import { useEffect, useState } from "react";
import type { ActionWork } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { Linkified } from "./Linkified.tsx";
import { fmtAgo, linkLabel } from "./util.ts";

/** Polls what agents are doing on these to-dos: often while one is working, rarely otherwise. */
export function useWork(ids: string[]): Record<string, ActionWork> {
  const key = ids.join(",");
  const [work, setWork] = useState<Record<string, ActionWork>>({});
  useEffect(() => {
    if (!key) return setWork({});
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      let next: Record<string, ActionWork> | null = null;
      try {
        next = await api.work(key.split(","));
        if (!stop) setWork(next);
      } catch {
        // Keep what's showing; the next poll tries again.
      }
      const busy = next && Object.values(next).some((w) => w.working);
      if (!stop) timer = setTimeout(load, busy ? 10_000 : 60_000);
    };
    void load();
    const onFocus = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [key]);
  return work;
}

/** The pill after a to-do's text: "Working" with a spinner while an agent is on it, else the log's ✦. */
export function WorkPill({ work, open, onToggle }: { work: ActionWork; open: boolean; onToggle: () => void }) {
  const done = work.log.find((e) => e.status === "done");
  const label = work.working ? "Working" : done ? "Summary" : `${work.log.length} update${work.log.length === 1 ? "" : "s"}`;
  const title = work.working
    ? `${work.working.by} · started ${fmtAgo(work.working.since)}\n${work.working.text}`
    : `${open ? "Hide" : "Show"} what was done`;
  return (
    <button
      type="button"
      className={`fu-work${work.working ? " working" : ""}${open ? " open" : ""}`}
      aria-expanded={open}
      title={title}
      onClick={onToggle}
    >
      {work.working ? <span className="fu-spin" aria-hidden /> : <span aria-hidden>✦</span>}
      {label}
    </button>
  );
}

const STATUS: Record<ActionWork["log"][number]["status"], string> = {
  done: "Done",
  working: "Started",
  progress: "Progress",
  blocked: "Blocked",
  needs_decision: "Needs a decision",
  shots: "Screenshots",
};

const FIRST = 3;

/** The to-do's log, newest first, as a bordered card under it. */
export function WorkCard({ work }: { work: ActionWork }) {
  const [all, setAll] = useState(false);
  const shown = all ? work.log : work.log.slice(0, FIRST);
  return (
    <div className="fu-log">
      {shown.map((e) => (
        <div key={e.id} className={`wl-entry ${e.status}`}>
          <div className="wl-head">
            <span className={`wl-status ${e.status}`}>{STATUS[e.status]}</span>
            <span className="wl-by">{e.by}</span>
            <time title={new Date(e.ts).toLocaleString()}>{fmtAgo(e.ts)}</time>
            {e.links.map((l) => (
              <a key={l} className="wl-link" href={l} target="_blank" rel="noreferrer">
                {linkLabel(l)}
              </a>
            ))}
          </div>
          {e.text && (
            <p className="wl-text">
              <Linkified text={e.text} />
            </p>
          )}
          {e.shots.length > 0 && (
            <div className="wl-shots">
              {e.shots.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.caption ?? "Open the screenshot"}>
                  <img src={s.url} alt={s.caption ?? "Screenshot"} loading="lazy" />
                  {s.caption && <span>{s.caption}</span>}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
      {work.log.length > FIRST && (
        <button type="button" className="wl-more" onClick={() => setAll(!all)}>
          {all ? "Fewer" : `${work.log.length - FIRST} earlier`}
        </button>
      )}
    </div>
  );
}
