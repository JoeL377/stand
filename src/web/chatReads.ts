// Where each person's read mark sits in the thread: under the last message they have read.
import type { ChatMessage, ChatRead } from "../shared/chat.ts";

/** By message id: the names of the people who have read up to that message and no further, by name.
 *  `messages` are the ones loaded, oldest first, and `reads` the other people's. Nobody's mark sits
 *  under their own message (that they wrote it says as much), and one before the oldest message
 *  loaded doesn't show. */
export function placeReads(messages: ChatMessage[], reads: ChatRead[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of [...reads].sort((a, b) => a.name.localeCompare(b.name))) {
    const at = messages.findLast((m) => m.seq <= r.upTo);
    if (!at || at.authorId === r.userId) continue;
    out.set(at.id, [...(out.get(at.id) ?? []), r.name]);
  }
  return out;
}

/** The marks with one person's moved on. A mark never moves back. */
export function moveRead(reads: ChatRead[], to: ChatRead): ChatRead[] {
  const was = reads.find((r) => r.userId === to.userId);
  if (was && was.upTo >= to.upTo) return reads;
  return [...reads.filter((r) => r.userId !== to.userId), to];
}
