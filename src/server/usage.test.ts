import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { requireUser } from "./auth.ts";
import { openDb } from "./db.ts";
import { HeuristicAgent } from "./llm.ts";
import { brainstormRoutes } from "./routes/brainstorms.ts";
import { deckRoutes } from "./routes/decks.ts";
import { costRange, spaceRoutes } from "./routes/spaces.ts";
import type { Services } from "./services.ts";
import { costOf, forSpace, metered, recordUsage, setUsageSink, type UsageRow } from "./usage.ts";

/** Runs `fn` with usage rows caught in the list it's given; the sink is put back after. */
async function catching(fn: (rows: UsageRow[]) => unknown) {
  const rows: UsageRow[] = [];
  setUsageSink((r) => rows.push(r));
  try {
    await fn(rows);
  } finally {
    setUsageSink(null);
  }
}
const spend = () => recordUsage("claude-sonnet-5-5", { input_tokens: 10, output_tokens: 2 });

test("a call is priced by its model, cache reads cheap and cache writes at 1.25x input", () => {
  const usd = costOf({ model: "claude-sonnet-5-5", input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 });
  assert.equal(usd.toFixed(2), (2 + 0.2 + 2.5 + 10).toFixed(2));
  assert.equal(costOf({ model: "claude-haiku-5-5", input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }).toFixed(2), "0.60");
  // An unknown model is priced high rather than free.
  assert.ok(costOf({ model: "something-new", input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }) >= 4);
});

test("calls through a metered agent count against its meeting and task, across awaits", () => catching(async (rows) => {
  let spent = 0;
  const agent = {
    async boardCard() {
      await new Promise((r) => setTimeout(r, 5));
      recordUsage("claude-sonnet-5-5", { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 });
      return "ok";
    },
    other: undefined as undefined | (() => void),
  };
  const m = metered(agent, "meet1", () => spent++);
  assert.equal(await m.boardCard(), "ok");
  assert.equal(m.other, undefined);
  // Outside any meeting.
  recordUsage("claude-opus-5-5", { input_tokens: 1, output_tokens: 1 });
  assert.deepEqual(
    rows.map((r) => [r.meetingId, r.task, r.model, r.input, r.cacheRead, r.output]),
    [
      ["meet1", "boardCard", "claude-sonnet-5-5", 10, 5, 2],
      [null, "other", "claude-opus-5-5", 1, 0, 1],
    ],
  );
  assert.equal(spent, 1);
}));

test("a call for a space has the space and its method's name, and keeps the meeting it was made in", () => catching(async (rows) => {
  const agent = {
    async suggestProjects() {
      await new Promise((r) => setTimeout(r, 2));
      spend();
    },
    async recapMeeting() {
      // A pass for the space started from inside a meeting's call stays that meeting's.
      await forSpace(agent, "room1").suggestProjects();
    },
    designSeed: undefined as undefined | (() => Promise<void>),
  };
  await forSpace(agent, "room1").suggestProjects();
  await metered(agent, "meet1").recapMeeting();
  assert.equal(forSpace(agent, "room1").designSeed, undefined);
  assert.deepEqual(
    rows.map((r) => [r.meetingId, r.roomId, r.task]),
    [
      [null, "room1", "suggestProjects"],
      ["meet1", null, "recapMeeting"],
    ],
  );
}));

test("a pass a timer starts once a meeting's write-up is done is the space's, not the meeting's", () => catching(async (rows) => {
  const agent = {
    async recapMeeting() {
      spend();
    },
    async suggestProjects() {
      spend();
    },
  };
  // The shape of a meeting's end: the recap is awaited, then the project pass is scheduled.
  async function end() {
    await metered(agent, "meet1").recapMeeting();
    await new Promise<void>((done) => setTimeout(() => void forSpace(agent, "room1").suggestProjects().then(done), 0));
  }
  await end();
  assert.deepEqual(
    rows.map((r) => [r.meetingId, r.roomId, r.task]),
    [
      ["meet1", null, "recapMeeting"],
      [null, "room1", "suggestProjects"],
    ],
  );
}));

