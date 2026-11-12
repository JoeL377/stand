import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heardIntent, suggestedNext } from "./nextSteps.ts";
import type { NextStep } from "../shared/protocol.ts";

describe("heardIntent", () => {
  it("hears someone asking for a brainstorm", () => {
    assert.deepEqual(heardIntent("Before you do this, let's start a brainstorm on this right now"), { kind: "map", topic: null });
    assert.deepEqual(heardIntent("I'm gonna say and let's start a brainstorming session."), { kind: "map", topic: null });
    assert.deepEqual(heardIntent("should we brainstorm on the primitives?"), { kind: "map", topic: "The primitives" });
    assert.equal(heardIntent("Maybe we need to all get together and do another brainstorming about what type of reviews we have")?.kind, "map");
  });
  it("hears a review being asked for, with what it is on", () => {
    assert.deepEqual(heardIntent("If we have time, let's do a design review of the projects migration."), { kind: "design-review", topic: "The projects migration" });
    assert.deepEqual(heardIntent("hey, we should have a design review for this"), { kind: "design-review", topic: null });
    assert.deepEqual(heardIntent("I think we need a product review on the phone views"), { kind: "product-review", topic: "The phone views" });
  });
  it("hears a design session", () => {
    assert.deepEqual(heardIntent("Alright, let's do a design session on dynamic workflows"), { kind: "diagram", topic: "Dynamic workflows" });
    assert.deepEqual(heardIntent("can we draw this out"), { kind: "diagram", topic: null });
  });
  it("stays quiet about ones that happened, or that nobody wants", () => {
    assert.equal(heardIntent("Me and Janesh did a brainstorming yesterday."), null);
    assert.equal(heardIntent("We don't need a design review for that"), null);
    assert.equal(heardIntent("We already had the product review, let's not do another product review"), null);
    assert.equal(heardIntent("The brainstorm map was too dense"), null);
    assert.equal(heardIntent("A terminology review is a design review."), null);
    assert.equal(heardIntent("We did a spec review. Now it's an idea review."), null);
  });
});

describe("suggestedNext", () => {
  const step = (p: Partial<NextStep>): NextStep => ({ id: "n1", kind: "design-review", topic: "", by: "Joe", ts: 1, segmentId: "s1", state: "missed", ...p });
  it("keeps the reviews that were asked for and not waved off, once each", () => {
    const steps = [
      step({ id: "a", topic: "Projects" }),
      step({ id: "b", topic: "projects", state: "noted" }),
      step({ id: "c", kind: "map", topic: "Discord", state: "missed" }),
      step({ id: "d", kind: "product-review", state: "waved" }),
      step({ id: "e", kind: "product-review", topic: "Phone views", state: "started" }),
    ];
    assert.deepEqual(suggestedNext(steps).map((s) => s.id), ["a"]);
  });
});
