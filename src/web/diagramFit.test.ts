import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramCap } from "./diagramFit.ts";

test("a slide's diagrams give up the height the slide is over by, the tallest first, down to a floor", () => {
  // The slide fits, or has no diagram: nothing changes.
  assert.equal(diagramCap([200, 200], 0), null);
  assert.equal(diagramCap([200, 200], -40), null);
  assert.equal(diagramCap([], 100), null);
  // One diagram gives up all of it.
  assert.equal(diagramCap([300], 100), 200);
  // Two of the same height share it.
  assert.equal(diagramCap([210, 210], 136), 142);
  // The taller one gives first: 400 comes down to 250 before the 150 one is touched.
  assert.equal(diagramCap([150, 400], 150), 250);
  // Past that, both come down together.
  assert.equal(diagramCap([150, 400], 300), 125);
  assert.equal(diagramCap([400, 150, 300], 250), 225);
  // Never below the floor: the slide scrolls for the rest.
  assert.equal(diagramCap([150, 400], 500), 120);
  assert.equal(diagramCap([300], 900), 120);
  assert.equal(diagramCap([300], 250, 80), 80);
});
