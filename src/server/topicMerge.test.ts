import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { HeuristicAgent, type ItemNotesDraft } from "./llm.ts";
import { RoomSession } from "./room.ts";
import { applyMerges, mainCount, mergePrompt, planMerge, rankTopics } from "./topicMerge.ts";
import type { Discussion, Note, Segment } from "../shared/protocol.ts";
import { chapterOf, stretches } from "../shared/chapters.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 10);

/** A meeting's talk: each topic gets `lines` remarks a few seconds apart, one topic after another. */
function meeting(topics: Array<{ id: string; itemId?: string | null; lines: number; speakers?: number; gapAfter?: number }>) {
  const segments: Segment[] = [];
  const discussions: Discussion[] = [];
  let t = T0;
  for (const top of topics) {
    const ids: string[] = [];
    for (let i = 0; i < top.lines; i++) {
      const id = `${top.id}-${i}`;
      segments.push({ id, meetingId: "m", itemId: top.itemId ?? null, speakerId: `p${i % (top.speakers ?? 2)}`, speakerName: `P${i % (top.speakers ?? 2)}`, kind: "speech", text: "…", ts: t });
      ids.push(id);
      t += 20_000;
    }
    t += top.gapAfter ?? 0;
    discussions.push({ id: top.id, meetingId: "m", itemId: top.itemId ?? null, topic: `Topic ${top.id}`, positions: [], outcome: "open", segmentIds: ids, continues: null, ts: T0 });
  }
  return { segments, discussions, end: t };
}
const note = (discussionId: string, kind: Note["kind"], text: string = kind): Note => ({
  id: `${discussionId}-${kind}-${text}`,
  meetingId: "m",
  itemId: null,
  kind,
  text,
  owner: null,
  ts: T0,
  doneAt: null,
  doneBy: null,
  discussionId,
});

test("topics rank by talk, people and what came of them; a meeting keeps 3 to 6 main ones", () => {
  const { segments, discussions, end } = meeting([
    { id: "long", lines: 40, speakers: 3 },
    { id: "aside", lines: 3 },
    { id: "decided", lines: 4 },
  ]);
  const ranked = rankTopics(discussions, segments, [note("decided", "decision"), note("decided", "action")], end);
  assert.deepEqual(
    ranked.map((t) => t.d.id),
    ["long", "decided", "aside"],
  );
  assert.equal(Math.round(ranked[0].minutes), 13, "each remark counts until the next one");
  assert.deepEqual([mainCount(10), mainCount(30), mainCount(100)], [3, 5, 6]);
});

test("the plan only changes when a topic starts, settles or moves in or out of the main ones", () => {
  const talk = meeting([{ id: "a", lines: 12 }, { id: "b", lines: 8 }, { id: "c", lines: 5 }, { id: "d", lines: 2 }, { id: "e", lines: 1 }]);
  const plan = planMerge(talk.discussions, talk.segments, [], talk.end);
  assert.deepEqual(plan.main.map((t) => t.d.id), ["a", "b", "c"]);
  assert.deepEqual(plan.small.map((t) => t.d.id), ["d", "e"]);
  assert.equal(planMerge(talk.discussions, talk.segments, [], talk.end + 1000).sig, plan.sig);
  const later = planMerge(talk.discussions, talk.segments, [], talk.end + 20 * MIN);
  assert.notEqual(later.sig, plan.sig, "everything settled");
});

test("a smaller topic goes into a main topic of its own item, or a group of two or more", () => {
  const talk = meeting([
    { id: "pricing", itemId: "i1", lines: 10 },
    { id: "rollout", itemId: "i2", lines: 9 },
    { id: "hiring", itemId: "i2", lines: 8 },
    { id: "tiers", itemId: "i1", lines: 2 },
    { id: "login", itemId: "i2", lines: 1 },
    { id: "sso", itemId: "i2", lines: 1 },
    { id: "lunch", itemId: "i2", lines: 1 },
    { id: "trial", itemId: "i2", lines: 1 },
  ]);
  const plan = planMerge(talk.discussions, talk.segments, [note("tiers", "question", "Monthly too?")], talk.end);
  const { text, keys } = mergePrompt(plan, (id) => (id === "i1" ? "Pricing page" : "Launch"));
  assert.match(text, /^Agenda item: Pricing page\nMain topics:\n- T1 Topic pricing \(10 remarks\)\nSmaller topics:\n- T\d Topic tiers \(2 remarks\)\n {2}Open: Monthly too\?/);
  const key = (id: string) => [...keys].find(([, t]) => t.d.id === id)![0];
  const merges = applyMerges(plan, keys, [
    { key: key("tiers"), into: key("pricing") },
    { key: key("login"), into: "Sign-in problems" },
    { key: key("sso"), into: "sign-in problems" },
    { key: key("lunch"), into: "Food" },
    // Another item's main topic: not allowed.
    { key: key("trial"), into: key("pricing") },
    { key: "T99", into: key("pricing") },
  ]);
  assert.deepEqual(merges, [
    { discussionId: "tiers", parentId: "pricing", group: null },
    { discussionId: "login", parentId: null, group: "Sign-in problems" },
    { discussionId: "sso", parentId: null, group: "sign-in problems" },
  ]);
});

