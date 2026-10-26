import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, metered, recordUsage, setUsageSink, type UsageRow } from "./usage.ts";

test("a call is priced by its model, cache reads cheap and cache writes at 1.25x input", () => {
  const usd = costOf({ model: "claude-sonnet-5-5", input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 });
  assert.equal(usd.toFixed(2), (2 + 0.2 + 2.5 + 10).toFixed(2));
  assert.equal(costOf({ model: "claude-haiku-5-5", input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }).toFixed(2), "0.60");
  // An unknown model is priced high rather than free.
  assert.ok(costOf({ model: "something-new", input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }) >= 4);
});

test("calls through a metered agent count against its meeting and task, across awaits", async () => {
  const rows: UsageRow[] = [];
  setUsageSink((r) => rows.push(r));
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
});
