import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { asMessage, restore, serial, unsaved, type PendingMessage } from "./chatPending.ts";

const saved = (id: string, key: string | null): ChatMessage => ({
  seq: 1, id, channelId: "c", sessionId: "s", authorId: "u", author: "Joe Liang", text: id, ts: 1, replyTo: null, editedAt: null, deletedAt: null, reactions: [], key,
});
const pending = (key: string, state: PendingMessage["state"] = "sending"): PendingMessage => ({ key, text: key, ts: 5, state });

test("a saved message with the same key takes the place of what was pending, whichever way it comes first", () => {
  const list = [pending("k1"), pending("k2"), pending("k3", "failed")];
  // The stream brings k2 before its send answers, then the answer to k1 comes.
  const afterEcho = unsaved(list, [saved("m2", "k2")]);
  assert.deepEqual(afterEcho.map((p) => p.key), ["k1", "k3"]);
  assert.deepEqual(unsaved(afterEcho, [saved("m2", "k2"), saved("m1", "k1")]).map((p) => p.key), ["k3"]);
  // Nothing changed: the same list, so React keeps it.
  assert.equal(unsaved(list, [saved("x", null), saved("y", "other")]), list);
});

test("a pending send shows as your message, after the saved ones and in no session", () => {
  const m = asMessage(pending("k1"), { id: "u", name: "Joe Liang" }, "c");
  assert.deepEqual([m.id, m.author, m.authorId, m.sessionId, m.key, m.seq], ["pending:k1", "Joe Liang", "u", "", "k1", Number.MAX_SAFE_INTEGER]);
});

test("after a reload, what wasn't sent comes back to send again by hand", () => {
  const kept = JSON.stringify([pending("k1"), pending("k2", "failed"), { key: 3 }, null]);
  assert.deepEqual(restore(kept).map((p) => [p.key, p.state]), [["k1", "failed"], ["k2", "failed"]]);
  assert.deepEqual(restore(null), []);
  assert.deepEqual(restore("{"), []);
  assert.deepEqual(restore('{"key":"k"}'), []);
});

test("sends go out one at a time, in order, and one that fails doesn't stop the next", async () => {
  const run = serial();
  const order: string[] = [];
  const later = (name: string, ms: number, fail = false) => () =>
    new Promise<string>((resolve, reject) => setTimeout(() => (order.push(name), fail ? reject(new Error(name)) : resolve(name)), ms));
  const results = await Promise.allSettled([run(later("first", 30)), run(later("second", 1, true)), run(later("third", 1))]);
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
});
