import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { type AlignmentDraft, type AlignmentInput, applyAlignment, boardText, carryOver, emptyAlignment, heuristicAlignment, matchAttendee, sameQuestion } from "./alignment.ts";
import { HeuristicAgent } from "./llm.ts";
import { RoomSession } from "./room.ts";
import { briefToMarkdown, buildBrief } from "./brief.ts";
import type { AlignmentState, ClientMessage, Segment, ServerMessage, User } from "../shared/protocol.ts";

const none: AlignmentDraft = {
  question: null,
  positions: [],
  differ: null,
  settleTest: null,
  agreedAdd: [],
  agreedRemove: [],
  unansweredAdd: [],
  answered: [],
  parkedAdd: [],
  landing: null,
};
const seg = (i: number, speakerName: string, text: string, ts = 1_000 * i): Segment => ({
  id: `s${i}`,
  meetingId: "m",
  itemId: null,
  speakerId: speakerName.toLowerCase(),
  speakerName,
  kind: "speech",
  text,
  ts,
});
const people = ["Joe Liang", "Huy Ngo", "Andy Li"];

test("names the model writes map to attendees, and anyone else is dropped", () => {
  assert.equal(matchAttendee("Huy", people), "Huy Ngo");
  assert.equal(matchAttendee("andy li", people), "Andy Li");
  assert.equal(matchAttendee("Duke", people), null);
  const lines = [seg(1, "Joe Liang", "One product"), seg(2, "Huy Ngo", "Two")];
  const next = applyAlignment(
    emptyAlignment(),
    {
      ...none,
      positions: [
        { person: "Joe", stance: "Merge them", reasons: ["a", "b", "c", "d"], moved: false, movedBecause: null, line: 1 },
        { person: "Janesh", stance: "Not here", reasons: [], moved: false, movedBecause: null, line: 2 },
      ],
    },
    lines,
    people,
  );
  assert.deepEqual(
    next.positions.map((p) => [p.person, p.stance, p.reasons.length]),
    [["Joe Liang", "Merge them", 3]],
  );
});

test("a stance only counts as moved when it changes, with the time it changed and why", () => {
  const lines = [seg(1, "Huy Ngo", "Fine, alignment is the goal", 5_000)];
  let s = applyAlignment(emptyAlignment(), { ...none, positions: [{ person: "Huy", stance: "Keep Connect separate", reasons: ["Horizontal"], moved: false, movedBecause: null, line: null }] }, [], people, 1);
  // Same stance with moved set: nothing moved.
  s = applyAlignment(s, { ...none, positions: [{ person: "Huy", stance: "keep connect separate", reasons: [], moved: true, movedBecause: "x", line: 1 }] }, lines, people);
  assert.equal(s.positions[0].movedAt, null);
  assert.deepEqual(s.positions[0].reasons, ["Horizontal"]);
  s = applyAlignment(
    s,
    { ...none, positions: [{ person: "Huy", stance: "Connect as the engine, Stand as a source", reasons: [], moved: true, movedBecause: "Both exist to align people", line: 1 }] },
    lines,
    people,
  );
  assert.equal(s.positions[0].movedAt, 5_000);
  assert.equal(s.positions[0].movedBecause, "Both exist to align people");
});

test("agreed points and waiting questions are added once and removed by their keys", () => {
  let s = applyAlignment(
    emptyAlignment(),
    {
      ...none,
      agreedAdd: [
        { text: "Stand feeds Connect", by: ["Joe", "Huy", "Andy", "Nobody"], line: 1 },
        { text: "Talk loses meaning through layers", by: [], line: null },
      ],
      unansweredAdd: [{ asker: "Andy", question: "Do we combine them?", line: 1 }],
    },
    [seg(1, "Andy Li", "Do we combine them?", 7)],
    people,
  );
  assert.deepEqual(s.agreed[0].by, ["Joe Liang", "Huy Ngo", "Andy Li"]);
  assert.equal(s.agreed[0].at, 7);
  assert.equal(s.unanswered[0].asker, "Andy Li");
  assert.match(boardText(s), /A1 Stand feeds Connect[\s\S]*A2 Talk[\s\S]*U1 Andy Li: Do we combine them\?/);
  s = applyAlignment(s, { ...none, agreedAdd: [{ text: "stand feeds connect", by: [], line: null }], agreedRemove: ["a2", "A9"], answered: ["U1"] }, [], people);
  assert.deepEqual(
    s.agreed.map((a) => a.text),
    ["Stand feeds Connect"],
  );
  assert.equal(s.unanswered.length, 0);
});

