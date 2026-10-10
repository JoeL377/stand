import assert from "node:assert/strict";
import { test } from "node:test";
import type { Discussion, Note, Segment } from "../shared/protocol.ts";
import { openDb } from "./db.ts";
import { HeuristicAgent } from "./llm.ts";
import { RoomSession } from "./room.ts";
import { linkSnaps, type SnapRow } from "./snaps.ts";

const seg = (id: string, ts: number, itemId = "a"): Segment =>
  ({ id, meetingId: "m", itemId, speakerId: "p", speakerName: "Huy", kind: "speech", text: id, ts }) as Segment;
const topic = (id: string, segmentIds: string[]): Discussion =>
  ({ id, meetingId: "m", itemId: "a", topic: id, positions: [], outcome: "open", segmentIds, continues: null, ts: 0 }) as Discussion;
const row = (ts: number, itemId: string | null = "a"): SnapRow => ({
  id: "s1",
  roomId: "r",
  meetingId: "m",
  itemId,
  ts,
  ext: "jpg",
  version: 2,
  width: 1920,
  height: 1080,
  source: "person",
  takenById: "u",
  takenBy: "Huy Ngo",
  sharerId: "j",
  sharerName: "Joe",
  caption: null,
  noteId: null,
});

test("a snap links to the remarks around it and the topic most of them belong to", () => {
  const segments = [seg("g1", 0), seg("g2", 100_000), seg("g3", 130_000), seg("g4", 150_000), seg("g5", 140_000, "b")];
  const discussions = [topic("t1", ["g1"]), topic("t2", ["g2", "g3"]), topic("t3", ["g4"])];
  const [s] = linkSnaps([row(135_000)], segments, discussions, "https://stand.test");
  assert.equal(s.url, "https://stand.test/api/snaps/s1.jpg?v=2");
  assert.deepEqual(s.segmentIds, ["g2", "g3", "g4"]);
  assert.equal(s.discussionId, "t2");
  // Nothing said close by: the topic of the nearest remark, if it's within two minutes.
  assert.equal(linkSnaps([row(250_000)], segments, discussions)[0].discussionId, "t3");
  assert.deepEqual(linkSnaps([row(250_000)], segments, discussions)[0].segmentIds, []);
  assert.equal(linkSnaps([row(400_000)], segments, discussions)[0].discussionId, null);
});

test("snaps pin to the item in focus when taken, get a caption, and the agent keeps a frame only when it backs a note", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Standup", null);
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Billing", url: null, description: null }]);
  let asked = 0;
  const agent = Object.assign(new HeuristicAgent(), {
    describeSnap: async () => "Stripe dashboard: 3 failed renewals",
    frameBacks: async (_i: unknown, _it: unknown, notes: Array<{ key: string }>) =>
      ++asked === 1 ? { key: notes[0].key, caption: "Retry setting at 3" } : null,
  });
  const session = new RoomSession(db, agent, room, () => {});
  const id = session.addSnap({
    buf: Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ext: "jpg",
    width: 1920,
    height: 1080,
    at: Date.now(),
    takenById: "u1",
    takenBy: "Huy Ngo",
  });
  await new Promise((r) => setTimeout(r, 10));
  const [snap] = session.state().snaps;
  assert.equal(snap.id, id);
  assert.equal(snap.itemId, item.id);
  assert.equal(snap.caption, "Stripe dashboard: 3 failed renewals");

  const s = session as unknown as {
    seen: { dataUrl: string; at: number; itemId: string | null };
    keepBackingFrame(itemId: string | null, notes: unknown[]): Promise<void>;
  };
  const note = db.addNote(session.meetingId, item.id, { kind: "decision", text: "Retry three times", owner: null }, null);
  s.seen = { dataUrl: "data:image/jpeg;base64,/9j/AAAA", at: Date.now(), itemId: item.id };
  await s.keepBackingFrame(item.id, [note]);
  await s.keepBackingFrame(item.id, [note]);
  const kept = session.state().snaps.filter((p) => p.source === "agent");
  assert.equal(asked, 1, "the same frame is only weighed once");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].noteId, note.id);
  assert.equal(kept[0].caption, "Retry setting at 3");
});

