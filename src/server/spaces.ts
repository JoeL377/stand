// The home page's view of a space, built from what Stand already records:
// who has been in it, its meetings' notes, and whether people are talking now.

import type { SpaceSummary } from "../shared/protocol.ts";
import type { DB } from "./db.ts";

type Row = ReturnType<DB["spaceRows"]>[number];
type Live = SpaceSummary["live"];

/** "Joe" or "Joe Liang" both name Joe Liang as an owner. */
export function ownedBy(owner: string | null, userName: string): boolean {
  if (!owner) return false;
  const o = owner.trim().toLowerCase();
  const full = userName.trim().toLowerCase();
  return o === full || o === full.split(/\s+/)[0];
}

export function toSpaceSummary(row: Row, user: { id: string; name: string }, live: Live): SpaceSummary {
  const latestMeeting = row.notes[0]?.meetingId;
  const open = row.notes.filter((n) => n.kind === "action" && !n.done);
  const last = row.notes.find((n) => n.kind !== "action") ?? row.notes[0] ?? null;
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    synthesisInstructions: row.synthesisInstructions,
    mine: row.createdBy === user.id,
    following: row.following,
    activeAt: live ? Date.now() : row.activeAt,
    live,
    toDecide: row.notes.filter((n) => n.kind === "question" && n.meetingId === latestMeeting).length,
    todos: open.length,
    forYou: open.filter((n) => ownedBy(n.owner, user.name)).length,
    last: last && { kind: last.kind, text: last.text, ts: last.ts },
    people: row.people,
    search: [row.name, row.purpose, ...row.people, ...row.notes.map((n) => `${n.text} ${n.owner ?? ""}`)]
      .join("\n")
      .toLowerCase()
      .slice(0, 20_000),
  };
}
