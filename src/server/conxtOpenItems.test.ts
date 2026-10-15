import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ConxtOpenItems, openItemsUrl } from "./conxtOpenItems.ts";

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
  path: "/ingestions/r1", at: "2026-10-13T04:34:12Z",
};

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
  assert.deepEqual(await o.refresh("room"), [item]);
  assert.equal(auth, "Bearer secret");
  assert.deepEqual(o.cached("room"), [item]);
});

test("no connection, or Conxt failing, leaves the agenda as it was", async () => {
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await new ConxtOpenItems(db(false), [destination], down).refresh("room"), []);
  assert.deepEqual(await new ConxtOpenItems(db(), [destination], down).refresh("room"), []);
});
