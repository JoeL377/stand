import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import express from "express";
import type { Note } from "../shared/protocol.ts";
import { agentApi } from "./agents.ts";
import { requireUser } from "./auth.ts";
import { openDb } from "./db.ts";
import { taskRoutes } from "./routes/tasks.ts";
import type { Services } from "./services.ts";
import { UploadLinks } from "./workLog.ts";

async function setup() {
  const db = openDb(":memory:");
  const [joe, huy, eve] = ["Joe Liang", "Huy Ngo", "Eve Adams"].map((name) =>
    db.upsertUser({ googleSub: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, name, picture: null }),
  );
  const room = db.createRoom("Growth", joe.id);
  for (const u of [joe, huy]) db.touchMembership(room.id, u.id);
  const m = db.startMeeting(room.id);
  const [action, question] = db.syncNotes(m.id, null, [
    { kind: "action", text: "Ship the pricing page", owner: "Joe" },
    { kind: "question", text: "Who signs off on pricing?", owner: null },
  ]);
  db.endMeeting(m.id, null);
  const notified: string[] = [];
  const agents = agentApi({
    db,
    notify: (r, what) => notified.push(`${r}:${what}`),
    brief: (id) => ({ meeting: id }),
    suggested: () => ({}) as never,
    uploads: new UploadLinks(),
  });
  const app = express();
  app.use(express.json());
  app.use("/api", requireUser(db));
  taskRoutes(app, { db, agents, sessions: new Map(), doneDecks: { schedule: () => {} } } as unknown as Services);
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
  const close = () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  return { db, joe, huy, eve, room, action, question, notified, as, close };
}

test("people in a space give a to-do to someone, or leave it unassigned; nobody else can", async () => {
  const { db, huy, eve, room, action, question, notified, as, close } = await setup();
  const [h, e] = [as(huy), as(eve)];
  const url = (id: string) => `/api/rooms/${room.id}/tasks/${id}/owner`;
  try {
    const given = await h<Note>("PATCH", url(action.id), { owner: "  Huy   Ngo " });
    assert.equal(given.status, 200);
    assert.equal(given.body.owner, "Huy Ngo");
    assert.equal(db.getNote(action.id)?.owner, "Huy Ngo");
    assert.equal(db.getNote(action.id)?.text, "Ship the pricing page");
    assert.deepEqual(notified, [`${room.id}:followups`]);

    // The same owner again changes nothing and is not an error.
    assert.equal((await h<Note>("PATCH", url(action.id), { owner: "Huy Ngo" })).status, 200);
    assert.equal(notified.length, 1);

    const cleared = await h<Note>("PATCH", url(action.id), { owner: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.owner, null);

    assert.equal((await h("PATCH", url(action.id), { owner: 7 })).status, 400);
    assert.equal((await h("PATCH", url(action.id), { owner: "a".repeat(81) })).status, 400);
    // Only to-dos have an owner to give; an open question is anyone's.
    assert.equal((await h("PATCH", url(question.id), { owner: "Huy Ngo" })).status, 404);
    // Someone outside the space can't, and a to-do of another space isn't found through this one.
    assert.equal((await e("PATCH", url(action.id), { owner: "Eve Adams" })).status, 404);
    const other = db.createRoom("Other", huy.id);
    db.touchMembership(other.id, huy.id);
    assert.equal((await h("PATCH", `/api/rooms/${other.id}/tasks/${action.id}/owner`, { owner: "Huy Ngo" })).status, 404);
    assert.equal(db.getNote(action.id)?.owner, null);
  } finally {
    await close();
  }
});
