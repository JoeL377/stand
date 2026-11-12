import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent } from "../shared/chat.ts";
import type { Segment } from "../shared/protocol.ts";
import { CHAT_QUIET_MS, Chat, type IntakeEvent } from "./chat.ts";
import { CAPTURE_FAILURES, CAPTURE_STALE_MS, ChatCapture, type CaptureOptions, caughtIn } from "./chatCapture.ts";
import { openDb } from "./db.ts";
import { type Agent, type CapturedNote, type EarlierDiscussion, HeuristicAgent, type ItemNotesDraft, type NotesContext, type NotesOptions } from "./llm.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 17, 0);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

type Call = { lines: string[]; ids: string[]; tidy: boolean; keys: string[]; earlier: string[]; instructions: string };

/** A notes agent that answers what the test tells it to, and keeps what it was asked. */
function scripted(answer: (call: Call, n: number) => ItemNotesDraft | Promise<ItemNotesDraft>) {
  const calls: Call[] = [];
  const agent = {
    async notesFor(_item: null, segments: Segment[], earlier: EarlierDiscussion[] = [], captured: CapturedNote[] = [], context: NotesContext = {}, options: NotesOptions = {}) {
      const call: Call = {
        lines: segments.map((s) => `${s.speakerName}: ${s.text}`),
        ids: segments.map((s) => s.id),
        tidy: !!options.tidy,
        keys: captured.map((c) => `${c.key} ${c.text}`),
        earlier: earlier.map((d) => d.topic),
        instructions: context.instructions ?? "",
      };
      calls.push(call);
      return answer(call, calls.length);
    },
  } as unknown as Agent;
  return { agent, calls };
}

const nothing: ItemNotesDraft = { notes: [], discussions: [] };
/** One topic over every line, with these notes under it. */
const draft = (call: Call, topic: string, notes: Array<[kind: "action" | "decision" | "question", text: string, owner?: string | null, sameAs?: string]>, summary?: string): ItemNotesDraft => ({
  notes: [
    ...(summary ? [{ kind: "summary" as const, text: summary, owner: null, discussion: null }] : []),
    ...notes.map(([kind, text, owner = null, sameAs]) => ({ kind, text, owner, discussion: 0, sameAs })),
  ],
  discussions: [{ topic, positions: [], outcome: "action", segmentIndexes: call.lines.map((_, i) => i), continuesId: null }],
});

function setup(answer: Parameters<typeof scripted>[0] = () => nothing, opts: CaptureOptions = {}) {
  const db = openDb();
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.test", name: "Joe Liang", picture: null });
  const huy = db.upsertUser({ googleSub: null, email: "huy@example.test", name: "Huy Ngo", picture: null });
  const room = db.createRoom("Growth", joe.id);
  for (const u of [joe, huy]) db.touchMembership(room.id, u.id);
  const events: ChatEvent[] = [];
  const { agent, calls } = scripted(answer);
  // Waits no test reaches unless it sets them: a run happens when the test asks for one.
  const capture = new ChatCapture(db, agent, (_roomId, e) => events.push(e), { quietMs: 3600_000, maxWaitMs: 3600_000, ...opts });
  const chat = new Chat(db, (_roomId, e) => {
    events.push(e);
    capture.heard(e);
  });
  const channel = db.spaceChannel(room.id, joe.id);
  const say = (userId: string, text: string, ts: number, more: Partial<Extract<IntakeEvent, { type: "message" }>> = {}) =>
    chat.accept(channel.id, [{ type: "message", author: { userId }, text, ts, ...more }]).messages[0];
  const kinds = (sessionId: string) => db.meetingNotes(sessionId).map((n) => `${n.kind}: ${n.text}${n.owner ? ` (${n.owner})` : ""}`);
  return { db, joe, huy, room, chat, capture, channel, events, calls, say, kinds };
}

