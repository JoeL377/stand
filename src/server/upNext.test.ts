import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemUpdate, Note } from "../shared/protocol.ts";
import { openDb } from "./db.ts";
import { type AgendaDraftRow, HeuristicAgent } from "./llm.ts";
import { applyPolish, computeUpNext, polishBasis, type UpNextInput } from "./upNext.ts";
import { UpNextPolisher, upNextView } from "./upNextPolish.ts";

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
  otherSpaces: [],
  captures: [],
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

test("Claude's pass rewords, reorders and folds duplicates, but only over facts it saw", () => {
  const notes = [
    note("a1", "m2", "action", "Write the retry doc", { ts: 210 }),
    note("a2", "m2", "action", "Draft webhook retry docs", { ts: 211 }),
    note("q1", "m2", "question", "Merge with Connect?", { ts: 220 }),
  ];
  const plain = computeUpNext(base({ notes })).upNext;
  const at = (k: string) => plain.suggestions.find((s) => s.key === k)!;
  const polish = {
    at: 400,
    rows: [
      { key: "note:a1", basis: polishBasis(at("note:a1")), title: "Retry docs", reason: "Two asks for the same doc", sameAs: null },
      { key: "note:q1", basis: polishBasis(at("note:q1")), title: "Stand inside Connect?", reason: "Left open Thu", sameAs: null },
      { key: "note:a2", basis: polishBasis(at("note:a2")), title: "x", reason: "x", sameAs: "note:a1" },
    ],
  };
  const out = applyPolish(plain, polish);
  assert.deepEqual(
    out.suggestions.map((s) => [s.key, s.title, s.merged]),
    [
      ["note:a1", "Retry docs", ["note:a2"]],
      ["note:q1", "Stand inside Connect?", []],
    ],
  );
  assert.equal(out.polishedAt, 400);

  // After the pass: a new to-do gets blocked, and the retry doc reports progress. Both keep the
  // plain wording (the pass never saw those facts), and the blocker goes first.
  const more = [...notes, note("a3", "m2", "action", "Get Connect API keys", { ts: 230 })];
  const updates = [update({ noteId: "a3", status: "blocked" }), update({ noteId: "a1", status: "progress", ts: 260 })];
  const stale = applyPolish(computeUpNext(base({ notes: more, updates })).upNext, polish);
  assert.deepEqual(
    stale.suggestions.map((s) => [s.key, s.title]),
    [
      ["note:a3", "Get Connect API keys"],
      ["note:q1", "Stand inside Connect?"],
      ["note:a1", "Write the retry doc"],
      ["note:a2", "Draft webhook retry docs"],
    ],
  );
});

test("a new space offers what's still open in spaces its people share", () => {
  const fresh = base({
    meetings: [{ id: "m1", startedAt: 300, endedAt: null }],
    otherSpaces: [{ id: "r2", name: "Prod Test", open: 3, lastAt: 90 }],
  });
  assert.deepEqual(
    computeUpNext(fresh).upNext.suggestions.map((s) => [s.key, s.title, s.reason]),
    [["space:r2", "Open to-dos from Prod Test", "3 open to-dos in Prod Test"]],
  );
  // Once the space has had a meeting of its own, it stops offering.
  assert.equal(computeUpNext(base({ otherSpaces: fresh.otherSpaces })).upNext.suggestions.length, 0);
});

test("the polisher saves Claude's pass, shows it, and skips a rerun when nothing changed", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Standup", null, "");
  const m = db.startMeeting(room.id);
  db.addNote(m.id, null, { kind: "action", text: "Write the retry doc", owner: "Huy" }, "Joe");
  db.endMeeting(m.id, null);
  let calls = 0;
  const seen: boolean[] = [];
  const agent = Object.assign(new HeuristicAgent(), {
    polishAgenda: async (_space: unknown, rows: AgendaDraftRow[]) => {
      calls++;
      return rows.map((r) => ({ key: r.key, title: "Retry docs", reason: "Huy's, still open", sameAs: null }));
    },
  });
  const polisher = new UpNextPolisher(
    db,
    agent,
    () => null,
    (id) => seen.push(polisher.busy(id)),
  );
  await polisher.run(room.id);
  await polisher.run(room.id);
  assert.equal(calls, 1);
  assert.deepEqual(seen, [true, false]);
  const { upNext } = upNextView(db, room.id, null);
  assert.deepEqual(
    upNext.suggestions.map((s) => [s.title, s.reason]),
    [["Retry docs", "Huy's, still open"]],
  );
  assert.ok(upNext.polishedAt);
});

test("snaps saved to the space since the last meeting are suggested, unless their item is on the agenda", () => {
  const snap = (id: string, ts: number, extra: Partial<UpNextInput["captures"][number]> = {}) => ({
    id,
    ts,
    itemId: null,
    by: "Huy Ngo",
    line: null,
    caption: null,
    screenText: null,
    ...extra,
  });
  const { upNext } = computeUpNext(
    base({
      captures: [
        snap("late", 290, { screenText: "\n  TypeError: cannot read 'plan' of undefined\n    at checkout.ts:42" }),
        snap("chart", 260, { line: "Signup chart dropped Tuesday", caption: "A line chart of signups" }),
        snap("pinned", 255, { itemId: "task", line: "Billing bug again" }),
        snap("webhooks", 240, { itemId: "gone", caption: "Webhook retries failing in the logs" }),
        snap("old", 180, { line: "From before the last meeting" }),
      ],
      notes: [note("q", "m2", "question", "Who owns pricing?"), note("a", "m2", "action", "Ship it")],
    }),
  );
  assert.deepEqual(
    upNext.suggestions.map((s) => [s.kind, s.title]),
    [
      ["question", "Who owns pricing?"],
      ["capture", "TypeError: cannot read 'plan' of undefined"],
      ["capture", "Signup chart dropped Tuesday"],
      ["capture", "Webhook retries failing in the logs"],
      ["todo", "Ship it"],
    ],
  );
  assert.equal(upNext.suggestions.find((s) => s.key === "snap:webhooks")?.reason, "Snap saved by Huy Ngo · Webhooks retry");
});

test("Conxt's open items join the agenda as needing people, and can be dismissed", () => {
  const conxt = [
    { kind: "confirmation" as const, id: "c1", title: "Build Stand and Conxt together.", why: "Decided while Joe Liang was away",
      needs: [{ id: "joe@example.com", name: "Joe Liang" }], path: "/ingestions/r1", at: null, contentHash: null, term: null },
    { kind: "question" as const, id: "q1", title: "Who reviews in a shared queue?", why: "Asked and not yet answered", needs: [], path: null, at: null, contentHash: null, term: null },
  ];
  const { upNext } = computeUpNext(base({ conxt }));
  const c1 = upNext.suggestions.find((s) => s.key === "conxt:c1")!;
  assert.equal(c1.kind, "needs_people");
  assert.equal(c1.owner, "Joe Liang");
  assert.equal(c1.reason, "Decided while Joe Liang was away · from Conxt");
  assert.equal(upNext.suggestions.find((s) => s.key === "conxt:q1")!.kind, "question");
  assert.ok(upNext.suggestions.indexOf(c1) < upNext.suggestions.findIndex((s) => s.key === "conxt:q1"));
  const dismissed = computeUpNext(base({ conxt, dismissed: new Map([["conxt:c1", 400]]) })).upNext;
  assert.equal(dismissed.suggestions.some((s) => s.key === "conxt:c1"), false);
});
