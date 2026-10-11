import assert from "node:assert/strict";
import { test } from "node:test";
import type { Discussion, Segment } from "../shared/protocol.ts";
import { settle } from "./settle.ts";

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
