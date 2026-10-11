import { EventEmitter } from "node:events";
import fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { briefToMarkdown, buildBrief, buildFollowUps } from "./brief.ts";
import { looksLikePdf, parseDeck } from "./decks.ts";
import { type CapturedNote, HeuristicAgent, type ItemNotesDraft, type NotesOptions, NotesTrouble, type SettledTopic } from "./llm.ts";
import type { ClientMessage, Item, Note, Segment, ServerMessage, User } from "../shared/protocol.ts";
import { parseLinearInput } from "./linear.ts";
import { RoomSession, mentionScore } from "./room.ts";
import { outlineToSlides } from "../shared/outline.ts";

function setup() {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const items = db.addItems(
    room.id,
    ["One", "Two", "Three"].map((title) => ({ source: "agenda" as const, externalId: null, title, url: null, description: null })),
  );
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  return { db, session, items, meetingId: session.meetingId };
}

test("speech is pinned to the item in focus when it was spoken, not when it arrived", () => {
  const { db, session, items, meetingId } = setup();
  const spokeAt = Date.now() - 2_000;
  session.setFocus(items[1].id, "Joe", "manual");
  // A transcript for words spoken before the switch lands late.
  session.addSpeech("p1", "Priya", "Wrapping up the first one", spokeAt);
  session.addSpeech("p1", "Priya", "Now the second", Date.now());
  const segs = db.meetingSegments(meetingId);
  assert.equal(segs.find((s) => s.text.startsWith("Wrapping"))?.itemId, items[0].id);
  assert.equal(segs.find((s) => s.text.startsWith("Now"))?.itemId, items[1].id);
});

test("a speaker's fragments join into one entry until they pause or someone else speaks", () => {
  const { db, session, meetingId } = setup();
  const t = Date.now();
  // Speech-to-text splits at short pauses, mid-sentence.
  session.addSpeech("p1", "Joe", "And I'm basically trying to see", t - 3_000);
  session.addSpeech("p1", "Joe", "what this initial experience looks like. I think", t - 1_500);
  session.addSpeech("p1", "Joe", "that", t);
  session.addSpeech("p2", "Priya", "Agreed.", t);
  session.addSpeech("p1", "Joe", "Next point.", t);
  const later = Date.now() + 5_000; // after a long pause
  session.addSpeech("p1", "Joe", "Another thought", later);
  assert.deepEqual(
    db.meetingSegments(meetingId).map((s) => [s.speakerName, s.text]),
    [
      ["Joe", "And I'm basically trying to see what this initial experience looks like. I think that"],
      ["Priya", "Agreed."],
      ["Joe", "Next point."],
      ["Joe", "Another thought"],
    ],
  );
});

test("accepting the agent's suggestion re-pins what was said since the screen changed", async () => {
  const { db, session, items, meetingId } = setup();
  session.addSpeech("p1", "Sam", "Before the screen changed", Date.now() - 5_000);
  session.demoSuggest(items[2].id, "Three is on screen");
  await new Promise((r) => setTimeout(r, 5));
  session.addSpeech("p1", "Sam", "Talking about three already", Date.now());
  session.demoAccept();
  const segs = db.meetingSegments(meetingId);
  assert.equal(segs[0].itemId, items[0].id);
  assert.equal(segs[1].itemId, items[2].id);
  assert.equal(session.state().focusItemId, items[2].id);
  assert.equal(session.state().suggestion, null);
});

test("talk that keeps naming another item nudges the host, and switching moves that talk", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const items = db.addItems(room.id, [
    { source: "linear" as const, externalId: "ENG-1", title: "Onboarding checklist drops users", url: null, description: null },
    { source: "linear" as const, externalId: "ENG-2", title: "Webhooks retry with exponential backoff", url: null, description: null },
  ]);
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  const t = Date.now();
  session.addSpeech("p1", "Sam", "Step three of the onboarding checklist is where people drop.", t - 9_000);
  assert.equal(session.state().suggestion, null);
  session.addSpeech("p2", "Alex", "Separate thing, ENG-2 is still failing.", t - 6_000);
  assert.equal(session.state().suggestion, null, "one passing mention is not a change of subject");
  session.addSpeech("p1", "Sam", "Did the webhooks retry change ship?", t - 3_000);
  const s = session.state().suggestion;
  assert.equal(s?.itemId, items[1].id);
  assert.equal(s?.source, "talk");
  session.demoAccept();
  const segs = db.meetingSegments(session.meetingId);
  assert.deepEqual(
    segs.map((x) => x.itemId),
    [items[0].id, items[1].id, items[1].id],
  );
  assert.equal(mentionScore("nothing relevant here", items[0]), 0);
  // One speaker's turn arrives in fragments; the drift still adds up across them.
  session.setFocus(items[0].id, "p1", "manual");
  assert.equal(session.state().suggestion, null);
  const later = Date.now() + 5;
  session.addSpeech("p3", "Ann", "Quick one, the webhooks", later);
  session.addSpeech("p3", "Ann", "retry needs a cap on the backoff.", later + 500);
  assert.equal(db.meetingSegments(session.meetingId).length, 4, "the two fragments are one remark");
  assert.equal(session.state().suggestion, null, "one remark, however pointed, is a passing mention");
  session.addSpeech("p1", "Sam", "Agreed, and the backoff should double.", later + 1_500);
  assert.equal(session.state().suggestion?.itemId, items[1].id, "a second remark makes it a change of subject");
  session.addSpeech("p1", "Sam", "Back to the onboarding checklist drop-off.", later + 5_000);
  assert.equal(session.state().suggestion, null, "talk back on the item in focus withdraws the nudge");
  // Talk that comes back without naming the item in focus withdraws it too, after two remarks.
  session.addSpeech("p3", "Ann", "One more on the webhooks retry backoff.", later + 8_000);
  session.addSpeech("p1", "Sam", "Yes, the webhooks retry cap.", later + 11_000);
  assert.equal(session.state().suggestion?.itemId, items[1].id);
  session.addSpeech("p3", "Ann", "Right, so step three loses most people.", later + 14_000);
  assert.equal(session.state().suggestion?.itemId, items[1].id, "one remark naming neither is not enough");
  session.addSpeech("p1", "Sam", "We should shorten it to two steps.", later + 17_000);
  assert.equal(session.state().suggestion, null, "two in a row means the talk settled back");
  assert.equal(mentionScore("eng-1 again", items[0]), 2);
  assert.equal(mentionScore("so eng 1 again", items[0]), 2, "a key said aloud");
  assert.equal(mentionScore("Обновление платежей сломалось", { title: "Обновление платежей", externalId: null }), 2);
  assert.equal(mentionScore("结账页面又出错了", { title: "结账页面", externalId: null }), 3);
});