const quiet = async (fn: () => Promise<void>) => {
  const [log, error] = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    await fn();
  } finally {
    [console.log, console.error] = [log, error];
  }
};

test("what people write becomes the session's to-dos, open questions, decisions and topics, as a meeting's talk does", () =>
  quiet(async () => {
    const { db, joe, huy, room, capture, channel, events, calls, say, kinds } = setup((call) =>
      draft(call, "Invite email", [["action", "Send the invite email copy", "Huy Ngo"], ["decision", "Ship the invite flow on Friday"], ["question", "Who reviews the copy?"]], "Joe and Huy agreed to ship on Friday."),
    );
    const first = say(joe.id, "Can we ship the invite flow on Friday?", T0);
    const second = say(huy.id, "Yes. I will send the email copy today. Who reviews it?", T0 + MIN);
    events.length = 0;
    await capture.run(channel.id);

    // The model read the messages as lines of chat, with the guide for written talk.
    assert.deepEqual(calls.map((c) => [c.lines, c.tidy, c.keys]), [[["Joe Liang: Can we ship the invite flow on Friday?", "Huy Ngo: Yes. I will send the email copy today. Who reviews it?"], false, []]]);
    assert.match(calls[0].instructions, /written chat/);
    // Someone who asks for a to-do gets one, though nobody answered.
    assert.match(calls[0].instructions, /action item even if nobody answered/);

    assert.deepEqual(kinds(first.sessionId), [
      "summary: Joe and Huy agreed to ship on Friday.",
      "action: Send the invite email copy (Huy Ngo)",
      "decision: Ship the invite flow on Friday",
      "question: Who reviews the copy?",
    ]);
    // They are the space's, at once: the session has an end from its first message.
    assert.deepEqual(db.spaceNotes(room.id, "action").map((n) => n.text), ["Send the invite email copy"]);
    assert.deepEqual(db.spaceNotes(room.id, "decision").map((n) => n.text), ["Ship the invite flow on Friday"]);
    const [topic] = db.meetingDiscussions(first.sessionId);
    assert.deepEqual([topic.topic, topic.segmentIds], ["Invite email", [first.id, second.id]]);
    assert.ok(db.meetingNotes(first.sessionId).filter((n) => n.kind !== "summary").every((n) => n.discussionId === topic.id));

    assert.equal(db.capturedUpTo(channel.id), second.seq);
    assert.deepEqual(events, [{ type: "notes", channelId: channel.id, sessionId: first.sessionId }]);
    // Still open: the summary is the session's once it has closed.
    assert.equal(db.getMeeting(first.sessionId)!.summary, null);
    // Nothing new: no run.
    await capture.run(channel.id);
    assert.equal(calls.length, 1);
  }));

test("a later run keeps each line's id, leaves a ticked to-do it forgot, and doesn't write a removed line again", () =>
  quiet(async () => {
    const { db, joe, huy, room, capture, channel, calls, say, kinds } = setup((call, n) =>
      n === 1
        ? draft(call, "Invoices", [["action", "Send the invoice", "Joe Liang"], ["action", "Book the venue", "Huy Ngo"], ["decision", "Use Stripe for invoices"]])
        : draft(call, "Invoices", [["action", "Send the invoice to Acme by Friday", "Joe Liang", "A1"], ["decision", "Use Stripe for invoices"], ["question", "Which plan?"]]),
    );
    const m = say(joe.id, "I will send the invoice. Huy books the venue. We agreed on Stripe.", T0);
    await capture.run(channel.id);
    const [invoice, venue, stripe] = db.meetingNotes(m.sessionId);
    db.setActionDone(room.id, venue.id, "Huy Ngo");
    db.removeNote(stripe.id);

    say(huy.id, "Send it to Acme by Friday please. Which plan are they on?", T0 + MIN);
    await capture.run(channel.id);
    assert.deepEqual(calls[1].keys, ["A1 Send the invoice", "A2 Book the venue"]);
    assert.deepEqual(kinds(m.sessionId).sort(), ["action: Book the venue (Huy Ngo)", "action: Send the invoice to Acme by Friday (Joe Liang)", "question: Which plan?"]);
    const after = db.meetingNotes(m.sessionId);
    assert.equal(after.find((n) => n.text.startsWith("Send the invoice"))!.id, invoice.id);
    assert.ok(after.find((n) => n.id === venue.id)!.doneAt);
  }));

