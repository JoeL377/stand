// Where what Stand caught from chat sits in the thread: each line under the message it came from,
// and what a closed session was about after its last message.
import type { CaughtLine, ChatCaught, ChatMessage } from "../shared/chat.ts";

export interface PlacedCaught {
  /** By message id: the lines to show under it. */
  lines: Map<string, CaughtLine[]>;
  /** By message id: the session that ended with it, with its summary and topics. */
  recaps: Map<string, ChatCaught>;
}

/** `messages` are the ones loaded, oldest first. A line whose message isn't known (the session is
 *  still open, or the message isn't loaded) sits after the last message written when Stand caught it. */
export function placeCaught(messages: ChatMessage[], caught: ChatCaught[], openSessionId: string | null): PlacedCaught {
  const out: PlacedCaught = { lines: new Map(), recaps: new Map() };
  for (const c of caught) {
    const own = messages.filter((m) => m.sessionId === c.sessionId);
    if (!own.length) continue;
    for (const line of c.lines) {
      const at = own.find((m) => m.id === line.messageId) ?? own.findLast((m) => m.ts <= line.ts) ?? own[0];
      out.lines.set(at.id, [...(out.lines.get(at.id) ?? []), line]);
    }
    if (c.sessionId !== openSessionId && (c.summary || c.topics.length)) out.recaps.set(own[own.length - 1].id, c);
  }
  return out;
}

/** Agents' reports, each under the last message written before it. One from before the oldest message here is left out. */
export function placeReports<R extends { ts: number }>(messages: ChatMessage[], reports: R[]): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const r of reports) {
    const at = messages.findLast((m) => m.ts <= r.ts);
    if (at) out.set(at.id, [...(out.get(at.id) ?? []), r]);
  }
  return out;
}

/** What was caught, with newer reads of a session in place of older ones. */
export function mergeCaught(before: ChatCaught[], fresh: ChatCaught[]): ChatCaught[] {
  const ids = new Set(fresh.map((c) => c.sessionId));
  return [...before.filter((c) => !ids.has(c.sessionId)), ...fresh];
}
