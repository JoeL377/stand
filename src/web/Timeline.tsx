// A finished meeting's timeline (shared/timeline.ts): what was said and typed, what Stand caught, what
// Ask Stand was asked and answered, which item or slide was up, and what agents reported, in order.
// It draws each kind the way the call's own transcript does, with chips to leave kinds out.

import { useState } from "react";
import { type TimelineEntry, type TimelineKind, timelineWho } from "../shared/timeline.ts";
import { Linkified } from "./Linkified.tsx";
import { Markdown } from "./Markdown.tsx";
import { usePersonColors } from "./PersonColors.tsx";
import { fmtTime } from "./util.ts";

const FILTERS: Array<{ id: string; label: string; kinds: TimelineKind[] }> = [
  { id: "said", label: "Said", kinds: ["speech"] },
  { id: "chat", label: "Chat", kinds: ["chat"] },
  { id: "caught", label: "Caught", kinds: ["capture"] },
  { id: "ask", label: "Ask Stand", kinds: ["ask"] },
  { id: "agents", label: "Agents", kinds: ["agent"] },
];

const CAUGHT: Record<string, string> = { action: "To-do", decision: "Decision", question: "Open question", context: "Context" };

const VERB: Partial<Record<string, string>> = {
  added: "added",
  ready: "ready to ship",
  done: "finished",
  progress: "reported",
  blocked: "is blocked",
  needs_decision: "needs a decision",
  comment: "commented",
  plan: "attached a plan",
  linked: "linked",
  note: "noted",
};

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const hidden = new Set(FILTERS.filter((f) => off.has(f.id)).flatMap((f) => f.kinds));
  const counts = new Map(FILTERS.map((f) => [f.id, entries.filter((e) => f.kinds.includes(e.kind)).length]));
  // Focus changes stay as dividers whatever is left out, so every line keeps the slide it was under.
  const shown = entries.filter((e) => !hidden.has(e.kind));
  const toggle = (id: string) =>
    setOff((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="timeline">
      <div className="tl-filters" role="group" aria-label="Show in the timeline">
        {FILTERS.filter((f) => (counts.get(f.id) ?? 0) > 0).map((f) => (
          <button key={f.id} type="button" className={off.has(f.id) ? "sp-chip" : "sp-chip on"} aria-pressed={!off.has(f.id)} onClick={() => toggle(f.id)}>
            {f.label} <span className="n">{counts.get(f.id)}</span>
          </button>
        ))}
      </div>
      <div className="transcript static">
        {shown.map((e) => (
          <TimelineRow key={e.id} e={e} />
        ))}
      </div>
    </div>
  );
}

function TimelineRow({ e }: { e: TimelineEntry }) {
  const colorFor = usePersonColors();
  switch (e.kind) {
    case "focus":
      return (
        <div className="seg board-move tl-focus" role="note">
          <span className="board-move-text">
            {!e.who && (
              <span className="agent-mark" aria-hidden>
                ✦{" "}
              </span>
            )}
            {e.who ? `${e.who} moved to` : "Moved to"} · <strong>{e.label && !e.text.startsWith(e.label) ? `${e.label}: ${e.text}` : e.text}</strong>
          </span>
          <span className="seg-time">{fmtTime(e.ts)}</span>
        </div>
      );
    case "capture":
      return (
        <div className={`seg capture-event capture-${e.capture}`} role="note">
          <div className="capture-head">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <strong>Caught: {CAUGHT[e.capture ?? ""] ?? "Note"}</strong>
            <span className="seg-time">{fmtTime(e.ts)}</span>
          </div>
          <div className="capture-text">
            <Linkified text={e.text} />
          </div>
          {e.who && <span className="capture-owner">{e.who}</span>}
        </div>
      );
    case "ask":
      return (
        <div className="seg capture-event capture-ask" role="note">
          <div className="capture-head">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <strong>{e.who ?? "Someone"} asked Stand</strong>
            <span className="seg-time">{fmtTime(e.ts)}</span>
          </div>
          <div className="capture-text">{e.text}</div>
          {e.answer ? <Markdown className="capture-text tl-answer" text={e.answer} breaks /> : <span className="capture-owner">No answer</span>}
        </div>
      );
    case "agent":
      return (
        <div className="seg capture-event capture-agent" role="note">
          <div className="capture-head">
            <strong>
              {timelineWho(e)} {VERB[e.status ?? ""] ?? "reported"}
            </strong>
            <span className="seg-time">{fmtTime(e.ts)}</span>
          </div>
          <div className="capture-text">
            <Linkified text={e.text} />
          </div>
        </div>
      );
    default:
      return (
        <div className={e.kind === "chat" ? "seg chat" : "seg"}>
          <div className="seg-head">
            <span className="seg-who" style={{ color: e.whoId ? colorFor(e.whoId) : undefined }}>
              {e.who}
            </span>
            {e.kind === "chat" && <span className="seg-kind">chat</span>}
            <span className="seg-time">{fmtTime(e.ts)}</span>
          </div>
          <div className="seg-text">
            <Linkified text={e.text} />
          </div>
        </div>
      );
  }
}