test("a run waits for the channel to go quiet, and no longer than the longest wait", () =>
  quiet(async () => {
    const { joe, capture, calls, say } = setup(() => nothing, { quietMs: 60, maxWaitMs: 150 });
    say(joe.id, "One two three four five six", T0);
    await tick(35);
    say(joe.id, "and some more words to read", T0 + 1);
    await tick(35);
    assert.equal(calls.length, 0, "the second message pushed the run back");
    await tick(50);
    await capture.idle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lines.length, 2);

    // People who never stop for the quiet time are read anyway.
    for (let i = 0; i < 6; i++) {
      say(joe.id, `still writing line number ${i} of this long talk`, T0 + 10 + i);
      await tick(35);
    }
    await capture.idle();
    assert.ok(calls.length >= 2, "the longest wait ran out while they wrote");
    capture.stop();
  }));

test("a message that comes while a run is going is read by the next run", () =>
  quiet(async () => {
    let release!: () => void;
    const { joe, capture, channel, calls, say, db } = setup(
      (_call, n) => (n === 1 ? new Promise<ItemNotesDraft>((ok) => (release = () => ok(nothing))) : nothing),
      { quietMs: 20, maxWaitMs: 100 },
    );
    const first = say(joe.id, "One two three four five six", T0);
    const running = capture.run(channel.id);
    const second = say(joe.id, "seven eight nine ten eleven twelve", T0 + 1);
    release();
    await running;
    assert.equal(db.capturedUpTo(channel.id), first.seq);
    await tick(40);
    await capture.idle();
    assert.deepEqual(calls.map((c) => c.lines.length), [1, 2]);
    assert.equal(db.capturedUpTo(channel.id), second.seq);
    capture.stop();
  }));

test("a few words wait for more, or for the session to close", () =>
  quiet(async () => {
    const { db, joe, huy, chat, capture, channel, calls, say } = setup((call) => draft(call, "Venue", [["action", "Book the venue", "Huy Ngo"]], "Huy books the venue."));
    say(joe.id, "Venue?", T0);
    await capture.run(channel.id);
    assert.equal(calls.length, 0);
    const asked = say(joe.id, "Can someone book the venue for the offsite?", T0 + 1);
    await capture.run(channel.id);
    assert.equal(calls.length, 1);
    const last = say(huy.id, "ok will do", T0 + MIN);
    await capture.run(channel.id);
    assert.equal(calls.length, 1, "three words since the last run");
    assert.equal(db.capturedUpTo(channel.id), asked.seq);

    // The session closes: the short answer is read with the rest.
    chat.sweep(last.ts + CHAT_QUIET_MS);
    await capture.run(channel.id);
    assert.deepEqual(calls.map((c) => [c.lines.length, c.tidy]), [[2, false], [3, true]]);
    assert.equal(db.capturedUpTo(channel.id), last.seq);

    // A session with next to nothing in it is left alone.
    const hi = say(joe.id, "Morning", last.ts + 2 * CHAT_QUIET_MS);
    chat.sweep(hi.ts + CHAT_QUIET_MS);
    await capture.run(channel.id);
    assert.equal(calls.length, 2);
    assert.equal(db.capturedUpTo(channel.id), hi.seq);
    assert.equal(caughtIn(db, hi.sessionId), null);
  }));