test("a deleted note and removed agenda items come back with Undo", () => {
  const { db, items, meetingId } = setup();
  const note = db.addNote(meetingId, items[0].id, { kind: "decision", text: "Ship it", owner: null }, null);
  db.removeNote(note.id);
  assert.equal(db.meetingNotes(meetingId).length, 0);
  assert.equal(db.dismissedNotes(meetingId, items[0].id).length, 1);
  db.restoreNote(note);
  assert.deepEqual(db.meetingNotes(meetingId).map((n) => n.id), [note.id]);
  assert.equal(db.dismissedNotes(meetingId, items[0].id).length, 0);
  db.archiveItem(items[1].id);
  assert.deepEqual(db.listItems(items[0].roomId).map((i) => i.title), ["One", "Three"]);
  db.unarchiveItems(items[0].roomId, [items[1].id]);
  assert.deepEqual(db.listItems(items[0].roomId).map((i) => i.title), ["One", "Two", "Three"]);
});

test("items keep their history when re-imported", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const issue = { source: "linear" as const, externalId: "ENG-1", title: "A", url: null, description: null };
  const [first] = db.addItems(room.id, [issue]);
  db.archiveItem(first.id);
  const [again] = db.addItems(room.id, [{ ...issue, title: "A (renamed)" }]);
  assert.equal(again.id, first.id);
  assert.equal(again.title, "A (renamed)");
});

test("parses Linear links and keys", () => {
  assert.deepEqual(parseLinearInput("https://linear.app/acme/project/q4-launch-8f2a9c1b3d4e/issues"), { kind: "project", id: "8f2a9c1b3d4e" });
  assert.deepEqual(parseLinearInput("https://linear.app/acme/team/ENG/cycle/12"), { kind: "cycle", teamKey: "ENG", number: 12 });
  assert.deepEqual(parseLinearInput("https://linear.app/acme/team/eng/active"), { kind: "cycle", teamKey: "ENG", number: "active" });
  assert.deepEqual(parseLinearInput("https://linear.app/acme/issue/ENG-42/fix-login"), { kind: "issues", keys: ["ENG-42"] });
  assert.deepEqual(parseLinearInput("ENG-1, ENG-2 and ENG-1"), { kind: "issues", keys: ["ENG-1", "ENG-2"] });
  assert.equal(parseLinearInput("https://example.com/x"), null);
});

test("sessions resolve to users, and Google sign-in links to an existing email", () => {
  const db = openDb(":memory:");
  const dev = db.upsertUser({ googleSub: null, email: "Joe@Example.com", name: "Joe", picture: null });
  const google = db.upsertUser({ googleSub: "g-123", email: "joe@example.com", name: "Joe Liang", picture: "https://x/p.png" });
  assert.equal(google.id, dev.id);
  assert.equal(google.name, "Joe Liang");
  const s = db.createSession(google.id);
  assert.equal(db.sessionUser(s.id)?.user.email, "joe@example.com");
  db.deleteSession(s.id);
  assert.equal(db.sessionUser(s.id), null);
});

test("a PDF deck becomes one item per slide, titled by its biggest text", async () => {
  const pdf = new Uint8Array(fs.readFileSync(new URL("./fixtures/deck.pdf", import.meta.url)));
  assert.ok(looksLikePdf(pdf));
  const slides = await parseDeck(pdf);
  assert.deepEqual(
    slides.map((s) => s.title),
    ["Q4 Roadmap", "Search latency", "Mobile onboarding", "Hiring plan"],
  );
  assert.match(slides[2].text, /Signup completion is 41%/);

  const db = openDb();
  const room = db.createRoom("R");
  const deck = db.createDeck(room.id, "Q4", slides.length);
  db.addItems(room.id, slides.map((s, i) => ({ source: "slide" as const, externalId: null, title: s.title, url: null, description: s.text, deckId: deck.id, slideNo: i + 1 })));
  assert.deepEqual(db.listDecks(room.id).map((d) => d.id), [deck.id]);
  assert.deepEqual(db.deckSlides(deck.id).map((i) => i.slideNo), [1, 2, 3, 4]);
  db.archiveDeck(deck.id);
  assert.equal(db.listItems(room.id).length, 0);
  assert.equal(db.listDecks(room.id).length, 0);
});

test("decks made in Stand save in place, keep slide ids and stay together in the agenda", () => {
  const { db, items } = setup();
  const roomId = items[0].roomId;
  const deck = db.createDeck(roomId, "Plan", 1, "native");
  const s = (id: string, title: string) => ({ id, title, layout: "bullets" as const, body: "- a", image: null, notes: "" });
  db.saveDeck(deck, { title: "Plan", theme: "paper", slides: [s("aaaaaaaa", "Intro"), s("bbbbbbbb", "Risks")] });
  // Move "Three" below the deck, then edit: the deck stays where it was.
  const ids = db.listItems(roomId).map((i) => i.id);
  db.reorderItems(roomId, [ids[0], ids[1], ids[3], ids[4], ids[2]]);
  const { deck: saved, slides } = db.saveDeck(deck, {
    title: "Plan v2",
    theme: "ocean",
    slides: [s("bbbbbbbb", "Risks!"), s("cccccccc", "Asks")],
  });
  assert.equal(saved.title, "Plan v2");
  assert.equal(saved.theme, "ocean");
  assert.equal(saved.pageCount, 2);
  assert.deepEqual(slides.map((i) => [i.id, i.title, i.slideNo]), [["bbbbbbbb", "Risks!", 1], ["cccccccc", "Asks", 2]]);
  assert.deepEqual(db.listItems(roomId).map((i) => i.title), ["One", "Two", "Risks!", "Asks", "Three"]);
  assert.equal(db.getItem("aaaaaaaa")?.title, "Intro", "removed slides keep their history");
  assert.equal(db.listItems(roomId)[2].slide?.layout, "bullets");
});

