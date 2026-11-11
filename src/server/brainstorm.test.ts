import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrainCaught, Segment } from "../shared/protocol.ts";
import { type MapAnswer, MapKeeper, brainstormOfMeeting, brainstormPage, brainstormsOf, finishBrainstorm, starIdea, startBrainstorm } from "./brainstorm.ts";
import { openDb } from "./db.ts";

const T0 = 1_000_000;
const seg = (n: number, who: string, text: string): Segment => ({ id: `s${n}`, meetingId: "m", itemId: null, speakerId: who, speakerName: who, kind: "speech", text, ts: T0 + n * 1000 });
const empty: MapAnswer = { add: [], extend: [], caught: [] };

/** A model that answers from a script and keeps what it was shown. */
function scripted(answers: Array<Partial<MapAnswer> | null>) {
  const asked: string[] = [];
  return {
    asked,
    async brainstormMap(context: string, talk: string) {
      asked.push(`${context}\n${talk}`);
      const a = answers.shift();
      return a === null ? null : { ...empty, ...a };
    },
  };
}

test("the map grows from the talk: directions off the centre, ideas under them, and nothing is added twice", async () => {
  const model = scripted([
    {
      add: [
        { under: "root", label: "Onboarding.", detail: "Ways to get a new team going.", by: "Huy Ngo", line: 2 },
        { under: "new1", label: "Welcome video", detail: "A short video on first sign-in.", by: "Huy", line: 2 },
        { under: "d9", label: "Lost idea", detail: "Names a direction that isn't there.", by: null, line: 2 },
      ],
    },
    {
      add: [
        { under: "root", label: "Onboarding", detail: "Same direction again.", by: "Joe", line: 1 },
        { under: "d1", label: "A welcome video", detail: "Said again in other words.", by: "Joe", line: 1 },
        { under: "d1", label: "Sample space", detail: "Start every team with a filled-in space.", by: "Joe", line: 1 },
      ],
      extend: [{ id: "i1", point: "Keep it under a minute", by: "Joe", line: 1 }],
      caught: [{ id: "i2", item: "li_1" }, { id: "i2", item: "li_404" }],
    },
  ]);
  const map = new MapKeeper(model, "How do new teams get value in week one?", T0);
  const talk = [seg(1, "Joe Liang", "ok let's start"), seg(2, "Huy Ngo", "what about a welcome video when they first sign in")];
  assert.equal(map.unreadSince(talk), talk[0].ts);
  assert.equal(await map.run(talk, ["Joe Liang", "Huy Ngo"], [], T0, T0 + 5000), true);
  assert.deepEqual(map.all().map((n) => [n.id, n.parent, n.label, n.by]), [
    ["d1", null, "Onboarding", "Huy"],
    ["i1", "d1", "Welcome video", "Huy"],
  ]);
  assert.equal(map.all()[1].quote!.text, "what about a welcome video when they first sign in");
  assert.match(model.asked[0], /The centre of the map: How do new teams get value in week one\?/);
  assert.match(model.asked[0], /NEW \[2\] \[0:02\] Huy Ngo: what about/);
  // Nothing new said: no pass.
  assert.equal(map.unreadSince(talk), null);
  assert.equal(await map.run(talk, [], [], T0, T0 + 6000), false);
  assert.equal(model.asked.length, 1);

  const caught: BrainCaught[] = [{ id: "li_1", kind: "action", text: "Draft the sample space", owner: "Joe", done: false }];
  talk.push(seg(9, "Joe Liang", "or every team starts with a sample space, and keep the video short"));
  assert.equal(await map.run(talk, [], caught, T0, T0 + 12_000), true);
  assert.match(model.asked[1], /- \[d1\] Onboarding \(Huy\)[^\n]*\n {2}- \[i1\] Welcome video/);
  assert.match(model.asked[1], /\[li_1\] action: Draft the sample space/);
  assert.deepEqual(map.all().map((n) => n.label), ["Onboarding", "Welcome video", "Sample space"]);
  assert.deepEqual(map.all()[1].points.map((p) => [p.text, p.by]), [["Keep it under a minute", "Joe"]]);
  assert.deepEqual(map.all()[2].caught, caught);
  // A caught line that was ticked off shows so; one that was taken back leaves its circle.
  assert.equal(map.refresh([{ ...caught[0], done: true }]), true);
  assert.equal(map.all()[2].caught[0].done, true);
  assert.equal(map.refresh([]), true);
  assert.deepEqual(map.all()[2].caught, []);
});