const usage = (r: Partial<UsageRow>): UsageRow => ({ meetingId: null, roomId: null, task: "other", model: "claude-sonnet-5-5", input: 0, cacheRead: 0, cacheWrite: 0, output: 0, at: 0, ...r });

test("llm_usage gets each call's space on an older database: meeting rows take their meeting's, the rest stay unknown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stand-usage-"));
  const file = path.join(dir, "stand.db");
  let db = openDb(file);
  const room = db.createRoom("Old");
  const m = db.startMeeting(room.id);
  // As an older version left it: no room_id column, one row in a meeting and one between meetings.
  db.raw.exec("DROP INDEX llm_usage_room; ALTER TABLE llm_usage DROP COLUMN room_id;");
  const insert = db.raw.prepare("INSERT INTO llm_usage (meeting_id, task, model, input, cache_read, cache_write, output, at) VALUES (?, ?, 'claude-sonnet-5-5', 1, 0, 0, 1, 1)");
  insert.run(m.id, "recapMeeting");
  insert.run(null, "doneDeck");
  db.raw.close();
  db = openDb(file);
  try {
    const read = () => db.raw.prepare("SELECT task, room_id FROM llm_usage ORDER BY rowid").all().map((r) => [r.task, r.room_id]);
    assert.deepEqual(read(), [
      ["recapMeeting", room.id],
      ["doneDeck", null],
    ]);
    assert.ok((db.raw.prepare("PRAGMA index_list(llm_usage)").all() as Array<{ name: string }>).some((i) => i.name === "llm_usage_room"));
    db.raw.close();
    db = openDb(file);
    assert.deepEqual(read(), [
      ["recapMeeting", room.id],
      ["doneDeck", null],
    ], "running again changes nothing");
    // A new row in a meeting takes the meeting's space; one between meetings keeps its own.
    db.addUsage(usage({ meetingId: m.id, task: "boardCard" }));
    db.addUsage(usage({ roomId: room.id, task: "polishAgenda" }));
    assert.deepEqual(read().slice(2), [
      ["boardCard", room.id],
      ["polishAgenda", room.id],
    ]);
  } finally {
    db.raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("what a space spent: by group and pass, priced by model, by day in the viewer's time, only its own rows in the range", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  const other = db.createRoom("Other");
  const call = db.startMeeting(room.id);
  const chat = "chat1";
  db.raw.prepare("INSERT INTO meetings (id, room_id, started_at, ended_at, kind) VALUES (?, ?, 0, 0, 'chat')").run(chat, room.id);
  const day = Date.UTC(2026, 10, 9);
  const h = 3_600_000;
  const M = 1_000_000;
  // Opus 5.5: $4 in, $20 out a million. Haiku 5.5: $0.10 in, $0.50 out.
  db.addUsage(usage({ meetingId: call.id, task: "recapMeeting", model: "claude-opus-5-5", input: M, at: day + 10 * h }));
  db.addUsage(usage({ meetingId: call.id, task: "boardCard", model: "claude-haiku-5-5", output: M, at: day + 11 * h }));
  db.addUsage(usage({ meetingId: chat, task: "notesFor", model: "claude-haiku-5-5", input: M, at: day + 12 * h }));
  db.addUsage(usage({ roomId: room.id, task: "suggestProjects", model: "claude-opus-5-5", output: M, at: day + 13 * h }));
  // 23:30 UTC: the next day an hour east of UTC.
  db.addUsage(usage({ roomId: room.id, task: "suggestProjects", model: "claude-haiku-5-5", output: M, at: day + 23.5 * h }));
  db.addUsage(usage({ roomId: room.id, task: "doneDeck", model: "claude-opus-5-5", input: M, at: day + 2 * 24 * h + h }));
  // Not this space's, not known, and outside the range.
  db.addUsage(usage({ roomId: other.id, task: "doneDeck", input: M, at: day + h }));
  db.addUsage(usage({ task: "doneDeck", input: M, at: day + h }));
  db.addUsage(usage({ roomId: room.id, task: "doneDeck", input: M, at: day - h }));
  db.addUsage(usage({ roomId: room.id, task: "doneDeck", input: M, at: day + 4 * 24 * h }));

  const since = day - h; // 00:00 on the 9th, an hour east of UTC
  const until = day + 4 * 24 * h - h; // 00:00 on the 13th, there
  const cost = db.spaceCost(room.id, { since, until, dayOffsetMin: 60 });
  const round = (n: number) => Math.round(n * 1000) / 1000;
  assert.deepEqual([round(cost.usd), cost.calls], [31.1, 7]);
  assert.deepEqual(
    cost.groups.map((g) => [g.where, round(g.usd), g.calls, g.tasks.map((t) => [t.task, round(t.usd), t.calls])]),
    [
      ["between", 26.5, 4, [["suggestProjects", 20.5, 2], ["doneDeck", 6, 2]]],
      ["calls", 4.5, 2, [["recapMeeting", 4, 1], ["boardCard", 0.5, 1]]],
      ["chat", 0.1, 1, [["notesFor", 0.1, 1]]],
    ],
  );
  assert.deepEqual(
    cost.days.map((d) => [d.day, round(d.usd), d.calls, round(d.between)]),
    [
      ["2026-11-09", 4 + 0.5 + 0.1 + 20 + 2, 5, 22],
      ["2026-11-10", 0.5, 1, 0.5],
      ["2026-11-11", 4, 1, 4],
      ["2026-11-12", 0, 0, 0],
    ],
  );
  // In UTC the 23:30 call stays on the 9th.
  assert.deepEqual(db.spaceCost(room.id, { since: day, until: day + 2 * 24 * h, dayOffsetMin: 0 }).days.map((d) => [d.day, d.calls]), [
    ["2026-11-09", 5],
    ["2026-11-10", 0],
  ]);
  const empty = db.spaceCost(other.id, { since: day + 2 * h, until: day + 3 * h, dayOffsetMin: 0 });
  assert.deepEqual([empty.usd, empty.calls, empty.groups, empty.days], [0, 0, [], [{ day: "2026-11-09", usd: 0, calls: 0, between: 0 }]]);
});

