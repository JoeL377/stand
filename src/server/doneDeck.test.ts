import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { DoneDecks, doneBasis, doneInput, donePrompt, plainSlides, slidesFrom } from "./doneDeck.ts";
import { HeuristicAgent, type DoneDeckDraft } from "./llm.ts";

const tick = () => new Promise((r) => setTimeout(r, 3));

/** A meeting two people talked in (or one, solo), with the to-dos it caught. */
async function meeting(db: ReturnType<typeof openDb>, roomId: string, people: string[], todos: Array<[string, string | null]> = []) {
  const m = db.startMeeting(roomId);
  for (const p of people) db.addSegment({ meetingId: m.id, itemId: null, speakerId: p, speakerName: p, kind: "speech", text: "hi", ts: Date.now() });
  const notes = todos.map(([text, owner]) => db.addNote(m.id, null, { kind: "action", text, owner }, null));
  await tick();
  db.endMeeting(m.id, null);
  await tick();
  return { m, notes };
}

test("the done pages count from the last meeting more than one person talked in, and cover only what closed since", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Conxt 1.0", null, "");
  const { m: real, notes } = await meeting(db, room.id, ["Joe Liang", "Huy Ngo"], [
    ["Add the mic picker", "Joe Liang"],
    ["Ask Andy for Railway access", "Huy Ngo"],
    ["Build the review queue", "Joe Liang"],
  ]);
  // A quick test on your own afterwards doesn't count as the last meeting.
  await meeting(db, room.id, ["Joe Liang"]);
  assert.equal(db.lastRealMeeting(room.id)?.id, real.id);

  db.setActionDone(room.id, notes[0].id, "Joe Liang via GitHub", "pr:https://github.com/JoeL377/stand/pull/41");
  db.setTaskState(room.id, notes[1].id, { state: "dropped", by: "Huy Ngo", reason: "Got it another way" });
  db.addUpdate({
    roomId: room.id,
    itemId: null,
    noteId: notes[2].id,
    noteText: notes[2].text,
    userId: "u1",
    userName: "Joe Liang",
    client: "Claude Code",
    status: "working",
    text: "Started on the queue",
    links: [],
  });

  const input = doneInput(db, room.id)!;
  assert.deepEqual(
    input.closed.map((n) => n.text),
    ["Add the mic picker", "Ask Andy for Railway access"],
  );
  assert.deepEqual(
    input.moving.map((n) => n.text),
    ["Build the review queue"],
  );
  const prompt = donePrompt(input);
  assert.match(prompt, /T1 · done \(PR #41 merged\).*Add the mic picker/);
  assert.match(prompt, /T2 · dropped \(Got it another way\).*Ask Andy for Railway access/);
  assert.match(prompt, /O1 · still open .*Build the review queue/);
  assert.match(prompt, /Claude Code \(working\): Started on the queue/);

  let calls = 0;
  const agent = Object.assign(new HeuristicAgent(), {
    doneDeck: async (): Promise<DoneDeckDraft> => {
      calls++;
      // It leaves out T2 and points at a key that doesn't exist.
      return { opening: "The mic is yours to pick now.", slides: [{ title: "Calls", lead: "The mic is yours to pick.", points: [{ text: "Pick your mic beside Mute", who: "Joe", tasks: ["T1", "T9"] }], shot: "S4" }] };
    },
  });
  let live = false;
  const decks = new DoneDecks(db, agent, () => live, () => {});
  await decks.run(room.id);
  const deck = db.getDoneDeck(room.id)!;
  assert.equal(deck.by, "claude");
  assert.equal(deck.summary, "The mic is yours to pick now.");
  assert.equal(deck.sinceMeetingId, real.id);
  assert.deepEqual([deck.closed, deck.dropped], [2, 1]);
  assert.deepEqual(deck.slides[0], {
    title: "Calls",
    lead: "The mic is yours to pick.",
    points: [{ text: "Pick your mic beside Mute", who: "Joe Liang", pr: "https://github.com/JoeL377/stand/pull/41", dropped: false }],
    shot: null,
  });
  // What it left out isn't lost.
  assert.deepEqual(deck.slides[1].title, "Also closed");
  assert.deepEqual(deck.slides[1].points, [{ text: "Ask Andy for Railway access", who: "Huy Ngo", pr: null, dropped: true }]);
  // Every page says what it is about, the leftovers too.
  assert.match(deck.slides[1].lead!, /^1 more task closed since \w+ \d+, as written on the to-dos\.$/);

  // Nothing new: no second pass. Something new: a pass, but never while a meeting is on.
  await decks.run(room.id);
  assert.equal(calls, 1);
  db.setActionDone(room.id, notes[2].id, "Joe Liang");
  live = true;
  await decks.run(room.id);
  assert.equal(calls, 1);
  live = false;
  await decks.run(room.id);
  assert.equal(calls, 2);
  decks.stop();
});

test("summary badges use task owners even when the model credits the closer or a reporter", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Stand", null, "");
  const { notes } = await meeting(db, room.id, ["Joe", "Janesh"], [
    ["Build task plans", "Janesh Chhabra"],
    ["Add comments", "Janesh Chhabra"],
    ["Fix avatars", "Huy Ngo"],
    ["Check pricing", null],
  ]);
  for (const n of notes) db.setActionDone(room.id, n.id, "Joe Liang via Claude");
  const input = doneInput(db, room.id)!;
  const points = slidesFrom(input, {
    opening: null,
    slides: [{ title: "Done", lead: null, shot: null, points: [
      { text: "Task plans work", who: "Joe", tasks: ["T1"] },
      { text: "Plans and comments work", who: "Joe", tasks: ["T1", "T2"] },
      { text: "Plans and avatars work", who: "Joe", tasks: ["T1", "T3"] },
      { text: "Pricing checked", who: "Joe", tasks: ["T4"] },
      { text: "Plans and pricing checked", who: "Joe", tasks: ["T1", "T4"] },
      { text: "Unsupported claim", who: "Joe", tasks: ["T99"] },
    ] }],
  })[0].points;
  assert.deepEqual(points.map((p) => p.who), ["Janesh Chhabra", "Janesh Chhabra", null, null, null]);
  assert.deepEqual(plainSlides(input, input.closed)[0].points.map((p) => p.who), ["Janesh Chhabra", "Janesh Chhabra", "Huy Ngo", null]);
});

