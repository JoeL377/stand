// What Stand, the meeting's own agent (server/meetingAgent.ts), puts on the board: for now, a
// card of options under an open question on the Open tab, asked for with "Options" on that line.
// Each option is one line with its tradeoff under it and the page it leans on; anyone can take it
// as a decision or a to-do. What the space already had on the question sits under the options.
// While a card is being worked on, everyone on the call sees a quiet "Finding options" on the
// card's top line (and on the Board tab beside a share); when it's back, "Options ready" for a
// few seconds, which jumps to the card. A question asked out loud (push-to-talk) or typed (@stand)
// gets a card of its own in the board's stack instead: AnswerPart is one question and its answer.
// What someone's own agent says in the call over the MCP is a card in the stack too: SaidCard.
// While the board is out of view on a screen, a card from an agent comes up there as a notice
// (SaidNotice) that opens the card in a panel on that screen only (SaidPanel).
import { useEffect, useRef, useState } from "react";
import type { AgentCard, AgentDraft } from "../../shared/protocol.ts";
import { Markdown } from "../Markdown.tsx";
import { usePersonColors } from "../PersonColors.tsx";
import { isSaid, saidLine, saidNotice, saidOnBoard } from "../agentNotice.ts";
import { fmtDay } from "../util.ts";

export interface AgentActs {
  cards: AgentCard[];
  /** Missing while the board can't ask (offline, the meeting ending, looking back). */
  onFind?: (noteId: string) => void;
  onPick?: (cardId: string, index: number, as: "decision" | "task") => void;
  onDismiss?: (cardId: string) => void;
  /** Take an answer's suggested next step as a to-do. */
  onTodo?: (cardId: string) => void;
}

const shortDate = (ms: number) => fmtDay(ms);
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** How often streamed-in words step on while they're typed out. */
const REVEAL_TICK_MS = 35;
/** How long "Options ready" stays up after a card comes back. */
export const READY_MS = 12_000;
/** Asks the board to show a card: its tab opens and it scrolls into view. */
export const SHOW_CARD = "stand:agent-show";

