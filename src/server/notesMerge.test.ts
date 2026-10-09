import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "../shared/protocol.ts";
import { mergeNotes } from "./notesMerge.ts";

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

test("an edited open question is kept even when the redraft drops it", () => {
  const q = note("q1", "question", "Do we need it on mobile first?", { editedBy: "Joe" });
  const plain = note("q2", "question", "Who owns billing?");
  const out = mergeNotes([], [q, plain], []);
  assert.deepEqual(
    out.map((n) => n.id),
    ["q1"],
  );
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
