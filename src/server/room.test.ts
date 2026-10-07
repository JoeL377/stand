import fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { briefToMarkdown, buildBrief, buildFollowUps } from "./brief.ts";
import { looksLikePdf, parseDeck } from "./decks.ts";
import { HeuristicAgent } from "./llm.ts";
import { parseLinearInput } from "./linear.ts";
import { RoomSession } from "./room.ts";
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
  assert.equal(db.sessionUser(s.id)?.email, "joe@example.com");
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
    ({ id, meetingId: "m1", itemId, kind, text, owner, ts: 0, doneAt: null, doneBy: null });
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
