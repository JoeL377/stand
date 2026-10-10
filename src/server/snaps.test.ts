import assert from "node:assert/strict";
import { test } from "node:test";
import type { Discussion, Segment } from "../shared/protocol.ts";
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