test("decks sit under an agenda item and fall back to standing alone when it goes", () => {
  const { db, items } = setup();
  const roomId = items[0].roomId;
  const s = (id: string, title: string) => ({ id, title, layout: "bullets" as const, body: "", image: null, notes: "" });
  const a = db.createDeck(roomId, "A", 1, "native");
  db.saveDeck(a, { title: "A", theme: "paper", slides: [s("aaaaaaa1", "A1"), s("aaaaaaa2", "A2")] });
  const b = db.createDeck(roomId, "B", 1, "native");
  db.saveDeck(b, { title: "B", theme: "paper", slides: [s("bbbbbbb1", "B1")] });
  db.setDeckParent(a.id, items[0].id);
  db.setDeckParent(b.id, items[0].id);
  assert.deepEqual(db.listItems(roomId).map((i) => i.title), ["One", "A1", "A2", "B1", "Two", "Three"]);
  assert.equal(db.getDeck(a.id)?.parentItemId, items[0].id);
  db.setDeckParent(b.id, items[2].id);
  assert.deepEqual(db.listItems(roomId).map((i) => i.title), ["One", "A1", "A2", "Two", "Three", "B1"]);
  db.archiveItem(items[0].id);
  assert.equal(db.getDeck(a.id)?.parentItemId, null);
  assert.deepEqual(db.listItems(roomId).map((i) => i.title), ["A1", "A2", "Two", "Three", "B1"]);
});

test("outlines turn into slides", () => {
  const slides = outlineToSlides("# Roadmap\nQ4\n\n# Where we are\n- Shipped\n  - fast\nNotes: thanks\n\n# Next\n---\n> Love it\n");
  assert.deepEqual(slides.map((s) => s.layout), ["title", "bullets", "section", "quote"]);
  assert.equal(slides[1].body, "Shipped\n  fast");
  assert.equal(slides[1].notes, "thanks");
});

test("the meeting brief lists every action with its owner and a link back to the item", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Platform");
  const [ticket, task] = db.addItems(room.id, [
    { source: "linear" as const, externalId: "ENG-7", title: "Search latency", url: "https://linear.app/acme/issue/ENG-7", description: null },
    { source: "agenda" as const, externalId: null, title: "Hiring", url: null, description: null },
  ]);
  const meeting = { id: "m1", roomId: room.id, startedAt: Date.UTC(2026, 9, 7, 9), endedAt: Date.UTC(2026, 9, 7, 9, 15), summary: "Short one." };
  const note = (id: string, itemId: string | null, kind: "summary" | "decision" | "action" | "question", text: string, owner: string | null = null) =>
    ({ id, meetingId: "m1", itemId, kind, text, owner, ts: 0, doneAt: null, doneBy: null, discussionId: null });
  const seg = (itemId: string | null, speakerName: string, text: string) =>
    ({ id: text, meetingId: "m1", itemId, speakerId: speakerName, speakerName, kind: "speech" as const, text, ts: meeting.startedAt });
  const brief = buildBrief({
    meeting,
    roomName: room.name,
    decks: [],
    baseUrl: "http://stand.test",
    withTranscript: true,
    groups: [
      { item: ticket, segments: [seg(ticket.id, "Priya", "p95 is 900ms")], notes: [note("n1", ticket.id, "decision", "Ship the cache"), note("n2", ticket.id, "action", "Add a dashboard", "Priya")] },
      { item: task, segments: [seg(task.id, "Joe", "Two offers out")], notes: [note("n3", task.id, "action", "Follow up with candidates")] },
    ],
  });
  assert.equal(brief.schema, "stand.meeting-brief/v1");
  assert.equal(brief.meeting.durationMinutes, 15);
  assert.deepEqual(brief.meeting.attendees, ["Priya", "Joe"]);
  assert.deepEqual(brief.actions.map((a) => [a.text, a.owner, a.item.key ?? a.item.title]), [["Add a dashboard", "Priya", "ENG-7"], ["Follow up with candidates", null, "Hiring"]]);
  assert.equal(brief.actions[0].item.url, "https://linear.app/acme/issue/ENG-7");
  assert.equal(brief.actions[1].item.url, `http://stand.test/items/${task.id}`);
  assert.equal(brief.items[0].transcript?.[0].text, "p95 is 900ms");
  const md = briefToMarkdown(brief);
  assert.match(md, /^---\nschema: stand.meeting-brief\/v1/);
  assert.match(md, /- \[ \] Add a dashboard \(owner: Priya\) · \[ENG-7 · Search latency\]\(https:\/\/linear.app\/acme\/issue\/ENG-7\)/);
  assert.match(md, /- \[ \] Follow up with candidates \(owner: unassigned\)/);
});

