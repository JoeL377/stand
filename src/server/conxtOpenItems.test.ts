import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ConxtOpenItems, type ConxtOpenItem, liveCards, openItemsUrl, saysTerm } from "./conxtOpenItems.ts";

const destination = {
  key: "product", label: "Acme / Product", token: "secret",
  submissionUrl: "https://conxt.test/api/v1/integrations/0b6430a1-307c-4516-b582-36f20104048a/sources",
};

function db(connected = true) {
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE conxt_connections (room_id TEXT, destination_key TEXT, submission_url TEXT, enabled INTEGER)");
  if (connected) sql.prepare("INSERT INTO conxt_connections VALUES ('room',?,?,1)").run(destination.key, destination.submissionUrl);
  return sql;
}

const item = {
  kind: "confirmation", id: "c1", title: "Build Stand and Conxt together.",
  why: "Decided while Joe Liang was away", needs: [{ id: "joe@example.com", name: "Joe Liang" }],
  path: "/ingestions/r1", at: "2026-10-13T04:34:12Z", content_hash: "a".repeat(64),
};
const parsed = { ...item, content_hash: undefined, contentHash: "a".repeat(64), term: null };
delete (parsed as { content_hash?: string }).content_hash;

test("open items sit beside the integration's source URL", () => {
  assert.equal(openItemsUrl(destination.submissionUrl), "https://conxt.test/api/v1/integrations/0b6430a1-307c-4516-b582-36f20104048a/open-items");
});

test("a connected room gets Conxt's open items, malformed rows dropped", async () => {
  let auth = "";
  const send = (async (_url: string, init: RequestInit) => {
    auth = (init.headers as Record<string, string>).Authorization;
    return { ok: true, json: async () => ({ items: [item, { kind: "bogus", id: "x", title: "t", why: "w" }, { kind: "question" }] }) };
  }) as unknown as typeof fetch;
  const o = new ConxtOpenItems(db(), [destination], send);
  assert.deepEqual(o.cached("room"), []);
  assert.deepEqual(await o.refresh("room"), [parsed]);
  assert.equal(auth, "Bearer secret");
  assert.deepEqual(o.cached("room"), [parsed]);
});

test("no connection, or Conxt failing, leaves the agenda as it was", async () => {
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await new ConxtOpenItems(db(false), [destination], down).refresh("room"), []);
  assert.deepEqual(await new ConxtOpenItems(db(), [destination], down).refresh("room"), []);
});

test("a confirmation goes back with the person and the decision's hash, then the list is fetched again", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let waiting = true;
  const send = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "POST") { waiting = false; return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ items: waiting ? [item] : [] }) };
  }) as unknown as typeof fetch;
  const o = new ConxtOpenItems(db(), [destination], send);
  await o.refresh("room");
  assert.deepEqual(await o.confirm("room", "c1", "joe@example.com"), { ok: true });
  const post = calls.find((c) => c.init?.method === "POST")!;
  assert.equal(post.url, "https://conxt.test/api/v1/integrations/0b6430a1-307c-4516-b582-36f20104048a/open-items/c1/confirm");
  assert.deepEqual(JSON.parse(post.init!.body as string), { person: "joe@example.com", content_hash: "a".repeat(64) });
  await o.refresh("room");
  assert.deepEqual(o.cached("room"), []);
});

test("a confirmation Conxt refuses, or one not on the list, says why", async () => {
  const send = (async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? { ok: false, status: 409 } : { ok: true, json: async () => ({ items: [item] }) }) as unknown as typeof fetch;
  const o = new ConxtOpenItems(db(), [destination], send);
  await o.refresh("room");
  assert.deepEqual(await o.confirm("room", "c1", "joe@example.com"), { ok: false, why: "it changed or doesn't wait on you" });
  assert.equal((await o.confirm("room", "nope", "joe@example.com")).ok, false);
});

const open: ConxtOpenItem[] = [
  { ...parsed, kind: "confirmation" },
  { kind: "divergence", id: "d1", title: "Stand meant two things.", why: "People used “stand” to mean different things",
    needs: [], path: null, at: null, contentHash: null, term: "stand" },
];

test("the live panel raises a decision only while someone it waits on is here", () => {
  const joe = { participantId: "u-joe", name: "Joe", email: "Joe@Example.com" };
  const huy = { participantId: "u-huy", name: "Huy", email: "huy@example.com" };
  assert.deepEqual(liveCards(open, [huy], new Set()), []);
  const [card] = liveCards(open, [huy, joe], new Set());
  assert.equal(card.kind, "confirmation");
  assert.deepEqual(card.here, [{ participantId: "u-joe", name: "Joe" }]);
});

test("a word used two ways shows once it is said again, as a whole word", () => {
  assert.deepEqual(saysTerm(open, "So Stand, the app, ships first."), ["d1"]);
  assert.deepEqual(saysTerm(open, "Our standup ran long."), []);
  assert.deepEqual(liveCards(open, [], new Set(["d1"])).map((c) => c.term), ["stand"]);
});
