import assert from "node:assert/strict";
import { test } from "node:test";
import { PILOT_ANSWER_MS, PILOT_AWAY_MS, PILOT_IDLE_MS, PILOT_RECENT_MS, PilotSeat } from "./pilot.ts";

const joe = { id: "u1", name: "Joe" };
const andy = { id: "u2", name: "Andy" };
const huy = { id: "u3", name: "Huy" };

test("pilot: the first to ask takes the free seat; nobody else can ask until it's theirs", () => {
  const seat = new PilotSeat();
  assert.equal(seat.use(joe, 0), true);
  assert.equal(seat.id, "u1");
  assert.equal(seat.use(andy, 1_000), false);
  assert.equal(seat.view(1_000).last?.how, "free");
});

test("pilot: Hand over moves the seat to the first asker at once; Not now tells them and starts the next one's countdown", () => {
  const seat = new PilotSeat();
  seat.use(joe, 0);
  seat.request(andy, 1_000);
  seat.request(huy, 2_000);
  assert.deepEqual(seat.view(2_000).requests.map((r) => r.name), ["Andy", "Huy"]);
  assert.equal(seat.answer("u2", true, 3_000), false, "only the pilot answers");
  seat.answer("u1", false, 3_000);
  assert.deepEqual(seat.view(3_000).declined, { id: "u2", by: "Joe", at: 3_000 });
  assert.equal(seat.view(3_000).handFrom, 3_000);
  seat.answer("u1", true, 4_000);
  const v = seat.view(4_000);
  assert.equal(v.id, "u3");
  assert.deepEqual(v.last, { fromId: "u1", from: "Joe", toId: "u3", to: "Huy", how: "gave", at: 4_000 });
  assert.equal(v.requests.length, 0);
});

test("pilot: a request nobody answers hands over by itself, but never within a minute of the pilot's last question", () => {
  const seat = new PilotSeat();
  seat.use(joe, 0);
  seat.request(andy, 90_000);
  // Joe last asked 90 s ago: just the 20 s countdown.
  assert.equal(seat.view(90_000).handAt, 90_000 + PILOT_ANSWER_MS);
  // Joe asks again; Andy's turn waits a minute from that question.
  seat.use(joe, 100_000);
  assert.equal(seat.view(100_000).handAt, 100_000 + PILOT_RECENT_MS);
  assert.equal(seat.tick(100_000 + PILOT_RECENT_MS - 1), false);
  assert.equal(seat.tick(100_000 + PILOT_RECENT_MS), true);
  assert.equal(seat.id, "u2");
  assert.equal(seat.view(100_000 + PILOT_RECENT_MS).last?.how, "auto");
});

test("pilot: typing keeps the seat while the pilot is mid-question", () => {
  const seat = new PilotSeat();
  seat.use(joe, 0);
  seat.request(andy, 120_000);
  seat.typing("u1", true, 135_000);
  assert.equal(seat.view(135_000).typing, true);
  assert.equal(seat.tick(140_000), false);
  assert.equal(seat.id, "u1");
  assert.equal(seat.view(140_000).handAt, 135_000 + PILOT_RECENT_MS);
});

test("pilot: an idle pilot's seat goes to the next asker at once", () => {
  const seat = new PilotSeat();
  seat.use(joe, 0);
  assert.equal(seat.view(PILOT_IDLE_MS - 1).idle, false);
  assert.equal(seat.nextAt(1_000), PILOT_IDLE_MS, "the idle mark gets a timer");
  assert.equal(seat.view(PILOT_IDLE_MS).idle, true);
  seat.request(andy, PILOT_IDLE_MS + 1);
  assert.equal(seat.id, "u2");
  assert.equal(seat.view(PILOT_IDLE_MS + 1).last?.how, "asked");
});

test("pilot: the pilot hands to anyone or leaves the seat; the host takes it without asking", () => {
  const seat = new PilotSeat();
  seat.use(joe, 0);
  seat.request(andy, 1_000);
  seat.give("u1", null, 2_000);
  assert.equal(seat.id, "u2", "leaving gives it to the first asker");
  seat.give("u2", null, 3_000);
  assert.equal(seat.id, null);
  assert.equal(seat.view(3_000).last?.how, "left");
  seat.use(andy, 4_000);
  seat.give("u2", huy, 5_000);
  assert.equal(seat.id, "u3");
  seat.take(joe, 6_000);
  assert.equal(seat.id, "u1");
  assert.equal(seat.view(6_000).last?.how, "took");
});

test("pilot: a pilot who drops keeps the seat a while, then it moves on; an asker who leaves leaves the line", () => {
  const seat = new PilotSeat();
  seat.use(joe, 0);
  seat.request(andy, 1_000);
  seat.request(huy, 1_500);
  seat.left("u2", 2_000);
  assert.deepEqual(seat.view(2_000).requests.map((r) => r.id), ["u3"]);
  seat.left("u1", 3_000);
  assert.equal(seat.view(3_000).away, true);
  assert.equal(seat.view(3_000).handAt, null, "no countdown while the pilot is away");
  seat.back("u1");
  assert.equal(seat.view(4_000).away, false);
  seat.left("u1", 5_000);
  assert.equal(seat.tick(5_000 + PILOT_AWAY_MS), true);
  assert.equal(seat.id, "u3");
  // An away pilot's seat goes to the next asker at once too.
  seat.left("u3", 60_000);
  seat.request(andy, 61_000);
  assert.equal(seat.id, "u2");
});