test("a topic keeps its id when a run renames it, and its place on the board with it", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const m = db.startMeeting(room.id);
  const draft = (topic: string, segmentIds: string[]) => ({ topic, positions: [], outcome: "open" as const, segmentIds, continuesId: null });
  const [big, small] = db.replaceDiscussions(m.id, null, [draft("Pricing", ["s1", "s2", "s3", "s4"]), draft("Tiers", ["s5"])]);
  db.replaceTopicMerges(m.id, [{ discussionId: small.id, parentId: big.id, group: null }]);
  const [renamed, split, same] = db.replaceDiscussions(m.id, null, [
    draft("Pricing for teams", ["s1", "s2", "s3", "s6"]),
    draft("Annual plans", ["s4"]),
    draft("tiers", ["s5", "s7"]),
  ]);
  assert.equal(renamed.id, big.id, "holds most of its lines");
  assert.notEqual(split.id, big.id);
  assert.equal(same.id, small.id, "same name");
  assert.equal(same.mergedInto, big.id);
  assert.equal(renamed.mergedInto, null);
  db.replaceTopicMerges(m.id, []);
  assert.equal(db.getDiscussion(small.id)?.mergedInto, null);
});

test("a run that writes the same note twice keeps one, and every note gets its own id", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const m = db.startMeeting(room.id);
  const [kept] = db.replaceNotes(m.id, null, [{ kind: "decision", text: "Ship Friday", owner: null }]);
  const notes = db.replaceNotes(m.id, null, [
    { kind: "decision", text: "Ship Friday", owner: null },
    { kind: "decision", text: "Ship Friday", owner: null, id: kept.id },
    { kind: "decision", text: "Ship Friday", owner: null, discussionId: "other" },
    { kind: "action", text: "Write the notes", owner: "Joe" },
    { kind: "action", text: "Write the notes", owner: "Joe" },
  ]);
  assert.deepEqual(
    notes.map((n) => [n.text, n.discussionId]),
    [
      ["Ship Friday", null],
      ["Ship Friday", "other"],
      ["Write the notes", null],
    ],
  );
  assert.equal(notes[0].id, kept.id);
  assert.equal(new Set(notes.map((n) => n.id)).size, 3);
});

test("the room places smaller topics after a notes run, and again on the tidy model as the meeting ends", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const calls: Array<{ prompt: string; final: boolean }> = [];
  const topics = ["Pricing", "Rollout", "Hiring", "Tiers", "Lunch"];
  const agent = Object.assign(new HeuristicAgent(), {
    async notesFor(_item: unknown, segments: Segment[]): Promise<ItemNotesDraft> {
      // Each topic gets a share of the lines: the first ones most.
      const share = [0.4, 0.25, 0.2, 0.1, 0.05];
      let at = 0;
      return {
        notes: [],
        discussions: topics.map((topic, k) => {
          const n = Math.max(1, Math.round(segments.length * share[k]));
          const turns = segments.slice(at, at + n).map((_, j) => at + j);
          at += n;
          return { topic, positions: [], outcome: "open", continuesId: null, segmentIndexes: turns, picksUp: null };
        }),
      };
    },
    async mergeTopics(prompt: string, final: boolean) {
      calls.push({ prompt, final });
      const key = (title: string) => prompt.match(new RegExp(`- (T\\d+) ${title}`))![1];
      return [
        { key: key("Tiers"), into: key("Pricing") },
        { key: key("Lunch"), into: "Food" },
      ];
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const internals = session as unknown as { refreshNotes(id: string | null): Promise<Note[]>; mergeRun: Promise<void> };
  const t = Date.now() - 20 * MIN;
  for (let i = 0; i < 40; i++) session.addSpeech(`p${i % 3}`, `P${i % 3}`, `Remark ${i}`, t + i * 20_000);
  await internals.refreshNotes(null);
  await new Promise((r) => setTimeout(r, 20));
  await internals.mergeRun;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].final, false);
  const byTopic = new Map(db.meetingDiscussions(session.meetingId).map((d) => [d.topic, d]));
  assert.equal(byTopic.get("Tiers")?.mergedInto, byTopic.get("Pricing")?.id);
  assert.equal(byTopic.get("Lunch")?.group ?? null, null, "a group of one stays as it is");

  // Nothing new: no call.
  await internals.refreshNotes(null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);

  await session.end();
  assert.equal(calls.at(-1)?.final, true);
});

test("the chapter bar: placed topics join their chapter, and an aside under a minute doesn't cut a stretch in two", () => {
  const every = (from: number, to: number, step = 15_000) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => T0 + from + i * step);
  const topics = [
    { id: "pricing", itemId: null, times: [...every(0, 5 * MIN), ...every(5.5 * MIN, 9 * MIN)] },
    { id: "aside", itemId: null, times: [T0 + 5 * MIN + 15_000] },
    { id: "tiers", itemId: null, mergedInto: "pricing", times: every(9.25 * MIN, 11 * MIN) },
    { id: "login", itemId: null, group: "Sign-in", times: every(11.25 * MIN, 13 * MIN) },
    { id: "sso", itemId: null, group: "sign-in", times: every(13.25 * MIN, 15 * MIN) },
    { id: "lunch", itemId: null, times: [T0 + 15.25 * MIN] },
  ];
  const byId = new Map(topics.map((t) => [t.id, t]));
  assert.equal(chapterOf(topics[2], byId), "pricing");
  assert.equal(chapterOf(topics[3], byId), chapterOf(topics[4], byId));
  const now = T0 + 15.5 * MIN;
  assert.deepEqual(
    stretches(topics, "lunch", now).map((s) => [s.chapter, (s.from - T0) / MIN]),
    [
      ["pricing", 0],
      ["group::sign-in", 11.25],
      ["lunch", 15.25],
    ],
    "the live chapter stays, however short",
  );
  assert.deepEqual(
    stretches(topics, null, now).map((s) => s.chapter),
    ["pricing", "group::sign-in"],
  );
});
