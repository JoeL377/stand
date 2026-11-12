import assert from "node:assert/strict";
import { test } from "node:test";
import { presenceChange } from "./roomSounds.ts";

test("the people already in the room when you arrive don't count as joining", () => {
  assert.deepEqual(presenceChange(null, ["me", "joe", "ann"], "me"), { joined: [], left: [] });
});

test("someone else coming in or going out is a join or a leave", () => {
  const prev = new Set(["me", "joe"]);
  assert.deepEqual(presenceChange(prev, ["me", "joe", "ann"], "me"), { joined: ["ann"], left: [] });
  assert.deepEqual(presenceChange(prev, ["me"], "me"), { joined: [], left: ["joe"] });
  assert.deepEqual(presenceChange(prev, ["me", "ann"], "me"), { joined: ["ann"], left: ["joe"] });
});

test("your own coming and going makes no sound for you", () => {
  assert.deepEqual(presenceChange(new Set(["joe"]), ["joe", "me"], "me"), { joined: [], left: [] });
  assert.deepEqual(presenceChange(new Set(["joe", "me"]), ["joe"], "me"), { joined: [], left: [] });
});