test("a circle someone took off stays off, and a model that can't answer changes nothing", async () => {
  const model = scripted([
    { add: [{ under: "root", label: "Pricing", detail: "Charge differently.", by: "Joe", line: 1 }, { under: "new1", label: "Free for small teams", detail: "No charge under five people.", by: "Joe", line: 1 }] },
    null,
    { add: [{ under: "root", label: "Pricing", detail: "Again.", by: "Huy", line: 1 }, { under: "new1", label: "Annual discount", detail: "Cheaper by the year.", by: "Huy", line: 1 }] },
  ]);
  const map = new MapKeeper(model, "Growth", T0);
  const talk = [seg(1, "Joe", "free for small teams")];
  await map.run(talk, [], [], T0, T0 + 2000);
  assert.equal(map.remove("d1"), true);
  assert.equal(map.remove("d1"), false);
  assert.deepEqual(map.all().map((n) => !!n.removed), [true, true]);
  talk.push(seg(5, "Huy", "hmm"));
  assert.equal(await map.run(talk, [], [], T0, T0 + 6000), false);
  talk.push(seg(8, "Huy", "pricing again, annual discount"));
  assert.equal(await map.run(talk, [], [], T0, T0 + 9000), false);
  assert.match(model.asked[2], /Taken off by the team, never add these again:\n- Pricing\n- Free for small teams/);
  assert.equal(map.all().length, 2);
  // A saved map picks up where it left off: ids keep counting, and talk it has read stays read.
  const again = new MapKeeper(scripted([]), "Growth", T0, map.all());
  assert.equal(again.unreadSince(talk), talk[1].ts);
});

test("a brainstorm leads the agenda while it runs, and keeps its page after the call", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Conxt 1.0", null, "");
  const other = db.createRoom("Elsewhere", null, "");
  db.addItems(room.id, [{ source: "agenda", externalId: null, title: "Roadmap", url: null, description: null }]);
  assert.throws(() => startBrainstorm(db, room.id, "   ", "Joe Liang"), /topic or a question/);
  const b = startBrainstorm(db, room.id, "  How should a  review start? ", "Joe Liang", T0);
  assert.equal(b.prompt, "How should a review start?");
  assert.deepEqual(db.listItems(room.id).map((i) => i.title), ["How should a review start?", "Roadmap"]);
  // The same sentence again is the same brainstorm; another one takes its place.
  assert.equal(startBrainstorm(db, room.id, "How should a review start?", "Huy Ngo").id, b.id);
  const next = startBrainstorm(db, room.id, "Pricing", "Huy Ngo", T0 + 10);
  assert.notEqual(next.id, b.id);
  assert.deepEqual(db.listItems(room.id).map((i) => i.title), ["Pricing", "Roadmap"]);
  assert.deepEqual(brainstormsOf(db, room.id).map((x) => [x.prompt, x.status]), [["Pricing", "live"], ["How should a review start?", "done"]]);

  db.saveBrainstormMap(next.id, [
    { id: "d1", parent: null, label: "Plans", detail: null, by: "Huy", ts: T0, quote: null, points: [], caught: [] },
    { id: "i1", parent: "d1", label: "Free tier", detail: null, by: "Huy", ts: T0, quote: null, points: [], caught: [] },
    { id: "i2", parent: "d1", label: "Wrong one", detail: null, by: null, ts: T0, quote: null, points: [], caught: [], removed: true },
  ]);
  const m = db.startMeeting(room.id);
  const done = finishBrainstorm(db, room.id, m.id, T0 + 99)!;
  assert.deepEqual([done.status, done.meetingId, done.endedAt], ["done", m.id, T0 + 99]);
  assert.deepEqual(db.listItems(room.id).map((i) => i.title), ["Roadmap"]);
  assert.equal(finishBrainstorm(db, room.id, m.id), null);
  // Its page shows what's on the map, to its own space only.
  assert.deepEqual(brainstormPage(db, room.id, next.id)!.nodes.map((n) => n.label), ["Plans", "Free tier"]);
  assert.equal(brainstormPage(db, other.id, next.id), null);
  // An idea can be starred from the page: only an idea, only one on the map, only in its own space.
  assert.deepEqual(starIdea(db, room.id, next.id, "i1", true)!.starred, ["i1"]);
  assert.deepEqual(starIdea(db, room.id, next.id, "i1", true)!.starred, ["i1"]);
  assert.equal(starIdea(db, room.id, next.id, "d1", true), null);
  assert.equal(starIdea(db, room.id, next.id, "i2", true), null);
  assert.equal(starIdea(db, other.id, next.id, "i1", true), null);
  assert.deepEqual(brainstormPage(db, room.id, next.id)!.starred, ["i1"]);
  assert.equal(starIdea(db, room.id, next.id, "i1", false)!.starred, undefined);
  assert.deepEqual(brainstormOfMeeting(db, m.id), { id: next.id, prompt: "Pricing", status: "done", startedAt: T0 + 10, meetingId: m.id, directions: 1, ideas: 1 });
});