test("action items stay open on their item across meetings until someone checks them off", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Platform");
  const other = db.createRoom("Elsewhere");
  const [ticket] = db.addItems(room.id, [
    { source: "linear" as const, externalId: "ENG-7", title: "Search latency", url: "https://linear.app/acme/issue/ENG-7", description: null },
  ]);
  const first = db.startMeeting(room.id);
  const [dash, alerts] = db.replaceNotes(first.id, ticket.id, [
    { kind: "action", text: "Add a dashboard", owner: "Priya" },
    { kind: "action", text: "Page on p95", owner: null },
  ]);
  // Notes regenerate while the meeting runs; a checked-off action stays checked.
  assert.ok(db.setActionDone(room.id, alerts.id, "Joe"));
  const again = db.replaceNotes(first.id, ticket.id, [
    { kind: "action", text: "Add a dashboard", owner: "Priya" },
    { kind: "action", text: "Page on p95", owner: null },
  ]);
  assert.equal(again[1].doneBy, "Joe");
  assert.equal(db.roomFollowUps(room.id).length, 0, "only finished meetings count");
  db.endMeeting(first.id, null);

  // Someone in another room can't check it off.
  assert.equal(db.setActionDone(other.id, again[0].id, "Mallory"), null);
  assert.deepEqual(
    db.roomFollowUps(room.id).map((f) => [f.text, f.itemId, f.doneBy]),
    [["Add a dashboard", ticket.id, null], ["Page on p95", ticket.id, "Joe"]],
  );

  // The next meeting's brief carries the open one over, linked to the ticket.
  const second = { ...db.startMeeting(room.id), roomId: room.id, summary: null, endedAt: null };
  second.startedAt = Math.max(second.startedAt, db.getMeeting(first.id)!.startedAt + 1);
  const brief = buildBrief({
    meeting: second,
    roomName: room.name,
    groups: [],
    decks: [],
    baseUrl: "http://stand.test",
    followUps: db.roomFollowUps(room.id),
    itemById: (id) => db.getItem(id),
  });
  assert.deepEqual(brief.carriedOver.map((a) => [a.text, a.status, a.item.key, a.item.historyUrl]), [
    ["Add a dashboard", "open", "ENG-7", `http://stand.test/items/${ticket.id}`],
  ]);
  assert.match(briefToMarkdown(brief), /## Still open from earlier meetings\n\n- \[ \] Add a dashboard \(owner: Priya\)/);

  const feed = buildFollowUps({ room, followUps: db.roomFollowUps(room.id), itemById: (id) => db.getItem(id), decks: [], baseUrl: "http://stand.test", status: "open" });
  assert.deepEqual(feed.actions.map((a) => a.text), ["Add a dashboard"]);
  assert.equal(feed.actions[0].meetingUrl, `http://stand.test/meetings/${first.id}`);
  void dash;
});

