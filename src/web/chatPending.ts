// What you sent that the server hasn't saved yet: it shows in the thread at once, under your name,
// and stays as "Not sent" if the send fails, so nothing you wrote is lost.
import type { ChatMessage } from "../shared/chat.ts";

export interface PendingMessage {
  /** The key the send goes out with. The saved message carries it back (ChatMessage.key). */
  key: string;
  text: string;
  ts: number;
  state: "sending" | "failed";
  /** The message it answers. */
  replyTo?: string | null;
}

/** The ones not saved yet: a saved message with the same key, from the send's answer or the stream, takes its place. */
export function unsaved(pending: PendingMessage[], messages: ChatMessage[]): PendingMessage[] {
  if (!pending.length) return pending;
  const saved = new Set(messages.flatMap((m) => (m.key ? [m.key] : [])));
  const left = pending.filter((p) => !saved.has(p.key));
  return left.length === pending.length ? pending : left;
}

export const pendingId = (key: string) => `pending:${key}`;

/** A pending send as a row of the thread: after every saved message, in the order it was sent. */
export function asMessage(p: PendingMessage, me: { id: string; name: string }, channelId: string): ChatMessage {
  return {
    seq: Number.MAX_SAFE_INTEGER,
    id: pendingId(p.key),
    channelId,
    // In no session, so nothing Stand caught is placed under it.
    sessionId: "",
    authorId: me.id,
    author: me.name,
    text: p.text,
    ts: p.ts,
    replyTo: p.replyTo ?? null,
    editedAt: null,
    deletedAt: null, reactions: [],
    key: p.key,
  };
}

/** Runs each task after the one before it has finished, failed or not, so sends are saved in the order they were made. */
export function serial() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = last.then(task, task);
    last = run.catch(() => {});
    return run;
  };
}

/** What a reload brings back: each one not sent yet, to send again by hand. */
export function restore(raw: string | null): PendingMessage[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.flatMap((p) =>
      p && typeof p.key === "string" && typeof p.text === "string" && typeof p.ts === "number"
        ? [{ key: p.key, text: p.text, ts: p.ts, state: "failed" as const, replyTo: typeof p.replyTo === "string" ? p.replyTo : null }]
        : [],
    );
  } catch {
    return [];
  }
}
