import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ConxtGlossary, glossaryUrl, vocabularyLine } from "./conxtGlossary.ts";

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

const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("the glossary sits beside the integration's source URL", () => {
  assert.equal(glossaryUrl(destination.submissionUrl), "https://conxt.test/api/v1/integrations/0b6430a1-307c-4516-b582-36f20104048a/glossary");
  assert.equal(glossaryUrl("https://conxt.test/elsewhere"), null);
});

test("a connected room gets keyterms and a prompt, sent with the integration credential", async () => {
  let seen: { url: string; auth: string } | null = null;
  const send = (async (url: string, init: RequestInit) => {
    seen = { url, auth: (init.headers as Record<string, string>).Authorization };
    return { ok: true, json: async () => ({ keyterms: ["Conxt", "Stand", 7, ""], terms: [{ term: "Conxt", aliases: ["Connect", 3] }, { term: "" }] }) };
  }) as unknown as typeof fetch;
  const g = new ConxtGlossary(db(), [destination], send);
  assert.deepEqual(g.cached("room"), { keyterms: [], terms: [] });
  assert.deepEqual(await g.refresh("room"), { keyterms: ["Conxt", "Stand"], terms: [{ term: "Conxt", aliases: ["Connect"] }] });
  assert.deepEqual(seen, { url: glossaryUrl(destination.submissionUrl), auth: "Bearer secret" });
  assert.deepEqual(g.cached("room").keyterms, ["Conxt", "Stand"]);
});

test("no connection, or Conxt failing, changes nothing", async () => {
  assert.deepEqual(await new ConxtGlossary(db(false), [destination], reply({ keyterms: ["X"] })).refresh("room"), { keyterms: [], terms: [] });
  assert.deepEqual(await new ConxtGlossary(db(), [destination], reply({}, false)).refresh("room"), { keyterms: [], terms: [] });
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await new ConxtGlossary(db(), [destination], down).refresh("room"), { keyterms: [], terms: [] });
});

test("a notes call only carries terms said in that stretch", () => {
  const terms = [{ term: "Conxt", aliases: ["Connect"] }, { term: "Stand", aliases: ["Stan"] }];
  assert.equal(vocabularyLine(terms, "Let's ship the loading bar."), null);
  assert.equal(
    vocabularyLine(terms, "Merge it with Connect?"),
    "Project vocabulary: Conxt (also heard as Connect). Write the project's own term even where the transcript has another name or a mis-hearing.",
  );
  assert.match(vocabularyLine(terms, "stan and conxt")!, /Conxt .*; Stand/);
  assert.equal(vocabularyLine(terms, "outstanding work"), null);
});
