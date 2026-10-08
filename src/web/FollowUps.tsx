import { useState } from "react";
import { Link } from "react-router-dom";
import { CopyForAgent } from "./CopyForAgent.tsx";
import type { Deck, Item, Note } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { fmtDate, keyOf } from "./util.ts";

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
}) {
  const [saved, setSaved] = useState<Record<string, Note>>({});
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <ul className={props.compact ? "followups compact" : "followups"}>
      {props.notes.map((orig) => {
        const n = { ...orig, ...saved[orig.id] };
        const done = Boolean(n.doneAt);
        const src = props.source?.(n);
        return (
          <li key={n.id} className={done ? "done" : undefined}>
            <button
              className="check"
              role="checkbox"
              aria-checked={done}
              aria-label={done ? `Reopen: ${n.text}` : `Mark done: ${n.text}`}
              title={done ? `Done${n.doneBy ? ` by ${n.doneBy}` : ""}. Click to reopen.` : "Mark done"}
              disabled={busy === n.id}
              onClick={async () => {
                setBusy(n.id);
                try {
                  const next = await props.onToggle(n, !done);
                  if (next) setSaved((s) => ({ ...s, [n.id]: next }));
                } finally {
                  setBusy(null);
                }
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                <path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="fu-body">
              <span className="fu-text">{n.text}</span>
              <span className="fu-meta">
                <span className={n.owner ? "fu-owner" : "fu-owner none"}>{n.owner ?? "Unassigned"}</span>
                {src && (src.href ? <Link to={src.href}>{src.label}</Link> : <span>{src.label}</span>)}
                {props.showDate && n.meetingStartedAt && <span>{fmtDate(n.meetingStartedAt)}</span>}
                {done && n.doneBy && <span>Done by {n.doneBy}</span>}
              </span>
            </span>
            <CopyForAgent kind="action" id={n.id} />
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
