import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "../shared/protocol.ts";
import { capturedFor, mergeNotes } from "./notesMerge.ts";

const note = (id: string, kind: Note["kind"], text: string, extra: Partial<Note> = {}): Note => ({
  id,
  meetingId: "m",
  itemId: "i",
  kind,
  text,
  owner: null,
  ts: 1,
  doneAt: null,
  doneBy: null,
  discussionId: null,
  ...extra,
});

test("the host's wording survives a redraft that restates the note", () => {
  const edited = note("a1", "action", "Ship the onboarding email on Friday", { owner: "Andy", editedBy: "Joe" });
  const out = mergeNotes(
    [{ kind: "action", text: "Ship onboarding email", owner: "Huy", discussionId: null, sameAs: "A1" }],
    [edited],
    [{ id: "a1", key: "A1" }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "a1");
  assert.equal(out[0].text, "Ship the onboarding email on Friday");
  assert.equal(out[0].owner, "Andy");
  assert.equal(out[0].editedBy, "Joe");
});

test("open questions a redraft leaves out stay, edited or not", () => {
  const q = note("q1", "question", "Do we need it on mobile first?", { editedBy: "Joe" });
  const plain = note("q2", "question", "Who owns billing?");
  const out = mergeNotes([], [q, plain], []);
  assert.deepEqual(
    out.map((n) => n.id),
    ["q1", "q2"],
  );
});

test("open questions get keys, and a reworded one keeps its id", () => {
  const existing = [note("a", "action", "Price out SSO"), note("q", "question", "Per seat or per space?"), note("d", "decision", "Keep LiveKit")];
  assert.deepEqual(
    capturedFor(existing).map((c) => c.key),
    ["A1", "Q1", "D1"],
  );
  const out = mergeNotes(
    [{ kind: "question", text: "Do we charge by seat or by space?", owner: null, discussionId: "t1", sameAs: "Q1" }],
    existing.filter((n) => n.kind === "question"),
    [{ id: "q", key: "Q1" }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "q");
  assert.equal(out[0].text, "Do we charge by seat or by space?");
});

test("an open question goes once the talk answers it, unless the host wrote it", () => {
  const asked = note("q1", "question", "Per seat or per space?");
  const hosts = note("q2", "question", "Who tells the customer?", { editedBy: "Joe" });
  const keys = [
    { id: "q1", key: "Q1" },
    { id: "q2", key: "Q2" },
  ];
  // Answered and left out; or answered and still written again: either way it's gone.
  assert.deepEqual(
    mergeNotes([], [asked, hosts], keys, [], ["Q1", "Q2"]).map((n) => n.id),
    ["q2"],
  );
  assert.deepEqual(
    mergeNotes([{ kind: "question", text: "Per seat or per space?", owner: null, discussionId: null }], [asked], keys, [], ["Q1"]),
    [],
  );
  // A key that isn't a question answers nothing.
  assert.equal(mergeNotes([], [note("a1", "action", "Price out SSO")], [{ id: "a1", key: "A1" }], [], ["A1"]).length, 1);
});

test("a note the host deleted isn't written again", () => {
  const out = mergeNotes(
    [
      { kind: "action", text: "Write the migration note", owner: null, discussionId: null },
      { kind: "decision", text: "Keep LiveKit", owner: null, discussionId: null },
    ],
    [],
    [],
    [{ kind: "action", text: "Write the migration notes" }],
  );
  assert.deepEqual(
    out.map((n) => n.text),
    ["Keep LiveKit"],
  );
});
