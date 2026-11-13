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
import { AgentError, agentApi } from "./agents.ts";
import { meetingTimeline } from "./timeline.ts";
import { upNextView } from "./upNextPolish.ts";
import { UploadLinks } from "./workLog.ts";
import type { BoardAnswer } from "./board.ts";
import { changeReview } from "./planReview.ts";
import { outlineToSlides } from "../shared/outline.ts";
import { config } from "./config.ts";
import { addSlide, startReview } from "./reviews.ts";

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
  const [dash, alerts] = db.syncNotes(first.id, ticket.id, [
    { kind: "action", text: "Add a dashboard", owner: "Priya" },
    { kind: "action", text: "Page on p95", owner: null },
  ]);
  // Notes regenerate while the meeting runs; a checked-off action stays checked.
  assert.ok(db.setActionDone(room.id, alerts.id, "Joe"));
  const again = db.syncNotes(first.id, ticket.id, [
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

test("one topic for an hour: its older talk folds into where it stood, and the run carries it on", async (ctx) => {
  // Regrouping talk still going (settle.ts LOCK_AFTER_MS locks it sooner).
  config.notesLock = false;
  ctx.after(() => {
    config.notesLock = true;
  });
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
      // Deciding per seat answered the open question.
      answered: ["Q1"],
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
  db.syncNotes(m.id, item.id, [
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

test("ending lets everyone go to the recap at once; the recap is written after, and a new call can start meanwhile", async () => {
  const { db, session } = setup();
  const room = db.getRoom(session.roomId)!;
  await session.end();
  const agent = new HeuristicAgent();
  let writeRecap!: () => void;
  const recapped = new Promise<void>((r) => (writeRecap = r));
  const slow = agent.recapMeeting.bind(agent);
  agent.recapMeeting = async (input) => {
    await recapped;
    return slow(input);
  };
  const s = new RoomSession(db, agent, room, () => {});
  let released = false;
  s.onRelease = () => (released = true);
  const ws = await join(s, { id: "u1", name: "Joe" });
  s.addSpeech("u1", "Joe", "Something worth a note", Date.now());
  const ending = s.end();
  for (let i = 0; i < 20 && !released; i++) await new Promise((r) => setImmediate(r));
  assert.ok(released, "the space is let go before the recap is written");
  assert.ok(ws.got.some((m) => m.type === "meeting.ended" && m.meetingId === s.meetingId));
  assert.equal(db.getMeeting(s.meetingId)?.endedAt, null);
  assert.ok(db.getMeeting(s.meetingId)?.endRequestedAt);
  // Someone who comes back with the old meeting is sent to its recap, not into the new call.
  const next = new RoomSession(db, new HeuristicAgent(), room, () => {});
  const late = await join(next, { id: "u1", name: "Joe" }, { type: "hello", meetingId: s.meetingId });
  assert.deepEqual(late.got, [{ type: "meeting.ended", meetingId: s.meetingId }]);
  writeRecap();
  await ending;
  assert.ok(db.getMeeting(s.meetingId)?.endedAt);
  await next.end();
});

test("anyone in the call flips a review's slides, but only the host moves to an item outside it", async () => {
  const { db, session, items } = setup();
  addSlide(db, session.roomId, { title: "Mic picker", summary: "", addedBy: "x" });
  addSlide(db, session.roomId, { title: "Dark mode", summary: "", addedBy: "x" });
  const host = await join(session, { id: "u1", name: "Joe" });
  const guest = await join(session, { id: "u2", name: "Huy" });
  const started = startReview(db, session.roomId);
  session.itemsChanged();
  await say(host, { type: "focus", itemId: started.firstItemId });
  const slides = db.listItems(session.roomId).filter((i) => i.deckId === started.deckId);
  assert.equal(slides.length, 2);
  await say(guest, { type: "focus", itemId: slides[1].id });
  assert.equal(session.state().focusItemId, slides[1].id);
  await say(guest, { type: "focus", itemId: items[0].id });
  assert.equal(session.state().focusItemId, slides[1].id, "an item outside the review stays the host's");
  await session.end();
});

test("presenting: whoever starts something presents it, everyone else is told and follows their view, and it ends with it", async () => {
  const { session } = setup();
  const joe = await join(session, { id: "u1", name: "Joe Liang" });
  const jan = await join(session, { id: "u2", name: "Janesh Chhabra" });
  const huy = await join(session, { id: "u3", name: "Huy Ngo" });
  const notices = (ws: FakeSocket) => ws.got.flatMap((m) => (m.type === "notice" ? [m.message] : []));
  // Janesh starts sharing: he presents, the host seat stays with Joe, and the others are told.
  await say(jan, { type: "sharing", on: true });
  assert.deepEqual(session.state().presenter, { id: "u2", name: "Janesh Chhabra", what: "screen" });
  assert.ok(session.hosts("u1"));
  assert.deepEqual(notices(joe), ["Janesh is presenting their screen"]);
  assert.deepEqual(notices(jan), []);
  // Only the presenter's view is everyone's now, the map tab included; the host's isn't.
  await say(joe, { type: "host.view", view: { tab: "board", rewind: null, pane: "words" } });
  assert.equal(session.state().hostView, null);
  await say(jan, { type: "host.view", view: { tab: "board", rewind: null, pane: "map" } });
  assert.equal(session.state().hostView?.pane, "map");
  // Huy takes over the screen: Janesh is told his share stopped, Joe that Huy presents.
  await say(huy, { type: "sharing", on: true });
  assert.equal(session.state().presenter?.id, "u3");
  assert.match(notices(jan).at(-1)!, /Huy is sharing now/);
  assert.equal(notices(joe).at(-1), "Huy is presenting their screen");
  // Huy opens a review while sharing, then stops sharing: the review is his to present again.
  session.present("u3", "product review");
  await say(huy, { type: "sharing", on: false });
  assert.deepEqual(session.state().presenter, { id: "u3", name: "Huy Ngo", what: "product review" });
  // Huy leaves: nobody presents, and everyone follows the host again.
  huy.close();
  assert.equal(session.state().presenter, null);
  await session.end();
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

test("the host's view goes to everyone; nobody else can set it, and a new host starts it fresh", async () => {
  const { session } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  const view = { tab: "board" as const, rewind: { id: "t1", key: "t1-5", at: 5, live: "t2" } };
  await say(joe, { type: "host.view", view });
  assert.deepEqual(session.state().hostView, view);
  await say(ann, { type: "host.view", view: { tab: "main", rewind: null } });
  assert.deepEqual(session.state().hostView, view);
  await say(joe, { type: "host.view", view: { tab: "sideways", rewind: null } as never });
  assert.deepEqual(session.state().hostView, view);
  await say(joe, { type: "host.give", participantId: "u2" });
  assert.equal(session.state().hostView, null);
  await say(ann, { type: "host.view", view: { tab: "main", rewind: { id: "kickoff", key: "kickoff", at: 1, live: null, page: 2 } } });
  assert.deepEqual(session.state().hostView?.rewind?.page, 2);
  await session.end();
});

test("everyone sees who is muted, once their page has said", async () => {
  const { session } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  const muted = () => session.state().participants.map((p) => [p.id, p.muted]);
  assert.deepEqual(muted(), [["u1", undefined], ["u2", undefined]]);
  await say(joe, { type: "mic", on: false });
  await say(ann, { type: "mic", on: true });
  assert.deepEqual(muted(), [["u1", true], ["u2", false]]);
  // Saying the same again (a reconnect) tells nobody anything.
  const before = ann.got.length;
  await say(joe, { type: "mic", on: false });
  assert.equal(ann.got.length, before);
  await say(joe, { type: "mic", on: true });
  assert.deepEqual(muted(), [["u1", false], ["u2", false]]);
  await session.end();
});

test("the room keeps what the main view showed each time it changed", async () => {
  const { db, session, items, meetingId } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  session.setFocus(items[1].id, "Joe", "manual");
  await say(joe, { type: "sharing", on: true });
  await say(joe, { type: "sharing", on: true });
  await say(joe, { type: "sharing", on: false });
  const views = db.stageEvents(meetingId).map((e) => [e.view.itemId, e.view.sharing]);
  // Each change once, in order; saying the same again adds nothing.
  assert.deepEqual(views.slice(-3), [
    [items[1].id, null],
    [items[1].id, "Joe"],
    [items[1].id, null],
  ]);
  await session.end();
});

test("one person shares at a time: a second share takes over, and the first sharer is told", async () => {
  const { session } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  await say(joe, { type: "sharing", on: true });
  await say(ann, { type: "sharing", on: true });
  const told = joe.got.find((m) => m.type === "notice");
  assert.match(told?.type === "notice" ? told.message : "", /Ann is sharing now/);
  assert.ok(!ann.got.some((m) => m.type === "error"));
  assert.deepEqual(
    session.state().participants.filter((p) => p.isSharing).map((p) => p.id),
    ["u2"],
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

test("a line a notes run leaves out stays in its topic, and a topic left out whole comes back", async (ctx) => {
  // Regrouping talk still going (settle.ts LOCK_AFTER_MS locks it sooner).
  config.notesLock = false;
  ctx.after(() => {
    config.notesLock = true;
  });
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const MIN = 60_000;
  const t = Date.now();
  const topic = (name: string, segmentIndexes: number[]) => ({ topic: name, positions: [], outcome: "open" as const, segmentIndexes, continuesId: null });
  const drafts: ItemNotesDraft[] = [
    { notes: [], discussions: [topic("Pricing", [0, 1, 2, 3, 4, 5]), topic("Hiring", [6, 7, 8, 9]), topic("Lunch", [10, 11])] },
    // Renamed Pricing and kept only its first lines, forgot Hiring, carried Lunch on.
    { notes: [], discussions: [topic("Pricing for teams", [0, 1, 2]), topic("Lunch", [10, 11, 12])] },
    // As the meeting ends: Hiring left out on purpose.
    { notes: [], discussions: [topic("Pricing for teams", [0, 1, 2, 3, 4, 5]), topic("Lunch", [10, 11, 12])] },
  ];
  const agent = Object.assign(new HeuristicAgent(), {
    async notesFor(item: Item | null, segments: Segment[]) {
      return drafts.shift() ?? new HeuristicAgent().notesFor(item, segments);
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const refresh = (session as unknown as { refreshNotes(id: string | null): Promise<Note[]> }).refreshNotes.bind(session);
  for (let i = 0; i < 12; i++) session.addSpeech(`p${i % 3}`, `P${i % 3}`, `Remark ${i}`, t - (13 - i) * MIN);
  const itemId = db.meetingSegments(session.meetingId)[0].itemId;
  await refresh(itemId);
  const first = new Map(db.meetingDiscussions(session.meetingId).map((d) => [d.topic, d]));
  session.addSpeech("p0", "P0", "Remark 12", t);
  await refresh(itemId);
  const lines = new Map(db.meetingSegments(session.meetingId).map((s) => [s.id, s.text]));
  const topics = db.meetingDiscussions(session.meetingId).map((d) => [d.id, d.topic, d.segmentIds.map((id) => lines.get(id)).join(",")]);
  assert.deepEqual(topics, [
    [first.get("Pricing")!.id, "Pricing for teams", "Remark 0,Remark 1,Remark 2,Remark 3,Remark 4,Remark 5"],
    [first.get("Hiring")!.id, "Hiring", "Remark 6,Remark 7,Remark 8,Remark 9"],
    [first.get("Lunch")!.id, "Lunch", "Remark 10,Remark 11,Remark 12"],
  ]);
  await session.end();
  assert.deepEqual(
    db.meetingDiscussions(session.meetingId).map((d) => d.topic),
    ["Pricing for teams", "Lunch"],
  );
});

test("the board's running list: lines come in, anyone ticks a to-do (and its live note), only the host takes one off", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const [item] = db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "One", url: null, description: null }]);
  const agent = Object.assign(new HeuristicAgent(), {
    async liveList() {
      return { add: [{ kind: "todo" as const, who: "Huy", text: "Send Joe the repo link", line: 1 }], change: [], close: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const host = await join(session, { id: "u1", name: "Joe" });
  const guest = await join(session, { id: "u2", name: "Huy" });
  assert.deepEqual(host.got.find((m) => m.type === "list"), { type: "list", items: [] });
  session.addSpeech("u2", "Huy", "I'll send Joe the repo link", Date.now());
  await (session as unknown as { listPasses: { run(): Promise<void> } }).listPasses.run();
  const lastList = (ws: FakeSocket) => ws.got.filter((m) => m.type === "list").at(-1) as Extract<ServerMessage, { type: "list" }>;
  const [line] = lastList(guest).items!;
  assert.deepEqual([line.kind, line.owner, line.itemId], ["action", "Huy", item.id]);
  assert.equal(db.meetingList(session.meetingId)?.length, 1);

  // The live notes caught the same to-do in their own words: ticking the board's line ticks it too.
  db.addNote(session.meetingId, item.id, { kind: "action", text: "Send Joe the link to the repo", owner: "Huy" }, null);
  await say(guest, { type: "followup.done", noteId: line.id, done: true });
  assert.equal(lastList(guest).items![0].doneBy, "Huy");
  assert.equal(db.meetingNotes(session.meetingId).find((n) => n.kind === "action")?.doneBy, "Huy");

  // Taking a line off is the host's; Undo puts it back.
  await say(guest, { type: "note.remove", noteId: line.id });
  assert.equal(lastList(guest).items!.length, 1);
  await say(host, { type: "note.remove", noteId: line.id });
  assert.equal(lastList(guest).items!.length, 0);
  await say(host, { type: "note.restore", noteId: line.id });
  assert.equal(lastList(guest).items!.length, 1);
});

test("without a model there's no running list: the board's tabs read the live notes", async () => {
  const { session } = setup();
  const ws = await join(session, { id: "u1", name: "Joe" });
  assert.deepEqual(ws.got.find((m) => m.type === "list"), { type: "list", items: null });
});

test("tasks: done needs what closed it, drop keeps why and leaves open lists, and a rewrite keeps both", () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Tasks");
  const m = db.startMeeting(room.id);
  const [fix, docs, q] = db.syncNotes(m.id, null, [
    { kind: "action", text: "Fix the Railway deploy", owner: "Joe" },
    { kind: "action", text: "Write the docs", owner: "Huy" },
    { kind: "question", text: "Do we keep SQLite?", owner: null },
  ]);
  assert.equal(db.setActionDone(room.id, fix.id, "Joe")?.closedBy, "confirmed");
  const dropped = db.setTaskState(room.id, docs.id, { state: "dropped", by: "Andy", reason: "Conxt has them" })!;
  assert.deepEqual([dropped.state, dropped.dropReason, dropped.doneBy, !!dropped.doneAt], ["dropped", "Conxt has them", "Andy", true]);
  assert.equal(db.setTaskState(room.id, q.id, { state: "done", by: "Joe" })?.state, "done");
  // The live notes rewrite the item: each task keeps where it stood.
  const again = db.syncNotes(m.id, null, [
    { kind: "action", text: "Fix the Railway deploy", owner: "Joe" },
    { kind: "action", text: "Write the docs", owner: "Huy" },
    { kind: "question", text: "Do we keep SQLite?", owner: null },
  ]);
  assert.deepEqual(again.map((n) => [n.state, n.closedBy ?? n.dropReason]), [["done", "confirmed"], ["dropped", "Conxt has them"], ["done", "confirmed"]]);
  db.endMeeting(m.id, null);
  // A dropped to-do isn't open anywhere that lists open to-dos.
  assert.deepEqual(db.openActions(room.id), []);
  // Back to open, and Still on it marks when it was checked; Undo clears that.
  const reopened = db.setTaskState(room.id, docs.id, { state: "open", by: "Huy", checked: true })!;
  assert.deepEqual([reopened.state, reopened.doneAt, reopened.dropReason, !!reopened.checkedAt], [null, null, null, true]);
  assert.equal(db.setTaskState(room.id, docs.id, { state: "open", by: "Huy", checked: false })?.checkedAt, null);
  // A decision is a closed Decide task; it can't be moved, and another space can't move anything.
  const [dec] = db.syncNotes(db.startMeeting(room.id).id, null, [{ kind: "decision", text: "Keep SQLite", owner: null }]);
  assert.equal(db.setTaskState(room.id, dec.id, { state: "dropped", by: "Joe" }), null);
  assert.equal(db.setTaskState(db.createRoom("Other").id, docs.id, { state: "done", by: "Mallory" }), null);
});

test("since last time: carried tasks open the meeting, Stand hears one called done, and answers stick", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Check-in");
  const last = db.startMeeting(room.id);
  const [railway, docs, pr] = db.syncNotes(last.id, null, [
    { kind: "action", text: "Fix the Railway deploy", owner: "Joe" },
    { kind: "action", text: "Write the docs", owner: "Huy" },
    { kind: "action", text: "Ship the bar fix", owner: "Andy" },
  ]);
  db.endMeeting(last.id, null);
  // Between meetings a PR merged and closed one.
  db.setActionDone(room.id, pr.id, "Andy via GitHub", "pr:https://github.com/a/b/pull/7");
  let shown = "";
  const agent = Object.assign(new HeuristicAgent(), {
    async liveList(_c: string, talk: string) {
      shown = talk;
      return { add: [], change: [], close: [], said_done: [{ id: "t1", line: 1 }] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const joe = await join(session, { id: "u1", name: "Joe" });
  const state = () => (joe.got.filter((m) => m.type === "state").at(-1) as Extract<ServerMessage, { type: "state" }>).state;
  // Open ones oldest first, and the one the PR closed since last time.
  assert.deepEqual(state().followUps.map((f) => [f.text, !!f.doneAt]), [["Fix the Railway deploy", false], ["Write the docs", false], ["Ship the bar fix", true]]);
  assert.deepEqual(state().checkIn, { closed: false, answeredAt: null, page: 0, closedAt: null, held: false });
  // Anyone turns the opening board's page, for everyone.
  await say(joe, { type: "checkin.page", page: 1 });
  assert.equal(state().checkIn?.page, 1);

  session.addSpeech("u1", "Joe", "I fixed the Railway deploy yesterday", Date.now());
  await (session as unknown as { listPasses: { run(): Promise<void> } }).listPasses.run();
  assert.match(shown, /Open tasks from earlier meetings:\n- \[t1\] \(Joe\) Fix the Railway deploy\n- \[t2\] \(Huy\) Write the docs/);
  const heard = state().followUps.find((f) => f.id === railway.id)!;
  assert.deepEqual([heard.saidDone?.speaker, heard.saidDone?.text, heard.doneAt], ["Joe", "I fixed the Railway deploy yesterday", null]);

  await say(joe, { type: "task.state", noteId: railway.id, state: "done" });
  await say(joe, { type: "task.state", noteId: docs.id, state: "open", still: true });
  const after = state();
  assert.equal(after.followUps.find((f) => f.id === railway.id)?.closedBy, "confirmed");
  assert.ok(after.followUps.find((f) => f.id === docs.id)!.checkedAt! >= session.meetingStartedAt);
  assert.ok(after.checkIn?.answeredAt);
  await say(joe, { type: "checkin", open: false });
  assert.equal(state().checkIn?.closed, true);
  const closedAt = state().checkIn?.closedAt;
  // Brought back from the board on the page someone was looking at, it stays until someone moves on again;
  // the Kickoff chapter still ends where the board first moved on.
  await say(joe, { type: "checkin", open: true, page: 1 });
  assert.deepEqual([state().checkIn?.closed, state().checkIn?.held, state().checkIn?.page, state().checkIn?.closedAt], [false, true, 1, closedAt]);
  await say(joe, { type: "checkin", open: false });
  assert.deepEqual([state().checkIn?.closed, state().checkIn?.held], [true, false]);
});

/** An agent that answers every question with "Fly.io" at once, so ✦ Stand's cards run in tests. */
class AnsweringAgent extends HeuristicAgent {
  async liveList() {
    return { add: [], change: [], close: [] } as never;
  }
  async findOptions() {
    return { answer: null, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 } };
  }
  async answer(prompt: string) {
    return { answer: { answer: `An answer (${prompt.length} characters asked)`, sources: [], todo: null, from_space: [] }, model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 } };
  }
}

test("Pilot: only the pilot asks Stand; a typed follow-up lands on its card; asking to pilot and handing over", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const session = new RoomSession(db, new AnsweringAgent(), room, () => {});
  const joe = await join(session, { id: "u1", name: "Joe" });
  const andy = await join(session, { id: "u2", name: "Andy" });
  const pilotOf = (ws: FakeSocket) => ws.got.filter((m) => m.type === "pilot").at(-1);
  const cardsOf = (ws: FakeSocket) => {
    const m = ws.got.filter((x) => x.type === "agent").at(-1);
    return m?.type === "agent" ? m.cards : [];
  };

  // Joe types first and takes the free seat.
  await say(joe, { type: "agent.ask.text", text: "What does Fly.io cost?", follows: null });
  const seat = pilotOf(andy);
  assert.equal(seat?.type === "pilot" && seat.pilot.name, "Joe");
  await new Promise((r) => setTimeout(r, 20));
  const first = cardsOf(joe)[0];
  assert.equal(first.status, "ready");

  // Andy can't ask, out loud or typed; he's told who pilots.
  await say(andy, { type: "agent.ask.text", text: "And Render?", follows: first.id });
  await say(andy, { type: "agent.ask.start" });
  assert.equal(cardsOf(joe).length, 1);
  const told = andy.got.filter((m) => m.type === "error").at(-1);
  assert.match(told?.type === "error" ? told.message : "", /Joe is piloting/);

  // Joe's follow-up lands on the first card right away, while Stand works on it.
  await say(joe, { type: "agent.ask.text", text: "And for two?", follows: first.id });
  const follow = cardsOf(joe)[1];
  assert.equal(follow.follows, first.id);

  // Andy asks to pilot; Joe hands over; now Andy asks and Joe can't.
  await say(andy, { type: "pilot.request" });
  const asked = pilotOf(joe);
  assert.deepEqual(asked?.type === "pilot" && asked.pilot.requests.map((r) => r.name), ["Andy"]);
  await say(joe, { type: "pilot.answer", yes: true });
  const moved = pilotOf(andy);
  assert.equal(moved?.type === "pilot" && moved.pilot.last?.how, "gave");
  assert.equal(moved?.type === "pilot" && moved.pilot.name, "Andy");
  await say(andy, { type: "agent.ask.text", text: "New question", follows: null });
  assert.equal(cardsOf(joe).at(-1)?.by, "Andy");
  assert.equal(cardsOf(joe).at(-1)?.follows, null);
  await say(joe, { type: "chat", text: "@stand one more" });
  assert.equal(cardsOf(joe).at(-1)?.by, "Andy");
  await session.end();
});

test("presenting a task with a spec starts a design review of it: slides to walk through, points to call, a verdict", async () => {
  const { db, session, meetingId, items } = setup();
  const roomId = session.state().roomId;
  const joe = await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  const bob = await join(session, { id: "u3", name: "Bob" });
  const task = db.addNote(meetingId, items[0].id, { kind: "action", text: "Review rollout", owner: "Ann" }, null);
  const spec = "# Rollout\n\n## Stages\n\nShip to ten percent first.\n\n## Risks\n\nThe bill may double.";
  db.addPlan(roomId, task.id, spec, "Ann");
  const plan = db.planVersions(task.id)[0];
  const at = (q: string) => ({ start: spec.indexOf(q), end: spec.indexOf(q) + q.length });
  changeReview(db, task.id, "Ann", { action: "create", version: plan.id, text: "Is ten percent too many?", ...at("Ship to ten percent first.") });

  await say(joe, { type: "task.present", taskId: task.id });
  const deck = () => session.state().items.filter((i) => i.slide?.layout === "design");
  const on = () => session.state().items.find((i) => i.id === session.state().focusItemId)!;
  assert.deepEqual(deck().map((i) => i.slide!.design!.role), ["overview", "section", "point", "section", "verdict"]);
  assert.equal(on().slide!.design!.role, "overview");
  assert.equal(session.state().items[0].id, on().id, "the review leads the agenda");
  assert.ok(db.noteUpdates(task.id).some((u) => u.text.startsWith("Review requested")));

  // What's said is filed under the slide on screen.
  const [, stages, point, risks, verdict] = deck();
  await say(joe, { type: "focus", itemId: point.id });
  session.addSpeech("u3", "Bob", "Ten percent is too many for the first day", Date.now());
  assert.equal(db.meetingSegments(meetingId).at(-1)?.itemId, point.id);

  // The spec's author moves between its slides for everyone; nobody else who isn't the host does.
  await say(bob, { type: "design.go", itemId: risks.id });
  assert.equal(on().id, point.id);
  await say(ann, { type: "design.go", itemId: risks.id });
  assert.equal(on().id, risks.id);
  await say(ann, { type: "design.go", itemId: items[1].id });
  assert.equal(on().id, risks.id);

  // Anyone calls a point and the verdict, with the outcomes each takes.
  await say(bob, { type: "design.outcome", itemId: point.id, outcome: "approve" });
  assert.equal(deck()[2].slide!.design!.outcome, null);
  await say(bob, { type: "design.outcome", itemId: point.id, outcome: "settled" });
  assert.deepEqual([deck()[2].slide!.design!.outcome, deck()[2].slide!.design!.outcomeBy], ["settled", "Bob"]);
  await say(ann, { type: "design.outcome", itemId: verdict.id, outcome: "changes" });
  assert.equal(deck()[4].slide!.design!.outcome, "changes");
  assert.equal(stages.slide!.design!.section, "Stages");

  // The review ends with the meeting: its slides leave the agenda.
  await session.end();
  assert.equal(db.listItems(roomId).some((i) => i.slide?.layout === "design"), false);
  assert.equal(db.reviewIn(roomId, ["live"], "design"), null);
  assert.equal(db.reviewIn(roomId, ["done"], "design")!.meetingId, meetingId);
});

test("presenting a task moves the meeting to an item for it, so what's said is filed under the task", async () => {
  const { db, session, meetingId, items } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  const ann = await join(session, { id: "u2", name: "Ann" });
  const task = db.addNote(meetingId, items[0].id, { kind: "action", text: "Review rollout", owner: "Joe" }, null);
  session.setFocus(items[1].id, "Joe", "manual");

  // Only the host presents, and only a task of this space.
  await say(ann, { type: "task.present", taskId: task.id });
  assert.equal(session.state().focusItemId, items[1].id);
  const otherRoom = db.createRoom("Private");
  const privateTask = db.addNote(db.startMeeting(otherRoom.id).id, null, { kind: "action", text: "Private task", owner: null }, null);
  await say(joe, { type: "task.present", taskId: privateTask.id });
  assert.equal(session.state().focusItemId, items[1].id);

  await say(joe, { type: "task.present", taskId: task.id });
  const shown = session.state().items.find((i) => i.id === session.state().focusItemId);
  assert.equal(shown?.taskId, task.id);
  assert.equal(shown?.title, "Review rollout");
  assert.match(shown?.description ?? "", /Walking through the to-do "Review rollout" \(Joe\)/);
  session.addSpeech("u2", "Ann", "Ten percent is too many for the first day", Date.now());
  assert.equal(db.meetingSegments(meetingId).at(-1)?.itemId, shown?.id);

  // The brief or the full spec is the host's choice for everyone.
  await say(ann, { type: "host.view", view: { tab: "main", rewind: null, taskMode: "spec" } });
  assert.equal(session.state().hostView?.taskMode, undefined);
  await say(joe, { type: "host.view", view: { tab: "main", rewind: null, taskMode: "bad" as never } });
  assert.equal(session.state().hostView?.taskMode, undefined);
  await say(joe, { type: "host.view", view: { tab: "main", rewind: null, taskMode: "spec" } });
  assert.equal(session.state().hostView?.taskMode, "spec");

  // Presenting it again is the same item; stopping goes back to where the meeting was.
  await say(joe, { type: "task.present", taskId: task.id });
  assert.equal(session.state().items.filter((i) => i.taskId === task.id).length, 1);
  await say(joe, { type: "task.present", taskId: null });
  assert.equal(session.state().focusItemId, items[1].id);

  // After the meeting it is off the agenda, and comes back with its history when presented again.
  await session.end();
  assert.equal(db.listItems(session.state().roomId).some((i) => i.taskId), false);
  assert.equal(db.taskItem(session.state().roomId, task.id, "Review rollout", null).id, shown?.id);
});

test("a brainstorm's map is drawn from the call's talk beside the board, and is done when the meeting ends", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const [roadmap] = db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "Roadmap", url: null, description: null }]);
  const asked: string[] = [];
  const agent = Object.assign(new HeuristicAgent(), {
    async brainstormMap(_context: string, talk: string) {
      asked.push(talk);
      return asked.length > 1
        ? { add: [], extend: [], caught: [] }
        : { add: [{ cluster: null, under: "root", label: "From the work", detail: "Start from what shipped.", by: "Huy", line: 1 }, { cluster: null, under: "new1", label: "Agents add slides", detail: "Each agent adds a slide when it finishes.", by: "Huy", line: 1 }], extend: [], caught: [] };
    },
  });
  const sent: ServerMessage[] = [];
  const session = new RoomSession(db, agent, room, () => {});
  (session as unknown as { broadcast(m: ServerMessage): void }).broadcast = (m) => void sent.push(m);
  const boardWaits: number[] = [];
  (session as unknown as { boardPasses: { schedule(wait: number): void } }).boardPasses.schedule = (wait) => void boardWaits.push(wait);
  // Started during the call, it adds nothing to the agenda and the call stays where it was.
  const b = startBrainstorm(db, room.id, "How should a review start?", "Joe");
  session.brainstormChanged();
  assert.equal(b.itemId, null);
  assert.deepEqual(db.listItems(room.id).map((i) => i.id), [roadmap.id]);
  assert.equal(session.state().focusItemId, roadmap.id);
  session.addSpeech("p1", "Huy", "each agent could add a slide when it finishes", Date.now());
  assert.equal(boardWaits.length, 1, "the board goes on while the map draws");
  await (session as unknown as { mapPasses: { run(): Promise<void> } }).mapPasses.run();
  assert.deepEqual(db.getBrainstorm(b.id)!.nodes.map((n) => [n.id, n.label]), [["d1", "From the work"], ["i1", "Agents add slides"]]);
  const maps = sent.flatMap((m) => (m.type === "brainstorm" ? [m.brainstorm] : []));
  assert.equal(maps.at(-1)!.nodes.length, 2);
  // Anyone takes a circle off; it leaves the map everyone sees.
  const inner = session as unknown as { brain: { map: { remove(id: string): boolean } }; saveBrainstorm(): void };
  assert.equal(inner.brain.map.remove("i1"), true);
  inner.saveBrainstorm();
  assert.deepEqual(maps.length && sent.flatMap((m) => (m.type === "brainstorm" ? [m.brainstorm] : [])).at(-1)!.nodes.map((n) => n.id), ["d1"]);
  await session.end();
  const done = db.getBrainstorm(b.id)!;
  assert.deepEqual([done.status, done.meetingId], ["done", session.meetingId]);
  assert.deepEqual(db.listItems(room.id).map((i) => i.title), ["Roadmap"]);
});

test("a running-list pass that fails waits before the next, instead of retrying in a loop", async () => {
  let calls = 0;
  class FailingList extends HeuristicAgent {
    async liveList(): Promise<never> {
      calls++;
      throw new Error("API overloaded");
    }
  }
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const session = new RoomSession(db, new FailingList(), room, () => {});
  // Talk older than the list's longest wait: the first pass starts at once.
  session.addSpeech("p1", "Joe", "We should ship the fix today.", Date.now() - 30_000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 1, "one failed pass, then a wait");
  await session.end();
});

test("what isn't a message is ignored, and a remark only moves to an item on this agenda", async () => {
  const { db, session, items, meetingId } = setup();
  const joe = await join(session, { id: "u1", name: "Joe" });
  for (const raw of ["null", "42", '"chat"', '{"text":"no type"}', '{"type":"chat","text":"hi","cid":7}']) joe.emit("message", Buffer.from(raw));
  await new Promise((r) => setImmediate(r));
  assert.equal(db.meetingSegments(meetingId).length, 0, "nothing landed in the transcript");
  assert.equal(joe.got.filter((m) => m.type === "error").length, 0, "and nothing threw");
  await say(joe, { type: "chat", text: "On the first item" });
  const [seg] = db.meetingSegments(meetingId);
  await say(joe, { type: "segment.move", segmentId: seg.id, itemId: "elsewhere" });
  assert.equal(db.meetingSegments(meetingId)[0].itemId, seg.itemId, "an id from no agenda here is refused");
  await say(joe, { type: "segment.move", segmentId: seg.id, itemId: items[2].id });
  assert.equal(db.meetingSegments(meetingId)[0].itemId, items[2].id);
  await say(joe, { type: "segment.move", segmentId: seg.id, itemId: null });
  assert.equal(db.meetingSegments(meetingId)[0].itemId, null, "General is fine");
});

test("Finish leaves a map alone; Stop drawing reads the talk no pass has read, keeps the map, and the call goes on", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const b = startBrainstorm(db, room.id, "How should a review start?", "Joe");
  let passes = 0;
  const agent = Object.assign(new HeuristicAgent(), {
    async brainstormMap() {
      passes++;
      return { add: [{ cluster: null, under: "root", label: "From the work", detail: "Start from what shipped.", by: "Huy", line: 1 }], extend: [], caught: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const huy = await join(session, { id: "u2", name: "Huy" });
  session.addSpeech("p1", "Huy", "start from what shipped", Date.now());
  assert.deepEqual(await session.finishExperience(), []);
  assert.equal(db.getBrainstorm(b.id)!.status, "live");
  // Anyone in the call stops it.
  await say(huy, { type: "view.stop" });
  for (let i = 0; i < 50 && db.getBrainstorm(b.id)!.status === "live"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(passes, 1, "one last pass before the map is the record");
  assert.deepEqual(db.getBrainstorm(b.id)!.nodes.map((n) => n.label), ["From the work"]);
  assert.equal(db.getBrainstorm(b.id)!.status, "done");
  session.addSpeech("p1", "Huy", "and now something else", Date.now());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(passes, 1, "no map passes once it's stopped");
  assert.equal(await session.stopView(), false);
  await session.end();
});

test("whoever starts a review presents it until it is finished, and the host seat stays; a map never reads a slide's talk", async () => {
  const { finishBrainstorm, startBrainstorm } = await import("./brainstorm.ts");
  const { setUpIdeaReview, startIdeaReview } = await import("./ideaReview.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const ran = startBrainstorm(db, room.id, "Experiences we should support", "Joe");
  db.saveBrainstormMap(ran.id, [
    { id: "d1", parent: null, label: "Reviews", detail: null, by: "Joe", ts: 1, quote: null, points: [], caught: [] },
    { id: "i1", parent: "d1", label: "Retro meeting", detail: null, by: "Joe", ts: 1, quote: null, points: [], caught: [] },
  ]);
  finishBrainstorm(db, room.id, null);
  const asked: string[] = [];
  const agent = Object.assign(new HeuristicAgent(), {
    async brainstormMap(_context: string, talk: string) {
      asked.push(talk);
      return { add: [], extend: [], caught: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  await join(session, { id: "u1", name: "Joe" });
  await join(session, { id: "u2", name: "Janesh" });
  assert.ok(session.hosts("u1"));
  startBrainstorm(db, room.id, "How should a review start?", "Janesh");
  session.brainstormChanged();
  assert.ok(session.hosts("u1"), "a map leaves the seat where it is");

  const started = startIdeaReview(db, room.id, setUpIdeaReview(db, room.id, ran.id, "Janesh").review.id);
  session.itemsChanged();
  session.present("u2", "idea review");
  assert.ok(session.hosts("u1"), "the host seat stays where it was");
  assert.deepEqual(session.state().presenter, { id: "u2", name: "Janesh", what: "idea review" });
  session.present("u9", "product review");
  assert.equal(session.state().presenter?.id, "u2", "someone who isn't in the call takes nothing");
  session.setFocus(started.firstItemId, "Janesh", "manual");
  session.addSpeech("u2", "Janesh", "this slide is about the retro", Date.now() - 1000);
  const mapPasses = (session as unknown as { mapPasses: { run(): Promise<void> } }).mapPasses;
  await mapPasses.run();
  assert.equal(asked.length, 0, "talk on a review slide isn't the map's");

  assert.deepEqual(await session.finishExperience(), ["review"]);
  assert.ok(session.hosts("u1"));
  assert.equal(session.state().presenter, null, "finished: nobody presents, and everyone follows the host again");
  assert.equal(db.brainstormLive(room.id)?.prompt, "How should a review start?", "the map goes on");
  session.addSpeech("u1", "Joe", "a review could start from what shipped", Date.now());
  await mapPasses.run();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /start from what shipped/);
  assert.doesNotMatch(asked[0], /about the retro/);
  await session.end();
});

test("starting a diagram stops the map first and keeps it; starting a map saves the diagram's draft spec", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const { parseSeed } = await import("./designSession.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  let passes = 0;
  const agent = Object.assign(new HeuristicAgent(), {
    async brainstormMap() {
      passes++;
      return { add: [{ cluster: null, under: "root", label: "From the work", detail: "Start from what shipped.", by: "Huy", line: 1 }], extend: [], caught: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  await join(session, { id: "u1", name: "Joe" });
  const map = startBrainstorm(db, room.id, "How should a review start?", "Joe");
  session.brainstormChanged();
  session.addSpeech("u1", "Joe", "start from what shipped", Date.now());
  // As the start route does when another one is drawing in the call.
  assert.equal(await session.stopView(), true);
  const diagram = startBrainstorm(db, room.id, "Stand's primitives", "Joe", Date.now(), { diagram: parseSeed("Task: a to-do\nProject: a group of tasks", Date.now()), seed: null, taskId: null });
  session.brainstormChanged();
  assert.equal(passes, 1);
  const kept = db.getBrainstorm(map.id)!;
  assert.deepEqual([kept.status, kept.nodes.map((n) => n.label)], ["done", ["From the work"]]);

  assert.equal(await session.stopView(), true);
  startBrainstorm(db, room.id, "Pricing", "Joe");
  session.brainstormChanged();
  const saved = db.getBrainstorm(diagram.id)!;
  assert.equal(saved.status, "done");
  assert.match(db.notePlan(saved.taskId!)!.text, /^# Stand's primitives\n/);
  assert.equal(db.brainstormLive(room.id)?.prompt, "Pricing");
  await session.end();
});

test("a line on the board is tied to its note by id: a tick crosses either way, even after the note is reworded", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const [item] = db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "One", url: null, description: null }]);
  const agent = Object.assign(new HeuristicAgent(), {
    async liveList() {
      return { add: [{ kind: "todo" as const, who: "Huy", text: "Send Joe the repo link", line: 1 }], change: [], close: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const huy = await join(session, { id: "u2", name: "Huy" });
  session.addSpeech("u2", "Huy", "I'll send Joe the repo link", Date.now());
  await (session as unknown as { listPasses: { run(): Promise<void> } }).listPasses.run();
  const lastList = () => (huy.got.filter((m) => m.type === "list").at(-1) as Extract<ServerMessage, { type: "list" }>).items!;
  const [line] = lastList();
  // A notes run writes the same to-do; after it, the line is tied to that note.
  const note = db.addNote(session.meetingId, item.id, { kind: "action", text: "Send Joe the link to the repo", owner: "Huy" }, null);
  (session as unknown as { linkList(): void }).linkList();
  assert.equal((db.meetingList(session.meetingId) ?? [])[0].noteId, note.id);
  // Reworded past any match by words: the tie holds.
  db.editNote(note.id, { text: "Share repository access with Joe", owner: "Huy" }, "Joe");
  await say(huy, { type: "followup.done", noteId: line.id, done: true });
  assert.equal(db.getNote(note.id)?.doneBy, "Huy", "the board's tick reached the note");
  await say(huy, { type: "followup.done", noteId: note.id, done: false });
  assert.equal(lastList()[0].doneAt, null, "and the note's untick reached the board");
  await say(huy, { type: "task.state", noteId: note.id, state: "done" });
  assert.equal(lastList()[0].doneBy, "Huy", "a Done from the check-in too");
  await session.end();
});

/** A call whose board moves when the test says so, and whose map model names an idea per pass. */
async function onTopics() {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const answers: Array<Partial<BoardAnswer>> = [];
  const boardAsked: string[] = [];
  const mapAsked: string[] = [];
  const agent = Object.assign(new HeuristicAgent(), {
    async boardCard(context: string): Promise<BoardAnswer> {
      boardAsked.push(context);
      return { current: { sentences: [], dropSentences: [], positions: [], add: [], change: [], remove: [], now: "" }, retitle: null, shift: null, ...answers.shift() };
    },
    async boardDrift() {
      return { verdict: "same" as const, title: null };
    },
    async brainstormMap(context: string, talk: string) {
      mapAsked.push(`${context}\n${talk}`);
      return { add: [{ cluster: null, under: "root", label: `Idea ${mapAsked.length}`, detail: "An idea.", by: "Joe", line: 1 }], extend: [], caught: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const joe = await join(session, { id: "u1", name: "Joe" });
  const inner = session as unknown as { board: { board(): { pending: unknown } }; boardPasses: { run(): Promise<void> }; mapPasses: { run(): Promise<void> }; viewTurn: Promise<void> };
  // The call began twenty minutes ago, so its talk can be spread out.
  const t0 = Date.now() - 20 * 60_000;
  (session as unknown as { meetingStartedAt: number }).meetingStartedAt = t0 - 1000;
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 10));
    await inner.viewTurn;
  };
  // Two people, so each line stays its own.
  const talk = (at: number, ...lines: string[]) => lines.forEach((text, i) => session.addSpeech(i % 2 ? "u2" : "u1", i % 2 ? "Huy" : "Joe", text, t0 + at + i * 1000));
  /** The board's next pass, then a click on the move it proposes when it waits for one. */
  const move = async (shift: NonNullable<BoardAnswer["shift"]>) => {
    answers.push({ shift });
    await inner.boardPasses.run();
    if (inner.board.board().pending) await say(joe, { type: "board.accept", title: shift.title });
    await settle();
  };
  const fresh = (title: string): NonNullable<BoardAnswer["shift"]> => ({ kind: "new", returnTo: null, title, card: { summary: [title], positions: [], items: [], now: "" } });
  const back = (id: string, title: string): NonNullable<BoardAnswer["shift"]> => ({ kind: "return", returnTo: id, title, card: null });
  const say_ = async (msg: ClientMessage) => {
    await say(joe, msg);
    await settle();
  };
  return { db, room, session, joe, inner, talk, move, fresh, back, say: say_, boardAsked, mapAsked };
}

test("the map of a topic is drawn from every line of that topic, those said before it was opened too", async () => {
  const { db, room, session, inner, talk, move, fresh, say, mapAsked } = await onTopics();
  talk(0, "we could charge per seat", "or a free tier for small teams");
  await move(fresh("Pricing"));
  talk(60_000, "onboarding could start with a welcome video", "or a sample space");
  await move(fresh("Onboarding"));
  await say({ type: "view.open" });
  const map = db.brainstormLive(room.id)!;
  assert.deepEqual([map.prompt, map.threadId, map.meetingId, map.startedBy], ["Onboarding", "t2", session.meetingId, "Joe"]);
  await inner.mapPasses.run();
  assert.equal(mapAsked.length, 1);
  assert.match(mapAsked[0], /The centre of the map: Onboarding/);
  assert.match(mapAsked[0], /welcome video/);
  assert.doesNotMatch(mapAsked[0], /charge per seat/);
  await session.end();
});

test("a topic's map keeps drawing when the board moves: the same map goes on, and a stopped map stays stopped", async () => {
  const { db, room, session, joe, inner, talk, move, fresh, back, say, boardAsked, mapAsked } = await onTopics();
  talk(0, "we could charge per seat", "or a free tier for small teams");
  await move(fresh("Pricing"));
  talk(60_000, "onboarding could start with a welcome video", "or a sample space");
  await move(fresh("Onboarding"));
  assert.ok(boardAsked.every((c) => !c.includes("is brainstorming")));
  await say({ type: "view.open" });
  const id = db.brainstormLive(room.id)!.id;
  await inner.mapPasses.run();
  assert.deepEqual(db.getBrainstorm(id)!.nodes.map((n) => n.label), ["Idea 1"]);
  assert.doesNotMatch(mapAsked.at(-1)!, /board's current topic/);

  // The board is told while the topic's map draws on it.
  talk(120_000, "the video should be short", "and skippable");
  await move(back("t1", "Pricing"));
  assert.match(boardAsked.at(-1)!, /The group is brainstorming "Onboarding". Ideas for it belong to this thread\./);
  // The board moved on, and the map didn't: it is still the one drawing, and nothing else started.
  assert.equal(db.brainstormLive(room.id)?.id, id, "the map goes on across topics");
  const sent = joe.got.flatMap((m) => (m.type === "brainstorm" ? [m] : [])).at(-1)!;
  assert.equal(sent.brainstorm?.id, id);
  assert.equal(db.brainstormsOfMeeting(session.meetingId).length, 1, "no second map");

  // What is said on the new topic reaches the same map, which is told the talk moved.
  await new Promise((r) => setTimeout(r, 5));
  session.addSpeech("u1", "Joe", "pricing again: per seat is simpler", Date.now());
  session.addSpeech("u2", "Huy", "yes per seat", Date.now());
  await inner.mapPasses.run();
  assert.match(mapAsked.at(-1)!, /The board's current topic: Pricing/);
  assert.match(mapAsked.at(-1)!, /per seat is simpler/);

  await say({ type: "view.stop" });
  assert.notEqual(db.getBrainstorm(id)!.endedAt, null);
  talk(200_000, "onboarding once more", "the sample space");
  await move(back("t2", "Onboarding"));
  assert.equal(db.brainstormLive(room.id), null, "a stopped map doesn't go on by itself");
  await say({ type: "view.open" });
  assert.equal(db.brainstormLive(room.id)?.id, id, "opening it again goes on with the same map");

  await session.end();
  assert.notEqual(db.getBrainstorm(id)!.endedAt, null);
});

test("a map started with a typed topic hears the board's topic too, so talk that moves on can start a cluster", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const { db, room, session, inner, talk, move, fresh, mapAsked } = await onTopics();
  startBrainstorm(db, room.id, "Jensen's downfall", "Joe");
  session.brainstormChanged();
  talk(0, "we could charge per seat", "or a free tier for small teams");
  await move(fresh("Credit cards"));
  await new Promise((r) => setTimeout(r, 5));
  session.addSpeech("u1", "Joe", "I have three credit cards", Date.now());
  await inner.mapPasses.run();
  assert.match(mapAsked.at(-1)!, /The centre of the map: Jensen's downfall\nThe board's current topic: Credit cards/);
  await session.end();
});

test("a diagram whose model gives no answer says so in the call, and one that heard nothing to draw says that", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  let fail = true;
  const agent = Object.assign(new HeuristicAgent(), {
    async designDiagram() {
      if (fail) throw new Error("400 bad schema");
      return { boxes: [], arrows: [], extend: [], caught: [], place: [], groups: [], topic: null };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const joe = await join(session, { id: "u1", name: "Joe" });
  startBrainstorm(db, room.id, "Untitled design", "Joe", Date.now(), { diagram: { boxes: [], arrows: [] }, seed: null, taskId: null });
  session.brainstormChanged();
  session.addSpeech("u1", "Joe", "The chat is the intake for all the text", Date.now());
  const inner = session as unknown as { mapPasses: { run(): Promise<void> } };
  await inner.mapPasses.run().catch(() => {});
  const last = () => joe.got.flatMap((m) => (m.type === "brainstorm" ? [m] : [])).at(-1)!.brainstorm!;
  assert.equal(last().heard, "failed");
  fail = false;
  session.addSpeech("u1", "Joe", "and Discord feeds it", Date.now() + 1);
  await inner.mapPasses.run();
  assert.equal(last().heard, "nothing");
  await session.end();
});

test("opening a topic's map while a diagram draws saves the diagram's draft spec first", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const { parseSeed } = await import("./designSession.ts");
  const { db, room, session, talk, move, fresh, say } = await onTopics();
  const diagram = startBrainstorm(db, room.id, "Stand's primitives", "Joe", Date.now(), { diagram: parseSeed("Task: a to-do\nProject: a group of tasks", Date.now()), seed: null, taskId: null });
  session.brainstormChanged();
  talk(0, "we could charge per seat", "or a free tier for small teams");
  await move(fresh("Pricing"));
  await say({ type: "view.open" });
  const saved = db.getBrainstorm(diagram.id)!;
  assert.equal(saved.status, "done");
  assert.match(db.notePlan(saved.taskId!)!.text, /^# Stand's primitives\n/);
  assert.equal(db.brainstormLive(room.id)?.prompt, "Pricing");
  await session.end();
});

test("a next step said out loud goes on one card: nothing starts by itself, anyone answers it, and a review that was asked for reaches the recap", async () => {
  const { suggestedNext } = await import("./nextSteps.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  await join(session, { id: "u1", name: "Joe" });
  const huy = await join(session, { id: "u2", name: "Huy" });
  session.addSpeech("u1", "Joe", "We did a brainstorm yesterday and it went fine", Date.now());
  assert.equal(session.state().next, null, "talk about one that happened offers nothing");
  session.addSpeech("u1", "Joe", "Hold up, let's start a brainstorm on the Discord integration", Date.now());
  const card = session.state().next!;
  assert.deepEqual([card.kind, card.topic, card.by, card.state], ["map", "The Discord integration", "Joe", "offered"]);
  assert.equal(db.brainstormLive(room.id), null, "nothing is drawn by itself");
  // Someone who isn't the host answers it; the card is settled for everyone.
  await say(huy, { type: "next.take", id: card.id, started: true });
  assert.equal(session.state().next, null);
  // A review nobody can start now: taking it keeps it for the recap.
  session.addSpeech("u2", "Huy", "I think we need a design review on the projects migration", Date.now());
  const review = session.state().next!;
  assert.deepEqual([review.kind, review.topic, review.ready], ["design-review", "The projects migration", 0]);
  await say(huy, { type: "next.take", id: review.id });
  // Waved off: gone, and that kind stays quiet for a while.
  session.addSpeech("u1", "Joe", "let's do a product review on the phone views", Date.now());
  await say(huy, { type: "next.wave", id: session.state().next!.id });
  session.addSpeech("u1", "Joe", "seriously, we should do a product review", Date.now());
  assert.equal(session.state().next, null);
  await session.end();
  assert.deepEqual(suggestedNext(db.meetingNext(session.meetingId)).map((n) => [n.kind, n.topic, n.state]), [["design-review", "The projects migration", "noted"]]);
});

test("Stand's card stays up for a full minute of other talk, then counts as missed", async (t) => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  await join(session, { id: "u1", name: "Joe" });
  await join(session, { id: "u2", name: "Huy" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.addSpeech("u1", "Joe", "Let's start a brainstorm on the Discord integration", Date.now());
  const card = session.state().next!;
  assert.equal(card.kind, "map");
  // People keep talking, about that and about other things: none of it takes the card down.
  session.addSpeech("u2", "Huy", "Sure. What if we also pull in the old threads, or maybe we skip them", Date.now());
  session.addSpeech("u1", "Joe", "Let's start a brainstorm on the Discord integration, yeah", Date.now());
  t.mock.timers.tick(59_000);
  assert.equal(session.state().next?.id, card.id, "still up just before the minute");
  t.mock.timers.tick(1_000);
  assert.equal(session.state().next, null);
  assert.equal(db.meetingNext(session.meetingId).find((n) => n.id === card.id)?.state, "missed");
  t.mock.timers.reset();
  await session.end();
});

test("Stand offers a map by itself when two people trade ideas, says it guessed, and doesn't repeat itself", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  await join(session, { id: "u1", name: "Joe" });
  const huy = await join(session, { id: "u2", name: "Huy" });
  session.addSpeech("u1", "Joe", "What if the first three seats are free?", Date.now());
  session.addSpeech("u2", "Huy", "Or we could price per meeting hour.", Date.now());
  assert.equal(session.state().next, null, "two ideas are not a brainstorm yet");
  session.addSpeech("u1", "Joe", "Another idea, maybe we charge for the agent only.", Date.now());
  const card = session.state().next!;
  assert.deepEqual([card.kind, card.topic, card.guessed, card.state], ["map", "", true, "offered"]);
  assert.equal(db.brainstormLive(room.id), null, "nothing is drawn by itself");
  await say(huy, { type: "next.wave", id: card.id });
  session.addSpeech("u2", "Huy", "What if it is free for open source, or maybe we do a trial?", Date.now());
  assert.equal(session.state().next, null, "it guessed once and stays quiet");
  await session.end();
});

test("the notes run says the talk sounds like a brainstorm and Stand offers a map, on a review's slide too, but not while a map or a diagram is drawing", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  let sounds: "map" | "diagram" | null = "map";
  let asked: number | undefined;
  const base = new HeuristicAgent();
  const agent = Object.assign(new HeuristicAgent(), {
    async notesFor(item: Item | null, segments: Segment[], _e?: unknown, _c?: unknown, _x?: unknown, options?: { recentFrom?: number }) {
      asked = options?.recentFrom;
      return { ...(await base.notesFor(item, segments)), soundsLike: sounds };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  const notes = (itemId: string | null) => (session as unknown as { runNotes(id: string | null): Promise<unknown> }).runNotes(itemId);
  addSlide(db, room.id, { title: "Your own agent", summary: "", addedBy: "x" });
  const joe = await join(session, { id: "u1", name: "Joe" });
  await join(session, { id: "u2", name: "Andy" });
  // The 13 Nov call: an open question worked through in words no phrase list would catch.
  session.addSpeech("u2", "Andy", "But then why do we even need Ask Stand at that point? Ideally we shouldn't have both.", Date.now());
  session.addSpeech("u1", "Joe", "I think it's fine to have both. We need to figure out what this does that Ask Stand can't.", Date.now());
  assert.equal(session.state().next, null, "the phrase count hears nothing in it");
  await notes(null);
  assert.equal(asked, 1, "the run is told where the last few minutes start");
  const card = session.state().next!;
  assert.deepEqual([card.kind, card.topic, card.guessed, card.state], ["map", "", true, "offered"]);
  // The next runs say it again: the card that is up stays, and after it Stand stays quiet for a while.
  await notes(null);
  assert.equal(session.state().next?.id, card.id);
  await say(joe, { type: "next.take", id: card.id });
  await notes(null);
  assert.equal(session.state().next, null, "said once in a while, not on every run");
  // On a review's slide a design talk gets a diagram offered, of the slide.
  sounds = "diagram";
  const started = startReview(db, room.id);
  session.itemsChanged();
  await say(joe, { type: "focus", itemId: started.firstItemId });
  session.addSpeech("u1", "Joe", "So your agent joins over MCP, reads the transcript and posts a card to the board.", Date.now());
  await notes(started.firstItemId);
  const onSlide = session.state().next!;
  assert.deepEqual([onSlide.kind, onSlide.topic, onSlide.guessed], ["diagram", "Your own agent", true]);
  await say(joe, { type: "next.wave", id: onSlide.id });
  // A map is drawing: Stand guesses nothing more, of either kind.
  (session as unknown as { nextGuessed: Map<string, number> }).nextGuessed.clear();
  (session as unknown as { nextWaved: Map<string, number> }).nextWaved.clear();
  startBrainstorm(db, room.id, "Your own agent", "Joe");
  session.brainstormChanged();
  session.addSpeech("u1", "Joe", "And the card goes to everyone in the call.", Date.now());
  await notes(started.firstItemId);
  assert.equal(session.state().next, null, "nothing is guessed while a map is on");
  await session.end();
});

test("a card is up at least 15 seconds before an ask for something else takes its place", async (t) => {
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  const session = new RoomSession(db, new HeuristicAgent(), room, () => {});
  await join(session, { id: "u1", name: "Joe" });
  await join(session, { id: "u2", name: "Huy" });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  session.addSpeech("u1", "Joe", "Let's start a brainstorm on the Discord integration", Date.now());
  const card = session.state().next!;
  assert.equal(card.kind, "map");
  t.mock.timers.tick(3_000);
  session.addSpeech("u2", "Huy", "and after that we need a design review on the projects migration", Date.now());
  assert.equal(session.state().next?.id, card.id, "the first card keeps its place");
  t.mock.timers.tick(11_000);
  assert.equal(session.state().next?.id, card.id, "still up at 14 seconds");
  t.mock.timers.tick(1_000);
  const review = session.state().next!;
  assert.deepEqual([review.kind, review.topic], ["design-review", "The projects migration"]);
  assert.equal(db.meetingNext(session.meetingId).find((n) => n.id === card.id)?.state, "missed");
  t.mock.timers.reset();
  await session.end();
});

test("during a review Stand guesses and answers an ask like anywhere else; a map offered on a slide is of that slide and reads its talk", async () => {
  const { startBrainstorm } = await import("./brainstorm.ts");
  const db = openDb(":memory:");
  const room = db.createRoom("Test");
  let read = "";
  const agent = Object.assign(new HeuristicAgent(), {
    async brainstormMap(_context: string, talk: string) {
      read = talk;
      return { add: [], extend: [], caught: [] };
    },
  });
  const session = new RoomSession(db, agent, room, () => {});
  addSlide(db, room.id, { title: "Mic picker", summary: "", addedBy: "x" });
  const joe = await join(session, { id: "u1", name: "Joe" });
  const huy = await join(session, { id: "u2", name: "Huy" });
  const started = startReview(db, room.id);
  session.itemsChanged();
  await say(joe, { type: "focus", itemId: started.firstItemId });
  // Ideas traded on a slide: Stand guesses there as anywhere else, and the card is of the slide.
  session.addSpeech("u1", "Joe", "What if the picker remembers the last mic?", Date.now());
  session.addSpeech("u2", "Huy", "Or we could show a level meter.", Date.now());
  session.addSpeech("u1", "Joe", "Another idea, maybe we test the mic first.", Date.now());
  const guess = session.state().next!;
  assert.deepEqual([guess.kind, guess.topic, guess.guessed], ["map", "Mic picker", true]);
  // Someone asks, naming nothing: the guess gives way to the ask, still of the slide.
  session.addSpeech("u2", "Huy", "Hold on, let's brainstorm", Date.now());
  const card = session.state().next!;
  assert.deepEqual([card.kind, card.topic, card.guessed], ["map", "Mic picker", undefined]);
  // Taking it starts the map the usual way (the room's route does this); it reads what is said on the slide.
  startBrainstorm(db, room.id, card.topic, "Huy");
  session.brainstormChanged();
  await say(huy, { type: "next.take", id: card.id, started: true });
  session.addSpeech("u1", "Joe", "We could pick the mic from the menu bar", Date.now());
  await (session as unknown as { mapPasses: { run(): Promise<void> } }).mapPasses.run();
  assert.match(read, /menu bar/, "the map reads the review's talk");
  // Another review asked for while this one runs can't start now: it is only kept for the recap.
  session.addSpeech("u1", "Joe", "we need a design review on the audio pipeline", Date.now());
  assert.equal(session.state().next!.ready, 0);
  await session.end();
});

test("on a server with no Stand model, a card from an agent after a restart keeps the ones from before it", async () => {
  const { db, session, meetingId } = setup();
  const room = db.getRoom(session.roomId)!;
  const huy = { kind: "agent" as const, person: "Huy", personId: "u2", agent: "opencode", connection: "tok1", model: "claude-fable-5-2" };
  const first = session.agentSay(huy, { text: "Before the restart" });
  assert.notEqual(typeof first, "string");
  const [open] = db.openMeetings(room.id);
  const again = new RoomSession(db, new HeuristicAgent(), room, () => {}, undefined, undefined, open);
  const second = again.agentSay({ ...huy, connection: "tok2" }, { text: "After it" });
  assert.notEqual(typeof second, "string");
  assert.deepEqual(db.meetingAgentCards(meetingId)?.map((c) => c.note), ["Before the restart", "After it"]);
  await again.end();
  await session.end();
});

test("someone's own agent reads a running call from where it left off and puts a card in it for everyone", async () => {
  const db = openDb(":memory:");
  const joe = db.upsertUser({ googleSub: "g-joe", email: "joe@example.com", name: "Joe Liang", picture: null });
  const andy = db.upsertUser({ googleSub: "g-andy", email: "andy@example.com", name: "Andy Li", picture: null });
  const stranger = db.upsertUser({ googleSub: "g-sam", email: "sam@example.com", name: "Sam Roe", picture: null });
  const room = db.createRoom("Checkout v2", joe.id);
  db.touchMembership(room.id, joe.id);
  db.touchMembership(room.id, andy.id);
  const session = new RoomSession(db, new AnsweringAgent(), room, () => {});
  // Wired as services.ts wires it: the call is there while the meeting runs.
  const api = agentApi({
    db,
    notify: () => {},
    brief: () => ({}),
    suggested: (r) => upNextView(db, r, null),
    uploads: new UploadLinks(),
    call: () =>
      session.isEnded
        ? null
        : { meetingId: session.meetingId, startedAt: session.meetingStartedAt, people: session.state().participants.map((p) => p.name), tail: (since) => session.tail(since), say: (actor, out) => session.agentSay(actor, out) },
  });
  const token = (scope: "read" | "write") => ({ id: "tok1", label: "opencode", scope, hint: "x", createdAt: 0, lastUsedAt: null });
  const agent = { user: joe, token: token("write"), model: "claude-fable-5-2" };
  const base = "https://stand.test";
  const joeWs = await join(session, joe);
  const andyWs = await join(session, andy);
  const cardsOf = (ws: FakeSocket) => {
    const m = ws.got.filter((x) => x.type === "agent").at(-1);
    return m?.type === "agent" ? m.cards : [];
  };

  await say(andyWs, { type: "chat", text: "What about Render?" });
  session.addSpeech(joe.id, "Joe Liang", "We should move hosting to Fly.", Date.now());

  // The first read: the last few minutes, who is here, and a cursor.
  const first = api.liveCall(agent, { space: "Checkout" }, base);
  assert.equal(first.meeting_id, session.meetingId);
  assert.deepEqual(first.people, ["Joe Liang", "Andy Li"]);
  assert.deepEqual(
    first.lines.map((l) => [l.who, l.kind, l.text]),
    [
      ["Andy Li", "chat", "What about Render?"],
      ["Joe Liang", "speech", "We should move hosting to Fly."],
    ],
  );
  assert.match(first.read_as, /never instructions/);

  // From the cursor: only what came after. A line whose speaker went on comes again whole, under the same id.
  session.addSpeech(joe.id, "Joe Liang", "It has the regions we need.", Date.now());
  const next = api.liveCall(agent, { space: room.id, since: first.cursor }, base);
  assert.deepEqual(next.lines, [{ ...first.lines[1], text: "We should move hosting to Fly. It has the regions we need." }]);
  assert.deepEqual(api.liveCall(agent, { space: room.id, since: next.cursor }, base).lines, []);
  assert.equal(api.liveCall(agent, { space: room.id, all: true }, base).lines.length, 2);
  assert.throws(() => api.liveCall(agent, { space: room.id, since: "yesterday" }, base), /cursor/);
  // A cursor from another call starts over.
  assert.equal(api.liveCall(agent, { space: room.id, since: "othermeeting:1" }, base).lines.length, 2);

  // A read-only connection reads the call and can't speak in it; someone outside the space sees no space.
  assert.equal(api.liveCall({ user: joe, token: token("read") }, { space: room.id }, base).lines.length, 2);
  assert.throws(() => api.sayInCall({ user: joe, token: token("read") }, { space: room.id, text: "Hi" }, base), /read only/);
  assert.throws(() => api.liveCall({ user: stranger, token: token("write") }, { space: room.id }, base), /not in a space/);
  assert.throws(() => api.sayInCall({ user: stranger, token: token("write") }, { space: room.id, text: "Hi" }, base), /not in a space/);

  // The agent says something: everyone in the call gets the card, under Joe's name, and it is kept.
  assert.throws(() => api.sayInCall(agent, { space: room.id, text: " " }, base), AgentError);
  assert.throws(() => api.sayInCall(agent, { space: room.id, text: "x".repeat(1201) }, base), /1200 characters/);
  const out = api.sayInCall(
    agent,
    { space: room.id, text: "The plan misses **retries**.", detail: "## Why\nNo queue.", todo: "Add a retry queue", sources: [{ url: "https://fly.io/docs/reference" }, { url: "javascript:alert(1)", title: "no" }] },
    base,
  );
  await new Promise((r) => setImmediate(r));
  const card = cardsOf(andyWs).at(-1)!;
  assert.equal(card.id, out.said.card);
  assert.equal(out.said.by, "Joe Liang via opencode");
  assert.equal(card.status, "ready");
  assert.equal(card.by, "Joe Liang");
  assert.equal(card.note, "The plan misses **retries**.");
  assert.equal(card.detail, "## Why\nNo queue.");
  assert.deepEqual(card.agent, { kind: "agent", person: "Joe Liang", personId: joe.id, agent: "opencode", connection: "tok1", model: "claude-fable-5-2" });
  assert.equal(card.costUsd, null);
  assert.deepEqual(card.sources, [{ url: "https://fly.io/docs/reference", title: "fly.io" }]);
  assert.deepEqual(db.meetingAgentCards(session.meetingId)?.map((c) => c.id), [card.id]);
  assert.throws(() => api.sayInCall(agent, { space: room.id, text: "And another thing" }, base), /every 5 seconds/);

  // It is in the call's record, and another agent reading the call sees it.
  const line = meetingTimeline(db, session.meetingId).find((e) => e.kind === "agent");
  assert.equal(line?.card, card.id);
  assert.equal(line?.actor?.agent, "opencode");
  assert.deepEqual(
    api.liveCall({ user: andy, token: { ...token("read"), id: "tok2" } }, { space: room.id }, base).answers.map((a) => [a.id, a.by, a.text]),
    [[card.id, "Joe Liang's agent (opencode)", "The plan misses **retries**."]],
  );

  // Nothing came of it until a person acted: Andy takes its next step as a to-do, then dismisses the card.
  assert.equal(db.meetingNotes(session.meetingId).length, 0);
  await say(andyWs, { type: "agent.todo", cardId: card.id });
  assert.equal(cardsOf(joeWs).at(-1)?.picked?.by, "Andy Li");
  assert.deepEqual(db.meetingNotes(session.meetingId).map((n) => [n.kind, n.text]), [["action", "Add a retry queue"]]);
  await say(andyWs, { type: "agent.dismiss", cardId: card.id });
  assert.equal(cardsOf(joeWs).at(-1)?.dismissed?.by, "Andy Li");

  // Stand still answers, and doesn't treat the agent's card as its own earlier answer.
  await say(joeWs, { type: "chat", text: "@stand what does Fly cost?" });
  await new Promise((r) => setTimeout(r, 20));
  const answer = cardsOf(joeWs).at(-1)!;
  assert.equal(answer.agent, undefined);
  assert.equal(answer.follows, null);

  await session.end();
  assert.throws(() => api.liveCall(agent, { space: room.id }, base), /No call is running/);
  assert.throws(() => api.sayInCall(agent, { space: room.id, text: "Too late" }, base), /No call is running/);
});
