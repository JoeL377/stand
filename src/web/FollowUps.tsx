import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { CopyForAgent } from "./CopyForAgent.tsx";
import type { Deck, Item, Note } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { fmtDate, keyOf } from "./util.ts";
import { errorToast } from "./Toasts.tsx";
import { WorkCard, WorkPill, useWork } from "./WorkLog.tsx";

/** An action item as a follow-up: the note plus, when it came from another
 *  meeting, when that meeting was. */
export type FollowUpNote = Note & { meetingStartedAt?: number };

/** Where an action item came from, as a short label: "ENG-142", "Q3 plan: Slide 4", or the task's title. */
export function sourceLabel(itemId: string | null, items: Item[], decks: Deck[] = []): string {
  if (!itemId) return "General";
  const it = items.find((i) => i.id === itemId);
  if (!it) return "Removed item";
  const deck = it.deckId ? decks.find((d) => d.id === it.deckId) : undefined;
  if (deck) return `${deck.title}: ${keyOf(it)}`;
  return keyOf(it) ?? it.title;
}

/** Action items with a checkbox each. Checking one off is saved for the
 *  whole room and shows wherever that item appears. */
export function FollowUpList(props: {
  notes: FollowUpNote[];
  /** Persists the change. Return the saved note to show it here; return
   *  nothing when the new state arrives through props (the live room). */
  onToggle: (n: FollowUpNote, done: boolean) => Promise<Note | void> | void;
  /** Label and link for the item each action came from; omit on an item's own page. */
  source?: (n: FollowUpNote) => { label: string; href: string | null } | null;
  showDate?: boolean;
  compact?: boolean;
  /** Anything to show under an action's line, like the screenshots it backs. */
  below?: (n: FollowUpNote) => ReactNode;
  /** One line per action: no line of owner and source under it; `tail` shows at its end instead. */
  oneLine?: boolean;
  tail?: (n: FollowUpNote) => ReactNode;
  /** Shows inline right after the text, like a small pill. */
  after?: (n: FollowUpNote) => ReactNode;
  /** Makes the text a button that opens the task. */
  onOpen?: (n: FollowUpNote) => void;
  /** The task open beside the list, marked in it. */
  openId?: string | null;
  /** A class for one action's row, like "part" for a row that sits under the one above it. */
  rowClass?: (n: FollowUpNote) => string | undefined;
}) {
  const [saved, setSaved] = useState<Record<string, { note: Note; original: FollowUpNote }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const work = useWork(props.notes.map((n) => n.id));
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <ul className={["followups", props.compact && "compact", props.oneLine && "one-line"].filter(Boolean).join(" ")}>
      {props.notes.map((orig) => {
        // Once fresh server props arrive, an earlier checkbox response must not mask edits.
        const local = saved[orig.id];
        const n = local?.original === orig ? { ...orig, ...local.note } : orig;
        const done = Boolean(n.doneAt);
        // A dropped task is closed but not done: its box shows a cross, and clicking it reopens it.
        const dropped = n.state === "dropped";
        const src = props.source?.(n);
        const w = work[n.id];
        const open = opened === n.id && !!w?.log.length;
        return (
          <li key={n.id} className={[done && "done", dropped && "dropped", props.openId === n.id && "opened", props.rowClass?.(n)].filter(Boolean).join(" ") || undefined}>
            <button
              className="check"
              role="checkbox"
              aria-checked={done}
              aria-label={done ? `Reopen: ${n.text}` : `Mark done: ${n.text}`}
              title={done ? `${dropped ? "Dropped" : "Done"}${n.doneBy ? ` by ${n.doneBy}` : ""}. Click to reopen.` : "Mark done"}
              disabled={busy === n.id}
              onClick={async () => {
                setBusy(n.id);
                try {
                  const next = await props.onToggle(n, !done);
                  if (next) setSaved((s) => ({ ...s, [n.id]: { note: next, original: orig } }));
                } catch (err) {
                  errorToast(done ? "Couldn't reopen it" : "Couldn't mark it done")(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                <path d={dropped ? "M3.5 3.5l5 5M8.5 3.5l-5 5" : "M2.5 6.2 5 8.6l4.6-5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="fu-body">
              <span className="fu-text">
                {props.onOpen ? (
                  <button type="button" className="fu-open" onClick={() => props.onOpen!(n)}>
                    {n.text}
                  </button>
                ) : (
                  n.text
                )}
                {props.after?.(n)}
                {w && <WorkPill work={w} open={open} onToggle={() => setOpened(open ? null : n.id)} />}
              </span>
              {!props.oneLine && (
                <span className="fu-meta">
                  <span className={n.owner ? "fu-owner" : "fu-owner none"}>{n.owner ?? "Unassigned"}</span>
                  {src && (src.href ? <Link to={src.href}>{src.label}</Link> : <span>{src.label}</span>)}
                  {props.showDate && n.meetingStartedAt && <span>{fmtDate(n.meetingStartedAt)}</span>}
                  {done && n.doneBy && <span>Done by {n.doneBy}</span>}
                </span>
              )}
              {props.below?.(n)}
            </span>
            {props.tail?.(n)}
            <CopyForAgent kind={n.kind === "question" ? "question" : "action"} id={n.id} />
            {/* The log takes a line of its own under the row, as wide as the row. */}
            {open && <WorkCard work={w} />}
          </li>
        );
      })}
    </ul>
  );
}

/** Saves a checkbox change for an action item in a room. */
export const saveFollowUp = (roomId: string) => (n: FollowUpNote, done: boolean) => api.setFollowUp(roomId, n.id, done);

/** Where an item's Stand page is: the deck for a slide, otherwise the item's history. */
export function itemHref(itemId: string | null, items: Item[]): string | null {
  if (!itemId) return null;
  const it = items.find((i) => i.id === itemId);
  return it?.deckId ? `/decks/${it.deckId}` : `/items/${itemId}`;
}
