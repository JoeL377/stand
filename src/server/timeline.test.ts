import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCard, Discussion, ItemUpdate, Note, Segment } from "../shared/protocol.ts";
import { timelineWho } from "../shared/timeline.ts";
import { openDb } from "./db.ts";
import { buildTimeline, meetingTimeline } from "./timeline.ts";

const seg = (id: string, ts: number, text: string, kind: "speech" | "chat" = "speech", who = "Joe"): Segment => ({
  id,
  meetingId: "m",
  itemId: "i1",
  speakerId: who.toLowerCase(),
  speakerName: who,
  kind,
  text,
  ts,
});
const note = (id: string, ts: number, kind: Note["kind"], text: string, extra: Partial<Note> = {}): Note => ({
  id,
  meetingId: "m",
  itemId: "i1",
  kind,
  text,
  owner: null,
  ts,
  doneAt: null,
  doneBy: null,
  discussionId: null,
  ...extra,
});
const card = (c: Partial<AgentCard>): AgentCard => ({
  id: "c1",
  kind: "answer",
  about: "",
  question: "",
  status: "ready",
  by: "Huy",
  at: 0,
  readyAt: null,
  options: [],
  fromSpace: [],
  note: null,
  picked: null,
  dismissed: null,
  model: null,
  costUsd: null,
  ...c,
});
const update = (u: Partial<ItemUpdate>): ItemUpdate => ({
  id: "u1",
  roomId: "r",
  itemId: null,
  noteId: null,
  noteText: null,
  userName: "Joe",
  client: null,
  status: "progress",
  text: "",
  links: [],
  ts: 0,
  ...u,
});
const base = { meeting: { startedAt: 1000, endedAt: 9000 }, segments: [], notes: [], discussions: [], cards: [], focus: [], updates: [], itemById: () => null };

test("chat sits between the speech around it, by when it was sent", () => {
  const t = buildTimeline({ ...base, segments: [seg("s1", 1000, "First"), seg("s3", 3000, "Third"), seg("s2", 2000, "Typed", "chat", "Huy")] });
  assert.deepEqual(
    t.map((e) => [e.kind, e.text]),
    [
      ["speech", "First"],
      ["chat", "Typed"],
      ["speech", "Third"],
    ],
  );
});

test("a capture sits right after the line it quotes, not when it was written", () => {
  const t = buildTimeline({
    ...base,
    segments: [seg("s1", 1000, "Let's ship it Friday"), seg("s2", 2000, "Next thing")],
    notes: [note("n1", 2500, "decision", "Ship Friday", { quote: { segmentId: "s1", ts: 1000, speaker: "Joe", text: "ship it Friday" } })],
  });
  assert.deepEqual(
    t.map((e) => e.id),
    ["speech:s1", "capture:n1", "speech:s2"],
  );
  assert.equal(t[1].ref, "stand:decision/n1");
});

test("without a quote, a capture sits after the last line of its discussion said before it", () => {
  const d = { id: "d1", segmentIds: ["s1", "s2"] } as Discussion;
  const t = buildTimeline({
    ...base,
    segments: [seg("s1", 1000, "a"), seg("s2", 2000, "b"), seg("s3", 3000, "c")],
    discussions: [d],
    notes: [note("n1", 3500, "action", "Write it up", { discussionId: "d1", owner: "Huy" })],
  });
  assert.deepEqual(
    t.map((e) => e.id),
    ["speech:s1", "speech:s2", "capture:n1", "speech:s3"],
  );
  assert.equal(t[2].capture, "action");
});

test("Ask Stand: the answer goes with its question; one still being heard is left out", () => {
  const t = buildTimeline({
    ...base,
    cards: [
      card({ id: "c1", question: "What did we decide on video?", at: 1500, note: "No video in meetings." }),
      card({ id: "c2", question: "", status: "listening", at: 1600 }),
      card({ id: "c3", question: "And pricing?", status: "working", at: 1700, note: "drafting" }),
    ],
  });
  assert.deepEqual(
    t.map((e) => [e.id, e.answer]),
    [
      ["ask:c1", "No video in meetings."],
      ["ask:c3", null],
    ],
  );
});

