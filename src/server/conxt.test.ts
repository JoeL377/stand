import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { openDb, type DB } from "./db.ts";
import { ConxtDelivery, conxtRoutes, parseDestinations, type ConxtDestination } from "./conxt.ts";
import { requireUser } from "./auth.ts";

const integration = "2198de80-af06-4b54-90e3-5f4232c43e93";
const destination: ConxtDestination = { key: "product", label: "Team / Product", token: "secret-integration-token",
  submissionUrl: `https://conxt.test/api/v1/integrations/${integration}/sources` };
function setup(file?: string) {
  const db = openDb(file);
  const owner = db.upsertUser({ googleSub: null, email: "owner@example.test", name: "Owner", picture: null });
  const guest = db.upsertUser({ googleSub: null, email: "guest@example.test", name: "Guest", picture: null });
  const outsider = db.upsertUser({ googleSub: null, email: "outsider@example.test", name: "Outsider", picture: null });
  const room = db.createRoom("Planning", owner.id);
  for (const user of [owner, guest]) db.touchMembership(room.id, user.id);
  return { db, owner, guest, outsider, room };
}
function connect(db: DB, roomId: string, userId: string, d = destination) {
  const id = randomUUID();
  db.raw.prepare("INSERT INTO conxt_connections VALUES (?,?,?,?,?,?,?,1)")
    .run(id, roomId, d.key, d.submissionUrl, d.label, userId, Date.now());
  return id;
}
function completed(db: DB, roomId: string, content = "We chose PostgreSQL.") {
  const meeting = db.startMeeting(roomId);
  db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: "alice", speakerName: "Alice", kind: "speech", text: content, ts: meeting.startedAt });
  db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: "bob", speakerName: "Bob", kind: "chat", text: "Confirmed", ts: meeting.startedAt + 1 });
  db.endMeeting(meeting.id, "Generated summary must not replace the transcript");
  return meeting;
}
function receipt(payload: Record<string, unknown>, status = "queued", id = randomUUID()) {
  return { id, integration_id: integration, external_id: payload.external_id, external_revision: payload.external_revision, status };
}
function due(db: DB) { db.raw.prepare("UPDATE conxt_deliveries SET next_at=0").run(); }

 test("destination configuration rejects widening URLs and duplicate keys", () => {
  assert.deepEqual(parseDestinations(undefined), []);
  assert.deepEqual(parseDestinations(JSON.stringify([destination])), [destination]);
  for (const patch of [{ submissionUrl: "http://conxt.test/sources" }, { submissionUrl: destination.submissionUrl + "?secret=1" },
    { submissionUrl: destination.submissionUrl.replace("https://", "https://user:pass@") }, { token: "secret\r\nheader" }]) {
    assert.throws(() => parseDestinations(JSON.stringify([{ ...destination, ...patch }])));
  }
  assert.throws(() => parseDestinations(JSON.stringify([destination, destination])));
});

test("only meetings started while explicitly connected enter the atomic outbox", () => {
  const { db, owner, room } = setup();
  const historical = completed(db, room.id);
  const inProgress = db.startMeeting(room.id);
  connect(db, room.id, owner.id);
  db.endMeeting(inProgress.id, null);
  const future = completed(db, room.id);
  new ConxtDelivery(db, []).reconcile();
  const rows = db.raw.prepare("SELECT meeting_id,payload FROM conxt_deliveries").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meeting_id, future.id);
  assert.notEqual(rows[0].meeting_id, historical.id);
  const body = JSON.parse(rows[0].payload as string);
  assert.match(body.content, /Alice \(speech\): We chose PostgreSQL/);
  assert.match(body.content, /Bob \(chat\): Confirmed/);
  assert.doesNotMatch(body.content, /Generated summary/);
  assert.match(body.id, /^[a-f0-9-]{36}$/);
  assert.match(body.external_revision, /^[a-f0-9]{64}$/);
  db.endMeeting(future.id, "Retry finalization");
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_deliveries").get()?.n, 1);
  db.raw.close();
});

test("network ambiguity and restart retry the same immutable delivery, then poll a fixed URL", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stand-conxt-"));
  const file = path.join(dir, "stand.db");
  let { db, owner, room } = setup(file);
  connect(db, room.id, owner.id); completed(db, room.id);
  let original = "";
  let worker = new ConxtDelivery(db, [destination], (async (_url, init) => {
    original = String(init?.body); throw new Error("socket lost after remote accepted");
  }) as typeof fetch);
  await worker.tick();
  db.raw.close(); db = openDb(file); due(db);
  let accepted: ReturnType<typeof receipt>;
  worker = new ConxtDelivery(db, [destination], (async (url, init) => {
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, `Bearer ${destination.token}`);
    assert.equal(init?.redirect, "error");
    if (init?.method === "POST") {
      assert.equal(init.body, original);
      accepted = receipt(JSON.parse(original));
      return Response.json({ receipt: accepted, status_path: "https://evil.test/steal-credential" });
    }
    assert.equal(url, `${destination.submissionUrl}/${accepted.id}`);
    return Response.json({ ...accepted, status: "ready" });
  }) as typeof fetch);
  await worker.tick(); due(db); await worker.tick();
  assert.equal(db.raw.prepare("SELECT state FROM conxt_deliveries").get()?.state, "ready");
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_deliveries").get()?.n, 1);
  db.raw.close(); rmSync(dir, { recursive: true });
});

