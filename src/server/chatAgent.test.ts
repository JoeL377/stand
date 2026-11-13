import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChatEvent, STAND_AUTHOR } from "../shared/chat.ts";
import type { ItemUpdate } from "../shared/protocol.ts";
import { Chat } from "./chat.ts";
import { ChatAsks, chatAsk, chatReports } from "./chatAgent.ts";
import { openDb } from "./db.ts";
import type { Agent } from "./llm.ts";

function setup(answer: Agent["answer"] | undefined, opts: { aDay?: number } = {}) {
  const db = openDb();
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe Liang", picture: null });
  const room = db.createRoom("Growth", joe.id);
  db.touchMembership(room.id, joe.id);
  const events: ChatEvent[] = [];
  let asks: ChatAsks | null = null;
  const chat = new Chat(db, (roomId, e) => {
    events.push(e);
    asks?.heard(roomId, e);
  });
  asks = new ChatAsks(db, chat, { answer }, (_roomId, e) => events.push(e), opts);
  const channel = db.spaceChannel(room.id, joe.id);
  const say = (text: string, replyTo?: string) => chat.accept(channel.id, [{ type: "message", author: { userId: joe.id }, text, ts: Date.now(), replyTo }]).messages[0];
  return { db, joe, room, channel, events, asks, say };
}

test("a chat message asks Stand only when it tags it", () => {
  assert.equal(chatAsk("@stand which plan has SSO?"), "which plan has SSO?");
  assert.equal(chatAsk("Good point. @Stand, what did we decide on pricing?"), "Good point. what did we decide on pricing?");
  assert.equal(chatAsk("we stand by that"), null);
  assert.equal(chatAsk("mail me at joe@standard.co"), null);
  assert.equal(chatAsk("@stand"), null);
});

test("Stand answers a tagged message in the chat, as a reply with its sources and next step, and follows up when answered", async () => {
  const prompts: string[] = [];
  const { db, channel, events, asks, say } = setup(async (prompt, onDraft, _repo, system) => {
    prompts.push(prompt);
    assert.match(system ?? "", /space's chat/);
    onDraft?.({ searches: ["sso pricing"], pages: [], partial: null });
    return {
      answer: { answer: `Answer ${prompts.length}`, sources: [{ url: "https://example.test/pricing", title: "Pricing" }], todo: "Ask sales about SSO", from_space: [] },
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 },
    };
  });
  say("We need SSO for the pilot");
  const q = say("@stand which plan has SSO?");
  await asks.idle();
  const all = db.channelMessages(channel.id);
  const a = all.at(-1)!;
  assert.deepEqual([a.authorId, a.author, a.text, a.replyTo], [STAND_AUTHOR, "Stand", "Answer 1", q.id]);
  assert.deepEqual(a.answer, { sources: [{ url: "https://example.test/pricing", title: "Pricing" }], fromSpace: [], todo: "Ask sales about SSO", todoId: null });
  assert.match(prompts[0], /Joe Liang asks you: which plan has SSO\?/);
  assert.match(prompts[0], /Joe Liang: We need SSO for the pilot/);
  // The open pages heard it coming, then that it was done, then the answer with what comes with it.
  const kinds = events.filter((e) => e.type === "answering").map((e) => (e.type === "answering" && e.done ? "done" : "going"));
  assert.deepEqual([kinds[0], kinds.at(-1)], ["going", "done"]);
  assert.ok(events.some((e) => e.type === "message" && e.message.id === a.id && e.message.answer?.todo));

  // An answer to Stand's message follows up without a tag; a plain message asks nothing.
  say("and how much is it?", a.id);
  say("thanks all");
  await asks.idle();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /You answered: Answer 1/);
  assert.equal(db.channelMessages(channel.id).at(-1)!.text, "Answer 2");
});

test("without a model, over the day's cap or when a run fails, Stand says so in a line", async () => {
  const none = setup(undefined);
  none.say("@stand hello there");
  await none.asks.idle();
  assert.match(none.db.channelMessages(none.channel.id).at(-1)!.text, /no model/);

  let n = 0;
  const capped = setup(
    async () => {
      if (++n === 1) throw new Error("boom");
      return { answer: { answer: "Fine", sources: [], todo: null, from_space: [] }, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 } };
    },
    { aDay: 2 },
  );
  for (const text of ["@stand one?", "@stand two?", "@stand three?"]) {
    capped.say(text);
    await capped.asks.idle();
  }
  const said = capped.db.channelMessages(capped.channel.id).filter((m) => m.authorId === STAND_AUTHOR).map((m) => m.text);
  assert.match(said[0], /couldn't answer/);
  assert.equal(said[1], "Fine");
  assert.match(said[2], /today/);
});

test("the chat shows agents' reports that say where a to-do stands, oldest first", () => {
  const u = (id: string, status: ItemUpdate["status"], client: string | null, ts: number): ItemUpdate => ({ id, roomId: "r", itemId: null, noteId: "n1", noteText: "Ship pricing", userName: "Joe", client, status, text: "PR is up", links: [], ts });
  assert.deepEqual(
    chatReports([u("c", "ready", "Claude Code", 3), u("b", "progress", "Claude Code", 2), u("a", "blocked", "Claude Code", 1), u("d", "done", null, 4), { ...u("e", "blocked", "Claude Code", 2), noteId: "n2" }]).map((r) => [r.id, r.status, r.by]),
    // Only the last word on each to-do.
    [
      ["e", "blocked", "Joe via Claude Code"],
      ["c", "ready", "Joe via Claude Code"],
    ],
  );
});