test("focus changes show once each, labelled, before what was said at the same moment", () => {
  const item = { id: "i2", title: "Task drawer", externalId: null, slideNo: 3, slide: null } as never;
  const t = buildTimeline({
    ...base,
    segments: [seg("s1", 2000, "So the drawer")],
    focus: [
      { id: "f1", ts: 2000, itemId: "i2", actor: "Joe", reason: "manual" },
      { id: "f2", ts: 2100, itemId: "i2", actor: "Joe", reason: "pin" },
    ],
    itemById: (id) => (id === "i2" ? item : null),
  });
  assert.deepEqual(
    t.map((e) => [e.kind, e.text, e.label ?? null]),
    [
      ["focus", "Task drawer", "Slide 3"],
      ["speech", "So the drawer", null],
    ],
  );
});

test("agent reports from the meeting's window show who did it through what; 'working' and outside reports don't", () => {
  const t = buildTimeline({
    ...base,
    updates: [
      update({ id: "u1", ts: 1500, status: "added", noteId: "n9", noteText: "Fix the drawer", client: "Claude", actor: { kind: "agent", person: "Joe", agent: "Claude" } }),
      update({ id: "u2", ts: 1600, status: "working", noteId: "n9" }),
      update({ id: "u3", ts: 9500, status: "ready" }),
      update({ id: "u4", ts: 500, status: "comment" }),
    ],
  });
  assert.deepEqual(
    t.map((e) => e.id),
    ["agent:u1"],
  );
  assert.equal(t[0].ref, "stand:action/n9");
  assert.equal(timelineWho(t[0]), "Joe via Claude");
});

test("meetingTimeline reads a stored meeting", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Conxt");
  const m = db.startMeeting(room.id);
  db.addSegment({ meetingId: m.id, itemId: null, speakerId: "p1", speakerName: "Huy", kind: "speech", text: "Hello", ts: m.startedAt + 1 });
  db.addSegment({ meetingId: m.id, itemId: null, speakerId: "p2", speakerName: "Joe", kind: "chat", text: "link here", ts: m.startedAt + 2 });
  db.addNote(m.id, null, { kind: "action", text: "Send the link", owner: "Joe" }, null);
  db.saveAgentCards(m.id, [card({ id: "c1", question: "Who owns it?", at: m.startedAt + 3, note: "Joe" })]);
  const t = meetingTimeline(db, m.id);
  assert.deepEqual(t.map((e) => e.kind).sort(), ["ask", "capture", "chat", "speech"]);
  assert.deepEqual(
    t.filter((e) => e.kind === "speech" || e.kind === "chat").map((e) => e.text),
    ["Hello", "link here"],
  );
  assert.deepEqual(meetingTimeline(db, "nope"), []);
});

