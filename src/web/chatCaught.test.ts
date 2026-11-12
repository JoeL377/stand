import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaughtLine, ChatCaught, ChatMessage } from "../shared/chat.ts";
import { mergeCaught, placeCaught } from "./chatCaught.ts";

const msg = (id: string, sessionId: string, ts: number): ChatMessage => ({
  seq: ts, id, channelId: "c", sessionId, authorId: "u", author: "Joe Liang", text: id, ts, replyTo: null, editedAt: null, deletedAt: null, key: null,
});
const line = (id: string, ts: number, messageId: string | null = null): CaughtLine => ({ id, kind: "action", text: id, owner: null, closed: false, messageId, ts });
const caught = (sessionId: string, lines: CaughtLine[], summary: string | null = null): ChatCaught => ({ sessionId, summary, topics: summary ? [{ id: "t", topic: "Topic", outcome: "action" }] : [], lines });
const ids = (m: Map<string, CaughtLine[]>) => [...m].map(([at, lines]) => [at, lines.map((l) => l.id)]);

test("a caught line sits under the message it came from, or after the last one written when it was caught", () => {
  const messages = [msg("a", "s1", 10), msg("b", "s1", 20), msg("c", "s1", 30), msg("d", "s2", 100)];
  const placed = placeCaught(messages, [caught("s1", [line("quoted", 35, "a"), line("live", 25), line("late", 99), line("early", 5)]), caught("s2", [line("other", 101)])], "s2");
  assert.deepEqual(ids(placed.lines), [["a", ["quoted", "early"]], ["b", ["live"]], ["c", ["late"]], ["d", ["other"]]]);
  // A message that isn't loaded: the line still shows, by when it was caught.
  assert.deepEqual(ids(placeCaught(messages.slice(1), [caught("s1", [line("quoted", 35, "a")])], null).lines), [["c", ["quoted"]]]);
  // A session with no message loaded shows nothing.
  assert.deepEqual(ids(placeCaught(messages.slice(3), [caught("s1", [line("x", 25)])], null).lines), []);
});

test("a closed session ends with what it was about; one still open does not", () => {
  const messages = [msg("a", "s1", 10), msg("b", "s1", 20), msg("c", "s2", 100)];
  const placed = placeCaught(messages, [caught("s1", [], "They agreed."), caught("s2", [], "Going on.")], "s2");
  assert.deepEqual([...placed.recaps].map(([at, c]) => [at, c.summary]), [["b", "They agreed."]]);
  // Nothing came of it: nothing to show.
  assert.equal(placeCaught(messages, [caught("s1", [line("x", 15)])], null).recaps.size, 0);
});

test("a newer read of a session replaces the older one", () => {
  const merged = mergeCaught([caught("s1", [line("old", 1)]), caught("s2", [])], [caught("s1", [line("new", 2)])]);
  assert.deepEqual(merged.map((c) => [c.sessionId, c.lines.map((l) => l.id)]), [["s2", []], ["s1", ["new"]]]);
});
