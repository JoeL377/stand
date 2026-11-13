// A finished meeting's timeline (shared/timeline.ts): what was said and typed, what Stand caught, what
// Ask Stand was asked and answered, which item or slide was up, and what agents reported, in order.
// It draws each kind the way the call's own transcript does, with chips to leave kinds out.

import { useState } from "react";
import type { Actor } from "../shared/actors.ts";
import type { Shown, TimelineEntry, TimelineKind } from "../shared/timeline.ts";
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
            {/* A change on the main view that wasn't a move to another item (a share, a spec, the board)
                says who in its own words. A move names who moved it: a person, or Stand by itself. */}
            {e.id.startsWith("stage:") ? (
              <strong>{e.text}</strong>
            ) : (
              <>
                <ActorTag actor={e.actor} /> moved to · <strong>{e.label && !e.text.startsWith(e.label) ? `${e.label}: ${e.text}` : e.text}</strong>
              </>
            )}
          </span>
          <span className="seg-time">{fmtTime(e.ts)}</span>
        </div>
      );
    case "capture":
      return (
        <div className={`seg capture-event capture-${e.capture}`} role="note">
          <div className="capture-head">
            <strong>
              {e.actor?.kind === "stand" ? "Caught" : "Added"}: {CAUGHT[e.capture ?? ""] ?? "Note"}
            </strong>
            <span className="seg-time">{fmtTime(e.ts)}</span>
          </div>
          <div className="capture-text">
            <Linkified text={e.text} />
          </div>
          <MadeBy e={e} />
          <ShownChip shown={e.shown} />
        </div>
      );
    case "ask":
      return <AskRow e={e} />;
    case "agent":
      return <AgentRow e={e} />;
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
          {e.points && <ShownChip shown={e.shown} pointing />}
        </div>
      );
  }
}

/** Who did it, exactly: the person by name in their own color, their agent by name with its model,
 *  or Stand. Never just "a person" or "an agent". */
export function ActorTag({ actor }: { actor: Actor | null | undefined }) {
  const colorFor = usePersonColors();
  if (!actor) return <span className="tl-actor">Someone</span>;
  if (actor.kind === "stand")
    return (
      <span className="tl-actor" title={actor.model ? `Stand, the meeting's own agent, running ${actor.model}` : "Stand, the meeting's own agent"}>
        Stand
      </span>
    );
  const name = actor.person ?? "Someone";
  const who = (
    <span className="tl-actor-person" style={{ color: colorFor(actor.personId ?? name) }}>
      {name}
    </span>
  );
  if (actor.kind === "person") return <span className="tl-actor">{who}</span>;
  const through = actor.kind === "github" ? "GitHub" : (actor.agent ?? "their agent");
  return (
    <span className="tl-actor" title={`${name}, through ${through}${actor.model ? `, running ${actor.model}` : ""}`}>
      {who}{" "}
      <span className="tl-actor-via">
        via {through}
        {actor.model ? ` (${actor.model})` : ""}
      </span>
    </span>
  );
}

/** Under a capture: who made it, and who it is for. The two are often different people. */
export function MadeBy({ e }: { e: Pick<TimelineEntry, "actor" | "owner" | "byHand"> }) {
  return (
    <span className="capture-owner tl-made">
      {e.actor?.kind === "stand" ? "Caught by" : e.byHand ? "By hand:" : "Added by"} <ActorTag actor={e.actor} />
      {e.owner && <> · Owner: {e.owner}</>}
    </span>
  );
}

/** What the main view showed when something was said or done, as a quiet link to it. It says what was
 *  up; `pointing` (the words point at the screen) is the only hint that they were about it. */
export function ShownChip({ shown, pointing }: { shown?: Shown; pointing?: boolean }) {
  if (!shown || shown.kind === "item") return null;
  const href = shown.snapUrl ?? (shown.itemId ? `/items/${shown.itemId}` : null);
  const title = pointing ? "These words point at what was on screen. Open what was up." : "What the main view showed at the time. Open it.";
  const words = (
    <>
      <span className="tl-shown-k">{pointing ? "Pointing at" : "On screen"}</span> {shown.label}
    </>
  );
  return href ? (
    <a className="tl-shown" href={href} target="_blank" rel="noreferrer" title={title}>
      {words}
    </a>
  ) : (
    <span className="tl-shown" title={title}>
      {words}
    </span>
  );
}

/** A question someone asked Stand, with its answer under it. onShow: a way to the card itself, in a call. */
export function AskRow({ e, onShow }: { e: TimelineEntry; onShow?: () => void }) {
  return (
    <div className="seg capture-event capture-ask" role="note">
      <div className="capture-head">
        <strong>
          <ActorTag actor={e.actor} /> {e.asked ? "asked their agent" : "asked Stand"}
        </strong>
        <span className="seg-time">{fmtTime(e.ts)}</span>
      </div>
      <div className="capture-text">{e.text}</div>
      {e.answer ? (
        <div className="tl-answer">
          <span className="capture-owner">
            <ActorTag actor={e.answeredBy} /> answered
          </span>
          <Markdown className="capture-text" text={e.answer} breaks />
        </div>
      ) : (
        <span className="capture-owner">{e.pending ? (e.asked ? "Their agent is working on it…" : "Stand is working on it…") : "No answer"}</span>
      )}
      <ShownChip shown={e.shown} />
      {onShow && (
        <button type="button" className="link small tl-show" onClick={onShow}>
          Show on the board
        </button>
      )}
    </div>
  );
}

/** Something a person's agent (or a person) reported to the space while the meeting ran, or what their
 *  agent said in the call itself. onShow: a way to that card, in a call. */
export function AgentRow({ e, onShow }: { e: TimelineEntry; onShow?: () => void }) {
  return (
    <div className="seg capture-event capture-agent" role="note">
      <div className="capture-head">
        <strong>
          <ActorTag actor={e.actor} /> {e.card ? "said in the call" : (VERB[e.status ?? ""] ?? "reported")}
        </strong>
        <span className="seg-time">{fmtTime(e.ts)}</span>
      </div>
      {e.card ? (
        <Markdown className="capture-text" text={e.text} breaks />
      ) : (
        <div className="capture-text">
          <Linkified text={e.text} />
        </div>
      )}
      {e.detail && (
        <details className="tl-detail">
          <summary>The full write-up</summary>
          <Markdown text={e.detail} />
        </details>
      )}
      <ShownChip shown={e.shown} />
      {e.card && onShow && (
        <button type="button" className="link small tl-show" onClick={onShow}>
          Show on the board
        </button>
      )}
    </div>
  );
}
