import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ChatRead } from "../shared/chat.ts";
import { moveRead, placeReads } from "./chatReads.ts";

const msg = (seq: number, authorId: string): ChatMessage => ({
  seq, id: `m${seq}`, channelId: "c", sessionId: "s", authorId, author: authorId, text: "", ts: seq, replyTo: null, editedAt: null, deletedAt: null, key: null,
});
const NAMES: Record<string, string> = { huy: "Huy Ngo", joe: "Joe Liang" };
const read = (userId: string, upTo: number): ChatRead => ({ userId, name: NAMES[userId], upTo });

test("a person's mark sits under the last message they have read", () => {
  const messages = [msg(10, "me"), msg(20, "me"), msg(30, "joe"), msg(40, "me")];
  const at = (...reads: ChatRead[]) => [...placeReads(messages, reads)];
  assert.deepEqual(at(read("joe", 40), read("huy", 20)), [["m20", ["Huy Ngo"]], ["m40", ["Joe Liang"]]]);
  // Two people at the same message share it, by name.
  assert.deepEqual(at(read("joe", 40), read("huy", 40)), [["m40", ["Huy Ngo", "Joe Liang"]]]);
  // A seq between two loaded messages: the one before it.
  assert.deepEqual(at(read("huy", 25)), [["m20", ["Huy Ngo"]]]);
  // Their own message: that they wrote it says they read it.
  assert.deepEqual(at(read("joe", 30)), []);
  // Read only what isn't loaded: no mark.
  assert.deepEqual(at(read("huy", 5)), []);
});

test("a mark moves forward, never back", () => {
  const reads = [read("joe", 20)];
  assert.deepEqual(moveRead(reads, read("joe", 30)), [read("joe", 30)]);
  assert.equal(moveRead(reads, read("joe", 10)), reads);
  assert.equal(moveRead(reads, read("joe", 20)), reads);
  assert.deepEqual(moveRead(reads, read("huy", 10)), [read("joe", 20), read("huy", 10)]);
});
