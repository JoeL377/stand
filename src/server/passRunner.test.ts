import assert from "node:assert/strict";
import { test } from "node:test";
import { PassRunner, retryWait } from "./passRunner.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("one pass at a time: run() while one is going returns that one", async () => {
  let calls = 0;
  let release!: () => void;
  const r = new PassRunner(
    () => {
      calls++;
      return new Promise<void>((ok) => (release = ok));
    },
    { label: "t", about: () => "pass" },
  );
  const a = r.run();
  const b = r.run();
  assert.equal(a, b);
  assert.equal(r.running, true);
  release();
  await a;
  assert.equal(calls, 1);
  assert.equal(r.running, false);
});

test("a debounced timer moves with each schedule; keepEarlier keeps the sooner one", async () => {
  let calls = 0;
  const debounced = new PassRunner(async () => void calls++, { label: "t", about: () => "pass" });
  debounced.schedule(20);
  await tick(10);
  debounced.schedule(20);
  await tick(15);
  assert.equal(calls, 0, "the second schedule pushed it back");
  await tick(15);
  assert.equal(calls, 1);

  let early = 0;
  const kept = new PassRunner(async () => void early++, { label: "t", about: () => "pass", keepEarlier: true });
  kept.schedule(10);
  kept.schedule(1_000);
  await tick(25);
  assert.equal(early, 1, "the later schedule didn't replace the sooner one");
  kept.stop();
});

test("after a failure the next pass waits, doubling up to a minute, and a pass that works resets it", async () => {
  assert.deepEqual([0, 1, 2, 3, 5, 9].map(retryWait), [0, 5_000, 10_000, 20_000, 60_000, 60_000]);
  let fail = true;
  let calls = 0;
  const r = new PassRunner(
    async () => {
      calls++;
      if (fail) throw new Error("overloaded");
    },
    { label: "t", about: () => "pass", settled: () => r.schedule(0) },
  );
  const quiet = console.error;
  console.error = () => {};
  try {
    await r.run();
    await tick(30);
    assert.equal(calls, 1, "a failed pass doesn't start again at once");
    fail = false;
    r.stop();
    await r.run();
    assert.equal(calls, 2, "run() still works after stop, for a last pass");
  } finally {
    console.error = quiet;
  }
});
