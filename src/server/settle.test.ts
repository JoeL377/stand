import assert from "node:assert/strict";
import { test } from "node:test";
import type { Discussion, Segment } from "../shared/protocol.ts";
import { LOCK_AFTER_MS, LOCK_MIN_LINES, settle } from "./settle.ts";

const MIN = 60_000;
const now = Date.UTC(2026, 9, 11, 3, 0, 0);
const line = (id: string, minutesAgo: number): Segment => ({
  id,
  meetingId: "m",
  itemId: null,
  speakerId: "u",
  speakerName: "Joe",
  kind: "speech",
  text: id,
  ts: now - minutesAgo * MIN,
});
const topic = (id: string, segmentIds: string[]): Discussion => ({
  id,
  meetingId: "m",
  itemId: null,
  topic: id,
  positions: [],
  outcome: "info",
  segmentIds,
  continues: null,
  ts: 0,
});

test("a topic nobody has come back to for ten minutes settles, and a run reads only what's still going", () => {
  const lines = [
    line("audio-1", 60),
    line("coffee", 55),
    line("audio-2", 50),
    line("capture-1", 45),
    line("weather", 30),
    line("capture-2", 4),
    line("queue-1", 2),
    line("lunch", 1),
  ];
  const topics = [topic("Capture", ["capture-1", "capture-2"]), topic("Audio", ["audio-1", "audio-2"]), topic("Queue", ["queue-1"])];
  const { settled, window } = settle(lines, topics, now, now - 1 * MIN);
  assert.deepEqual(settled.map((d) => d.id), ["Audio"]);
  // Capture is still going, so all of it is read, the 45-minute-old line too. Old talk under no
  // topic drops out; recent talk stays in, under a topic or not yet.
  assert.deepEqual(window.map((s) => s.id), ["capture-1", "capture-2", "queue-1", "lunch"]);
});

test("talk no run has read yet stays in however old, so a stretch of failed runs loses nothing", () => {
  const lines = [line("audio-1", 60), line("audio-2", 50), line("unread-1", 40), line("unread-2", 20)];
  const topics = [topic("Audio", ["audio-1", "audio-2"])];
  // The last run that worked read up to the 50-minute-old line.
  assert.deepEqual(settle(lines, topics, now, now - 50 * MIN).window.map((s) => s.id), ["unread-1", "unread-2"]);
  // After a restart nobody knows what was read, so nothing but settled topics drops out.
  assert.deepEqual(settle(lines, topics, now).window.map((s) => s.id), ["unread-1", "unread-2"]);
  assert.deepEqual(settle([line("chat", 40)], [], now).window.map((s) => s.id), ["chat"]);
});

test("what a run reads only loses lines now and then, so the start of the prompt stays cached", () => {
  const lines = Array.from({ length: 120 }, (_, i) => line(`s${i}`, 60 - i / 2));
  const windows = Array.from({ length: 60 }, (_, i) => settle(lines, [], now + i * 5_000, now).window[0].id);
  // Five minutes of runs: the first line read changes at most twice.
  assert.ok(new Set(windows).size <= 2, `first line changed ${new Set(windows).size} times`);
});

test("inside a long topic still going, talk older than 15 minutes folds once there's a lot of it", () => {
  // An hour on one topic: a line a minute, the last one just now.
  const lines = Array.from({ length: 61 }, (_, i) => line(`pricing-${i}`, 60 - i));
  const { settled, folded, window } = settle(lines, [topic("Pricing", lines.map((s) => s.id))], now, now);
  assert.deepEqual(settled, []);
  assert.equal(folded.length, 1);
  // The fold edge moves in 5-minute steps: 15 minutes ago, here on the step itself.
  assert.deepEqual(folded[0].segmentIds, lines.filter((s) => s.ts < now - 15 * MIN).map((s) => s.id));
  assert.deepEqual(window.map((s) => s.id), lines.filter((s) => s.ts >= now - 15 * MIN).map((s) => s.id));

  // Twenty minutes on one topic: too little to fold, so all of it is read.
  const short = lines.slice(-20);
  assert.deepEqual(settle(short, [topic("Pricing", short.map((s) => s.id))], now, now).folded, []);
  // And talk no run has read yet never folds.
  const unread = settle(lines, [topic("Pricing", lines.map((s) => s.id))], now, now - 20 * MIN);
  assert.deepEqual(unread.folded[0].segmentIds, lines.filter((s) => s.ts <= now - 20 * MIN).map((s) => s.id));
  assert.equal(unread.window[0].id, "pricing-41");
});

test("live, a topic's talk several minutes old locks to it: the run reads only the latest talk", () => {
  const lines = Array.from({ length: 20 }, (_, i) => line(`pricing-${i}`, 20 - i));
  const { folded, window } = settle(lines, [topic("Pricing", lines.map((s) => s.id))], now, now, { foldAfterMs: LOCK_AFTER_MS, foldMinLines: LOCK_MIN_LINES });
  assert.equal(folded.length, 1);
  assert.ok(folded[0].segmentIds.length >= 6, "the older talk is locked to Pricing");
  assert.ok(window.length < 20 && window.length >= 8, `the run reads ${window.length} lines`);
  assert.deepEqual(window.at(-1)?.id, "pricing-19");
  // Too little older talk to be worth locking: it's all read again.
  const short = lines.slice(-5);
  assert.deepEqual(settle(short, [topic("Pricing", short.map((s) => s.id))], now, now, { foldAfterMs: LOCK_AFTER_MS, foldMinLines: LOCK_MIN_LINES }).folded, []);
});