test("the agent groups an item's talk into discussions, and notes point at the one they came from", async () => {
  const { db, session, items, meetingId } = setup();
  const t = Date.now();
  session.addSpeech("p1", "Sam", "The annual plan shows 15 percent off but planning said 20.", t - 20_000);
  session.addSpeech("p2", "Jordan", "Then billing is wrong. I'll file it today.", t - 10_000);
  await session.end();
  const [d] = db.meetingDiscussions(meetingId);
  assert.equal(d.itemId, items[0].id);
  assert.equal(d.outcome, "action");
  assert.deepEqual(d.positions.map((p) => p.speaker), ["Sam", "Jordan"]);
  assert.equal(d.segmentIds.length, 2);
  const action = db.meetingNotes(meetingId).find((n) => n.kind === "action")!;
  assert.equal(action.discussionId, d.id);

  // A later meeting picks the same question up again.
  const next = db.startMeeting(db.getMeeting(meetingId)!.roomId);
  const [again] = db.replaceDiscussions(next.id, items[0].id, [
    { topic: "Annual plan discount", positions: [], outcome: "decided", segmentIds: [], continuesId: d.id },
  ]);
  assert.equal(again.continues?.meetingId, meetingId);
  assert.equal(again.continues?.topic, d.topic);
  assert.deepEqual(db.itemDiscussions(items[0].id).map((x) => x.id), [again.id, d.id]);

  const brief = buildBrief({
    meeting: db.getMeeting(meetingId)!,
    roomName: "Test",
    groups: [{ item: items[0], segments: db.meetingSegments(meetingId), notes: db.meetingNotes(meetingId), discussions: db.meetingDiscussions(meetingId) }],
    decks: [],
    baseUrl: "http://stand.test",
  });
  assert.equal(brief.actions[0].discussion?.topic, d.topic);
  assert.deepEqual(brief.items[0].discussions[0].actionIds, [action.id]);
  assert.match(briefToMarkdown(brief), /#### One · action taken\n\n- Sam: The annual plan/);
});

test("allowlist: only listed emails or domains get in, checked on every request", async () => {
  const { userFromRequest } = await import("./auth.ts");
  const { config } = await import("./config.ts");
  const db = openDb(":memory:");
  const cookie = (email: string, googleSub: string | null) => {
    const u = db.upsertUser({ googleSub, email, name: email, picture: null });
    return { headers: { cookie: `standup_session=${db.createSession(u.id).id}` } } as never;
  };
  const ann = cookie("ann@gmail.com", "g-ann");
  const bo = cookie("bo@acme.com", "g-bo");
  const eve = cookie("eve@gmail.com", "g-eve");
  const standIn = cookie("ann2@gmail.com", null);
  try {
    // Open to anyone: everyone, including a stand-in sign-in, gets in.
    assert.ok(userFromRequest(db, eve) && userFromRequest(db, standIn));
    config.allowedEmails = ["ann@gmail.com", "ann2@gmail.com"];
    config.allowedDomains = ["acme.com"];
    assert.equal(userFromRequest(db, ann)?.email, "ann@gmail.com");
    assert.equal(userFromRequest(db, bo)?.email, "bo@acme.com");
    assert.equal(userFromRequest(db, eve), null, "existing session of someone not listed is cut off");
    assert.equal(userFromRequest(db, standIn), null, "unverified sign-in never counts once access is limited");
  } finally {
    config.allowedEmails = [];
    config.allowedDomains = [];
  }
});

test("a notes refresh never drops a to-do or decision captured earlier, and keeps its id and checked-off state", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const [item] = db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "One", url: null, description: null }]);
  const drafts: ItemNotesDraft[] = [
    {
      notes: [
        { kind: "action", text: "Send Joe the repo link", owner: "Huy", discussion: 0 },
        { kind: "action", text: "Try out Connect", owner: null, discussion: 0 },
        { kind: "action", text: "Debug why notes disappeared", owner: "Joe", discussion: 0 },
        { kind: "decision", text: "Review the queue daily", owner: null, discussion: 0 },
      ],
      discussions: [{ topic: "Repo", positions: [], outcome: "action", segmentIndexes: [0], continuesId: null }],
    },
    // The rerun rewords one to-do, says which it was, and forgets the rest.
    {
      notes: [{ kind: "action", text: "Send Joe the link to the repo today", owner: null, discussion: 0, sameAs: "A1" }],
      discussions: [{ topic: "Repo", positions: [], outcome: "action", segmentIndexes: [0], continuesId: null }],
    },
  ];
  const seen: Array<CapturedNote[] | undefined> = [];
  const agent = Object.assign(new HeuristicAgent(), {
    async notesFor(_i: unknown, _s: unknown, _e: unknown, captured?: CapturedNote[]) {
      seen.push(captured);
      return drafts.shift()!;
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  session.addSpeech("p1", "Huy", "I'll send Joe the repo link", Date.now());
  const refresh = (session as unknown as { refreshNotes(id: string): Promise<Note[]> }).refreshNotes.bind(session);
  const first = await refresh(item.id);
  const debug = first.find((n) => n.text.startsWith("Debug"))!;
  db.setActionDone(room.id, debug.id, "Joe");

  const second = await refresh(item.id);
  assert.deepEqual(seen[1]?.map((c) => `${c.key} ${c.text}`), ["A1 Send Joe the repo link", "A2 Try out Connect", "A3 Debug why notes disappeared", "D1 Review the queue daily"]);
  const actions = second.filter((n) => n.kind === "action");
  assert.deepEqual(actions.map((n) => n.text), ["Send Joe the link to the repo today", "Try out Connect", "Debug why notes disappeared"]);
  assert.equal(actions[0].id, first[0].id);
  assert.equal(actions[0].owner, "Huy");
  assert.equal(actions[2].id, debug.id);
  assert.equal(actions[2].doneBy, "Joe");
  assert.equal(second.filter((n) => n.kind === "decision").length, 1);
});

test("in a long meeting a quiet topic settles: runs read what's still going, and its notes stay as they were", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "One", url: null, description: null }]);
  const calls: Array<{ lines: string[]; settled: SettledTopic[]; tidy: boolean }> = [];
  const drafts: ItemNotesDraft[] = [
    {
      notes: [
        { kind: "action", text: "Make the keep button stand out", owner: "Joe", discussion: 0 },
        { kind: "decision", text: "Open the review queue in the widget first", owner: null, discussion: 1 },
      ],
      discussions: [
        { topic: "Conflict page", positions: [], outcome: "action", segmentIndexes: [0, 1], continuesId: null },
        { topic: "Review queue", positions: [], outcome: "decided", segmentIndexes: [2, 3], continuesId: null },
      ],
    },
    // Forty minutes on, the conflict page settled. The model writes its to-do again anyway.
    {
      notes: [
        { kind: "action", text: "Make the keep button stand out more", owner: "Joe", discussion: 0 },
        { kind: "decision", text: "Open the review queue in the widget first", owner: null, discussion: 0, sameAs: "D1" },
      ],
      discussions: [{ topic: "Review queue", positions: [], outcome: "decided", segmentIndexes: [0, 1, 2], continuesId: null }],
    },
    // Then the talk goes back to the conflict page.
    {
      notes: [
        { kind: "action", text: "Make the conflict diff easier to read", owner: "Andy", discussion: 0 },
        { kind: "decision", text: "Open the review queue in the widget first", owner: null, discussion: 1, sameAs: "D1" },
      ],
      discussions: [
        { topic: "Conflict page diff", positions: [{ speaker: "Andy", position: "The diff is hard to read" }], outcome: "action", segmentIndexes: [3], continuesId: null, picksUp: "T1" },
        { topic: "Review queue", positions: [], outcome: "decided", segmentIndexes: [0, 1, 2], continuesId: null },
      ],
    },
  ];
  const agent = Object.assign(new HeuristicAgent(), {
    async notesFor(item: Item | null, segments: Segment[], _e: unknown, _c: unknown, _s: unknown, options?: NotesOptions) {
      calls.push({ lines: segments.map((x) => x.text), settled: options?.settled ?? [], tidy: !!options?.tidy });
      return drafts.shift() ?? new HeuristicAgent().notesFor(item, segments);
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const refresh = (session as unknown as { refreshNotes(id: string | null): Promise<Note[]> }).refreshNotes.bind(session);
  const MIN = 60_000;
  const t = Date.now();
  session.addSpeech("p1", "Andy", "The conflict page needs a clearer keep button", t - 40 * MIN);
  session.addSpeech("p2", "Joe", "I'll make the keep button stand out", t - 39 * MIN);
  session.addSpeech("p3", "Huy", "Should the review queue open in the widget?", t - 3 * MIN);
  session.addSpeech("p1", "Andy", "Yes, widget first", t - 2 * MIN);
  const itemId = db.meetingSegments(session.meetingId)[0].itemId;
  const first = await refresh(itemId);
  assert.equal(calls[0].lines.length, 4);
  const conflict = db.meetingDiscussions(session.meetingId).find((d) => d.topic === "Conflict page")!;
  const keep = first.find((n) => n.text === "Make the keep button stand out")!;
  db.setActionDone(room.id, keep.id, "Joe");

  session.addSpeech("p3", "Huy", "And the widget shows the queue count", t - 1 * MIN);
  const second = await refresh(itemId);
  assert.deepEqual(calls[1].lines, ["Should the review queue open in the widget?", "Yes, widget first", "And the widget shows the queue count"]);
  assert.deepEqual(calls[1].settled, [
    {
      key: "T1",
      topic: "Conflict page",
      outcome: "action",
      notes: [{ kind: "action", text: "Make the keep button stand out", owner: "Joe" }],
    },
  ]);
  const settled = db.meetingDiscussions(session.meetingId).find((d) => d.id === conflict.id);
  assert.deepEqual(settled?.segmentIds, conflict.segmentIds);
  const actions = second.filter((n) => n.kind === "action");
  assert.deepEqual(actions.map((n) => [n.id, n.doneBy, n.discussionId]), [[keep.id, "Joe", conflict.id]], "kept as it was, not written twice");

  session.addSpeech("p1", "Andy", "Back on the conflict page, the diff is hard to read", Date.now());
  const third = await refresh(itemId);
  assert.equal(calls[2].lines.at(-1), "Back on the conflict page, the diff is hard to read");
  const back = db.meetingDiscussions(session.meetingId).find((d) => d.id === conflict.id)!;
  assert.equal(back.topic, "Conflict page diff");
  assert.equal(back.segmentIds.length, 3, "its earlier lines and the new one");
  assert.equal(third.find((n) => n.text === "Make the conflict diff easier to read")?.discussionId, conflict.id);

  // As the meeting ends, one last run reads all of it.
  await session.end();
  assert.equal(calls.at(-1)?.tidy, true);
  assert.equal(calls.at(-1)?.lines.length, 6);
  assert.deepEqual(calls.at(-1)?.settled, []);
  assert.ok(db.meetingNotes(session.meetingId).some((n) => n.id === keep.id && n.doneBy === "Joe"));
});

test("one topic for an hour: its older talk folds into where it stood, and the run carries it on", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "One", url: null, description: null }]);
  const calls: Array<{ lines: string[]; settled: SettledTopic[] }> = [];
  const MIN = 60_000;
  const t = Date.now();
  const drafts: ItemNotesDraft[] = [
    {
      notes: [
        { kind: "question", text: "Per seat or per space?", owner: null, discussion: 0 },
        { kind: "action", text: "Price out SSO", owner: "Andy", discussion: 0 },
      ],
      discussions: [{ topic: "Pricing", positions: [{ speaker: "Huy", position: "Per seat" }], outcome: "open", segmentIndexes: [...Array(50).keys()], continuesId: null }],
    },
    {
      notes: [
        { kind: "decision", text: "Charge per seat", owner: null, discussion: 0 },
        { kind: "action", text: "Price out SSO", owner: "Andy", discussion: 0, sameAs: "A1" },
      ],
      discussions: [
        // Every line it was sent; how many depends on where the 5-minute step falls.
        { topic: "Pricing", positions: [{ speaker: "Joe", position: "Per seat, then" }], outcome: "decided", segmentIndexes: [], continuesId: null, picksUp: "T1" },
      ],
    },
  ];
  const agent = Object.assign(new HeuristicAgent(), {
    async notesFor(item: Item | null, segments: Segment[], _e: unknown, _c: unknown, _s: unknown, options?: NotesOptions) {
      calls.push({ lines: segments.map((x) => x.text), settled: options?.settled ?? [] });
      const draft = drafts.shift();
      if (draft && calls.length === 2) draft.discussions[0].segmentIndexes = [...segments.keys()];
      return draft ?? new HeuristicAgent().notesFor(item, segments);
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const refresh = (session as unknown as { refreshNotes(id: string | null): Promise<Note[]> }).refreshNotes.bind(session);
  // Fifty remarks on pricing over the last hour, the latest six minutes ago.
  for (let i = 0; i < 50; i++) session.addSpeech("p1", i % 2 ? "Huy" : "Joe", `Pricing, take ${i}`, t - (60 - i * 1.1) * MIN);
  const itemId = db.meetingSegments(session.meetingId)[0].itemId;
  await refresh(itemId);
  const pricing = db.meetingDiscussions(session.meetingId)[0];
  assert.equal(pricing.segmentIds.length, 50);

  session.addSpeech("p2", "Joe", "OK, per seat", t - 2 * MIN);
  session.addSpeech("p1", "Huy", "Agreed", t - 1 * MIN);
  const notes = await refresh(itemId);
  // The talk from over 15 minutes ago isn't sent again; where the topic stood is.
  // The topic's last 15 to 20 minutes (the edge moves in 5-minute steps) and the new talk.
  const sent = calls[1].lines.length;
  assert.ok(sent >= 11 && sent <= 15, `sent ${sent} lines`);
  assert.deepEqual(calls[1].lines.slice(-2), ["OK, per seat", "Agreed"]);
  assert.deepEqual(calls[1].settled[0], {
    key: "T1",
    topic: "Pricing",
    outcome: "open",
    going: true,
    positions: [{ speaker: "Huy", position: "Per seat" }],
    notes: [
      { kind: "question", text: "Per seat or per space?", owner: null },
      { kind: "action", text: "Price out SSO", owner: "Andy" },
    ],
  });
  const after = db.meetingDiscussions(session.meetingId);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, pricing.id);
  assert.equal(after[0].segmentIds.length, 52, "its older lines and the new ones");
  assert.deepEqual(after[0].positions.map((p) => p.speaker), ["Huy", "Joe"]);
  assert.deepEqual(notes.map((n) => n.kind).sort(), ["action", "decision"]);
  assert.ok(notes.every((n) => n.discussionId === pricing.id));
});

