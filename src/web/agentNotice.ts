// Which cards from people's own agents this screen has not seen yet, for the notice that tells about
// them while the board is out of view (Stage.tsx). Kept on the screen only: the server keeps nothing.
import type { AgentCard } from "../shared/protocol.ts";

/** How long the notice stays up after a card arrives on this screen. */
export const NOTICE_MS = 60_000;

/** A card someone's own agent put in the call by itself (say_in_call), with nobody asking it there. */
export const isSaid = (c: AgentCard) => !!c.agent && c.kind === "answer" && !c.question;

/** The cards from agents that are on the board now: ready and not dismissed. */
export const saidOnBoard = (cards: AgentCard[] | null | undefined) => (cards ?? []).filter((c) => isSaid(c) && c.status === "ready" && !c.dismissed);

/**
 * What the notice shows. `seen`: the cards this screen has had in view (or had when it opened);
 * `arrived`: when each card first came to this screen, on its own clock. `unseen` counts every card
 * not seen yet (for the mark on the Board tab); `card` is the newest one that came in the last
 * NOTICE_MS and wasn't closed (`closed`: × on the notice, which leaves the cards unseen), and `more`
 * the other unseen ones.
 */
export function saidNotice(cards: AgentCard[] | null | undefined, seen: ReadonlySet<string>, arrived: ReadonlyMap<string, number>, now: number, closed: ReadonlySet<string> = new Set()) {
  const unseen = saidOnBoard(cards)
    .filter((c) => !seen.has(c.id))
    .sort((a, b) => a.at - b.at);
  const recent = unseen.filter((c) => !closed.has(c.id) && now - (arrived.get(c.id) ?? now) < NOTICE_MS);
  const card = recent.at(-1) ?? null;
  const ends = card ? (arrived.get(card.id) ?? now) + NOTICE_MS : null;
  return { unseen: unseen.length, card, more: card ? unseen.length - 1 : 0, ends };
}

/** The first line of what an agent said, without its markdown. */
export function saidLine(c: AgentCard, max = 80): string {
  const line = (c.note ?? "").split("\n").find((l) => l.trim()) ?? "";
  const plain = line.replace(/^[#>\-*\s]+/, "").replace(/[*_`]/g, "").trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