export function showCard(id: string) {
  window.dispatchEvent(new CustomEvent(SHOW_CARD, { detail: id }));
  // After the tab has switched and the card is on screen.
  setTimeout(() => document.getElementById(`agent-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 80);
}

export { isSaid };

/** A small on the Board tab beside a share: pulsing while Stand works, still for a moment once it's back,
 *  and still for as long as a card from someone's own agent is there that this screen hasn't seen (`unseen`). */
export function AgentTabMark({ cards, unseen = 0 }: { cards: AgentCard[] | null | undefined; unseen?: number }) {
  const { working, ready } = useAgentStatus(cards);
  const asked = (cards ?? []).some((c) => c.kind === "answer" && (c.status === "listening" || c.status === "working"));
  if (!working.length && !ready.length && !asked && !unseen) return null;
  const last = ready.at(-1) ?? (unseen ? saidOnBoard(cards).at(-1) : undefined);
  return (
    <span
      className={working.length || asked ? "agent-tab-mark working" : "agent-tab-mark ready"}
      aria-label={asked ? "Stand is answering" : working.length ? "Stand is finding options" : last && isSaid(last) ? `New from ${last.by.split(" ")[0]}'s agent` : "Options ready"}
      role="img"
    />
  );
}

/** What Stand is up to, for everyone: cards being worked on, and ones that came back a moment ago. */
export function useAgentStatus(cards: AgentCard[] | null | undefined) {
  const [now, setNow] = useState(Date.now);
  // Answers have their own card on the board (AnswerPart); this is about options on open questions, and
  // what someone's own agent just put on the board.
  const live = (cards ?? []).filter((c) => (c.kind === "options" || isSaid(c)) && !c.dismissed);
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

/** The quiet line on the card's top line: "Finding options" while a run is on, then "Options ready". */
export function AgentStatus({ cards, onShow }: { cards: AgentCard[] | null | undefined; onShow?: () => void }) {
  const { working, ready } = useAgentStatus(cards);
  const first = (n: string) => n.split(" ")[0];
  if (ready.length) {
    const c = ready.at(-1)!;
    const said = isSaid(c);
    return (
      <button
        key={c.id}
        type="button"
        className="agent-status ready"
        title={said ? `${c.by}'s own agent put a card on the board` : `${c.question}\nAsked by ${first(c.by)}`}
        onClick={() => {
          onShow?.();
          setTimeout(() => showCard(c.id), 0);
        }}
      >
        {said ? `New from ${first(c.by)}'s agent` : "Options ready"}
      </button>
    );
  }
  if (working.length) {
    const c = working.at(-1)!;
    return (
      <span className="agent-status working" title={`${c.question}\nAsked by ${first(c.by)}`} role="status">
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

/** "Options" at the end of an open question's line, while it has no card. */
export function FindOptions({ noteId, acts }: { noteId: string; acts: AgentActs }) {
  if (!acts.onFind) return null;
  return (
    <button type="button" className="agent-find" title="Ask Stand for options on this, with the tradeoffs" onClick={() => acts.onFind!(noteId)}>
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

/** Stand's answer to a question someone asked it (push-to-talk or @stand), as one turn of a chat on its
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

/** What someone's own agent said in the call over the MCP (say_in_call), under its person's name: its
 *  words, the pages it leans on, a next step anyone can take as a to-do, and its longer write-up folded
 *  under them. Stand ran no model for it; the model named is the one the agent reported. */
export function SaidCard({ card, acts }: { card: AgentCard; acts?: AgentActs }) {
  const colorFor = usePersonColors();
  const a = card.agent;
  const first = card.by.split(" ")[0];
  const via = [a?.agent, a?.model].filter(Boolean).join(" · ");
  return (
    <div id={`agent-${card.id}`} className="said-card" aria-live="polite">
      <div className="said-card-head">
        <span className="said-card-who" style={{ color: colorFor(a?.personId ?? card.by) }}>
          {first}'s agent
        </span>
        {via && (
          <span className="said-card-via" title={`${card.by}'s own agent, connected to Stand.${a?.model ? " The model is what the agent reported." : ""}`}>
            {via}
          </span>
        )}
        {acts?.onDismiss && (
          <button type="button" className="agent-card-close" aria-label="Dismiss" title="Take this card off the board, for everyone" onClick={() => acts.onDismiss!(card.id)}>
            ×
          </button>
        )}
      </div>
      <Markdown className="said-card-text" text={card.note ?? ""} breaks />
      {(card.sources?.length ?? 0) > 0 && (
        <div className="ask-sources">
          {card.sources!.map((x) => (
            <a key={x.url} href={x.url} target="_blank" rel="noreferrer" title={x.title}>
              {host(x.url)}
            </a>
          ))}
        </div>
      )}
      {card.todo && (
        <div className="agent-answer-todo">
          <span className="agent-answer-todo-text">{card.todo}</span>
          {card.picked ? (
            <span className="agent-option-picked">To do · {card.picked.by.split(" ")[0]}</span>
          ) : (
            acts?.onTodo && (
              <button type="button" onClick={() => acts.onTodo!(card.id)}>
                To do
              </button>
            )
          )}
        </div>
      )}
      {card.detail && (
        <details className="said-card-detail">
          <summary>The full write-up</summary>
          <Markdown text={card.detail} />
        </details>
      )}
    </div>
  );
}

/** Cards from agents this screen hasn't seen, and the notice for the newest. `inView`: the board's card is
 *  on this screen now, so what is on the board counts as seen. Cards that were there when the screen
 *  opened count as seen too. */
export function useSaidNotice(cards: AgentCard[] | null | undefined, inView: boolean) {
  const on = saidOnBoard(cards);
  const ids = on.map((c) => c.id).join(" ");
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const arrived = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  const t = Date.now();
  for (const c of on) if (!arrived.current.has(c.id)) arrived.current.set(c.id, t);
  const add = (more: string[]) => setSeen((s) => (s && more.every((id) => s.has(id)) ? s : new Set([...(s ?? []), ...more])));
  useEffect(() => {
    if (seen === null && cards) setSeen(new Set(on.map((c) => c.id)));
  }, [cards]);
  useEffect(() => {
    if (inView && seen !== null) add(on.map((c) => c.id));
  }, [inView, ids, seen === null]);
  const n = saidNotice(cards, seen ?? new Set(on.map((c) => c.id)), arrived.current, t, closed);
  useEffect(() => {
    if (n.ends === null) return;
    const id = setTimeout(() => tick((x) => x + 1), Math.max(0, n.ends - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [n.ends]);
  return {
    ...n,
    /** The card was in view (opened in the panel). */
    see: (id: string) => add([id]),
    /** × on the notice: it goes, and the cards stay unseen for the Board tab's mark. */
    close: () => setClosed((c) => new Set([...c, ...on.map((x) => x.id)])),
  };
}

/** The notice at the foot of the middle screen (or one line over a phone's sheet): whose agent, the first
 *  line of what it said, Open and ×. */
export function SaidNotice({ card, more, line, onOpen, onClose }: { card: AgentCard; more: number; line?: boolean; onOpen: () => void; onClose: () => void }) {
  const colorFor = usePersonColors();
  const who = `${card.by.split(" ")[0]}'s agent`;
  return (
    <div className={line ? "phone-next said-notice-line" : "nudge said-notice"} role="status" title={`${card.by}'s own agent put a card on the board`}>
      <span className="said-notice-who" style={{ color: colorFor(card.agent?.personId ?? card.by) }}>
        {who}
      </span>
      <button type="button" className={line ? "phone-next-what" : "said-notice-what"} onClick={onOpen}>
        {saidLine(card, 90) || "put a card on the board"}
      </button>
      {more > 0 && <span className="said-notice-more muted">+{more}</span>}
      <button type="button" className={line ? "link" : "primary said-notice-open"} onClick={onOpen}>
        Open
      </button>
      <button type="button" className="link muted" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

/** A card from an agent opened from its notice: over the middle screen, on this screen only, while the
 *  share or the slide goes on under it. Escape or × closes it. */
export function SaidPanel({ card, acts, onClose }: { card: AgentCard; acts?: AgentActs; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="said-panel" role="dialog" aria-label={`From ${card.by.split(" ")[0]}'s agent`}>
      <SaidCard card={card} acts={acts && { ...acts, onDismiss: undefined }} />
      <div className="said-panel-foot">
        <button type="button" onClick={onClose} title="Only you see this panel">
          Close
        </button>
        {acts?.onDismiss && (
          <button
            type="button"
            className="link muted"
            title="Take this card off the board, for everyone"
            onClick={() => {
              acts.onDismiss!(card.id);
              onClose();
            }}
          >
            Dismiss for everyone
          </button>
        )}
      </div>
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
  const code = draft?.code ?? [];
  if (!searches.length && !code.length) return working ? <div className="ask-step"><span className="ask-shimmer">Thinking…</span></div> : null;
  const web = working ? (pages.length ? `Reading ${pages.length} ${pages.length === 1 ? "page" : "pages"}` : "Searching the web") : `Searched the web${pages.length ? ` · ${pages.length} ${pages.length === 1 ? "page" : "pages"}` : ""}`;
  const repo = working ? `${code.at(-1)}…` : `Looked in the repo · ${code.length} ${code.length === 1 ? "step" : "steps"}`;
  // While working, the latest step leads; once written, both fold into one line.
  const what = !code.length ? web : !searches.length ? repo : working ? repo : `${repo} · searched the web`;
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
          {code.map((s, i) => (
            <div key={`c${i}`} className="ask-step-query">
              {s}
            </div>
          ))}
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
  if (!draft.options.length && !draft.text) return draft.searches.length ? <div className="agent-card-note agent-draft-searching">{doing(draft, "")}</div> : null;
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