test("spaces: every space is listed with its open to-dos, the ones for you, and what to decide", async () => {
  const { toSpaceSummary, ownedBy } = await import("./spaces.ts");
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.com", name: "Joe Liang", picture: null });
  const sam = db.upsertUser({ googleSub: null, email: "sam@example.com", name: "Sam", picture: null });
  const a = db.createRoom("Checkout v2", joe.id, "Ship one-page checkout");
  const b = db.createRoom("Hiring loop", sam.id);
  db.touchMembership(a.id, joe.id);
  const [item] = db.addItems(a.id, [{ source: "agenda" as const, externalId: null, title: "Apple Pay", url: null, description: null }]);
  const m = db.startMeeting(a.id);
  db.replaceNotes(m.id, item.id, [
    { kind: "decision", text: "Guest checkout stays for v1", owner: null },
    { kind: "action", text: "Set up the Apple Pay sandbox", owner: "Joe" },
    { kind: "action", text: "Write the copy", owner: "Sam" },
    { kind: "question", text: "Do we need 3DS?", owner: null },
  ]);
  const rows = db.spaceRows(joe.id);
  // Invite only: Joe sees the space he's in, not Sam's.
  assert.deepEqual(rows.map((r) => r.name), ["Checkout v2"]);
  const s = toSpaceSummary(rows.find((r) => r.id === a.id)!, joe, null);
  assert.equal(s.mine, true);
  assert.equal(s.following, true);
  assert.equal(s.purpose, "Ship one-page checkout");
  assert.equal(s.todos, 2);
  assert.equal(s.forYou, 1);
  assert.equal(s.toDecide, 1);
  assert.equal(s.last?.kind, "question");
  assert.ok(s.search.includes("apple pay sandbox") && s.search.includes("joe liang"));
  db.touchMembership(b.id, joe.id);
  const other = toSpaceSummary(db.spaceRows(joe.id).find((r) => r.id === b.id)!, joe, null);
  assert.equal(other.mine, false);
  assert.ok(ownedBy("joe liang", "Joe Liang") && ownedBy("Joe", "Joe Liang") && !ownedBy("Joey", "Joe Liang"));
});

