import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { agentApi } from "./agents.ts";
import { openDb } from "./db.ts";
import { HeuristicAgent } from "./llm.ts";
import { handleMcp } from "./mcp.ts";
import { RoomSession } from "./room.ts";
import { upNextView } from "./upNextPolish.ts";
import { UploadLinks } from "./workLog.ts";
import type { ServerMessage, User } from "../shared/protocol.ts";

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  got: ServerMessage[] = [];
  send(data: string) {
    this.got.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
const say = async (ws: FakeSocket, msg: unknown) => {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
  await new Promise((r) => setImmediate(r));
};

test("over HTTP, wait_for_ask holds the request until the person asks in the call, then answers with the ask", async () => {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const room = db.createRoom("Checkout v2", joe.id);
  db.touchMembership(room.id, joe.id);
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  const api = agentApi({
    db,
    notify: () => {},
    brief: () => ({}),
    suggested: (r) => upNextView(db, r, null),
    uploads: new UploadLinks(),
    call: () =>
      session.isEnded
        ? null
        : {
            meetingId: session.meetingId,
            startedAt: session.meetingStartedAt,
            people: session.state().participants.map((p) => p.name),
            tail: (since) => session.tail(since),
            say: (actor, out, askId) => session.agentSay(actor, out, askId),
            wait: (actor, ms, signal) => session.waitForAsk(actor, ms, signal),
          },
  });
  const caller = { user: joe, token: { id: "tok1", label: "opencode", scope: "write" as const, hint: "x", createdAt: 0, lastUsedAt: null } };
  const app = express().use(express.json());
  app.post("/mcp", (req, res) => void handleMcp(req, res, api, caller, "https://stand.test"));
  const server = app.listen(0);
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url));

  const ws = new FakeSocket();
  session.attach(ws as never, { ...joe, picture: null } as User);
  await say(ws, { type: "hello" });

  const tools = await client.listTools();
  assert.ok(tools.tools.some((x) => x.name === "wait_for_ask"));

  const started = Date.now();
  const waiting = client.callTool({ name: "wait_for_ask", arguments: { space: "Checkout", timeout_s: 20 } });
  await new Promise((r) => setTimeout(r, 150));
  await say(ws, { type: "chat", text: "@agent which plan has SSO?" });
  const res = (await waiting) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.ok(!res.isError, res.content[0]?.text);
  assert.ok(Date.now() - started < 5_000, "it returns when the ask comes, not when the hold ends");
  const got = JSON.parse(res.content[0].text);
  assert.equal(got.question, "which plan has SSO?");
  assert.match(got.call.cursor, new RegExp(`^${session.meetingId}:`));

  const answer = (await client.callTool({ name: "say_in_call", arguments: { space: room.id, text: "Enterprise has SSO.", ask_id: got.ask_id } })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.ok(!answer.isError, answer.content[0]?.text);
  const cards = ws.got.filter((m) => m.type === "agent").at(-1);
  assert.equal(cards?.type === "agent" && cards.cards.find((c) => c.id === got.ask_id)?.note, "Enterprise has SSO.");

  // A wait the client cancels (Escape in opencode) ends at once, so no ask goes to a wait nobody reads.
  const ac = new AbortController();
  const cancelled = client.callTool({ name: "wait_for_ask", arguments: { space: room.id, timeout_s: 20 } }, undefined, { signal: ac.signal }).catch(() => "cancelled");
  await new Promise((r) => setTimeout(r, 100));
  const own = () => (session as unknown as { ownAgents: Map<string, { wait: unknown }> }).ownAgents.get(joe.id);
  assert.ok(own()?.wait, "the wait is open");
  ac.abort();
  assert.equal(await cancelled, "cancelled");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(own()?.wait, null);

  await client.close();
  await session.end();
  server.close();
});
