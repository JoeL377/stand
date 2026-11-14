// What agents do on a to-do: a pill while one is on it, and a log of
// what it reported (the summary of what changed first, with its screenshots)
// that opens under the to-do. Agents report through the Stand MCP.

import { useEffect, useState, useMemo } from "react";
import type { ActionWork, Snap } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { SnapGallery } from "./Snaps.tsx";
import { fmtAgo, linkLabel, fmtFull } from "./util.ts";

// What was last read about each to-do, kept for the visit. A list that comes back on screen (another
// tab and back, a project and back) starts from this instead of from nothing: the Projects tab orders
// its cards by who is working on what, so starting from nothing drew them in one order and then moved
// them when the answer landed.
const known = new Map<string, ActionWork>();
const asked = new Set<string>();
const read = (ids: string[]) => {
  const out: Record<string, ActionWork> = {};
  for (const id of ids) {
    const w = known.get(id);
    if (w) out[id] = w;
  }
  return out;
};
/** Whether every one of these to-dos has been read at least once in this visit. */
export const workKnown = (ids: string[]) => ids.every((id) => asked.has(id));

/** Polls what agents are doing on these to-dos: often while one is working, rarely otherwise. */
export function useWork(ids: string[]): Record<string, ActionWork> {
  const key = ids.join(",");
  const [read_, reads] = useState(0);
  useEffect(() => {
    if (!key) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      let next: Record<string, ActionWork> | null = null;
      try {
        next = await api.work(key.split(","));
        for (const id of key.split(",")) {
          asked.add(id);
          if (next[id]) known.set(id, next[id]);
          else known.delete(id);
        }
        if (!stop) reads((n) => n + 1);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => read(key ? key.split(",") : []), [key, read_]);
}

/** The pill after a to-do's text: "Working" with a spinner while an agent is on it, "Ready to ship"
 *  while its PR waits to merge, else just the count. */
export function WorkPill({ work, open, onToggle, quiet }: {
  work: ActionWork; open: boolean; onToggle: () => void;
  /** The row's checkbox says where the to-do stands: the pill is only the count of updates, with the state in its tooltip. */
  quiet?: boolean;
}) {
  const done = work.log.find((e) => e.status === "done");
  const state = !quiet && work.working ? "working" : !quiet && work.ready ? "ready" : "";
  if (quiet && !work.log.length) return null;
  const label = quiet && !done
    ? String(work.log.length)
    : work.working
    ? "Working"
    : work.ready
      ? "Ready to ship"
      : done
        ? "Summary"
        : String(work.log.length);
  // A row says only how many reports there are; the word is in the tooltip.
  const full = label === String(work.log.length) ? `${label} update${work.log.length === 1 ? "" : "s"}` : label;
  const title = work.working
    ? `${work.working.by} · started ${fmtAgo(work.working.since)}\n${work.working.text}`
    : work.ready
      ? `${work.ready.by} · ${fmtAgo(work.ready.since)}\n${work.ready.pr ? `${linkLabel(work.ready.pr)} · checked off when it merges` : "Waiting to ship"}`
      : `${full}: ${open ? "hide" : "show"} what was done`;
  return (
    <button
      type="button"
      className={`fu-work${state ? ` ${state}` : ""}${quiet ? " quiet" : ""}${open ? " open" : ""}`}
      aria-expanded={open}
      aria-label={full}
      title={title}
      onClick={onToggle}
    >
      {state === "working" && <span className="fu-spin" aria-hidden />}
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
  ready: "Ready to ship",
  added: "Added",
  note: "Note",
  comment: "Comment",
  plan: "Spec attached",
  linked: "Linked",
  shots: "Screenshots",
};

const FIRST = 3;

type Entry = ActionWork["log"][number];

/** An entry's screenshots in the shape the snap viewer shows (no crop or delete: they're the agent's). */
const asSnaps = (e: Entry): Snap[] =>
  e.shots.map((s, k) => ({
    id: `${e.id}-${k}`,
    meetingId: null,
    itemId: null,
    itemSuggested: false,
    ts: e.ts,
    url: s.url,
    width: 0,
    height: 0,
    source: "person",
    takenById: null,
    takenBy: e.by,
    sharerId: null,
    sharerName: null,
    caption: s.caption,
    line: null,
    screenText: null,
    noteId: null,
    discussionId: null,
    segmentIds: [],
  }));

/** The to-do's log, newest first, as a bordered card under it. noPlan: the plan shows elsewhere. */
export function WorkCard({ work, noPlan }: { work: ActionWork; noPlan?: boolean }) {
  const [all, setAll] = useState(false);
  const [viewing, setViewing] = useState<{ entry: Entry; at: number } | null>(null);
  // A long report shows its first lines; "More" opens the rest.
  const [whole, setWhole] = useState<Set<string>>(new Set());
  const long = (e: Entry) => e.text.length > 320 || e.text.split("\n").length > 6;
  const shown = all ? work.log : work.log.slice(0, FIRST);
  return (
    <div className="fu-log">
      {work.plan && !noPlan && (
        <details className="wl-plan">
          <summary>
            Spec <span className="wl-by">{work.plan.by}</span> <time title={fmtFull(work.plan.ts)}>{fmtAgo(work.plan.ts)}</time>
          </summary>
          <Markdown className="wl-text" text={work.plan.text} />
        </details>
      )}
      {shown.map((e) => (
        <div key={e.id} className={`wl-entry ${e.status}`}>
          <div className="wl-head">
            <span className={`wl-status ${e.status}`}>{STATUS[e.status]}</span>
            <span className="wl-by">{e.by}</span>
            <time title={fmtFull(e.ts)}>{fmtAgo(e.ts)}</time>
            {e.links.map((l) => (
              <a key={l} className="wl-link" href={l} target="_blank" rel="noreferrer">
                {linkLabel(l)}
              </a>
            ))}
          </div>
          {e.text && <Markdown className={long(e) && !whole.has(e.id) ? "wl-text clamp" : "wl-text"} text={e.text} breaks />}
          {e.text && long(e) && (
            <button
              type="button"
              className="wl-more"
              onClick={() => setWhole((w) => { const n = new Set(w); if (!n.delete(e.id)) n.add(e.id); return n; })}
            >
              {whole.has(e.id) ? "Less" : "More"}
            </button>
          )}
          {e.shots.length > 0 && (
            <div className="wl-shots">
              {e.shots.map((s, k) => (
                <button key={s.url} type="button" onClick={() => setViewing({ entry: e, at: k })} title={s.caption ?? "Open the screenshot"}>
                  <img src={s.url} alt={s.caption ?? "Screenshot"} loading="lazy" />
                  {s.caption && <span>{s.caption}</span>}
                </button>
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
      {viewing && <SnapGallery snaps={asSnaps(viewing.entry)} me="" isHost={false} start={viewing.at} onClose={() => setViewing(null)} />}
    </div>
  );
}