test("the recap sees the snaps and puts each under the note it backs or the topic it was discussed in; the brief carries the same", async () => {
  const { buildBrief, briefToMarkdown } = await import("./brief.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Standup", null);
  const [item] = db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Billing", url: null, description: null }]);
  const screensSeen: unknown[] = [];
  let recapIn: import("./llm.ts").RecapInput | null = null;
  const agent = Object.assign(new HeuristicAgent(), {
    describeSnap: async () => "Stripe dashboard",
    notesFor: async (_i: unknown, _s: unknown, _e: unknown, _c: unknown, screens?: unknown[]) => {
      screensSeen.push(screens);
      return {
        notes: [
          { kind: "action" as const, text: "Lower retries to 3", owner: "Huy", discussion: 0 },
          { kind: "decision" as const, text: "Keep the annual toggle", owner: null, discussion: 1 },
        ],
        discussions: [
          { topic: "Retry policy", positions: [], outcome: "action" as const, segmentIndexes: [0], continuesId: null },
          { topic: "Pricing page", positions: [], outcome: "decided" as const, segmentIndexes: [1], continuesId: null },
        ],
      };
    },
    recapMeeting: async (input: import("./llm.ts").RecapInput) => {
      recapIn = input;
      const g = input.items[0];
      const todo = g.notes.find((n) => n.kind === "action")!;
      return {
        summary: "Retries go down to three.",
        snaps: [
          { id: input.snaps[0].id, noteId: todo.id, discussionId: todo.discussionId, caption: "Failed renewals chart: why retries drop to 3" },
          { id: input.snaps[1].id, noteId: null, discussionId: g.topics[1].id, caption: "Pricing page mock the team reviewed" },
        ],
      };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const t0 = Date.now();
  session.addSpeech("p1", "Huy", "Renewals keep failing, I'll lower retries to three", t0);
  session.addSpeech("p2", "Joe", "And we keep the annual toggle on the pricing page", t0 + 5);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const snap = (at: number, pasted = false) =>
    session.addSnap({ buf: jpeg, ext: "jpg", width: 800, height: 600, at, takenById: "u1", takenBy: "Huy Ngo", pasted });
  const chart = snap(t0);
  const mock = snap(t0, true);
  await new Promise((r) => setTimeout(r, 10));

  // The live notes get what was on screen as words, never the image.
  await (session as unknown as { refreshNotes(id: string): Promise<unknown> }).refreshNotes(item.id);
  assert.deepEqual((screensSeen[0] as Array<{ caption: string }>).map((s) => s.caption), ["Stripe dashboard", "Stripe dashboard"]);

  await session.end();
  assert.equal(recapIn!.snaps.length, 2);
  assert.equal(recapIn!.snaps[0].image.mediaType, "image/jpeg");
  assert.equal(recapIn!.snaps[0].image.data, jpeg.toString("base64"));
  assert.ok(recapIn!.snaps[0].said.some((l) => l.startsWith("Huy: Renewals")));
  assert.equal(db.getMeeting(session.meetingId)?.summary, "Retries go down to three.");

  const segments = db.meetingSegments(session.meetingId);
  const discussions = db.meetingDiscussions(session.meetingId);
  const notes = db.meetingNotes(session.meetingId);
  const linked = linkSnaps(db.meetingSnaps(session.meetingId), segments, discussions, "");
  const todo = notes.find((n) => n.kind === "action")!;
  const pricing = discussions.find((d) => d.topic === "Pricing page")!;
  const [a, b] = [linked.find((s) => s.id === chart)!, linked.find((s) => s.id === mock)!];
  assert.equal(a.noteId, todo.id);
  assert.equal(a.caption, "Failed renewals chart: why retries drop to 3");
  assert.equal(b.noteId, null);
  assert.equal(b.discussionId, pricing.id, "the recap's topic wins over the remarks around it");

  const meeting = db.getMeeting(session.meetingId)!;
  const brief = buildBrief({
    meeting,
    roomName: room.name,
    decks: [],
    baseUrl: "https://stand.test",
    groups: [{ item, segments, notes, discussions, snaps: linked }],
  });
  assert.deepEqual(brief.actions[0].images?.map((p) => p.caption), ["Failed renewals chart: why retries drop to 3"]);
  assert.deepEqual(brief.decisions[0].images, []);
  const topic = brief.items[0].discussions.find((d) => d.topic === "Pricing page")!;
  assert.deepEqual(topic.images.map((p) => p.snapId), [mock]);
  assert.deepEqual(brief.items[0].discussions.find((d) => d.topic === "Retry policy")!.images, [], "one home per image");
  const md = briefToMarkdown(brief);
  assert.match(md, new RegExp(`- \\[ \\] Lower retries to 3 .*\\n  !\\[Failed renewals chart: why retries drop to 3\\]\\(https://stand.test/api/snaps/${chart}\\.jpg\\?v=1\\)`));
  assert.match(md, new RegExp(`!\\[Pricing page mock the team reviewed\\]\\(https://stand.test/api/snaps/${mock}\\.jpg`));
});

test("the recap call sends the images and maps its keys back to notes and topics", async () => {
  const { config } = await import("./config.ts");
  const { createAgent } = await import("./llm.ts");
  const was = config.anthropicKey;
  Object.assign(config, { anthropicKey: "test-key" });
  const agent = createAgent();
  Object.assign(config, { anthropicKey: was });
  let sent: Array<{ type: string; text?: string; source?: { data: string } }> = [];
  Object.assign(agent, {
    parse: async (_schema: unknown, content: typeof sent) => {
      sent = content;
      return {
        summary: "Short.",
        screenshots: [
          { key: "S1", note: "N2", topic: null, caption: "The error banner they decided to remove" },
          { key: "S2", note: null, topic: "T1", caption: "Funnel chart behind the drop-off talk" },
          { key: "S9", note: "N1", topic: null, caption: "No such screenshot" },
        ],
      };
    },
  });
  const note = (id: string, kind: Note["kind"], text: string, discussionId: string | null) =>
    ({ id, meetingId: "m", itemId: "a", kind, text, owner: null, ts: 0, doneAt: null, doneBy: null, discussionId }) as Note;
  const image = { data: "AAAA", mediaType: "image/jpeg" as const };
  const out = await agent.recapMeeting({
    items: [
      {
        item: null,
        notes: [note("n-sum", "summary", "Talked onboarding", null), note("n-todo", "action", "Fix step 3", "d1"), note("n-dec", "decision", "Drop the banner", "d1")],
        topics: [{ id: "d1", topic: "Onboarding drop-off" }],
      },
    ],
    snaps: [
      { id: "s-a", itemId: null, at: 0, by: "Joe", caption: null, said: ["Priya: that banner"], image },
      { id: "s-b", itemId: null, at: 1, by: "Joe", caption: "A chart", said: [], image },
    ],
  });
  assert.equal(sent.filter((b) => b.type === "image").length, 2);
  const text = sent.map((b) => b.text ?? "").join("\n");
  assert.match(text, /T1 topic: Onboarding drop-off/);
  assert.match(text, /N1 to-do: Fix step 3 \(under T1\)/);
  assert.match(text, /N2 decision: Drop the banner/);
  assert.match(text, /S1: saved by Joe[\s\S]*Priya: that banner/);
  assert.equal(out.summary, "Short.");
  assert.deepEqual(out.snaps, [
    { id: "s-a", noteId: "n-dec", discussionId: "d1", caption: "The error banner they decided to remove" },
    { id: "s-b", noteId: null, discussionId: "d1", caption: "Funnel chart behind the drop-off talk" },
  ]);
});