test("changing an owner refreshes the cached summary, including work in flight", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Stand", null, "");
  const { notes } = await meeting(db, room.id, ["Joe", "Janesh"], [
    ["Build task plans", "Joe Liang"],
    ["Add comments", "Joe Liang"],
  ]);
  db.setActionDone(room.id, notes[0].id, "Joe Liang via Claude");
  db.addUpdate({ roomId: room.id, itemId: null, noteId: notes[1].id, noteText: notes[1].text,
    userId: "u1", userName: "Joe Liang", client: "Claude", status: "working", text: "Started comments", links: [] });
  const decks = new DoneDecks(db, new HeuristicAgent(), () => false, () => {});
  await decks.run(room.id);
  assert.equal(db.getDoneDeck(room.id)!.slides[0].points[0].who, "Joe Liang");
  db.editNote(notes[0].id, { text: notes[0].text, owner: "Janesh Chhabra" }, "Janesh Chhabra");
  await decks.run(room.id);
  assert.equal(db.getDoneDeck(room.id)!.slides[0].points[0].who, "Janesh Chhabra");
  const basis = doneBasis(doneInput(db, room.id)!);
  db.editNote(notes[1].id, { text: notes[1].text, owner: "Huy Ngo" }, "Janesh Chhabra");
  assert.notEqual(doneBasis(doneInput(db, room.id)!), basis);
  decks.stop();
});

test("without a model the pages are the closed tasks as they are, and a new meeting starts them over", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Stand", null, "");
  const { notes } = await meeting(db, room.id, ["Joe", "Andy"], [["Fix the black board", "Joe"]]);
  db.setActionDone(room.id, notes[0].id, "Joe");
  const decks = new DoneDecks(db, new HeuristicAgent(), () => false, () => {});
  await decks.run(room.id);
  assert.deepEqual(
    db.getDoneDeck(room.id)!.slides.map((s) => [s.title, s.points.map((p) => p.text)]),
    [["Done", ["Fix the black board"]]],
  );
  assert.match(db.getDoneDeck(room.id)!.slides[0].lead!, /^1 task closed since /);
  // The next meeting ends: what closed before it is old news.
  await meeting(db, room.id, ["Joe", "Andy"]);
  await decks.run(room.id);
  assert.deepEqual(db.getDoneDeck(room.id)!.slides, []);
  decks.stop();
});
