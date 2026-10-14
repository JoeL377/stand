import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { GithubApp, appJwt, readEvent, signedByGithub } from "./github.ts";
import { openDb } from "./db.ts";
import { ShipWatch, refsIn, samePr } from "./shipWatch.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const cfg = { id: "12345", slug: "stand-app", privateKey: PEM, webhookSecret: "shh" };

function setup() {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const room = db.createRoom("Stand", joe.id, "Ship it");
  db.touchMembership(room.id, joe.id);
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Fixes", url: null, description: null }]);
  const m = db.startMeeting(room.id);
  const notes = db.replaceNotes(m.id, item.id, [
    { kind: "action", text: "Fix the loading bar", owner: "Joe", discussionId: null },
    { kind: "action", text: "Add a mic picker", owner: "Joe", discussionId: null },
    { kind: "action", text: "Follow headphone switches", owner: "Joe", discussionId: null },
  ]);
  db.endMeeting(m.id, null);
  const ready = (noteId: string, link: string) =>
    db.addUpdate({ roomId: room.id, itemId: item.id, noteId, noteText: null, userId: joe.id, userName: "Joe Liang", client: "Claude", status: "ready", text: "Done in a PR.", links: [link] });
  return { db, joe, room, notes, ready };
}

/** A pretend GitHub API: answers by path, and counts the calls. */
function fakeGithub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const get = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    // GitHub doesn't mind the case of owner and repo names.
    const body = Object.entries(routes).find(([k]) => k.toLowerCase() === path.toLowerCase())?.[1];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { get, calls };
}

test("the app signs in as itself with an RS256 token GitHub can check", () => {
  const jwt = appJwt("12345", PEM, Date.UTC(2026, 9, 14));
  const [h, b, sig] = jwt.split(".");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(sig, "base64url")));
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  assert.equal(claims.iss, "12345");
  assert.equal(claims.exp - claims.iat, 600);
});

test("webhooks count only when signed with the shared secret", () => {
  const raw = Buffer.from('{"action":"closed"}');
  const good = `sha256=${createHmac("sha256", "shh").update(raw).digest("hex")}`;
  assert.equal(signedByGithub("shh", raw, good), true);
  assert.equal(signedByGithub("other", raw, good), false);
  assert.equal(signedByGithub("shh", Buffer.from("{}"), good), false);
  assert.equal(signedByGithub("shh", raw, undefined), false);
});

test("webhook events Stand cares about", () => {
  const pr = { html_url: "https://github.com/JoeL377/stand/pull/15", merged: true, body: "Closes stand:action/abcd1234", user: { login: "JoeL377" } };
  assert.deepEqual(readEvent("pull_request", { action: "closed", pull_request: pr }), {
    kind: "pr-closed",
    pr: { url: pr.html_url, merged: true, body: pr.body, author: "JoeL377" },
  });
  assert.equal(readEvent("pull_request", { action: "opened", pull_request: pr }).kind, "other");
  assert.deepEqual(readEvent("installation", { action: "deleted", installation: { id: 7 } }), { kind: "uninstalled", id: 7 });
  assert.deepEqual(readEvent("installation", { action: "created", installation: { id: 7 } }), { kind: "installed", id: 7 });
});

test("connecting: the install link's nonce works once, for the person who left with it", async () => {
  const { db, joe } = setup();
  const gh = fakeGithub({ "/app/installations/77": { id: 77, account: { login: "JoeL377", type: "User" }, repository_selection: "selected" } });
  const app = new GithubApp(cfg, db.raw, gh.get);
  const url = new URL(app.installUrl(joe.id));
  assert.equal(url.origin + url.pathname, "https://github.com/apps/stand-app/installations/new");
  const state = url.searchParams.get("state")!;
  assert.equal(app.takeState(state, "someone-else"), false);
  assert.equal(app.takeState(state, joe.id), true);
  assert.equal(app.takeState(state, joe.id), false, "only once");

  const saved = await app.remember(77, joe.id);
  assert.deepEqual(saved, {
    id: 77,
    account: "JoeL377",
    accountType: "User",
    repos: "selected",
    connectedBy: "Joe Liang",
    connectedAt: saved!.connectedAt,
    manageUrl: "https://github.com/settings/installations/77",
  });
  // GitHub's own "installed" notice later doesn't lose who connected it.
  await app.remember(77, null);
  assert.equal(app.list()[0].connectedBy, "Joe Liang");
  assert.equal(await app.remember(78, joe.id), null, "an installation of some other app isn't saved");
  app.forget(77);
  assert.deepEqual(app.list(), []);
});