test("when a session closes it is read once more, whole: each line gets the message it came from, and the session its summary", () =>
  quiet(async () => {
    const { db, joe, huy, chat, capture, channel, events, calls, say } = setup((call) => {
      const d = draft(call, "Invite email", [["action", "Send the invite email copy", "Huy Ngo"], ["decision", "Ship the invite flow on Friday"]], "They ship on Friday; Huy sends the copy.");
      // The run as it closes brings the words each line came from.
      if (call.tidy) d.notes[1].quote = { segmentId: call.ids[1], ts: T0 + MIN, speaker: "Huy Ngo", text: "I will send the email copy today" };
      return d;
    });
    const first = say(joe.id, "Can we ship the invite flow on Friday?", T0);
    const second = say(huy.id, "Yes. I will send the email copy today.", T0 + MIN);
    await capture.run(channel.id);
    const live = caughtIn(db, first.sessionId)!;
    assert.deepEqual(live.lines.map((l) => [l.kind, l.text, l.owner, l.messageId, l.closed]), [
      ["action", "Send the invite email copy", "Huy Ngo", null, false],
      ["decision", "Ship the invite flow on Friday", null, null, false],
    ]);
    assert.deepEqual([live.summary, live.topics.map((t) => t.topic)], [null, ["Invite email"]]);

    events.length = 0;
    assert.equal(chat.sweep(second.ts + CHAT_QUIET_MS), 1);
    await capture.idle();
    await capture.run(channel.id);
    assert.deepEqual(calls.map((c) => c.tidy), [false, true]);
    // Already-caught lines went in with their keys, so they keep their ids.
    assert.deepEqual(calls[1].keys, ["A1 Send the invite email copy", "D1 Ship the invite flow on Friday"]);
    const closed = caughtIn(db, first.sessionId)!;
    assert.deepEqual(closed.lines.map((l) => [l.id, l.messageId]), [[live.lines[0].id, second.id], [live.lines[1].id, null]]);
    assert.equal(closed.summary, "They ship on Friday; Huy sends the copy.");
    assert.equal(db.getMeeting(first.sessionId)!.summary, "They ship on Friday; Huy sends the copy.");
    assert.equal(db.capturedUpTo(channel.id), second.seq);
    assert.deepEqual(events, [
      { type: "session", channelId: channel.id, sessionId: first.sessionId, open: false },
      { type: "notes", channelId: channel.id, sessionId: first.sessionId },
    ]);
    // Read once: nothing more to do for it.
    await capture.run(channel.id);
    assert.equal(calls.length, 2);
  }));

test("a session that closes while a run is going still gets its last read", () =>
  quiet(async () => {
    let release!: () => void;
    const { db, joe, chat, capture, channel, calls, say } = setup((call, n) =>
      n === 1 ? new Promise<ItemNotesDraft>((ok) => (release = () => ok(draft(call, "Venue", [["action", "Book the venue"]])))) : draft(call, "Venue", [["action", "Book the venue"]], "Joe books the venue."),
    );
    const m = say(joe.id, "I will book the venue for the offsite", T0);
    const running = capture.run(channel.id);
    chat.sweep(m.ts + CHAT_QUIET_MS);
    release();
    await running;
    await capture.idle();
    await capture.run(channel.id);
    assert.deepEqual(calls.map((c) => c.tidy), [false, true]);
    assert.equal(db.getMeeting(m.sessionId)!.summary, "Joe books the venue.");
  }));

