// What ✦ Stand, the meeting's own agent (server/meetingAgent.ts), puts on the board: for now, a
// card of options under an open question on the Open tab, asked for with "✦ Options" on that line.
// Each option is one line with its tradeoff under it and the page it leans on; anyone can take it
// as a decision or a to-do. What the space already had on the question sits under the options.
import type { AgentCard } from "../../shared/protocol.ts";

export interface AgentActs {
  cards: AgentCard[];
  /** Missing while the board can't ask (offline, the meeting ending, looking back). */
  onFind?: (noteId: string) => void;
  onPick?: (cardId: string, index: number, as: "decision" | "task") => void;
  onDismiss?: (cardId: string) => void;
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The card on an open question, if one is up. */
export function cardFor(acts: AgentActs | undefined, noteId: string): AgentCard | undefined {
  return acts?.cards.filter((c) => c.about === noteId && !c.dismissed).at(-1);
}

/** "✦ Options" at the end of an open question's line, while it has no card. */
export function FindOptions({ noteId, acts }: { noteId: string; acts: AgentActs }) {
  if (!acts.onFind) return null;
  return (
    <button type="button" className="agent-find" title="Ask Stand for options on this, with the tradeoffs" onClick={() => acts.onFind!(noteId)}>
      <span className="agent-mark" aria-hidden>
        ✦
      </span>{" "}
      Options
    </button>
  );
}

export function OptionsCard({ card, acts }: { card: AgentCard; acts: AgentActs }) {
  const picked = card.picked;
  const cost = card.costUsd !== null ? ` · $${card.costUsd < 0.01 ? card.costUsd.toFixed(3) : card.costUsd.toFixed(2)}` : "";
  const log = `Asked by ${card.by}${card.readyAt ? ` · ${Math.max(1, Math.round((card.readyAt - card.at) / 1000))} s` : ""}${card.model ? ` · ${card.model}` : ""}${cost}`;
  return (
    <div className={["agent-card", card.status].join(" ")} aria-live="polite">
      <div className="agent-card-head">
        <span className="agent-mark" aria-hidden>
          ✦
        </span>
        <span className="agent-card-title">{card.status === "working" ? "Finding options…" : "Options"}</span>
        <span className="agent-card-by" title={log}>
          for {card.by.split(" ")[0]}
        </span>
        {acts.onDismiss && card.status !== "working" && (
          <button type="button" className="agent-card-close" aria-label="Dismiss" title="Dismiss" onClick={() => acts.onDismiss!(card.id)}>
            ×
          </button>
        )}
      </div>
      {card.options.length > 0 && (
        <ol className="agent-options">
          {card.options.map((o, i) => {
            const mine = picked?.index === i;
            return (
              <li key={i} className={[mine && "picked", picked && !mine && "passed"].filter(Boolean).join(" ")}>
                <div className="agent-option-line">
                  <span className="agent-option-title">{o.title}</span>
                  {o.source && (
                    <a className="agent-option-source" href={o.source.url} target="_blank" rel="noreferrer" title={o.source.title}>
                      {host(o.source.url)} ↗
                    </a>
                  )}
                  {mine && picked ? (
                    <span className="agent-option-picked">
                      {picked.as === "decision" ? "Decided" : "To do"} · {picked.by.split(" ")[0]}
                    </span>
                  ) : (
                    !picked &&
                    acts.onPick && (
                      <span className="agent-option-acts">
                        <button type="button" onClick={() => acts.onPick!(card.id, i, "decision")}>
                          Decide
                        </button>
                        <button type="button" onClick={() => acts.onPick!(card.id, i, "task")}>
                          To do
                        </button>
                      </span>
                    )
                  )}
                </div>
                <div className="agent-option-why">{o.why}</div>
              </li>
            );
          })}
        </ol>
      )}
      {card.note && <div className="agent-card-note">{card.note}</div>}
      {card.fromSpace.length > 0 && (
        <ul className="agent-space">
          {card.fromSpace.map((f, i) => (
            <li key={i}>
              <span className="agent-space-when">{shortDate(f.when)}</span>
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