test("the agent suggests a question only when people haven't set one, and never rewrites theirs", () => {
  let s = applyAlignment(emptyAlignment(), { ...none, question: { text: "Merge or not?", askedBy: "Andy", whyNow: null, line: null } }, [], people);
  assert.equal(s.question?.suggested, true);
  // Its own suggestion it may sharpen.
  s = applyAlignment(s, { ...none, question: { text: "Should Connect and Stand be one product?", askedBy: "Andy", whyNow: null, line: null } }, [], people);
  assert.equal(s.question?.text, "Should Connect and Stand be one product?");
  s.question = { text: "Ours", askedBy: "Joe Liang", at: 1, whyNow: null, suggested: false };
  s = applyAlignment(s, { ...none, question: { text: "Something else", askedBy: null, whyNow: "Ingestion has to live somewhere", line: null } }, [], people);
  assert.equal(s.question?.text, "Ours");
  assert.equal(s.question?.whyNow, "Ingestion has to live somewhere");
});

test("where it landed keeps its owners to attendees", () => {
  const s = applyAlignment(
    emptyAlignment(),
    {
      ...none,
      landing: {
        outcome: "held",
        text: "Keep them separate for now",
        reopens: "Tomorrow, with Janesh",
        changesIf: null,
        stillOpen: "Would anyone use Connect without Stand?",
        nextSteps: [
          { owner: "Andy", text: "Build ingestion in Connect" },
          { owner: "Janesh", text: "Weigh in" },
        ],
      },
    },
    [],
    people,
  );
  assert.equal(s.landing?.outcome, "held");
  assert.deepEqual(
    s.landing?.nextSteps.map((x) => x.owner),
    ["Andy Li", null],
  );
});

test("the next meeting on the same question starts from where it stood, not where it landed", () => {
  const s: AlignmentState = {
    ...emptyAlignment(),
    question: { text: "Q", askedBy: "Andy Li", at: 1, whyNow: "now", suggested: false },
    positions: [{ person: "Huy Ngo", stance: "Engine", reasons: [], movedAt: 9, movedBecause: "x" }],
    landing: { outcome: "held", text: "Separate", reopens: null, changesIf: null, stillOpen: null, nextSteps: [] },
  };
  const next = carryOver(s);
  assert.equal(next.landing, null);
  assert.equal(next.positions[0].movedAt, null);
  assert.equal(next.positions[0].stance, "Engine");
  assert.equal(s.positions[0].movedAt, 9);
});

test("without a model, each speaker's latest longer remark stands in for their position", () => {
  const input: AlignmentInput = {
    state: emptyAlignment(),
    context: [],
    lines: [seg(1, "Andy Li", "Do we combine them?"), seg(2, "Joe Liang", "I think one surface for alignment is the way to go"), seg(3, "Huy Ngo", "Ok")],
    attendees: people,
    closing: true,
    space: { name: "CoNxt", purpose: "" },
  };
  const d = heuristicAlignment(input);
  assert.equal(d.question?.text, "Do we combine them?");
  assert.deepEqual(
    d.positions.map((p) => p.person),
    ["Joe Liang"],
  );
  assert.equal(d.landing?.outcome, "held");
});