/** Just enough of a WebSocket for a RoomSession: what it was sent, and a way to talk to it. */
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
async function join(session: RoomSession, user: Pick<User, "id" | "name">, hello: ClientMessage = { type: "hello" }) {
  const ws = new FakeSocket();
  session.attach(ws as never, { picture: null, ...user } as User);
  await say(ws, hello);
  return ws;
}
async function say(ws: FakeSocket, msg: ClientMessage) {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
  await new Promise((r) => setImmediate(r));
}

test("a meeting the server was running when it stopped picks up where it was, host and all", async () => {
  const { db, session, items, meetingId } = setup();
  const room = db.getRoom(session.roomId)!;
  const host = await join(session, { id: "u1", name: "Joe" });
  await join(session, { id: "u2", name: "Priya" });
  await say(host, { type: "focus", itemId: items[1].id });
  session.addSpeech("u2", "Priya", "Second item, still going", Date.now());

  // The server restarts: the live session is gone, the meeting is still open.
  const [open] = db.openMeetings(room.id);
  assert.equal(open.id, meetingId);
  assert.equal(open.hostId, "u1");
  assert.equal(open.segmentCount, 1);
  const again = new RoomSession(db, new HeuristicAgent(), room, () => {}, undefined, undefined, open);
  assert.equal(again.meetingId, meetingId);
  assert.equal(again.meetingStartedAt, session.meetingStartedAt);
  assert.equal(again.state().focusItemId, items[1].id);

  // Priya is back first, but the seat is kept for Joe.
  await join(again, { id: "u2", name: "Priya" });
  assert.equal(again.state().participants.find((p) => p.isHost), undefined);
  const back = await join(again, { id: "u1", name: "Joe" });
  assert.equal(again.state().participants.find((p) => p.isHost)?.id, "u1");
  const welcome = back.got.find((m) => m.type === "welcome");
  assert.equal(welcome?.type === "welcome" && welcome.segments.length, 1);

  await again.end();
  assert.ok(db.getMeeting(meetingId)?.endedAt);
  assert.equal(db.openMeetings(room.id).length, 0);
});

test("a change sent again after a reconnect is acked and applied once", async () => {
  const { db, session, meetingId } = setup();
  const ws = await join(session, { id: "u1", name: "Joe" });
  const add: ClientMessage = { type: "note.add", itemId: null, kind: "action", text: "Write the doc", owner: null, cid: "c1" };
  await say(ws, add);
  const again = await join(session, { id: "u1", name: "Joe" });
  await say(again, add);
  assert.equal(db.meetingNotes(meetingId).filter((n) => n.text === "Write the doc").length, 1);
  assert.ok(ws.got.some((m) => m.type === "ack" && m.cid === "c1"));
  assert.ok(again.got.some((m) => m.type === "ack" && m.cid === "c1"));
  await session.end();
});

test("a host's dropped connection doesn't hand the meeting to someone else", async () => {
  const { session } = setup();
  const host = await join(session, { id: "u1", name: "Joe" });
  await join(session, { id: "u2", name: "Priya" });
  host.close();
  assert.equal(session.state().participants.find((p) => p.isHost), undefined);
  await join(session, { id: "u1", name: "Joe" });
  assert.equal(session.state().participants.find((p) => p.isHost)?.id, "u1");
  await session.end();
});

test("someone whose meeting ended while they were away is sent to its recap", async () => {
  const { db, session, meetingId } = setup();
  const room = db.getRoom(session.roomId)!;
  await session.end();
  const next = new RoomSession(db, new HeuristicAgent(), room, () => {});
  const ws = await join(next, { id: "u1", name: "Joe" }, { type: "hello", meetingId });
  assert.deepEqual(ws.got, [{ type: "meeting.ended", meetingId }]);
  assert.equal(next.state().participants.length, 0);
  await next.end();
});

test("End meeting shows everyone it's ending, and the meeting ends even when the agent fails", async () => {
  const { db, session, meetingId } = setup();
  const agent = new HeuristicAgent();
  agent.recapMeeting = () => Promise.reject(new Error("down"));
  agent.summarizeMeeting = () => Promise.reject(new Error("down"));
  const room = db.getRoom(session.roomId)!;
  await session.end();
  const s = new RoomSession(db, agent, room, () => {});
  const ws = await join(s, { id: "u1", name: "Joe" });
  s.addSpeech("u1", "Joe", "Something worth a note", Date.now());
  await say(ws, { type: "meeting.end", cid: "end" });
  assert.ok(ws.got.some((m) => m.type === "state" && m.state.ending));
  assert.ok(ws.got.some((m) => m.type === "meeting.ended" && m.meetingId === s.meetingId));
  assert.ok(db.getMeeting(s.meetingId)?.endedAt);
  assert.ok(db.getMeeting(meetingId)?.endedAt);
});

