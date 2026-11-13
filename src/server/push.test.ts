import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import http2 from "node:http2";
import { test } from "node:test";
import type { ChatEvent } from "../shared/chat.ts";
import type { PushMessage } from "../shared/push.ts";
import { Apns, DeviceGone } from "./apns.ts";
import { Chat } from "./chat.ts";
import { openDb } from "./db.ts";
import type { PushDevice } from "./db/push.ts";
import { Push, chatPayload } from "./push.ts";

const TOKEN = (n: number) => String(n).repeat(64).slice(0, 64);

function setup(opts: { fail?: (d: PushDevice) => Error | null } = {}) {
  const db = openDb();
  const [joe, huy, janesh] = ["Joe Liang", "Huy Ngo", "Janesh Chhabra"].map((name) =>
    db.upsertUser({ googleSub: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, name, picture: null }),
  );
  const room = db.createRoom("Conxt 1.0", joe.id);
  for (const u of [joe, huy, janesh]) db.touchMembership(room.id, u.id);
  const sent: Array<{ to: string; m: PushMessage }> = [];
  const push = new Push(db, {}, {
    waitMs: 0,
    send: async (d, m) => {
      const err = opts.fail?.(d);
      if (err) throw err;
      sent.push({ to: d.userId, m });
    },
  });
  const events: ChatEvent[] = [];
  const chat = new Chat(db, (_roomId, e) => events.push(e));
  const channel = db.spaceChannel(room.id, joe.id);
  const say = (user: { id: string }, text: string, replyTo?: string) =>
    chat.accept(channel.id, [{ type: "message", author: { userId: user.id }, text, ts: Date.now(), replyTo }]).messages[0];
  const run = () => push.notifyChannel(room.id, channel.id);
  return { db, joe, huy, janesh, room, channel, push, sent, say, run, events };
}

test("a new message notifies everyone in the space with a phone, except who wrote it", async () => {
  const t = setup();
  t.db.savePushDevice({ token: TOKEN(1), userId: t.joe.id, env: "production" });
  t.db.savePushDevice({ token: TOKEN(2), userId: t.janesh.id, env: "sandbox" });
  t.say(t.janesh, "Review is looking sick");
  await t.run();
  assert.deepEqual(t.sent.map((s) => s.to), [t.joe.id], "Janesh wrote it; Huy has no phone");
  assert.deepEqual(t.sent[0].m, { title: "Conxt 1.0", body: "Janesh Chhabra: Review is looking sick", url: `/s/${t.room.id}?chat=1`, tag: `chat-${t.room.id}` });
});

test("nothing for a message you have read, and each message is told once", async () => {
  const t = setup();
  t.db.savePushDevice({ token: TOKEN(1), userId: t.joe.id, env: "production" });
  const m = t.say(t.janesh, "one")!;
  t.db.markChannelRead(t.channel.id, t.joe.id, m.seq);
  await t.run();
  assert.equal(t.sent.length, 0, "Joe had the chat open");
  t.say(t.janesh, "two");
  await t.run();
  await t.run();
  assert.equal(t.sent.length, 1);
});

test("a burst folds into one notification with the newest message and a count", async () => {
  const t = setup();
  t.db.savePushDevice({ token: TOKEN(1), userId: t.joe.id, env: "production" });
  t.say(t.janesh, "one");
  t.say(t.huy, "two");
  t.say(t.janesh, "three");
  await t.run();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].m.body, "Janesh Chhabra: three\n+2 more messages");
});

test("a space set to mentions notifies only for @mentions and replies to you", async () => {
  const t = setup();
  t.db.savePushDevice({ token: TOKEN(1), userId: t.joe.id, env: "production" });
  t.db.setChatNotify(t.room.id, t.joe.id, "mentions");
  t.say(t.janesh, "just talking");
  await t.run();
  assert.equal(t.sent.length, 0);
  t.say(t.janesh, "@Joe can you look?");
  await t.run();
  assert.equal(t.sent.length, 1);
  const mine = t.say(t.joe, "Merged it");
  t.say(t.huy, "nice", mine!.id);
  await t.run();
  assert.equal(t.sent.length, 2, "a reply to Joe reaches him");
  t.db.setChatNotify(t.room.id, t.joe.id, "all");
  assert.equal(t.db.chatNotify(t.room.id, t.joe.id), "all");
});

