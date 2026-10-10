import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { authRoutes } from "./auth.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

test("the Mac app signs in through the browser: a one-time code only the app's secret can redeem", async (t) => {
  Object.assign(config.google, { clientId: "test-client", clientSecret: "test-secret" });
  t.after(() => Object.assign(config.google, { clientId: undefined, clientSecret: undefined }));
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const browser = db.createSession(joe.id);
  const app = express().use(express.json()).use("/api/auth", authRoutes(db));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  // Not signed in in the browser yet: off to Google, coming back here after.
  const anon = await fetch(`${base}/desktop?challenge=${challenge}&port=52011`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location")!, /^\/api\/auth\/google\?next=%2Fapi%2Fauth%2Fdesktop.*port%3D52011$/);
  // The code only ever goes back to this computer.
  const nowhere = await fetch(`${base}/desktop?challenge=${challenge}&port=80`, { headers: { cookie: `standup_session=${browser.id}` } });
  assert.equal(nowhere.status, 400);

  const handOff = async () => {
    const r = await fetch(`${base}/desktop?challenge=${challenge}&port=52011`, {
      headers: { cookie: `standup_session=${browser.id}` },
      redirect: "manual",
    });
    const to = new URL(r.headers.get("location")!);
    assert.equal(to.origin + to.pathname, "http://127.0.0.1:52011/signed-in");
    return to.searchParams.get("code")!;
  };
  const code = await handOff();

  const redeem = (body: object) =>
    fetch(`${base}/desktop/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await redeem({ code, verifier: "someone-else" })).status, 400, "the code is gone once tried");

  const code2 = await handOff();
  const ok = await redeem({ code: code2, verifier });
  assert.equal(ok.status, 200);
  const { cookie, session } = (await ok.json()) as { cookie: string; session: string };
  assert.equal(cookie, "standup_session");
  assert.notEqual(session, browser.id, "the app gets a session of its own");
  assert.equal(db.sessionUser(session)?.user.email, "joe@example.com");
  assert.equal((await redeem({ code: code2, verifier })).status, 400, "codes work once");
});