test("Start sets the kind and question for the next meeting, used once", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  assert.equal(db.getRoom(room.id)?.defaultKind, "notes");
  db.setMeetingSetup(room.id, "alignment", { text: "One product?", by: "Joe", carry: null });
  assert.equal(db.getRoom(room.id)?.defaultKind, "alignment");
  assert.deepEqual(db.takeNextQuestion(room.id), { text: "One product?", by: "Joe", carry: null });
  assert.equal(db.takeNextQuestion(room.id), null);
  // Set long ago: not this meeting's question.
  db.setMeetingSetup(room.id, "alignment", { text: "Stale", by: "Joe", carry: null });
  assert.equal(db.takeNextQuestion(room.id, -1), null);
});

test("votes are one per person and clear when where it landed is written again", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  const m = db.startMeeting(room.id);
  db.setAlignmentVote(m.id, "u1", "Joe", "aligned");
  db.setAlignmentVote(m.id, "u1", "Joe", "commit");
  db.setAlignmentVote(m.id, "u2", "Huy", "not_aligned");
  assert.deepEqual(
    db.alignmentVotes(m.id).map((v) => [v.name, v.vote]),
    [
      ["Joe", "commit"],
      ["Huy", "not_aligned"],
    ],
  );
  db.clearAlignmentVotes(m.id);
  assert.equal(db.alignmentVotes(m.id).length, 0);
});

test("the space offers the last alignment meeting's question again until it's decided", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  const m = db.startMeeting(room.id);
  db.setMeetingKind(m.id, "alignment");
  const state: AlignmentState = { ...emptyAlignment(), question: { text: "One product?", askedBy: null, at: 1, whyNow: null, suggested: false } };
  db.saveAlignment(m.id, state);
  assert.equal(db.openAlignment(room.id), null); // still going
  db.endMeeting(m.id, null, null);
  assert.equal(db.openAlignment(room.id)?.state.question?.text, "One product?");
  db.saveAlignment(m.id, { ...state, landing: { outcome: "decided", text: "Yes", reopens: null, changesIf: null, stillOpen: null, nextSteps: [] } });
  assert.equal(db.openAlignment(room.id), null);
});

// ---- a whole alignment meeting, with a scripted agent ----------------------------------------

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  got: ServerMessage[] = [];
  send(data: string) {
    this.got.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}
async function join(session: RoomSession, user: Pick<User, "id" | "name">) {
  const ws = new FakeSocket();
  session.attach(ws as never, { picture: null, ...user } as User);
  await say(ws, { type: "hello" });
  return ws;
}
async function say(ws: FakeSocket, msg: ClientMessage) {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
  await new Promise((r) => setImmediate(r));
}

/** Writes positions from what each person said, and where it landed when asked. Counts live notes runs. */
class ScriptedAgent extends HeuristicAgent {
  runs: AlignmentInput[] = [];
  notesRuns = 0;
  override async alignmentFor(input: AlignmentInput): Promise<AlignmentDraft> {
    this.runs.push(input);
    return {
      ...none,
      positions: input.lines.map((l, i) => ({ person: l.speakerName, stance: l.text, reasons: [], moved: false, movedBecause: null, line: i + 1 })),
      landing: { outcome: "held", text: "Separate for now", reopens: "Tomorrow", changesIf: null, stillOpen: null, nextSteps: [{ owner: "Andy", text: "Build ingestion" }] },
    };
  }
  override async notesFor(...args: Parameters<HeuristicAgent["notesFor"]>) {
    this.notesRuns++;
    return super.notesFor(...args);
  }
}