test("a changed message is read again while its session is open, and a deleted one is not shown to the model", () =>
  quiet(async () => {
    const { db, joe, huy, chat, capture, channel, calls, say } = setup((call) => 
      draft(call, "Launch", [["decision", call.lines.some((l) => /Monday/.test(l)) ? "Launch on Monday" : "Launch on Friday", null, call.keys.length ? "D1" : undefined]]),
    );
    const first = say(joe.id, "We agreed to launch on Friday next week", T0);
    const second = say(huy.id, "Great, I am happy with that plan", T0 + MIN);
    await capture.run(channel.id);
    assert.equal(db.capturedUpTo(channel.id), second.seq);

    chat.accept(channel.id, [{ type: "edit", id: first.id, by: { userId: joe.id }, text: "We agreed to launch on Monday next week", ts: T0 + 2 * MIN }]);
    assert.equal(db.capturedUpTo(channel.id), first.seq - 1);
    await capture.run(channel.id);
    // The same decision, in its new words.
    assert.deepEqual(db.meetingNotes(first.sessionId).map((n) => n.text), ["Launch on Monday"]);

    chat.accept(channel.id, [{ type: "delete", id: second.id, by: { userId: huy.id }, ts: T0 + 3 * MIN }]);
    await capture.run(channel.id);
    assert.deepEqual(calls.at(-1)!.lines, ["Joe Liang: We agreed to launch on Monday next week"]);
    assert.deepEqual(db.meetingDiscussions(first.sessionId).map((d) => d.segmentIds), [[first.id]]);
  }));

test("a message deleted after its session closed is quoted nowhere, and nothing is read again", () =>
  quiet(async () => {
    const { db, joe, chat, capture, channel, calls, say } = setup((call) => {
      const d = draft(call, "Venue", [["action", "Book the venue", "Joe Liang"]], "Joe books the venue.");
      const quote = { segmentId: call.ids[0], ts: T0, speaker: "Joe Liang", text: "I will book the venue" };
      if (call.tidy) {
        d.notes[1].quote = quote;
        d.discussions[0].positions = [{ speaker: "Joe Liang", position: "Will book it", quote }];
      }
      return d;
    });
    const m = say(joe.id, "I will book the venue for the offsite", T0);
    chat.sweep(m.ts + CHAT_QUIET_MS);
    await capture.run(channel.id);
    assert.equal(caughtIn(db, m.sessionId)!.lines[0].messageId, m.id);
    assert.ok(db.meetingDiscussions(m.sessionId)[0].positions[0].quote);

    chat.accept(channel.id, [{ type: "delete", id: m.id, by: { userId: joe.id }, ts: T0 + 2 * CHAT_QUIET_MS }]);
    await capture.run(channel.id);
    assert.equal(calls.length, 1);
    // The line stays, without the words that are gone.
    assert.deepEqual(caughtIn(db, m.sessionId)!.lines.map((l) => [l.text, l.messageId]), [["Book the venue", null]]);
    assert.deepEqual(db.meetingDiscussions(m.sessionId)[0].positions, [{ speaker: "Joe Liang", position: "Will book it" }]);
  }));

test("a run that fails leaves the session unread, and after enough failures in a row the session is skipped", () =>
  quiet(async () => {
    let fail = true;
    const { db, joe, capture, channel, calls, say } = setup((call) => {
      if (fail) throw new Error("model is down");
      return draft(call, "Venue", [["action", "Book the venue"]]);
    });
    const m = say(joe.id, "I will book the venue for the offsite", T0);
    await capture.run(channel.id);
    assert.equal(db.capturedUpTo(channel.id), 0);
    assert.deepEqual(db.meetingNotes(m.sessionId), []);
    // It works again: nothing was lost.
    fail = false;
    await capture.run(channel.id);
    assert.deepEqual(db.meetingNotes(m.sessionId).map((n) => n.text), ["Book the venue"]);

    fail = true;
    const next = say(joe.id, "and I will also send the invoice to Acme", T0 + MIN);
    for (let i = 0; i < CAPTURE_FAILURES; i++) await capture.run(channel.id);
    assert.equal(calls.length, 2 + CAPTURE_FAILURES);
    assert.equal(db.capturedUpTo(channel.id), next.seq, "given up on, so it isn't tried forever");
    // What was caught before stays.
    assert.deepEqual(db.meetingNotes(m.sessionId).map((n) => n.text), ["Book the venue"]);
    capture.stop();
  }));

