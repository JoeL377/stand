// What ✦ Stand, the meeting's own agent (server/meetingAgent.ts), puts on the board: for now, a
// card of options under an open question on the Open tab, asked for with "✦ Options" on that line.
// Each option is one line with its tradeoff under it and the page it leans on; anyone can take it
// as a decision or a to-do. What the space already had on the question sits under the options.
// While a card is being worked on, everyone on the call sees a quiet "✦ Finding options" on the
// card's top line (and on the Board tab beside a share); when it's back, "✦ Options ready" for a
// few seconds, which jumps to the card. A question asked out loud (push-to-talk) or typed (@stand)
// gets a card of its own in the board's stack instead: AnswerPart is one question and its answer.
import { useEffect, useState } from "react";
import type { AgentCard, AgentDraft } from "../../shared/protocol.ts";

export interface AgentActs {
  cards: AgentCard[];
  /** Missing while the board can't ask (offline, the meeting ending, looking back). */
  onFind?: (noteId: string) => void;
  onPick?: (cardId: string, index: number, as: "decision" | "task") => void;
  onDismiss?: (cardId: string) => void;
  /** Take an answer's suggested next step as a to-do. */
  onTodo?: (cardId: string) => void;
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** How often streamed-in words step on while they're typed out. */
const REVEAL_TICK_MS = 35;
/** How long "✦ Options ready" stays up after a card comes back. */
export const READY_MS = 12_000;
/** Asks the board to show a card: its tab opens and it scrolls into view. */
export const SHOW_CARD = "stand:agent-show";

export function showCard(id: string) {
  window.dispatchEvent(new CustomEvent(SHOW_CARD, { detail: id }));
  // After the tab has switched and the card is on screen.
  setTimeout(() => document.getElementById(`agent-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 80);
}

/** A small ✦ on the Board tab beside a share: pulsing while ✦ Stand works, still for a moment once it's back. */
export function AgentTabMark({ cards }: { cards: AgentCard[] | null | undefined }) {
  const { working, ready } = useAgentStatus(cards);
  const asked = (cards ?? []).some((c) => c.kind === "answer" && (c.status === "listening" || c.status === "working"));
  if (!working.length && !ready.length && !asked) return null;
  return (
    <span className={working.length || asked ? "agent-tab-mark working" : "agent-tab-mark ready"} aria-label={asked ? "Stand is answering" : working.length ? "Stand is finding options" : "Options ready"}>
      ✦
    </span>
  );
}

/** What ✦ Stand is up to, for everyone: cards being worked on, and ones that came back a moment ago. */
export function useAgentStatus(cards: AgentCard[] | null | undefined) {
  const [now, setNow] = useState(Date.now);
  // Answers have their own card on the board (AnswerPart); this is about options on open questions.
  const live = (cards ?? []).filter((c) => c.kind === "options" && !c.dismissed);
  const working = live.filter((c) => c.status === "working");
  const ready = live.filter((c) => c.status === "ready" && c.readyAt !== null && now - c.readyAt < READY_MS);
  const next = ready.length ? Math.min(...ready.map((c) => c.readyAt! + READY_MS)) : null;
  useEffect(() => {
    setNow(Date.now());
  }, [cards]);
  useEffect(() => {
    if (next === null) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [next]);
  return { working, ready };
}

/** The quiet line on the card's top line: "✦ Finding options" while a run is on, then "✦ Options ready". */
export function AgentStatus({ cards, onShow }: { cards: AgentCard[] | null | undefined; onShow?: () => void }) {
  const { working, ready } = useAgentStatus(cards);
  const first = (n: string) => n.split(" ")[0];
  if (ready.length) {
    const c = ready.at(-1)!;
    return (
      <button
        key={c.id}
        type="button"
        className="agent-status ready"
        title={`${c.question}\nAsked by ${first(c.by)}`}
        onClick={() => {
          onShow?.();
          setTimeout(() => showCard(c.id), 0);
        }}
      >
        <span className="agent-mark" aria-hidden>
          ✦
        </span>{" "}
        Options ready
      </button>
    );
  }
  if (working.length) {
    const c = working.at(-1)!;
    return (
      <span className="agent-status working" title={`${c.question}\nAsked by ${first(c.by)}`} role="status">
        <span className="agent-mark" aria-hidden>
          ✦
        </span>{" "}
        Finding options{working.length > 1 ? ` · ${working.length}` : ""}
      </span>
    );
  }
  return null;
}

/** The card on an open question, if one is up. */
export function cardFor(acts: AgentActs | undefined, noteId: string): AgentCard | undefined {
  return acts?.cards.filter((c) => c.kind === "options" && c.about === noteId && !c.dismissed).at(-1);
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
  const fresh = card.status === "ready" && card.readyAt !== null && Date.now() - card.readyAt < READY_MS;
  // Options that land together (a run that searched writes them in one go) come in one after another.
  const [arriving] = useState(card.status === "working");
  const log = `Asked by ${card.by}${card.readyAt ? ` · ${Math.max(1, Math.round((card.readyAt - card.at) / 1000))} s` : ""}${card.model ? ` · ${card.model}` : ""}${cost}`;
  return (
    <div id={`agent-${card.id}`} className={["agent-card", card.status, fresh && "fresh"].filter(Boolean).join(" ")} aria-live="polite">
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
      {card.status === "working" && card.draft && <DraftOptions draft={card.draft} />}
      {card.options.length > 0 && (
        <ol className="agent-options">
          {card.options.map((o, i) => {
            const mine = picked?.index === i;
            return (
              <li
                key={i}
                className={[mine && "picked", picked && !mine && "passed", arriving && "arriving"].filter(Boolean).join(" ")}
                style={arriving ? { animationDelay: `${i * 160}ms` } : undefined}
              >
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

/** ✦ Stand's answer to a question someone asked it (push-to-talk or @stand), as one turn of a chat on its
 *  card, the way an assistant app shows it: the question in a bubble on the right, then Stand's steps (the
 *  web searches and what it read, folded to one line once it's written) and the answer under them, then the
 *  pages it leans on, what the space already had, and a next step anyone can take as a to-do. */
export function AnswerPart({ card, onTodo }: { card: AgentCard; onTodo?: (cardId: string) => void }) {
  const first = (n: string) => n.split(" ")[0];
  const cost = card.costUsd !== null ? ` · $${card.costUsd < 0.01 ? card.costUsd.toFixed(3) : card.costUsd.toFixed(2)}` : "";
  const log = `Asked by ${card.by}${card.readyAt ? ` · ${Math.max(1, Math.round((card.readyAt - card.at) / 1000))} s` : ""}${card.model ? ` · ${card.model}` : ""}${cost}`;
  const { shown, typing } = useReveal(card.status === "working" ? (card.draft?.text ?? "") : card.status === "listening" ? "" : (card.note ?? ""));
  // Its sources, what the space had and the next step come in once the words are all there.
  const done = card.status === "ready" && !typing;
  return (
    <div id={`agent-${card.id}`} className={["ask-turn", card.status].filter(Boolean).join(" ")} aria-live="polite">
      <div className="ask-q">
        <span className="ask-q-who">{first(card.by)}</span>
        <div className="ask-q-bubble">{card.status === "listening" ? <span className="ask-shimmer">Listening…</span> : card.question}</div>
      </div>
      {card.status !== "listening" && (
        <div className="ask-a" title={log}>
          <Steps draft={card.draft} working={card.status === "working" && !shown} />
          {shown && (
            // The answer as Stand writes it, with a caret at the end until it's all there.
            <div className={["ask-a-text", card.status === "failed" && "failed", (typing || card.status === "working") && "streaming"].filter(Boolean).join(" ")}>{shown}</div>
          )}
          {done && (card.sources?.length ?? 0) > 0 && (
            <div className="ask-sources">
              {card.sources!.map((x) => (
                <a key={x.url} href={x.url} target="_blank" rel="noreferrer" title={x.title}>
                  {host(x.url)}
                </a>
              ))}
            </div>
          )}
          {done && card.fromSpace.length > 0 && (
            <ul className="agent-space">
              {card.fromSpace.map((f, i) => (
                <li key={i}>
                  <span className="agent-space-when">{shortDate(f.when)}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          )}
          {done && card.todo && (
            <div className="agent-answer-todo">
              <span className="agent-answer-todo-text">{card.todo}</span>
              {card.picked ? (
                <span className="agent-option-picked">To do · {first(card.picked.by)}</span>
              ) : (
                onTodo && (
                  <button type="button" onClick={() => onTodo(card.id)}>
                    To do
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Stand's steps before it writes, like an assistant app's tool calls: one line that says what it's doing
 *  while it does it, and once it's written, folds to "Searched the web · N pages", which opens to the
 *  searches and the sites. */
function Steps({ draft, working }: { draft: AgentDraft | null | undefined; working: boolean }) {
  const [open, setOpen] = useState(false);
  const searches = draft?.searches ?? [];
  const pages = draft?.pages ?? [];
  if (!searches.length) return working ? <div className="ask-step"><span className="ask-shimmer">Thinking…</span></div> : null;
  const what = working ? (pages.length ? `Reading ${pages.length} ${pages.length === 1 ? "page" : "pages"}` : "Searching the web") : `Searched the web${pages.length ? ` · ${pages.length} ${pages.length === 1 ? "page" : "pages"}` : ""}`;
  const shown = open || working;
  return (
    <div className="ask-steps">
      <button type="button" className="ask-step" onClick={() => setOpen((o) => !o)} aria-expanded={shown} disabled={working}>
        <span className="ask-step-icon" aria-hidden>
          ⌕
        </span>
        <span className={working ? "ask-shimmer" : undefined}>{what}</span>
        {!working && (
          <span className="ask-step-chev" aria-hidden>
            {open ? "⌄" : "›"}
          </span>
        )}
      </button>
      {shown && (
        <div className="ask-step-detail">
          {searches.map((q, i) => (
            <div key={i} className="ask-step-query">
              {q}
            </div>
          ))}
          {pages.length > 0 && (
            <div className="ask-step-sites">
              {pages.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What a run is doing before it writes: searching, then reading what it found. */
function doing(draft: AgentDraft | null | undefined, idle: string): string {
  const pages = draft?.pages ?? [];
  if (pages.length) return `Reading ${pages.slice(0, 3).join(", ")}${pages.length > 3 ? ` and ${pages.length - 3} more` : ""}…`;
  if (draft?.searches.length) return `Searching the web: ${draft.searches.at(-1)}`;
  return idle;
}

/** What a run looked up, as a quiet line under what it's writing. */
function Searched({ draft }: { draft: AgentDraft }) {
  return <div className="agent-searched">Searched {draft.searches.map((q) => `“${q}”`).join(", ")}</div>;
}

/** Text that arrives in one go comes in over a moment, a few letters at a time, like typing; text that was
 *  already there when it came on screen shows whole. */
function useReveal(text: string): { shown: string; typing: boolean } {
  const [n, setN] = useState(text.length);
  useEffect(() => {
    if (n > text.length) return void setN(text.length);
    if (n === text.length) return;
    const t = setTimeout(() => {
      // On to the end of the next word or two.
      const at = text.indexOf(" ", Math.min(text.length, n + 8));
      setN(at < 0 ? text.length : at);
    }, REVEAL_TICK_MS);
    return () => clearTimeout(t);
  }, [text, n]);
  return { shown: text.slice(0, n), typing: n < text.length };
}

/** Options as Stand writes them: each one slides in as it comes, the last one's tradeoff still being written. */
function DraftOptions({ draft }: { draft: AgentDraft }) {
  if (!draft.options.length && !draft.text) return draft.searches.length ? <div className="agent-card-note agent-draft-searching">✦ {doing(draft, "")}</div> : null;
  return (
    <>
      {draft.options.length > 0 && (
        <ol className="agent-options drafting">
          {draft.options.map((o, i) => (
            <li key={i}>
              <div className="agent-option-line">
                <span className="agent-option-title">{o.title}</span>
              </div>
              {o.why && <div className={i === draft.options.length - 1 ? "agent-option-why streaming" : "agent-option-why"}>{o.why}</div>}
            </li>
          ))}
        </ol>
      )}
      {!draft.options.length && draft.text && <div className="agent-card-note streaming">{draft.text}</div>}
      {draft.searches.length > 0 && <Searched draft={draft} />}
    </>
  );
}
