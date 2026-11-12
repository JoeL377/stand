import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import type { ChatCaught, ChatEvent, ChatMessage, ChatThread } from "../shared/chat.ts";
import { requireUser } from "./auth.ts";
import { Chat } from "./chat.ts";
import { openDb } from "./db.ts";
import { unreadChatMentions } from "./mentions.ts";
import { chatRoutes } from "./routes/chat.ts";
import type { Services } from "./services.ts";
import { SpaceEvents } from "./spaceEvents.ts";

async function setup() {
  const db = openDb();
  const [joe, huy, eve] = ["Joe Liang", "Huy Ngo", "Eve Adams"].map((name) =>
    db.upsertUser({ googleSub: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, name, picture: null }),
  );
  const room = db.createRoom("Growth", joe.id);
  for (const u of [joe, huy]) db.touchMembership(room.id, u.id);
  const spaceEvents = new SpaceEvents();
  const chat = new Chat(db, (roomId, e) => spaceEvents.send(roomId, e));
  const app = express();
  app.use(express.json());
  app.use("/api", requireUser(db));
  chatRoutes(app, { db, chat, spaceEvents } as Services);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const as = (user: { id: string }) => {
    const cookie = `standup_session=${db.createSession(user.id).id}`;
    return async <T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await fetch(base + url, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as T };
    };
  };
  /** The space's event stream as this person's page reads it: next() gives the next event. */
  const stream = async (user: { id: string }) => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/rooms/${room.id}/events`, { headers: { cookie: `standup_session=${db.createSession(user.id).id}` }, signal: ctl.signal });
    const reader = res.body!.getReader();
    let buf = "";
    const next = async (): Promise<ChatEvent> => {
      for (;;) {
        const m = /^data: (.*)\n\n/m.exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += new TextDecoder().decode(value);
      }
    };
    return { res, next, close: () => ctl.abort() };
  };
  const close = () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  return { db, joe, huy, eve, room, spaceEvents, as, stream, close };
}

test("people in a space send, read, change and delete its chat; nobody else gets in", async () => {
  const { db, joe, huy, eve, room, as, close } = await setup();
  const [j, h, e] = [as(joe), as(huy), as(eve)];
  try {
    const opened = await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`);
    assert.equal(opened.status, 200);
    assert.deepEqual([opened.body.channel.source, opened.body.messages, opened.body.readUpTo], ["stand", [], 0]);
    assert.deepEqual(opened.body.people.map((p) => p.name), ["Huy Ngo", "Joe Liang"]);
    const channel = opened.body.channel.id;

    // Someone who isn't in the space: no chat, no messages, no stream, no sending.
    assert.equal((await e("GET", `/api/rooms/${room.id}/chat`)).status, 404);
    assert.equal((await e("GET", `/api/channels/${channel}/messages`)).status, 404);
    assert.equal((await e("GET", `/api/rooms/${room.id}/events`)).status, 404);
    assert.equal((await e("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Let me in" })).status, 404);
    assert.equal((await e("POST", `/api/channels/${channel}/read`, { upTo: 1 })).status, 404);

    // A send that is tried again gives the same message back.
    const key = "3f6c1a52-9d0e-4b7a-8c11-5e2f0a9b7d43";
    const sent = await j<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Can we ship Friday?", key });
    assert.deepEqual([sent.status, sent.body.author, sent.body.text], [200, "Joe Liang", "Can we ship Friday?"]);
    assert.equal((await j<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Can we ship Friday?", key })).body.id, sent.body.id);
    // The message carries its key, so the page that sent it knows it when the stream brings it first.
    assert.equal(sent.body.key, key);
    assert.equal((await j("POST", `/api/rooms/${room.id}/chat/messages`, { text: "  " })).status, 400);
    const reply = await h<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Yes", replyTo: sent.body.id });
    assert.equal(reply.body.replyTo, sent.body.id);
    assert.equal(reply.body.key, null);

    // Joe wrote the first and hasn't seen the second. Huy sent the second, so he has read up to it.
    assert.deepEqual([db.unreadChat(joe.id).get(room.id), db.unreadChat(huy.id).get(room.id), db.unreadChat(eve.id).size], [1, undefined, 0]);
    const thread = await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`);
    assert.deepEqual(thread.body.messages.map((m) => m.text), ["Can we ship Friday?", "Yes"]);
    assert.deepEqual(thread.body.sessions.map((s) => [s.id, s.messages]), [[sent.body.sessionId, 2]]);
    assert.equal(thread.body.readUpTo, sent.body.seq);
    // Reading never goes past the last message, or back.
    assert.deepEqual((await j("POST", `/api/channels/${channel}/read`, { upTo: 10_000 })).body, { readUpTo: reply.body.seq });
    assert.deepEqual((await j("POST", `/api/channels/${channel}/read`, { upTo: 0 })).body, { readUpTo: reply.body.seq });
    assert.equal((await j("POST", `/api/channels/${channel}/read`, { upTo: "x" })).status, 400);
    assert.equal(db.unreadChat(joe.id).size, 0);

    // Pages by seq.
    assert.deepEqual((await h<{ messages: ChatMessage[] }>("GET", `/api/channels/${channel}/messages?after=${sent.body.seq}`)).body.messages.map((m) => m.text), ["Yes"]);
    assert.deepEqual((await h<{ messages: ChatMessage[] }>("GET", `/api/channels/${channel}/messages?before=${reply.body.seq}`)).body.messages.map((m) => m.text), ["Can we ship Friday?"]);

    // Only its author changes or deletes a message.
    assert.equal((await h("PATCH", `/api/chat/messages/${sent.body.id}`, { text: "No" })).status, 403);
    assert.equal((await h("DELETE", `/api/chat/messages/${sent.body.id}`)).status, 403);
    assert.equal((await e("PATCH", `/api/chat/messages/${sent.body.id}`, { text: "No" })).status, 404);
    assert.equal((await j("PATCH", `/api/chat/messages/${sent.body.id}`, { text: " " })).status, 400);
    const edited = await j<ChatMessage>("PATCH", `/api/chat/messages/${sent.body.id}`, { text: "Can we ship Monday?" });
    assert.equal(edited.body.text, "Can we ship Monday?");
    assert.ok(edited.body.editedAt);
    const gone = await j<ChatMessage>("DELETE", `/api/chat/messages/${sent.body.id}`);
    assert.equal(gone.body.text, "");
    assert.ok(gone.body.deletedAt);
    assert.equal((await j("DELETE", "/api/chat/messages/nope")).status, 404);
  } finally {
    await close();
  }
});

test("an unread chat message that tags you counts as a mention in that space until you read it", async () => {
  const { db, joe, huy, room, as, close } = await setup();
  const [j, h] = [as(joe), as(huy)];
  try {
    const channel = (await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.channel.id;
    // Joe's own message never tags him (and sending reads what came before it).
    await j("POST", `/api/rooms/${room.id}/chat/messages`, { text: "note to self @Joe Liang" });
    await h("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Morning all" });
    await h("POST", `/api/rooms/${room.id}/chat/messages`, { text: "@Joe can you look at the deploy?" });
    await h("POST", `/api/rooms/${room.id}/chat/messages`, { text: "mail joe@example.test, cc @Huy Ngo" });
    // A deleted message doesn't count.
    const gone = await h<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "@Joe Liang never mind" });
    await h("DELETE", `/api/chat/messages/${gone.body.id}`);
    assert.equal(unreadChatMentions(db, joe.id).get(room.id), 1);
    assert.equal(unreadChatMentions(db, huy.id).size, 0, "Huy wrote the message that tags him");

    const last = (await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.messages.at(-1)!;
    await j("POST", `/api/channels/${channel}/read`, { upTo: last.seq });
    assert.equal(unreadChatMentions(db, joe.id).size, 0);
  } finally {
    await close();
  }
});

test("a page with the space's stream open hears each message, edit and delete as it is saved", async () => {
  const { huy, joe, room, spaceEvents, as, stream, close } = await setup();
  const s = await stream(huy);
  try {
    assert.equal(s.res.headers.get("content-type"), "text/event-stream");
    assert.equal(spaceEvents.watching(room.id), 1);
    const sent = (await as(joe)<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Deploy is out" })).body;
    assert.deepEqual(await s.next(), { type: "session", channelId: sent.channelId, sessionId: sent.sessionId, open: true });
    assert.deepEqual(await s.next(), { type: "message", message: sent });
    await as(joe)("PATCH", `/api/chat/messages/${sent.id}`, { text: "Deploy is out, all green" });
    const edited = await s.next();
    assert.equal(edited.type === "message" && edited.message.text, "Deploy is out, all green");
    await as(joe)("DELETE", `/api/chat/messages/${sent.id}`);
    const gone = await s.next();
    assert.equal(gone.type === "message" && gone.message.deletedAt !== null, true);
    // The page goes away: its stream is forgotten.
    s.close();
    for (let i = 0; i < 50 && spaceEvents.watching(room.id); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(spaceEvents.watching(room.id), 0);
  } finally {
    s.close();
    await close();
  }
});

test("the thread says how far the others have read, and an open page hears when one of them reads on", async () => {
  const { joe, huy, room, as, stream, close } = await setup();
  const [j, h] = [as(joe), as(huy)];
  const s = await stream(joe);
  try {
    const first = (await j<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "Deploy is out" })).body;
    const second = (await j<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "All green" })).body;
    for (let i = 0; i < 3; i++) await s.next();
    // Huy hasn't opened it. Joe has read what he sent, which the thread tells Huy and not Joe himself.
    assert.deepEqual((await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.reads, []);
    assert.deepEqual((await h<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.reads, [{ userId: joe.id, name: "Joe Liang", upTo: second.seq }]);

    await h("POST", `/api/channels/${first.channelId}/read`, { upTo: first.seq });
    assert.deepEqual(await s.next(), { type: "read", channelId: first.channelId, userId: huy.id, name: "Huy Ngo", upTo: first.seq });
    assert.deepEqual((await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.reads, [{ userId: huy.id, name: "Huy Ngo", upTo: first.seq }]);
    // Reading the same again, or less, tells nobody: the next thing heard is the read that moved on.
    await h("POST", `/api/channels/${first.channelId}/read`, { upTo: first.seq });
    await h("POST", `/api/channels/${first.channelId}/read`, { upTo: 0 });
    await h("POST", `/api/channels/${first.channelId}/read`, { upTo: second.seq });
    assert.deepEqual(await s.next(), { type: "read", channelId: first.channelId, userId: huy.id, name: "Huy Ngo", upTo: second.seq });
    assert.deepEqual((await j<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.reads, [{ userId: huy.id, name: "Huy Ngo", upTo: second.seq }]);
  } finally {
    s.close();
    await close();
  }
});

test("what Stand caught from chat comes with the thread; anyone in the space removes a line that isn't one, and it doesn't come back", async () => {
  const { db, joe, huy, eve, room, as, stream, close } = await setup();
  const [j, h, e] = [as(joe), as(huy), as(eve)];
  const s = await stream(huy);
  try {
    const sent = (await j<ChatMessage>("POST", `/api/rooms/${room.id}/chat/messages`, { text: "I will send the invoice. We ship on Friday." })).body;
    await s.next();
    await s.next();
    // Nothing caught yet: the thread says so by leaving the session out.
    assert.deepEqual((await h<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body.caught, []);
    assert.deepEqual((await h<ChatCaught>("GET", `/api/chat/sessions/${sent.sessionId}/caught`)).body, { sessionId: sent.sessionId, summary: null, topics: [], lines: [] });

    // As a capture run leaves it.
    const [todo, started, decision] = db.syncNotes(sent.sessionId, null, [
      { kind: "action", text: "Send the invoice", owner: "Joe Liang" },
      { kind: "action", text: "Book the venue", owner: "Huy Ngo" },
      { kind: "decision", text: "Ship on Friday", owner: null },
    ]);
    db.setTaskState(room.id, started.id, { state: "doing", by: "Huy Ngo" });
    const thread = (await h<ChatThread>("GET", `/api/rooms/${room.id}/chat`)).body;
    assert.deepEqual(thread.caught.map((c) => [c.sessionId, c.lines.map((l) => `${l.kind}: ${l.text}`)]), [[sent.sessionId, ["action: Send the invoice", "action: Book the venue", "decision: Ship on Friday"]]]);
    assert.deepEqual((await h<{ caught: ChatCaught[] }>("GET", `/api/channels/${sent.channelId}/messages`)).body.caught, thread.caught);

    // Only people in the space read or remove what was caught, and only what came from chat.
    assert.equal((await e("GET", `/api/chat/sessions/${sent.sessionId}/caught`)).status, 404);
    assert.equal((await e("DELETE", `/api/chat/caught/${decision.id}`)).status, 404);
    const meeting = db.startMeeting(room.id);
    const [spoken] = db.syncNotes(meeting.id, null, [{ kind: "decision", text: "Use Stripe", owner: null }]);
    db.endMeeting(meeting.id, null);
    assert.equal((await h("DELETE", `/api/chat/caught/${spoken.id}`)).status, 404);
    assert.equal((await h("GET", `/api/chat/sessions/${meeting.id}/caught`)).status, 404);

    // Huy removes Joe's decision: gone for everyone, the open page is told, and a later run can't write it again.
    assert.deepEqual((await h("DELETE", `/api/chat/caught/${decision.id}`)).body, { removed: decision.id });
    assert.deepEqual(await s.next(), { type: "notes", channelId: sent.channelId, sessionId: sent.sessionId });
    assert.deepEqual(db.spaceNotes(room.id, "decision").map((n) => n.text), ["Use Stripe"]);
    assert.deepEqual(db.dismissedNotes(sent.sessionId, null), [{ kind: "decision", text: "Ship on Friday" }]);
    assert.equal((await h("DELETE", `/api/chat/caught/${decision.id}`)).status, 404);

    // A to-do someone took up is closed on the Tasks tab, not deleted from under them.
    const refused = await j<{ error: string }>("DELETE", `/api/chat/caught/${started.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Tasks tab/);
    assert.equal((await j("DELETE", `/api/chat/caught/${todo.id}`)).status, 200);
    assert.deepEqual(db.meetingNotes(sent.sessionId).map((n) => n.text), ["Book the venue"]);
  } finally {
    s.close();
    await close();
  }
});