test("a channel gets so many runs a day while it is open, and the run as a session closes still happens", () =>
  quiet(async () => {
    const { joe, chat, capture, channel, calls, say } = setup(() => nothing, { dailyMax: 2 });
    let last = say(joe.id, "One two three four five six", T0);
    for (let i = 0; i < 4; i++) {
      await capture.run(channel.id);
      last = say(joe.id, `and six more words for run ${i}`, T0 + i + 1);
    }
    assert.equal(calls.length, 2);
    chat.sweep(last.ts + CHAT_QUIET_MS);
    await capture.run(channel.id);
    assert.deepEqual(calls.map((c) => c.tidy), [false, false, true]);
  }));

test("a session is shown the topics of the channel's earlier sessions, and can carry one on", () =>
  quiet(async () => {
    let earlierId = "";
    const { db, joe, chat, capture, channel, calls, say } = setup((call) => {
      const d = draft(call, call.earlier.length ? "Invite email, again" : "Invite email", [["action", "Send the invite email copy"]]);
      if (call.earlier.length) d.discussions[0].continuesId = earlierId;
      return d;
    });
    const first = say(joe.id, "I will send the invite email copy", T0);
    chat.sweep(first.ts + CHAT_QUIET_MS);
    await capture.run(channel.id);
    earlierId = db.meetingDiscussions(first.sessionId)[0].id;

    const second = say(joe.id, "The invite email copy is nearly done now", first.ts + 3 * CHAT_QUIET_MS);
    await capture.run(channel.id);
    assert.deepEqual(calls.map((c) => c.earlier), [[], ["Invite email"]]);
    assert.equal(db.meetingDiscussions(second.sessionId)[0].continues?.id, earlierId);
  }));

test("after a restart, what is going on or just ended is read, and old talk is left as it is", () =>
  quiet(async () => {
    const now = T0 + 10 * 3600_000;
    const first = setup();
    const old = first.say(first.joe.id, "I will send the invoice to Acme today", now - CAPTURE_STALE_MS - 2 * CHAT_QUIET_MS);
    first.chat.sweep(old.ts + CHAT_QUIET_MS);
    const recent = first.say(first.joe.id, "I will book the venue for the offsite", now - CHAT_QUIET_MS - MIN);
    first.chat.sweep(now - 1);
    const going = first.say(first.joe.id, "I will write the launch post tomorrow", now - MIN);
    first.capture.stop();

    // The server comes back: capture has read nothing yet.
    const { agent, calls } = scripted((call) => draft(call, "Work", [["action", call.lines[0]]], "Summary"));
    const capture = new ChatCapture(first.db, agent, () => {}, { quietMs: 10, maxWaitMs: 50 });
    capture.start(now);
    await tick(5);
    await capture.idle();
    await tick(30);
    await capture.idle();
    assert.deepEqual(calls.map((c) => [c.lines[0], c.tidy]), [
      ["Joe Liang: I will book the venue for the offsite", true],
      ["Joe Liang: I will write the launch post tomorrow", false],
    ]);
    assert.deepEqual(first.db.meetingNotes(old.sessionId), []);
    assert.equal(first.db.capturedUpTo(first.channel.id), going.seq);
    assert.equal(first.db.getMeeting(recent.sessionId)!.summary, "Summary");
    capture.stop();
  }));

test("with no model, the patterns still catch a to-do and a decision from chat", () =>
  quiet(async () => {
    const base = setup();
    const capture = new ChatCapture(base.db, new HeuristicAgent(), () => {}, { quietMs: 3600_000 });
    const m = base.say(base.joe.id, "We decided to ship the invite flow on Friday.", T0);
    base.say(base.huy.id, "I will send the invite email copy today.", T0 + MIN);
    await capture.run(base.channel.id);
    const lines = caughtIn(base.db, m.sessionId)!.lines.map((l) => [l.kind, l.text, l.owner]);
    assert.deepEqual(lines, [
      ["decision", "We decided to ship the invite flow on Friday.", null],
      ["action", "I will send the invite email copy today.", "Huy Ngo"],
    ]);
  }));
