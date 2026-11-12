import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import express from "express";
import { requireUser } from "./auth.ts";
import { conxtRoutes } from "./conxt.ts";
import { openDb } from "./db.ts";
import { sourceRoutes } from "./routes/sources.ts";
import { spaceRoutes } from "./routes/spaces.ts";
import type { Services } from "./services.ts";
import { toSpaceSummary } from "./spaces.ts";

function setup() {
  const db = openDb(":memory:");
  const person = (name: string) => db.upsertUser({ googleSub: null, email: `${name.toLowerCase()}@example.test`, name, picture: null });
  const [joe, ann, sam, outsider] = ["Joe", "Ann", "Sam", "Outsider"].map(person);
  const room = db.createRoom("Checkout v2", joe.id);
  for (const u of [joe, ann, sam]) db.touchMembership(room.id, u.id);
  return { db, joe, ann, sam, outsider, room };
}

test("space admins: the creator always manages, an admin does once made one, and entering again keeps the role", () => {
  const { db, joe, ann, sam, outsider, room } = setup();
  assert.equal(db.managesSpace(room, joe.id), true);
  assert.equal(db.managesSpace(room, ann.id), false);
  assert.equal(db.setAdmin(room.id, outsider.id, true), false, "not in the space");
  assert.equal(db.managesSpace(room, outsider.id), false);

  assert.equal(db.setAdmin(room.id, ann.id, true), true);
  db.touchMembership(room.id, ann.id);
  assert.equal(db.managesSpace(room, ann.id), true);
  assert.equal(db.managesSpace(room, sam.id), false);
  assert.deepEqual(
    db.spaceMembers(room, ann.id).map((m) => [m.name, m.role, m.you]),
    [["Joe", "creator", false], ["Ann", "admin", true], ["Sam", "member", false]],
  );
  const summary = (userId: string, name: string) => toSpaceSummary(db.spaceRows(userId)[0], { id: userId, name }, null);
  assert.deepEqual([summary(joe.id, "Joe").mine, summary(joe.id, "Joe").canManage], [true, true]);
  assert.deepEqual([summary(ann.id, "Ann").mine, summary(ann.id, "Ann").canManage], [false, true]);
  assert.equal(summary(sam.id, "Sam").canManage, false);

  assert.equal(db.setAdmin(room.id, ann.id, false), true);
  assert.equal(db.managesSpace(room, ann.id), false);
  // An older space with no creator: anyone in it manages it, as before.
  assert.equal(db.managesSpace(db.createRoom("Old space"), sam.id), true);
});

test("space admins over HTTP: admins rename the space, manage its repos and Conxt, and choose the admins", async () => {
  const { db, joe, ann, sam, outsider, room } = setup();
  const app = express();
  app.use(express.json());
  app.use(requireUser(db));
  spaceRoutes(app, { db, sessions: new Map() } as unknown as Services);
  sourceRoutes(app, { db, githubApp: null, sources: { list: () => [], unlink: () => false } } as unknown as Services);
  app.use("/api/rooms/:id/conxt", conxtRoutes(db, []));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const as = (user: { id: string }) => {
    const cookie = `standup_session=${db.createSession(user.id).id}`;
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}/api/rooms/${room.id}${path}`, {
        method,
        headers: { cookie, origin: base, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
  };
  const [asJoe, asAnn, asSam, asOutsider] = [joe, ann, sam, outsider].map(as);
  try {
    assert.equal((await asOutsider("GET", "/members")).status, 404);
    const before = await asAnn("GET", "/members");
    assert.equal(before.body.canManage, false);
    assert.deepEqual(before.body.members.map((m: { name: string; role: string }) => `${m.name}: ${m.role}`), ["Joe: creator", "Ann: member", "Sam: member"]);
    assert.doesNotMatch(JSON.stringify(before.body), /example\.test/, "no email addresses");

    // Someone who isn't an admin can't change anything.
    assert.equal((await asAnn("PUT", `/members/${ann.id}`, { admin: true })).status, 403);
    assert.equal((await asAnn("PATCH", "", { name: "Ann's space" })).status, 403);
    assert.equal((await asAnn("GET", "/sources")).body.canManage, false);
    assert.equal((await asAnn("DELETE", "/sources/JoeL377/stand")).status, 403);
    assert.equal((await asAnn("GET", "/conxt")).body.canManage, false);
    assert.equal((await asAnn("DELETE", "/conxt")).status, 403);

    // The creator makes Ann an admin.
    assert.equal((await asJoe("PUT", `/members/${outsider.id}`, { admin: true })).status, 404);
    assert.equal((await asJoe("PUT", `/members/${ann.id}`, {})).status, 400);
    const made = await asJoe("PUT", `/members/${ann.id}`, { admin: true });
    assert.equal(made.status, 200);
    assert.equal(made.body.members.find((m: { id: string }) => m.id === ann.id).role, "admin");

    // Ann now manages what the creator manages.
    assert.equal((await asAnn("PATCH", "", { name: "Checkout v3" })).body.name, "Checkout v3");
    assert.equal((await asAnn("GET", "/sources")).body.canManage, true);
    assert.equal((await asAnn("DELETE", "/sources/JoeL377/stand")).status, 404, "allowed, but no such repo is linked");
    assert.equal((await asAnn("GET", "/conxt")).body.canManage, true);
    assert.equal((await asAnn("DELETE", "/conxt")).status, 200);

    // An admin makes more admins, but the creator stays one.
    assert.equal((await asAnn("PUT", `/members/${sam.id}`, { admin: true })).status, 200);
    assert.equal((await asSam("PUT", `/members/${joe.id}`, { admin: false })).status, 400);
    assert.equal(db.managesSpace(room, joe.id), true);

    // And takes it back, from someone else or from themselves.
    assert.equal((await asSam("PUT", `/members/${ann.id}`, { admin: false })).status, 200);
    assert.equal((await asAnn("PATCH", "", { name: "Ann's space" })).status, 403);
    const left = await asSam("PUT", `/members/${sam.id}`, { admin: false });
    assert.equal(left.body.canManage, false);
    // Anyone in the space still changes what it synthesizes.
    assert.equal((await asSam("PATCH", "", { synthesisInstructions: "List the risks" })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.raw.close();
  }
});
