import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskBriefs } from "./taskPresentation.ts";

const brief = { summary: "A staged launch", takeaways: ["Start with one team"], questions: ["Who owns rollout?"] };

test("viewers share a brief, and changes to the task or spec invalidate it", async () => {
  let calls = 0;
  const briefs = new TaskBriefs({ taskBrief: async (prompt) => {
    calls++;
    assert.equal(JSON.parse(prompt).task, calls === 3 ? "Revised task" : "Launch");
    return brief;
  } });
  const [a, b] = await Promise.all([briefs.get("task", "Launch", "Spec"), briefs.get("task", "Launch", "Spec")]);
  assert.deepEqual(a, brief);
  assert.deepEqual(b, brief);
  assert.equal(calls, 1);
  await briefs.get("task", "Launch", "Edited spec");
  await briefs.get("task", "Revised task", "Edited spec");
  assert.equal(calls, 3);
});

test("failed runs are retryable and missing AI/specs never fabricate a brief", async () => {
  let calls = 0;
  const briefs = new TaskBriefs({ taskBrief: async () => { if (++calls === 1) throw new Error("Model unavailable"); return brief; } });
  await assert.rejects(briefs.get("task", "Launch", "Spec"), /Model unavailable/);
  assert.deepEqual(await briefs.get("task", "Launch", "Spec"), brief);
  await assert.rejects(new TaskBriefs({}).get("task", "Launch", "Spec"), /unavailable/);
  await assert.rejects(briefs.get("task", "Launch", "  "), /Attach a spec/);
  await assert.rejects(briefs.get("task", "Launch", "x".repeat(120_001)), /too long/);
  assert.equal(calls, 2);
});