test("reading a PR as the app: one installation lookup and one token, reused", async () => {
  const { db } = setup();
  const gh = fakeGithub({
    "/repos/JoeL377/stand/installation": { id: 77 },
    "/app/installations/77/access_tokens": { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() },
    "/repos/JoeL377/stand/pulls/15": { state: "closed", merged: true },
    "/repos/JoeL377/stand/pulls/16": { state: "open", merged: false },
  });
  const app = new GithubApp(cfg, db.raw, gh.get);
  assert.equal(await app.prState("https://github.com/JoeL377/stand/pull/15"), "merged");
  assert.equal(await app.prState("https://github.com/joel377/Stand/pull/16"), "open");
  assert.deepEqual(gh.calls, [
    "GET /repos/JoeL377/stand/installation",
    "POST /app/installations/77/access_tokens",
    "GET /repos/JoeL377/stand/pulls/15",
    "GET /repos/joel377/Stand/pulls/16",
  ]);
});

test("a merge notice checks off the to-do reported ready with that PR, and any whose ref is in its description", () => {
  const { db, notes, ready } = setup();
  const [bar, mic, phones] = notes;
  ready(bar.id, "https://github.com/JoeL377/stand/pull/15/files");
  const watch = new ShipWatch(db, () => {}, async () => null);
  watch.settle({ url: "https://github.com/joel377/stand/pull/15", merged: true, author: "JoeL377", body: `Fixes the mic.\n\nstand:action/${mic.id} and stand:action/${bar.id}` });
  assert.equal(db.getNote(bar.id)!.doneBy, "Joe Liang via Claude");
  assert.match(db.notesUpdates([bar.id]).at(-1)!.text, /^Shipped: PR #15 merged\. Done in a PR\./);
  assert.equal(db.getNote(mic.id)!.doneBy, "JoeL377 via GitHub", "named in the description, never reported ready");
  assert.equal(db.notesUpdates([mic.id]).at(-1)!.text, "Shipped: PR #15 merged.");
  assert.equal(db.notesUpdates([bar.id]).filter((u) => u.status === "done").length, 1, "one done entry, not two");
  assert.equal(db.getNote(phones.id)!.doneAt, null);

  // Closed without merging: the ready one hears about it; a ref in the description changes nothing.
  ready(phones.id, "https://github.com/JoeL377/stand/pull/17");
  watch.settle({ url: "https://github.com/JoeL377/stand/pull/17", merged: false, author: "JoeL377", body: `stand:action/${phones.id}` });
  assert.equal(db.getNote(phones.id)!.doneAt, null);
  assert.match(db.notesUpdates([phones.id]).at(-1)!.text, /PR #17 was closed without merging/);
});

test("PR links match across case and sub-pages; refs come out of descriptions", () => {
  assert.equal(samePr("https://github.com/JoeL377/stand/pull/15/files", "https://github.com/joel377/STAND/pull/15"), true);
  assert.equal(samePr("https://github.com/JoeL377/stand/pull/15", "https://github.com/JoeL377/stand/pull/16"), false);
  assert.deepEqual(refsIn("Closes stand:action/abcd1234 (see https://stand.example/ref/action/zzzz9999), stand:action/abcd1234"), ["abcd1234", "zzzz9999"]);
});