test("an alignment meeting keeps the board, wraps up on the host's word, and takes each person's answer", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  db.setMeetingSetup(room.id, "alignment", { text: "Should Connect and Stand be one product?", by: "Joe Liang", carry: null });
  const agent = new ScriptedAgent();
  const session = new RoomSession(db, agent, db.getRoom(room.id)!, () => {});
  assert.equal(session.state().kind, "alignment");
  assert.equal(session.state().alignment?.state.question?.text, "Should Connect and Stand be one product?");
  assert.equal(db.getMeeting(session.meetingId)?.kind, "alignment");

  const joe = await join(session, { id: "u1", name: "Joe Liang" });
  const andy = await join(session, { id: "u2", name: "Andy Li" });
  session.addSpeech("u1", "Joe Liang", "One surface for alignment", Date.now());
  session.addSpeech("u2", "Andy Li", "Name a team that uses Connect without Stand", Date.now());

  // Voting waits for a landing; only the host wraps up.
  await say(andy, { type: "align.vote", vote: "aligned" });
  assert.equal(db.alignmentVotes(session.meetingId).length, 0);
  await say(andy, { type: "align.wrap" });
  assert.equal(session.state().alignment?.state.landing, null);
  assert.ok(andy.got.some((m) => m.type === "error"));

  await say(joe, { type: "align.wrap" });
  await new Promise((r) => setTimeout(r, 20));
  const view = session.state().alignment!;
  assert.equal(view.state.landing?.text, "Separate for now");
  assert.equal(view.state.landing?.nextSteps[0].owner, "Andy Li");
  assert.deepEqual(
    view.state.positions.map((p) => p.person),
    ["Joe Liang", "Andy Li"],
  );
  // The run read the new lines once, with everyone in the meeting as attendees.
  assert.deepEqual(agent.runs.at(-1)?.attendees.sort(), ["Andy Li", "Joe Liang"]);
  assert.equal(agent.notesRuns, 0);

  await say(andy, { type: "align.vote", vote: "commit" });
  assert.deepEqual(
    session.state().alignment?.votes.map((v) => [v.name, v.vote]),
    [["Andy Li", "commit"]],
  );
  // Anyone can change the question; the agent never does.
  await say(andy, { type: "align.question", text: "  One product, or two?  " });
  assert.equal(session.state().alignment?.state.question?.text, "One product, or two?");
  assert.equal(session.state().alignment?.state.question?.askedBy, "Andy Li");

  // Ending writes the usual notes too, and the brief carries the board and the answers.
  const runsBefore = agent.runs.length;
  await session.end();
  assert.equal(agent.runs.length, runsBefore, "already landed: no second closing pass");
  assert.ok(agent.notesRuns > 0);
  const m = db.getMeeting(session.meetingId)!;
  const brief = buildBrief({
    meeting: m,
    roomName: "CoNxt",
    alignment: { state: db.getAlignment(m.id)!.state, votes: db.alignmentVotes(m.id) },
    groups: [],
    decks: [],
    baseUrl: "http://x",
  });
  assert.equal(brief.alignment?.landing?.outcome, "held");
  assert.match(briefToMarkdown(brief), /Where we landed \(Held, not decided\):\*\* Separate for now[\s\S]*Andy Li: Disagree, but I'll commit/);
});

test("an alignment meeting ended without wrapping up still says where it landed", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  db.setMeetingSetup(room.id, "alignment", null);
  const agent = new ScriptedAgent();
  const session = new RoomSession(db, agent, db.getRoom(room.id)!, () => {});
  assert.equal(session.state().alignment?.state.question, null);
  await join(session, { id: "u1", name: "Joe Liang" });
  session.addSpeech("u1", "Joe Liang", "Let's keep them apart for now", Date.now());
  await session.end();
  assert.ok(agent.runs.some((r) => r.closing));
  assert.equal(db.getAlignment(session.meetingId)?.state.landing?.text, "Separate for now");
});

test("Start on an open meeting nobody has talked in yet changes its kind; once people talk, it stays", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Team");
  const session = new RoomSession(db, new ScriptedAgent(), room, () => {});
  assert.equal(session.state().kind, "notes");
  assert.equal(session.state().alignment, null);
  assert.ok(session.setup("alignment", { text: "Ship Friday?", by: "Joe", carry: null }));
  assert.equal(session.state().alignment?.state.question?.text, "Ship Friday?");
  await join(session, { id: "u1", name: "Joe" });
  session.addSpeech("u1", "Joe", "Hello", Date.now());
  assert.equal(session.setup("notes", null), false);
  assert.equal(session.state().kind, "alignment");
  await session.end();
});