test("a deck drafted from a brief and a design session seeded from notes are kept with their space", () => catching(async (rows) => {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe Liang", picture: null });
  const room = db.createRoom("Growth", joe.id);
  db.touchMembership(room.id, joe.id);
  const agent = Object.assign(new HeuristicAgent(), {
    draftDeck: async () => (spend(), []),
    designSeed: async () => (spend(), null),
  });
  const app = express();
  app.use(express.json());
  app.use("/api", requireUser(db));
  deckRoutes(app, { db, agent, afterItemsChange: () => [], parentFor: () => null } as unknown as Services);
  brainstormRoutes(app, { db, agent, sessions: new Map() } as unknown as Services);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookie = `standup_session=${db.createSession(joe.id).id}`;
  const post = async (url: string, body: unknown) => {
    const res = await fetch(base + url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const made = await post(`/api/rooms/${room.id}/decks/new`, { brief: "Signups dipped on Tuesday", title: "Signups" });
    assert.equal(made.status, 200);
    assert.equal((await post(`/api/decks/${made.body.deck.id}/draft`, { brief: "Two more slides" })).status, 200);
    assert.equal((await post(`/api/rooms/${room.id}/brainstorm/start`, { prompt: "Signup flow", design: { seed: "People sign up, then confirm their email." } })).status, 200);
    assert.deepEqual(
      rows.map((r) => [r.meetingId, r.roomId, r.task]),
      [
        [null, room.id, "draftDeck"],
        [null, room.id, "draftDeck"],
        [null, room.id, "designSeed"],
      ],
    );
  } finally {
    await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  }
}));

test("the cost range is whole days in the viewer's time, up to now, clamped", () => {
  const h = 3_600_000;
  const midnight = Date.UTC(2026, 10, 12) - h; // 00:00 on Nov 12, an hour east of UTC
  const day = (at: number) => new Date(at + h).toISOString().slice(0, 10);
  // Asked at that midnight: 7 whole days, today the last.
  const r = costRange("7", "60", midnight);
  assert.deepEqual([r.since, r.until, r.dayOffsetMin], [midnight - 6 * 24 * h, midnight + 1, 60]);
  const db = openDb(":memory:");
  const room = db.createRoom("Shop");
  const days = db.spaceCost(room.id, r).days.map((d) => d.day);
  assert.deepEqual([days.length, days[0], days.at(-1)], [7, day(midnight - 6 * 24 * h), "2026-11-12"]);
  // A minute before it: the 11th is today.
  assert.equal(db.spaceCost(room.id, costRange(7, 60, midnight - 60_000)).days.at(-1)!.day, "2026-11-11");
  for (const r of [costRange(undefined, undefined, midnight), costRange("abc", "x", midnight)]) {
    assert.equal(r.dayOffsetMin, 0);
    assert.equal(db.spaceCost(room.id, r).days.length, 30);
  }
  assert.equal(costRange(500, 2000, midnight).dayOffsetMin, 840);
  assert.equal(costRange(0, -2000, midnight).dayOffsetMin, -840);
  assert.equal(db.spaceCost(room.id, costRange(500, 0, midnight)).days.length, 90);
  assert.equal(db.spaceCost(room.id, costRange(0, 0, midnight)).days.length, 1);
  assert.equal(db.spaceCost(room.id, costRange("7.9", 0, midnight)).days.length, 7);
});

test("only a space's admins get what it spent; a member is refused as on the other manage routes, someone outside gets not found", async () => {
  const db = openDb(":memory:");
  const [joe, huy, eve] = ["Joe Liang", "Huy Ngo", "Eve Adams"].map((name) =>
    db.upsertUser({ googleSub: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, name, picture: null }),
  );
  const room = db.createRoom("Growth", joe.id);
  for (const u of [joe, huy]) db.touchMembership(room.id, u.id);
  db.addUsage(usage({ roomId: room.id, task: "doneDeck", model: "claude-opus-5-5", input: 1_000_000, at: Date.now() - 60_000 }));
  const app = express();
  app.use(express.json());
  app.use("/api", requireUser(db));
  spaceRoutes(app, { db, sessions: new Map() } as unknown as Services);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (user: { id: string }, url: string) => {
    const res = await fetch(base + url, { headers: { cookie: `standup_session=${db.createSession(user.id).id}` } });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    const now = Date.now();
    const got = await get(joe, `/api/rooms/${room.id}/cost?days=7&tz=60`);
    assert.equal(got.status, 200);
    assert.deepEqual([got.body.usd, got.body.calls, got.body.groups.map((g: { where: string }) => g.where)], [4, 1, ["between"]]);
    const day = (at: number) => new Date(at + 3_600_000).toISOString().slice(0, 10);
    assert.deepEqual([got.body.days.length, got.body.days[0].day, got.body.days.at(-1).day], [7, day(now - 6 * 86_400_000), day(now)]);
    assert.equal((await get(joe, `/api/rooms/${room.id}/cost?days=900`)).body.days.length, 90);
    assert.equal((await get(joe, `/api/rooms/${room.id}/cost?days=-3`)).body.days.length, 1);
    assert.equal((await get(joe, `/api/rooms/${room.id}/cost`)).body.days.length, 30);
    // As changing its admins answers them.
    const member = await get(huy, `/api/rooms/${room.id}/cost`);
    const admins = await fetch(`${base}/api/rooms/${room.id}/members/${huy.id}`, {
      method: "PUT",
      headers: { cookie: `standup_session=${db.createSession(huy.id).id}`, "content-type": "application/json" },
      body: JSON.stringify({ admin: true }),
    });
    assert.deepEqual([member.status, admins.status], [403, 403]);
    assert.match(member.body.error, /^Only an admin of this space can /);
    assert.match(((await admins.json()) as { error: string }).error, /^Only an admin of this space can /);
    assert.deepEqual(await get(eve, `/api/rooms/${room.id}/cost`), { status: 404, body: { error: "Space not found" } });
  } finally {
    await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  }
});
