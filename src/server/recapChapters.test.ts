import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief, briefToMarkdown, offset } from "./brief.ts";
import type { Discussion, Note, Segment } from "../shared/protocol.ts";
import { meetingChapters } from "../shared/chapters.ts";

const T0 = Date.UTC(2026, 9, 12, 10);

/** Topics talked about one after another, `lines` remarks each, 20 s apart. */
function talk(topics: Array<{ id: string; lines: number; outcome?: Discussion["outcome"]; mergedInto?: string; group?: string }>) {
  const segments: Segment[] = [];
  const discussions: Discussion[] = [];
  let t = T0 + 30_000;
  for (const top of topics) {
    const ids: string[] = [];
    for (let i = 0; i < top.lines; i++) {
      const id = `${top.id}-${i}`;
      segments.push({ id, meetingId: "m", itemId: null, speakerId: `p${i % 2}`, speakerName: i % 2 ? "Huy Ngo" : "Joe Liang", kind: "speech", text: `line ${i}`, ts: t });
      ids.push(id);
      t += 20_000;
    }
    discussions.push({
      id: top.id,
      meetingId: "m",
      itemId: null,
      topic: `Topic ${top.id}`,
      positions: [{ speaker: "Joe Liang", position: `on ${top.id}` }],
      outcome: top.outcome ?? "open",
      segmentIds: ids,
      continues: null,
      mergedInto: top.mergedInto ?? null,
      group: top.group ?? null,
      ts: T0,
    });
  }
  return { segments, discussions, end: t };
}

const note = (discussionId: string, kind: Note["kind"], text: string): Note => ({
  id: `${discussionId}-${text}`,
  meetingId: "m",
  itemId: null,
  kind,
  text,
  owner: kind === "action" ? "Joe Liang" : null,
  ts: T0,
  doneAt: null,
  doneBy: null,
  discussionId,
  editedBy: null,
});

test("a meeting's chapters: a topic placed inside another is part of it, groups gather, all in the order talked about", () => {
  const { segments, discussions } = talk([
    { id: "a", lines: 40, outcome: "decided" },
    { id: "b", lines: 4, outcome: "action", mergedInto: "a" },
    { id: "c", lines: 6, outcome: "info", group: "Login" },
    { id: "d", lines: 6, outcome: "action", group: "Login" },
  ]);
  const chapters = meetingChapters(discussions, segments);
  assert.deepEqual(
    chapters.map((c) => [c.key, c.title, c.topicIds, c.outcome]),
    [
      ["a", "Topic a", ["a", "b"], "decided"],
      ["group::login", "Login", ["c", "d"], "action"],
    ],
  );
  assert.equal(chapters[0].segmentIds.length, 44);
  assert.deepEqual(chapters[0].speakers, ["Joe Liang", "Huy Ngo"]);
  assert.ok(Math.abs(chapters[0].minutes - (44 * 20) / 60) < 0.5);
  assert.ok(chapters[0].stretches.length >= 1);
  assert.equal(chapters[0].start, T0 + 30_000);
});

test("the brief lists chapters with the recap's crux and moments, and each action names its chapter", () => {
  const { segments, discussions, end } = talk([
    { id: "a", lines: 40, outcome: "decided" },
    { id: "b", lines: 6, outcome: "open" },
  ]);
  const notes = [note("a", "action", "Build ingestion"), note("a", "decision", "Keep them separate"), note("b", "question", "Store or link?")];
  const brief = buildBrief({
    meeting: {
      id: "m",
      roomId: "r",
      startedAt: T0,
      endedAt: end,
      summary: "They kept them separate.",
      chapters: [{ key: "a", crux: "Kept separate for now.", moments: [{ segmentId: "a-3", ts: segments[3].ts, text: "Andy: pick a lane" }] }],
    },
    roomName: "CoNxt",
    groups: [{ item: null, segments, notes, discussions }],
    decks: [],
    baseUrl: "https://stand.test",
  });
  assert.deepEqual(
    brief.chapters.map((c) => [c.at, c.title, c.outcome, c.crux, c.actionIds.length, c.decisions, c.openQuestions]),
    [
      ["0:30", "Topic a", "decided", "Kept separate for now.", 1, ["Keep them separate"], []],
      ["13:50", "Topic b", "open", null, 0, [], ["Store or link?"]],
    ],
  );
  assert.deepEqual(brief.chapters[0].moments.map((x) => [x.at, x.text]), [["1:30", "Andy: pick a lane"]]);
  assert.deepEqual(brief.actions[0].chapter, { key: "a", title: "Topic a", at: "0:30" });
  const md = briefToMarkdown(brief);
  assert.match(md, /## Chapters\n\n### 0:30 · Topic a · 13 min · decided\n\nKept separate for now\.\n\n- 1:30 Andy: pick a lane/);
});

test("offsets read like a video's chapters", () => {
  assert.equal(offset(T0 + 921_000, T0), "15:21");
  assert.equal(offset(T0 + 3_724_000, T0), "1:02:04");
  assert.equal(offset(T0 - 5_000, T0), "0:00");
});