test("expired leases recover and stale workers cannot overwrite confirmed delivery", async () => {
  const { db, owner, room } = setup(); connect(db, room.id, owner.id); completed(db, room.id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new ConxtDelivery(db, [destination], (async (_url, init) => {
    await gate; return Response.json({ receipt: receipt(JSON.parse(String(init?.body))) });
  }) as typeof fetch);
  const running = first.tick();
  db.raw.prepare("UPDATE conxt_deliveries SET lease_until=0").run();
  const second = new ConxtDelivery(db, [destination], (async (_url, init) =>
    Response.json({ receipt: receipt(JSON.parse(String(init?.body)), "ready") })) as typeof fetch);
  await second.tick(); release(); await running;
  assert.equal(db.raw.prepare("SELECT state FROM conxt_deliveries").get()?.state, "ready"); db.raw.close();
});

test("destination changes pause old work without rerouting, oversized unicode is not sent", async () => {
  const { db, owner, room } = setup(); connect(db, room.id, owner.id); completed(db, room.id);
  let calls = 0;
  const send = (async () => { calls++; throw new Error("must not send"); }) as typeof fetch;
  await new ConxtDelivery(db, [{ ...destination, submissionUrl: destination.submissionUrl.replace("conxt.test", "another.test") }], send).tick();
  assert.equal(calls, 0); assert.equal(db.raw.prepare("SELECT state FROM conxt_deliveries").get()?.state, "failed");
  completed(db, room.id, "😀".repeat(70_000));
  await new ConxtDelivery(db, [destination], send).tick();
  assert.equal(calls, 0);
  assert.match(String(db.raw.prepare("SELECT error FROM conxt_deliveries ORDER BY rowid DESC LIMIT 1").get()?.error), /250 KB/);
  db.raw.close();
});

test("HTTP rejection is safe, rate limits retry and mismatched receipts are not accepted", async () => {
  const { db, owner, room } = setup(); connect(db, room.id, owner.id); completed(db, room.id);
  const rejection = new ConxtDelivery(db, [destination], (async () => new Response("secret echoed", { status: 401 })) as typeof fetch);
  await rejection.tick();
  const row = db.raw.prepare("SELECT state,error FROM conxt_deliveries").get()!;
  assert.equal(row.state, "failed"); assert.doesNotMatch(String(row.error), /secret/);
  db.raw.prepare("UPDATE conxt_deliveries SET state='queued',next_at=0").run();
  await new ConxtDelivery(db, [destination], (async () => new Response("rate limited", { status: 429 })) as typeof fetch).tick();
  assert.equal(db.raw.prepare("SELECT state FROM conxt_deliveries").get()?.state, "queued"); due(db);
  await new ConxtDelivery(db, [destination], (async (_url, init) => Response.json({ receipt: { ...receipt(JSON.parse(String(init?.body))), external_id: "wrong" } })) as typeof fetch).tick();
  assert.equal(db.raw.prepare("SELECT receipt_id FROM conxt_deliveries").get()?.receipt_id, null); db.raw.close();
});

test("room routes require membership, owner consent and same-origin writes; never return secrets", async () => {
  const { db, owner, guest, outsider, room } = setup();
  const app = express(); app.use(express.json()); app.use(requireUser(db));
  app.use("/api/rooms/:id/conxt", conxtRoutes(db, [destination]));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = [owner, guest, outsider].map(u => `standup_session=${db.createSession(u.id).id}`);
  const request = (cookie: string, method = "GET", body?: unknown, reqOrigin = base) => fetch(`${base}/api/rooms/${room.id}/conxt`, {
    method, headers: { cookie, origin: reqOrigin, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request(cookies[2])).status, 404);
    const body = { destinationKey: destination.key, confirmedTeamAccess: true };
    assert.equal((await request(cookies[1], "POST", body)).status, 403);
    assert.equal((await request(cookies[0], "POST", body, "https://evil.test")).status, 403);
    assert.equal((await request(cookies[0], "POST", { ...body, confirmedTeamAccess: false })).status, 400);
    assert.equal((await request(cookies[0], "POST", body)).status, 200);
    const connection = db.raw.prepare("SELECT id FROM conxt_connections WHERE enabled=1").get()?.id;
    assert.equal((await request(cookies[0], "POST", body)).status, 200);
    assert.equal(db.raw.prepare("SELECT id FROM conxt_connections WHERE enabled=1").get()?.id, connection);
    completed(db, room.id);
    const text = await (await request(cookies[1])).text();
    assert.doesNotMatch(text, /secret-integration-token|submissionUrl|payload/);
    assert.equal(JSON.parse(text).deliveries.length, 1);
    assert.equal((await request(cookies[0], "DELETE")).status, 200);
    let calls = 0;
    await new ConxtDelivery(db, [destination], (async () => { calls++; throw new Error(); }) as typeof fetch).tick();
    assert.equal(calls, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.raw.close(); }
});


test("finalization and queue commit together; reconciliation recovers a missed enqueue", () => {
  const { db, owner, room } = setup(); connect(db, room.id, owner.id);
  const meeting = db.startMeeting(room.id);
  db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: "alice", speakerName: "Alice",
                  kind: "speech", text: "A durable decision", ts: meeting.startedAt });
  db.raw.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON conxt_deliveries BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => db.endMeeting(meeting.id, "Summary"));
  assert.equal(db.raw.prepare("SELECT ended_at FROM meetings WHERE id=?").get(meeting.id)?.ended_at, null);
  db.raw.exec("DROP TRIGGER reject_delivery");
  db.raw.prepare("UPDATE meetings SET ended_at=? WHERE id=?").run(Date.now(), meeting.id);
  new ConxtDelivery(db, []).reconcile();
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_deliveries").get()?.n, 1);
  db.raw.close();
});