test("a kept question picks up the earlier meeting's board", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  const first = db.startMeeting(room.id);
  db.setMeetingKind(first.id, "alignment");
  db.saveAlignment(first.id, {
    ...emptyAlignment(),
    question: { text: "One product?", askedBy: "Andy Li", at: 1, whyNow: "Ingestion", suggested: false },
    positions: [{ person: "Huy Ngo", stance: "Engine", reasons: ["Horizontal"], movedAt: 5, movedBecause: "x" }],
    agreed: [{ text: "Stand feeds Connect", at: 2, by: [] }],
    landing: { outcome: "held", text: "Separate", reopens: null, changesIf: null, stillOpen: null, nextSteps: [] },
  });
  db.endMeeting(first.id, null, null);
  db.setMeetingSetup(room.id, "alignment", { text: "One product?", by: "Joe Liang", carry: first.id });
  const session = new RoomSession(db, new ScriptedAgent(), db.getRoom(room.id)!, () => {});
  const s = session.state().alignment!.state;
  assert.equal(s.question?.askedBy, "Andy Li");
  assert.equal(s.question?.whyNow, "Ingestion");
  assert.equal(s.positions[0].stance, "Engine");
  assert.equal(s.positions[0].movedAt, null);
  assert.equal(s.agreed.length, 1);
  assert.equal(s.landing, null);
});

test("a small fix to the question is the same question; a different one isn't", () => {
  assert.ok(sameQuestion("Should Connect and Stand be one prodcut?", "Should Connect and Stand be one product?"));
  assert.ok(sameQuestion("Should Connect and Stand be one product?", "Should Connect and Stand be one product, or two?"));
  assert.ok(!sameQuestion("Ship on Friday?", "Ship on Monday?"));
  assert.ok(!sameQuestion("Should Connect and Stand be one product?", "Who owns live transcript ingestion?"));
  assert.ok(!sameQuestion("", "Anything?"));
});

test("a question changed while the agent reads the old one keeps none of what the run said about the old one", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  db.setMeetingSetup(room.id, "alignment", { text: "Should Connect and Stand be one product?", by: "Joe Liang", carry: null });
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  class SlowAgent extends HeuristicAgent {
    override async alignmentFor(input: AlignmentInput): Promise<AlignmentDraft> {
      await gate;
      return { ...none, question: { text: input.state.question!.text, askedBy: null, whyNow: "Ingestion has to live in one of them", line: null } };
    }
  }
  const session = new RoomSession(db, new SlowAgent(), db.getRoom(room.id)!, () => {});
  const joe = await join(session, { id: "u1", name: "Joe Liang" });
  session.addSpeech("u1", "Joe Liang", "We need to decide where ingestion lives", Date.now());
  await say(joe, { type: "align.wrap" });
  assert.equal(session.state().alignment?.busy, true);
  await say(joe, { type: "align.question", text: "Who owns live transcript ingestion?" });
  release();
  await new Promise((r) => setTimeout(r, 20));
  const q = session.state().alignment!.state.question!;
  assert.equal(q.text, "Who owns live transcript ingestion?");
  assert.equal(q.whyNow, null);
  assert.equal(session.state().alignment?.wrapFailed, false);
});

test("a wrap-up that fails says so, and the next one clears it", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("CoNxt");
  db.setMeetingSetup(room.id, "alignment", null);
  let fail = true;
  class FlakyAgent extends ScriptedAgent {
    override async alignmentFor(input: AlignmentInput): Promise<AlignmentDraft> {
      if (fail) throw new Error("down");
      return super.alignmentFor(input);
    }
  }
  const session = new RoomSession(db, new FlakyAgent(), db.getRoom(room.id)!, () => {});
  const joe = await join(session, { id: "u1", name: "Joe Liang" });
  session.addSpeech("u1", "Joe Liang", "Let's keep them apart for now", Date.now());
  await say(joe, { type: "align.wrap" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.state().alignment?.wrapFailed, true);
  assert.equal(session.state().alignment?.state.landing, null);
  fail = false;
  await say(joe, { type: "align.wrap" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.state().alignment?.wrapFailed, false);
  assert.equal(session.state().alignment?.state.landing?.text, "Separate for now");
});