test("a note change from someone who isn't the host says why, and puts their screen back", async () => {
  const { db, session, meetingId } = setup();
  await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  // Sent while offline, back when Ann was hosting; it arrives after the seat moved.
  await say(ann, { type: "note.add", itemId: null, kind: "action", text: "Write the doc", owner: null, cid: "late" });
  assert.equal(db.meetingNotes(meetingId).length, 0);
  assert.ok(ann.got.some((m) => m.type === "ack" && m.cid === "late"));
  const err = ann.got.find((m) => m.type === "error");
  assert.match(err?.type === "error" ? err.message : "", /Couldn't save your to-do: only the host can change notes, and Joe is hosting now/);
  // The list she's shown is the real one, without the to-do that didn't go in.
  assert.ok(ann.got.some((m) => m.type === "notes" && m.itemId === null && m.notes.length === 0));
  await session.end();
});

test("the agenda changing doesn't move a host off General, and a removed item takes its pin and nudge with it", async () => {
  const { db, session, items } = setup();
  const host = await join(session, { id: "u1", name: "Joe" });
  await say(host, { type: "focus", itemId: null });
  db.addItems(session.roomId, [{ source: "agenda", externalId: null, title: "Four", url: null, description: null }]);
  session.itemsChanged();
  assert.equal(session.state().focusItemId, null, "a host on General stays there");

  await say(host, { type: "pin", itemId: items[1].id });
  assert.equal(session.state().pinnedBy, "Joe");
  db.archiveItem(items[1].id);
  session.itemsChanged();
  assert.equal(session.state().focusItemId, items[0].id);
  assert.equal(session.state().pinnedBy, null, "the pin went with its item");

  session.demoSuggest(items[2].id, "Three is on screen");
  db.archiveItem(items[2].id);
  session.itemsChanged();
  assert.equal(session.state().suggestion, null, "no nudge for an item that's gone");
  await session.end();
});

test("Undo of Switch and move puts the focus and every remark back, late ones too", async () => {
  const { db, session, items, meetingId } = setup();
  const host = await join(session, { id: "u1", name: "Joe" });
  session.addSpeech("u2", "Sam", "Before the screen changed", Date.now() - 5_000);
  session.demoSuggest(items[2].id, "Three is on screen");
  await new Promise((r) => setTimeout(r, 5));
  session.addSpeech("u2", "Sam", "Still on one, really", Date.now());
  await say(host, { type: "suggestion.accept", cid: "a" });
  assert.equal(session.state().focusItemId, items[2].id);
  // Words spoken before the click, arriving after it.
  session.addSpeech("u3", "Ann", "Agreed on one", Date.now() - 1);
  await say(host, { type: "suggestion.undo", cid: "u" });
  assert.equal(session.state().focusItemId, items[0].id);
  assert.deepEqual(
    db.meetingSegments(meetingId).map((s) => s.itemId),
    [items[0].id, items[0].id, items[0].id],
  );
  await session.end();
});

test("only one person shares at a time; the second is told who is", async () => {
  const { session } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  await say(joe, { type: "sharing", on: true });
  await say(ann, { type: "sharing", on: true });
  const err = ann.got.find((m) => m.type === "error");
  assert.match(err?.type === "error" ? err.message : "", /Joe is already sharing/);
  assert.deepEqual(
    session.state().participants.filter((p) => p.isSharing).map((p) => p.id),
    ["u1"],
  );
  await session.end();
});

test("notes that fail stay marked on their item until a try works, and anyone can retry", async () => {
  const { session, items } = setup();
  const agent = (session as unknown as { agent: HeuristicAgent }).agent;
  const real = agent.notesFor.bind(agent);
  agent.notesFor = () => Promise.reject(new Error("rate limited"));
  const ann = await join(session, { id: "u2", name: "Ann" });
  session.addSpeech("u2", "Ann", "We should ship the checklist on Friday", Date.now());
  await say(ann, { type: "notes.retry", itemId: items[0].id });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(session.state().notesFailing, [items[0].id]);
  agent.notesFor = real;
  await say(ann, { type: "notes.retry", itemId: items[0].id });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(session.state().notesFailing, []);
  await session.end();
});

test("a rate-limited notes run waits it out instead of trying again at every pause", async () => {
  const { session, items } = setup();
  const agent = (session as unknown as { agent: HeuristicAgent }).agent;
  let tries = 0;
  agent.notesFor = () => (tries++, Promise.reject(new NotesTrouble("busy", 30_000)));
  const ann = await join(session, { id: "u2", name: "Ann" });
  await say(ann, { type: "notes.retry", itemId: items[0].id });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tries, 1);
  assert.equal(session.state().notesTrouble, "busy");
  const told = ann.got.filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.message : ""));
  assert.match(told.join(" "), /rate limit/);
  // More talk while it's held: no new run until the wait is over.
  session.addSpeech("u2", "Ann", "Let's ship the checklist on Friday", Date.now());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tries, 1);
  agent.notesFor = HeuristicAgent.prototype.notesFor.bind(agent);
  await session.end();
});

test("someone whose browser can't transcribe shows as not recorded to everyone", async () => {
  const { session } = setup();
  await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  await say(ann, { type: "recording", on: false });
  assert.equal(session.state().participants.find((p) => p.id === "u2")?.notRecording, true);
  await say(ann, { type: "recording", on: true });
  assert.equal(session.state().participants.find((p) => p.id === "u2")?.notRecording, false);
  await session.end();
});

test("after a restart the held seat names its host and says how long it's held", async () => {
  const { db, session } = setup();
  const room = db.getRoom(session.roomId)!;
  const joe = db.upsertUser({ googleSub: null, email: "joe@example.com", name: "Joe Liang", picture: null });
  await join(session, { id: joe.id, name: joe.name });
  const [open] = db.openMeetings(room.id);
  const again = new RoomSession(db, new HeuristicAgent(), room, () => {}, undefined, undefined, open);
  await join(again, { id: "u2", name: "Ann" });
  assert.equal(again.state().hostAway, "Joe Liang");
  assert.ok((again.state().hostAwayMs ?? 0) > 0);
  await again.end();
});

test("transcription that stops starts again by itself once, then asks people to rejoin", async (t) => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  let started = 0;
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {}, () => (started++, { stop: async () => {} }));
  const joe = await join(session, { id: "u1", name: "Joe" });
  assert.equal(started, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.transcriptionFailed("speech-to-text stopped");
  assert.equal(session.state().transcriptionDown, true);
  assert.equal(session.state().transcriptionRestarting, true);
  assert.match(String(joe.got.findLast((m) => m.type === "error")?.message), /starting it again/);
  t.mock.timers.tick(10_000);
  assert.equal(started, 2);
  assert.equal(session.state().transcriptionDown, false);
  // A second stop soon after: no loop of restarts, people are told what to do.
  session.transcriptionFailed("speech-to-text stopped");
  t.mock.timers.tick(10_000);
  assert.equal(started, 2);
  assert.equal(session.state().transcriptionRestarting, false);
  assert.match(String(joe.got.findLast((m) => m.type === "error")?.message), /Leave and rejoin/);
  t.mock.timers.reset();
  await session.end();
});
