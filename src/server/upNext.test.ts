import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemUpdate, Note } from "../shared/protocol.ts";
import { computeUpNext, type UpNextInput } from "./upNext.ts";

const note = (id: string, meetingId: string, kind: Note["kind"], text: string, extra: Partial<Note> = {}): Note => ({
  id,
  meetingId,
  itemId: "slide",
  kind,
  text,
  owner: null,
  ts: 1,
  doneAt: null,
  doneBy: null,
  discussionId: null,
  ...extra,
});

const update = (extra: Partial<ItemUpdate>): ItemUpdate => ({
  id: "u",
  roomId: "r",
  itemId: null,
  noteId: null,
  noteText: null,
  userName: "Andy Li",
  client: "Claude Code",
  status: "progress",
  text: "",
  links: [],
  ts: 250,
  ...extra,
});

// Three meetings: m1 (t=100), m2 (t=200), and the live one (t=300).
const base = (over: Partial<UpNextInput> = {}): UpNextInput => ({
  now: 310,
  meetings: [
    { id: "m1", startedAt: 100, endedAt: 150 },
    { id: "m2", startedAt: 200, endedAt: 250 },
    { id: "m3", startedAt: 300, endedAt: null },
  ],
  currentStart: 300,
  notes: [],
  items: new Map([
    ["slide", { title: "Slide 1", archived: false, deck: true }],
    ["task", { title: "Billing bug", archived: false, deck: false }],
    ["gone", { title: "Webhooks retry", archived: true, deck: false }],
  ]),
  updates: [],
  dismissed: new Map(),
  ...over,
});

test("blockers rank first, then last meeting's questions, then to-dos", () => {
  const notes = [
    note("a1", "m2", "action", "Write the retry doc", { owner: "Huy", ts: 210 }),
    note("q1", "m2", "question", "Merge with Connect?", { ts: 220 }),
    note("a2", "m2", "action", "Design the inbox path", { ts: 230 }),
  ];
  const { upNext } = computeUpNext(base({ notes, updates: [update({ noteId: "a2", status: "blocked" })] }));
  assert.deepEqual(
    upNext.suggestions.map((s) => [s.key, s.kind]),
    [
      ["note:a2", "needs_people"],
      ["note:q1", "question"],
      ["note:a1", "todo"],
    ],
  );
  assert.equal(upNext.suggestions[0].reason, "Blocked · Andy's agent");
  assert.equal(upNext.suggestions[2].reason, "To-do from last meeting · Huy");
});

test("to-dos already on an agenda task aren't suggested, they carry the ↻ count instead", () => {
  const notes = [note("a1", "m1", "action", "Fix the 17% copy", { itemId: "task" })];
  const { upNext, carried } = computeUpNext(base({ notes }));
  assert.equal(upNext.suggestions.length, 0);
  assert.deepEqual(carried, { task: 2 });
});

test("open to-dos on a task that came off the agenda bring the task back once", () => {
  const notes = [
    note("a1", "m2", "action", "Cap backoff at an hour", { itemId: "gone" }),
    note("a2", "m2", "action", "Give up after 24h", { itemId: "gone" }),
  ];
  const { upNext } = computeUpNext(base({ notes }));
  assert.deepEqual(
    upNext.suggestions.map((s) => [s.key, s.title, s.reason]),
    [["item:gone", "Webhooks retry", "2 open to-dos · from last meeting"]],
  );
});

test("done to-dos and older questions drop out, and the closed count says so", () => {
  const notes = [
    note("a1", "m1", "action", "Old and done", { doneAt: 260 }),
    note("a2", "m2", "action", "Still open"),
    note("q0", "m1", "question", "Asked two meetings ago"),
  ];
  const { upNext } = computeUpNext(base({ notes }));
  assert.deepEqual(
    upNext.suggestions.map((s) => s.key),
    ["note:a2"],
  );
  assert.equal(upNext.closed, 1);
  assert.equal(upNext.total, 2);
  assert.equal(upNext.since, 200);
});

test("a to-do quiet for two meetings is parked, and comes back when someone reports on it", () => {
  const notes = [note("a1", "m1", "action", "Look at the Connect repo")];
  const four = {
    meetings: [...base().meetings.slice(0, 2), { id: "m3", startedAt: 300, endedAt: 350 }, { id: "m4", startedAt: 400, endedAt: null }],
  };
  const quiet = computeUpNext(base({ ...four, currentStart: 400, notes })).upNext;
  assert.equal(quiet.suggestions.length, 0);
  assert.deepEqual(
    quiet.parked.map((s) => s.key),
    ["note:a1"],
  );
  const woke = computeUpNext(base({ ...four, currentStart: 400, notes, updates: [update({ noteId: "a1", ts: 360 })] })).upNext;
  assert.deepEqual(
    woke.suggestions.map((s) => s.key),
    ["note:a1"],
  );
});

test("a dismissed suggestion stays away until something new happens on it", () => {
  const notes = [note("a1", "m2", "action", "Write the retry doc", { ts: 210 })];
  const dismissed = new Map([["note:a1", 280]]);
  assert.equal(computeUpNext(base({ notes, dismissed })).upNext.suggestions.length, 0);
  const later = computeUpNext(base({ notes, dismissed, updates: [update({ noteId: "a1", ts: 290 })] })).upNext;
  assert.equal(later.suggestions.length, 1);
});