test("remote processing failure remains visible and later Conxt retry is observed", async () => {
  const { db, owner, room } = setup(); connect(db, room.id, owner.id); completed(db, room.id);
  let saved: ReturnType<typeof receipt>;
  let calls = 0;
  const worker = new ConxtDelivery(db, [destination], (async (_url, init) => {
    calls++;
    if (init?.method === "POST") saved = receipt(JSON.parse(String(init.body)), "failed");
    return Response.json(init?.method === "POST" ? { receipt: saved } : { ...saved, status: "ready" });
  }) as typeof fetch);
  await worker.tick();
  assert.equal(db.raw.prepare("SELECT state FROM conxt_deliveries").get()?.state, "failed");
  due(db); await worker.tick();
  assert.equal(calls, 2);
  assert.equal(db.raw.prepare("SELECT state FROM conxt_deliveries").get()?.state, "ready"); db.raw.close();
});


test("finalized synthesis carries exact discussion evidence and holds tasks and unsupported decisions", () => {
  const { db, owner, room } = setup();
  connect(db, room.id, owner.id);
  const meeting = db.startMeeting(room.id);
  const first = db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: "a", speakerName: "Alice", kind: "speech", text: "Launch Friday?", ts: meeting.startedAt });
  const last = db.addSegment({ meetingId: meeting.id, itemId: null, speakerId: "b", speakerName: "Bob", kind: "speech", text: "😀 Agreed Monday instead.\r\nAlice will do QA.", ts: meeting.startedAt + 1 });
  const [discussion] = db.replaceDiscussions(meeting.id, null, [{ topic: "Launch", outcome: "decided", positions: [], segmentIds: [first.id, last.id], continuesId: null }]);
  db.replaceNotes(meeting.id, null, [
    { kind: "decision", text: "Launch Monday.", owner: null, discussionId: discussion.id },
    { kind: "action", text: "Run QA.", owner: "Alice", discussionId: discussion.id },
    { kind: "decision", text: "Use Redis.", owner: null, discussionId: null },
    { kind: "question", text: "What next?", owner: null, discussionId: discussion.id },
  ]);
  db.endMeeting(meeting.id, "Launch rescheduled.", "Monday after QA.");
  const row = db.raw.prepare("SELECT payload FROM conxt_deliveries WHERE meeting_id=?").get(meeting.id)!;
  const payload = JSON.parse(row.payload as string);
  assert.equal(payload.synthesis.summary, "Launch rescheduled.");
  assert.equal(payload.synthesis.narrative, "Monday after QA.");
  assert.equal(payload.synthesis.items.length, 4);
  const decision = payload.synthesis.items.find((i: { content: string }) => i.content === "Launch Monday.");
  assert.equal(decision.disposition, "settled");
  assert.deepEqual(decision.evidence.map((e: { turn_id: string }) => e.turn_id), [first.id, last.id]);
  assert.equal(decision.evidence[1].quote, "😀 Agreed Monday instead.\nAlice will do QA.");
  for (const e of decision.evidence) assert.ok(payload.content.includes(e.quote));
  assert.equal(payload.synthesis.items.find((i: { primitive: string }) => i.primitive === "task").owner, "Alice");
  assert.equal(payload.synthesis.items.find((i: { content: string }) => i.content === "Use Redis.").disposition, "unresolved");
  assert.equal(payload.synthesis.items.find((i: { primitive: string }) => i.primitive === "question").disposition, "unresolved");
  db.endMeeting(meeting.id, "Changed summary");
  assert.equal(db.raw.prepare("SELECT payload FROM conxt_deliveries WHERE meeting_id=?").get(meeting.id)!.payload, row.payload);
  db.raw.close();
});