test("a phone Apple says is gone is forgotten; other errors keep it", async () => {
  const t = setup({ fail: (d) => (d.token === TOKEN(1) ? new DeviceGone("Unregistered") : d.token === TOKEN(2) ? new Error("APNs 500") : null) });
  t.db.savePushDevice({ token: TOKEN(1), userId: t.joe.id, env: "production" });
  t.db.savePushDevice({ token: TOKEN(2), userId: t.joe.id, env: "production" });
  t.say(t.janesh, "hello");
  await t.run();
  assert.deepEqual(t.db.pushDevices(t.joe.id).map((d) => d.token), [TOKEN(2)]);
});

test("heard() waits, then sends once for a burst; edits and other events start nothing", async () => {
  const t = setup();
  t.db.savePushDevice({ token: TOKEN(1), userId: t.joe.id, env: "production" });
  const push = new Push(t.db, {}, { waitMs: 20, send: async (d, m) => void t.sent.push({ to: d.userId, m }) });
  t.say(t.janesh, "a");
  t.say(t.janesh, "b");
  for (const e of t.events) push.heard(t.room.id, e);
  push.heard(t.room.id, { type: "notes", channelId: t.channel.id, sessionId: "x" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].m.body, /\+1 more message$/);
  push.stop();
});

test("no key, no sending", () => {
  const db = openDb();
  assert.equal(new Push(db, {}).enabled, false);
});

test("long messages are cut", () => {
  const p = chatPayload("S", "r", [{ author: "A", text: "x".repeat(400) } as never], 1);
  assert.ok(p.body.length < 200 && p.body.endsWith("…"));
});

test("APNs: a signed request in Apple's shape, and a gone phone said so", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const seen: http2.IncomingHttpHeaders[] = [];
  const bodies: string[] = [];
  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    seen.push(headers);
    let b = "";
    stream.on("data", (d) => (b += d));
    stream.on("end", () => {
      bodies.push(b);
      const gone = String(headers[":path"]).endsWith(TOKEN(9));
      stream.respond({ ":status": gone ? 410 : 200 });
      stream.end(gone ? JSON.stringify({ reason: "Unregistered" }) : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const apns = new Apns({ key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "studio.conxt.stand" });
  // Point both of Apple's hosts at the local server.
  (apns as unknown as { session: (env: string) => http2.ClientHttp2Session }).session = (() => {
    const s = http2.connect(`http://127.0.0.1:${port}`);
    return () => s;
  })();
  const m = { title: "Conxt 1.0", body: "Janesh: hi", url: "/s/r?chat=1", tag: "chat-r" };
  await apns.send({ token: TOKEN(1), env: "production" }, m);
  await assert.rejects(apns.send({ token: TOKEN(9), env: "production" }, m), DeviceGone);
  const h = seen[0];
  assert.equal(h[":path"], `/3/device/${TOKEN(1)}`);
  assert.equal(h["apns-topic"], "studio.conxt.stand");
  assert.equal(h["apns-collapse-id"], "chat-r");
  assert.deepEqual(JSON.parse(bodies[0]), { aps: { alert: { title: "Conxt 1.0", body: "Janesh: hi" }, sound: "default", "thread-id": "chat-r" }, url: "/s/r?chat=1" });
  const [head, claims, sig] = String(h.authorization).replace("bearer ", "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "ES256", kid: "ABC123DEFG" });
  assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).iss, "TEAM123456");
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
  apns.close();
  (apns as unknown as { session: (e: string) => http2.ClientHttp2Session }).session("production").close();
  await new Promise<void>((r) => server.close(() => r()));
});
