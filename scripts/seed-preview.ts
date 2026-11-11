// Made-up data for looking at the web app on your own machine: `npm run preview:ui` runs this,
// then starts Stand on it. Everything here is invented (Acme), so nothing from a real meeting is
// needed. It puts to-dos, decisions and context in each state the pages can show.
//
// It wipes DATA_DIR first, so every run starts the same, and refuses any folder not named preview.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChapterRecap, DiscussionOutcome, Item, Note, NoteKind, Position, Quote, User } from "../src/shared/protocol.ts";
import { agentApi } from "../src/server/agents.ts";
import { openDb } from "../src/server/db.ts";
import { addSlide, finishReview, setOutcome, startReview } from "../src/server/reviews.ts";
import { finishBrainstorm, startBrainstorm } from "../src/server/brainstorm.ts";
import type { BrainNode } from "../src/shared/protocol.ts";
import { upNextView } from "../src/server/upNextPolish.ts";
import { UploadLinks } from "../src/server/workLog.ts";

const dir = path.resolve(process.env.DATA_DIR ?? "");
if (!process.env.DATA_DIR || !path.basename(dir).includes("preview") || process.env.NODE_ENV === "production") {
  console.error("seed-preview wipes its folder, so it only runs on a DATA_DIR named preview, outside production.");
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
const file = path.join(dir, "standup.db");
const db = openDb(file);

const DAY = 86_400_000;
const MIN = 60_000;
const now = Date.now();

const person = (name: string, email: string, picture: string | null = null) => db.upsertUser({ googleSub: null, email, name, picture });
/** A stand-in for a Google photo, large like the real ones, since people in production have them. */
const photo = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/><circle cx="48" cy="38" r="18" fill="#fff"/><ellipse cx="48" cy="92" rx="32" ry="30" fill="#fff"/></svg>`)}`;
const sam = person("Sam Rivera", "sam@acme.test", photo("#3f6f8f"));
const priya = person("Priya Shah", "priya@acme.test", photo("#8f5f3f"));
const leo = person("Leo Park", "leo@acme.test");
const maya = person("Maya Chen", "maya@acme.test");
const team = [sam, priya, leo, maya];

const room = db.createRoom("Acme Checkout", sam.id, "Ship one-page checkout by Dec 1");
const growth = db.createRoom("Acme Growth", sam.id, "Weekly numbers and experiments");
const support = db.createRoom("Acme Support", priya.id, "What shoppers keep asking us");
const hiring = db.createRoom("Acme Hiring", maya.id, "Two engineers by January");
for (const u of team) for (const space of [room, growth, support, hiring]) db.touchMembership(space.id, u.id);
const [retries, guest, mobile] = db.addItems(room.id, [
  { source: "agenda", externalId: "PAY-212", title: "Payment retries", url: null, description: "Failed cards should retry without the shopper noticing." },
  { source: "agenda", externalId: "PAY-219", title: "Guest checkout", url: null, description: "Buy without making an account." },
  { source: "agenda", externalId: null, title: "Mobile layout", url: null, description: null },
]);

interface Line {
  who: User;
  said: string;
}
interface Kept {
  kind: NoteKind;
  text: string;
  owner?: string;
  /** Which line it was settled in. */
  line?: number;
}
interface Topic {
  item: Item;
  title: string;
  outcome: DiscussionOutcome;
  crux: string;
  positions: Position[];
  lines: Line[];
  kept: Kept[];
}

/** A finished meeting, written the way the app leaves one. Returns its notes, findable by their text. */
function meeting(daysAgo: number, minutes: number, summary: string, topics: Topic[]) {
  const started = now - daysAgo * DAY;
  const m = db.startMeeting(room.id);
  const notes: Note[] = [];
  const chapters: ChapterRecap[] = [];
  let ts = started + 2 * MIN;
  for (const item of new Set(topics.map((t) => t.item))) {
    const here = topics.filter((t) => t.item === item);
    const said = here.map((t) =>
      t.lines.map((l) => {
        ts += 40_000;
        return db.addSegment({ meetingId: m.id, itemId: item.id, speakerId: l.who.id, speakerName: l.who.name, kind: "speech", text: l.said, ts });
      }),
    );
    const discussions = db.replaceDiscussions(
      m.id,
      item.id,
      here.map((t, i) => ({ topic: t.title, positions: t.positions, outcome: t.outcome, segmentIds: said[i].map((s) => s.id), continuesId: null })),
    );
    here.forEach((t, i) => {
      const first = said[i][0];
      chapters.push({ key: discussions[i].id, crux: t.crux, moments: [{ segmentId: first.id, ts: first.ts, text: t.crux }] });
    });
    notes.push(
      ...db.syncNotes(
        m.id,
        item.id,
        here.flatMap((t, i) =>
          t.kept.map((k) => {
            const s = k.line === undefined ? undefined : said[i][k.line];
            const quote: Quote | null = s ? { segmentId: s.id, ts: s.ts, speaker: s.speakerName, text: s.text } : null;
            return { kind: k.kind, text: k.text, owner: k.owner ?? null, discussionId: discussions[i].id, ts: started + 10 * MIN, quote };
          }),
        ),
      ),
    );
  }
  db.endMeeting(m.id, summary, null, started + minutes * MIN, chapters);
  return { id: m.id, started, ended: started + minutes * MIN, note: (start: string) => notes.find((n) => n.text.startsWith(start))! };
}

const earlier = meeting(8, 34, "The team moved payment retries to the server and kept guest checkout behind a flag until December. Mobile layout work starts after the retry worker lands.", [
  {
    item: retries,
    title: "Where payment retries run",
    outcome: "decided",
    crux: "Retries move to the server, so a shopper closing the tab can't lose an order.",
    positions: [
      { speaker: "Priya Shah", position: "Run retries on the server so a closed tab can't drop an order" },
      { speaker: "Leo Park", position: "Worried about charging twice without an idempotency key" },
    ],
    lines: [
      { who: priya, said: "If the shopper closes the tab mid-retry we lose the order. It has to run on the server." },
      { who: leo, said: "Fine, as long as every charge has an idempotency key. I don't want to charge anyone twice." },
      { who: sam, said: "Agreed. Server side, with the key. Priya, can you take the worker?" },
    ],
    kept: [
      { kind: "decision", text: "Run payment retries on the server", line: 2 },
      { kind: "action", text: "Build the payment retry worker", owner: "Priya Shah" },
      { kind: "action", text: "Add an idempotency key to every charge", owner: "Leo Park" },
      { kind: "action", text: "Remove the browser retry path", owner: "Priya Shah" },
      { kind: "action", text: "Write the retry runbook for support", owner: "Maya Chen" },
    ],
  },
  {
    item: guest,
    title: "When guest checkout goes live",
    outcome: "decided",
    crux: "Guest checkout stays behind a flag until December.",
    positions: [
      { speaker: "Sam Rivera", position: "Keep it behind a flag until the fraud numbers settle" },
      { speaker: "Maya Chen", position: "Would like it sooner for the holiday traffic" },
    ],
    lines: [
      { who: maya, said: "Holiday traffic starts in November. I'd love guest checkout out by then." },
      { who: sam, said: "I don't trust the fraud numbers yet. Let's keep it behind a flag until December." },
    ],
    kept: [
      { kind: "decision", text: "Keep guest checkout behind a flag until December", line: 1 },
      { kind: "action", text: "Pull fraud numbers for guest orders", owner: "Sam Rivera" },
      { kind: "action", text: "Try a promo code field on the payment step", owner: "Maya Chen" },
    ],
  },
]);

const latest = meeting(2, 41, "Fraud numbers came in low, so guest checkout goes to everyone on Nov 20. The retry worker is nearly done, and the team still has to settle how long a retry can run.", [
  {
    item: guest,
    title: "Guest checkout after the fraud numbers",
    outcome: "decided",
    crux: "Fraud is low enough to ship guest checkout to everyone on Nov 20.",
    positions: [
      { speaker: "Sam Rivera", position: "The numbers are fine, ship it before the holidays" },
      { speaker: "Leo Park", position: "Wants an alert on chargebacks first" },
    ],
    lines: [
      { who: sam, said: "Fraud on guest orders is under half a percent. I was wrong to wait, let's ship it to everyone on the twentieth." },
      { who: leo, said: "Okay, but I want a chargeback alert in place first." },
      { who: sam, said: "Leo, can you add that this week?" },
    ],
    kept: [
      { kind: "decision", text: "Ship guest checkout to everyone on Nov 20", line: 0 },
      { kind: "action", text: "Add a chargeback alert", owner: "Leo Park" },
      { kind: "action", text: "Write the guest checkout launch note" },
      { kind: "action", text: "Update the terms link at checkout", owner: "Sam Rivera" },
    ],
  },
  {
    item: retries,
    title: "How long a retry can run",
    outcome: "open",
    crux: "Nobody settled the cap, so it comes back next week.",
    positions: [
      { speaker: "Priya Shah", position: "Cap retries at one hour with jitter" },
      { speaker: "Maya Chen", position: "Support needs a shopper-facing message before any cap" },
    ],
    lines: [
      { who: priya, said: "I'd cap it at an hour with jitter and give up after that." },
      { who: maya, said: "Then support needs something to tell the shopper. What do they see?" },
    ],
    kept: [{ kind: "question", text: "How long should a retry run before it gives up?" }],
  },
  {
    item: mobile,
    title: "Mobile summary bar",
    outcome: "decided",
    crux: "The order summary sticks to the bottom on phones.",
    positions: [{ speaker: "Maya Chen", position: "A sticky bar keeps the total in view" }],
    lines: [
      { who: maya, said: "On phones the total scrolls away. I want it stuck to the bottom." },
      { who: sam, said: "Yes, do that." },
    ],
    kept: [
      { kind: "decision", text: "Stick the order summary to the bottom on phones", line: 0 },
      { kind: "action", text: "Build the sticky order summary", owner: "Maya Chen" },
      { kind: "question", text: "Does Apple Pay need its own button on the summary bar?" },
    ],
  },
]);

// What people's agents did since, through the same calls they make over the MCP.
const api = agentApi({
  db,
  notify: () => {},
  brief: () => ({}),
  suggested: (id) => upNextView(db, id, null),
  uploads: new UploadLinks(),
});
const agent = (user: User, label: string) => ({ user, token: db.createToken(user.id, label, "write").info, model: label === "Codex" ? "gpt-5-codex" : "claude-opus-5-5" });
const samsAgent = agent(sam, "Claude Code");
const priyasAgent = agent(priya, "Claude Code");
const leosAgent = agent(leo, "Codex");
const ref = (n: Note) => `stand:action/${n.id}`;

const worker = earlier.note("Build the payment retry worker");
const browserPath = earlier.note("Remove the browser retry path");
const key = earlier.note("Add an idempotency key");
const alert = latest.note("Add a chargeback alert");
const fraud = earlier.note("Pull fraud numbers");
const summaryBar = latest.note("Build the sticky order summary");
const promo = earlier.note("Try a promo code");

// A product review that ran five days ago, so its page shows how slides ended and what was raised.
addSlide(db, room.id, { title: "One-page checkout, first cut", name: "One-page checkout", summary: "Address, shipping and payment on one page.\nLook at: does the order summary stay in view?", addedBy: "Priya Shah via Claude Code", owner: priya.name, pr: "https://github.com/acme-demo/checkout/pull/31" });
addSlide(db, room.id, { title: "Saved cards at checkout", name: "Saved cards", summary: "Returning shoppers pick a saved card in one tap.", addedBy: "Leo Park via Codex", owner: leo.name, pr: "https://github.com/acme-demo/checkout/pull/33" });
addSlide(db, room.id, { title: "Order confirmation email", name: "Confirmation email", summary: "New layout with the delivery date at the top.", addedBy: "Maya Chen via Cursor", owner: maya.name });
const pastReview = startReview(db, room.id);
const reviewStarted = now - 5 * DAY;
const reviewCall = db.startMeeting(room.id);
const slideItems = db.listItems(room.id).slice(0, 3);
slideItems.forEach((it, i) => db.addSegment({ meetingId: reviewCall.id, itemId: it.id, speakerId: team[i].id, speakerName: team[i].name, kind: "speech", text: `Here's ${it.title.toLowerCase()}.`, ts: reviewStarted + (i + 1) * 4 * MIN }));
db.addNote(reviewCall.id, slideItems[0].id, { kind: "action", text: "Keep the order summary pinned while the page scrolls", owner: maya.name }, null);
db.addNote(reviewCall.id, slideItems[0].id, { kind: "question", text: "Does the one-page layout work with long addresses?", owner: null }, null);
db.addNote(reviewCall.id, slideItems[1].id, { kind: "decision", text: "Saved cards ship to everyone this week", owner: null }, null);
db.addNote(reviewCall.id, slideItems[2].id, { kind: "action", text: "Put the order number in the subject line", owner: maya.name }, null);
db.addNote(reviewCall.id, slideItems[2].id, { kind: "action", text: "Test the email in Outlook", owner: leo.name }, null);
db.addNote(reviewCall.id, null, { kind: "decision", text: "Reviews run every other Thursday", owner: null }, null);
db.addNote(reviewCall.id, null, { kind: "action", text: "Invite support to the next review", owner: sam.name }, null);
setOutcome(db, slideItems[0].id, "fixes", sam.name);
setOutcome(db, slideItems[1].id, "ship", priya.name);
setOutcome(db, slideItems[2].id, "not_yet", sam.name);
db.endMeeting(reviewCall.id, "The team reviewed three checkout features. Saved cards ship now, one-page checkout ships with a fix to the summary, and the confirmation email needs another pass.", null, reviewStarted + 18 * MIN, []);
finishReview(db, room.id, reviewCall.id, reviewStarted + 18 * MIN);

// A brainstorm that ran three days ago, so its page shows a finished map.
{
  const at = now - 3 * DAY;
  const b = startBrainstorm(db, room.id, "How do we get more shoppers through guest checkout?", sam.name, at);
  const call = db.startMeeting(room.id);
  let n = 0;
  const q = (who: { name: string }, text: string) => ({ segmentId: `bs${++n}`, ts: at + n * 40_000, speaker: who.name, text });
  const node = (id: string, parent: string | null, label: string, detail: string, who: { name: string }, said: string, extra: Partial<BrainNode> = {}): BrainNode => {
    const quote = q(who, said);
    return { id, parent, label, detail, by: who.name.split(" ")[0], ts: quote.ts, quote, points: [], caught: [], ...extra };
  };
  db.saveBrainstormMap(b.id, [
    node("d1", null, "Fewer steps", "Cut what a guest has to fill in before paying.", priya, "Honestly the biggest thing is how much we ask for before they can pay."),
    node("i1", "d1", "Skip account prompt", "Don't ask a guest to make an account until after the order is placed.", priya, "We shouldn't ask them to sign up until the order's done.", {
      points: [{ text: "Offer it on the confirmation page instead", by: "Leo", ts: at + 5 * MIN, quote: q(leo, "Put the sign-up offer on the confirmation page, they've already typed everything.") }],
      caught: [{ id: "bc1", kind: "action", text: "Move the account prompt to the confirmation page", owner: leo.name, done: false }],
    }),
    node("i2", "d1", "Autofill the address", "Use the browser's saved address and a postcode lookup.", leo, "Postcode lookup would save half the typing."),
    node("i3", "d1", "One page, not three", "Address, shipping and payment on a single page.", maya, "If it's all on one page people can see how close they are."),
    node("d2", null, "Trust", "Reasons a first-time shopper hesitates to pay.", maya, "A lot of drop-off is people not being sure about us."),
    node("i4", "d2", "Show delivery date early", "Put the expected delivery date beside the total.", maya, "Show when it arrives right next to the price.", { caught: [{ id: "bc2", kind: "question", text: "Can we promise a delivery date before the address is in?", owner: null, done: false }] }),
    node("i5", "d2", "Returns line by the button", "One line on free returns next to Pay.", sam, "Just say free returns right by the pay button."),
    node("i6", "d2", "Known payment logos", "Show Apple Pay and card logos before the payment step.", priya, "People look for the Apple Pay logo before they commit."),
    node("d3", null, "Faster payment", "Ways to pay without typing a card number.", leo, "Typing a card on a phone is where we lose them."),
    node("i7", "d3", "Apple Pay on the cart", "A pay button on the cart page that skips the form.", leo, "Put Apple Pay on the cart itself.", {
      points: [{ text: "Needs its own button on the summary bar", by: "Maya", ts: at + 9 * MIN, quote: q(maya, "Then it needs its own button on the sticky summary bar on mobile.") }],
    }),
    node("i8", "d3", "Pay by link", "Text a payment link to finish on another device.", sam, "What if they could finish on their laptop from a link?"),
    node("d4", null, "Bring them back", "Recover people who leave partway.", sam, "And what about the ones who leave, can we get them back?"),
    node("i9", "d4", "Save the cart by email", "Ask for an email first and send the cart back to them.", sam, "If we get the email first we can send them their cart.", { caught: [{ id: "bc3", kind: "decision", text: "Email comes first on the form", owner: null, done: false }] }),
    node("i10", "d4", "Remember the address", "Keep what a guest typed on this device for next time.", priya, "At least remember what they typed if they come back on the same phone."),
  ]);
  db.endMeeting(call.id, "The team brainstormed ways to get more shoppers through guest checkout.", null, at + 22 * MIN, []);
  finishBrainstorm(db, room.id, call.id, at + 22 * MIN);
}

// Done, closed by the PR that shipped it, with a summary in its log.
api.postUpdate(leosAgent, { ref: ref(key), status: "working", text: "Adding the key to the charge call" });
api.completeAction(leosAgent, {
  ref: ref(key),
  note: "Every charge now sends an idempotency key, so a retry can't charge twice.\n- Key is the order id plus the attempt\n- Old orders are unaffected",
  links: ["https://github.com/acme-demo/checkout/pull/38"],
});
// Done by a person, with no agent.
db.setActionDone(room.id, fraud.id, sam.name, "confirmed");
// Dropped, with why.
api.updateAction({ user: maya, token: null }, { ref: ref(promo), status: "dropped", reason: "Promo codes wait until after launch" });

// An agent on it right now, with a plan.
api.attachPlan(priyasAgent, {
  ref: ref(worker),
  plan: "# Payment retry worker\n\n1. Queue failed charges in Postgres\n2. Retry with backoff and jitter, reusing the idempotency key\n3. Mark the order paid or failed, and tell the shopper\n\nOpen: the cap on how long a retry runs. It's on the agenda for next week.\n\nNotes from the first test are in https://github.com/acme-demo/checkout/pull/41",
});
api.startWork(priyasAgent, { ref: ref(worker), note: "Adding the backoff with jitter" });
api.postUpdate(priyasAgent, { ref: ref(worker), text: "Queue is in. Backoff next." });

// Waiting on another to-do.
api.linkTodos(priyasAgent, { ref: ref(browserPath), dependsOn: ref(worker) });

// Finished and waiting to ship.
api.startWork(leosAgent, { ref: ref(alert) });
api.postUpdate(leosAgent, { ref: ref(alert), status: "ready", text: "Chargebacks over 1% of a day's orders now page the on-call.", links: ["https://github.com/acme-demo/checkout/pull/44"] });

// Yours, with the work in and waiting on your look.
api.postUpdate(samsAgent, { ref: ref(latest.note("Update the terms link")), status: "ready", text: "The link now points at the new terms.", links: ["https://github.com/acme-demo/checkout/pull/45"] });

// Stuck, and someone has to decide.
api.postUpdate({ user: maya, token: db.createToken(maya.id, "Cursor", "write").info }, { ref: ref(summaryBar), status: "needs_decision", text: "The bar hides the Apple Pay button on small phones. Keep the button or the total?" });

// Added by hand, and being done by a person.
api.createAction(samsAgent, { space: room.id, text: "Draft the Dec 1 launch checklist", itemId: guest.id, status: "doing", summary: "Starting from last quarter's checklist." });

// A replacement Stand only suspects, for a person to confirm.
const flagDecision = earlier.note("Keep guest checkout behind a flag");
const shipDecision = latest.note("Ship guest checkout to everyone");
db.addLink(room.id, shipDecision.id, flagDecision.id, "conflicts", "Sam Rivera via Claude Code", null);

// What's true in the space.
const old = api.addContext(samsAgent, { space: room.id, text: "Stripe is the only card processor" });
api.addContext(samsAgent, { space: room.id, text: "Stripe takes cards; Adyen takes everything in the EU", replaces: old.created.ref });
api.addContext(samsAgent, { space: room.id, text: "Launch freeze starts Nov 28" });

// Notes saved from the bar between meetings.
db.addJot({ id: "previewjot1", roomId: room.id, itemId: guest.id, text: "Support asked if guest orders can be looked up by email. Worth checking before the 20th.", byId: maya.id, by: maya.name, ts: now - 6 * 3_600_000 });
db.addJot({ id: "previewjot2", roomId: room.id, itemId: null, text: "Legal is fine with the new receipt wording.", byId: leo.id, by: leo.name, ts: now - DAY });

// startMeeting always says now, so the dates go back afterwards.
const raw = new DatabaseSync(file);
for (const m of [earlier, latest]) raw.prepare("UPDATE meetings SET started_at = ?, ended_at = ? WHERE id = ?").run(m.started, m.ended, m.id);
raw.prepare("UPDATE meetings SET started_at = ?, ended_at = ? WHERE id = ?").run(reviewStarted, reviewStarted + 18 * MIN, reviewCall.id);
raw.prepare("UPDATE reviews SET started_at = ? WHERE id = ?").run(reviewStarted, pastReview.review.id);
const hoursAgo = (h: number) => now - h * 3_600_000;
raw.prepare("UPDATE updates SET ts = ? WHERE note_id = ?").run(hoursAgo(30), key.id);
raw.prepare("UPDATE notes SET done_at = ? WHERE id = ?").run(hoursAgo(30), key.id);
raw.prepare("UPDATE notes SET done_at = ? WHERE id = ?").run(hoursAgo(50), fraud.id);
raw.close();

console.log(`Sample data is in ${dir}. You are Sam Rivera, with no sign-in.`);
process.exit(0);