test("the brief with its transcript carries the timeline, in JSON and Markdown", async () => {
  const { buildBrief, briefToMarkdown } = await import("./brief.ts");
  const timeline = buildTimeline({
    ...base,
    segments: [seg("s1", 1000, "Hello"), seg("s2", 2000, "the link", "chat", "Huy")],
    cards: [card({ id: "c1", question: "Who owns it?", at: 3000, note: "Joe" })],
  });
  const input = {
    meeting: { id: "m", roomId: "r", startedAt: 1000, endedAt: 9000, summary: null },
    roomName: "Conxt",
    groups: [],
    decks: [],
    baseUrl: "https://stand.test",
    timeline,
  };
  assert.equal(buildBrief(input).timeline, undefined);
  const brief = buildBrief({ ...input, withTranscript: true });
  assert.deepEqual(
    brief.timeline?.map((e) => [e.kind, e.who, e.text]),
    [
      ["speech", "Joe", "Hello"],
      ["chat", "Huy", "the link"],
      ["ask", "Huy", "Who owns it?"],
    ],
  );
  const md = briefToMarkdown(brief);
  assert.match(md, /## Timeline/);
  assert.match(md, /Huy \(chat\): the link/);
  assert.match(md, /Huy asked Stand: Who owns it\?\n {2}- Stand: Joe/);
});

test("a question to Stand and an agent's report go under the item that was up", () => {
  const onB = { ...seg("s2", 3000, "Now the second slide"), itemId: "i2" };
  const cards = [card({ id: "c1", question: "Early?", at: 1500, note: "Yes" }), card({ id: "c2", question: "Later?", at: 3500, status: "working" })];
  const updates = [update({ id: "u1", ts: 3600, status: "added", itemId: "elsewhere" })];
  // A live call: no focus log, so the last line before it says where it was.
  const live = buildTimeline({ ...base, meeting: { startedAt: 1000, endedAt: null }, segments: [seg("s1", 1000, "First slide"), onB], cards, updates });
  assert.deepEqual(
    live.filter((e) => e.kind !== "speech").map((e) => [e.id, e.itemId, e.pending ?? false]),
    [
      ["ask:c1", "i1", false],
      ["ask:c2", "i2", true],
      ["agent:u1", "i2", false],
    ],
  );
  // A finished meeting: the focus log decides, even with nothing said on the item yet.
  const done = buildTimeline({ ...base, segments: [seg("s1", 1000, "First slide")], cards, focus: [{ id: "f1", ts: 3400, itemId: "i3", actor: "Joe", reason: "manual" }] });
  assert.equal(done.find((e) => e.id === "ask:c2")?.itemId, "i3");
});

const view = (more: Partial<import("../shared/timeline.ts").StageView> = {}) => ({ itemId: "i1", tab: "main" as const, taskMode: null, shot: null, snapId: null, sharing: null, ...more });
const slide = { id: "i1", title: "Saved cards at checkout", externalId: null, slideNo: 2, slide: { review: { name: "Saved cards" } }, taskId: null } as never;

test("what was on screen: a capture and a pointing line carry it, a plain line doesn't", () => {
  const t = buildTimeline({
    ...base,
    segments: [seg("s1", 2000, "Let's talk about retention"), seg("s2", 3000, "As you can see here, the total is cut off"), seg("s3", 6000, "This button is too small")],
    notes: [note("n1", 3500, "action", "Fix the total", { quote: { segmentId: "s2", ts: 3000, speaker: "Joe", text: "the total is cut off" } })],
    stage: [
      { id: "g1", ts: 1500, view: view() },
      { id: "g2", ts: 2500, view: view({ sharing: "Priya Shah" }) },
      { id: "g3", ts: 5000, view: view() },
    ],
    snaps: [
      { id: "p0", ts: 1000, caption: "an old still", url: "/api/snaps/p0.jpg?v=1" },
      { id: "p1", ts: 2800, caption: "the checkout page", url: "/api/snaps/p1.jpg?v=1" },
    ],
    itemById: (id) => (id === "i1" ? slide : null),
  });
  const by = (id: string) => t.find((e) => e.id === id)!;
  assert.equal(by("speech:s1").shown, undefined);
  // Said while Priya shared: the last still taken of that share, not one from before it.
  assert.deepEqual([by("speech:s2").points, by("speech:s2").shown?.kind, by("speech:s2").shown?.label, by("speech:s2").shown?.snapId], [true, "screen", "Priya's screen: the checkout page", "p1"]);
  assert.equal(by("capture:n1").shown?.label, "Priya's screen: the checkout page");
  // After the share: the slide itself, named once (its title already starts with its short name).
  assert.deepEqual([by("speech:s3").points, by("speech:s3").shown?.kind, by("speech:s3").shown?.label], [true, "slide", "Saved cards at checkout"]);
  // The share starting and stopping show as lines of their own; the first view (just the item) doesn't.
  assert.deepEqual(
    t.filter((e) => e.id.startsWith("stage:")).map((e) => e.text),
    ["Priya Shah started sharing their screen", "Priya Shah stopped sharing"],
  );
});

test("what was on screen: a presented to-do's spec gives its ref; a plain agenda line gives nothing to point at", () => {
  const task = { id: "i1", title: "Build the retry worker", externalId: null, slideNo: null, slide: null, taskId: "n9" } as never;
  const spec = buildTimeline({
    ...base,
    notes: [note("n1", 3000, "decision", "Cap retries at five")],
    stage: [{ id: "g1", ts: 1500, view: view({ taskMode: "spec" }) }],
    itemById: () => task,
  });
  assert.deepEqual(spec.find((e) => e.id === "capture:n1")?.shown, { kind: "spec", label: "Full spec: Build the retry worker", itemId: "i1", ref: "stand:action/n9" });
  const plain = buildTimeline({ ...base, segments: [seg("s1", 2000, "Look at this button")], itemById: () => ({ id: "i1", title: "Pricing", externalId: null, slideNo: null, slide: null }) as never });
  assert.equal(plain[0].points, undefined);
});
