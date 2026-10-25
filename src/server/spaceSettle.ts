// Claude's pass over a space's decisions and open questions across all its meetings, so the space
// page shows where things stand now: an open question a later decision answered (or a later
// question asked again) leaves the Open card, and a decision a later one reversed shows as
// replaced. It runs with the agenda pass (upNextPolish.ts): when a meeting ends and when someone
// opens the space, and only when the space's decisions or questions changed since the last pass.

import { createHash } from "node:crypto";
import type { Note } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import type { Agent, SettleRow } from "./llm.ts";

export interface Settled {
  at: number;
  /** The notes the pass looked at, so it reruns only when they change. */
  basis: string;
  rows: Array<{ noteId: string; byNoteId: string; how: SettleRow["how"] }>;
}

type Replaced = { text: string; meetingId: string; startedAt: number };

/** How many of each the pass reads, newest first. */
const LIMIT = 200;

/** The space's decisions and questions from finished meetings, oldest first, with their meeting's start. */
function spaceRecord(db: DB, roomId: string) {
  const started = new Map(db.listMeetings(roomId).map((m) => [m.id, m.startedAt]));
  return [...db.spaceNotes(roomId, "decision", LIMIT), ...db.spaceNotes(roomId, "question", LIMIT)]
    .map((n) => ({ ...n, meetingStartedAt: started.get(n.meetingId) ?? n.ts }))
    .sort((a, b) => a.meetingStartedAt - b.meetingStartedAt || a.ts - b.ts);
}

const basisOf = (notes: Note[]) =>
  createHash("sha1")
    .update(notes.map((n) => `${n.id}:${n.text}`).join("\n"))
    .digest("hex");

export async function settleSpace(db: DB, agent: Agent, roomId: string): Promise<void> {
  const room = db.getRoom(roomId);
  const notes = spaceRecord(db, roomId);
  if (!room || !notes.some((n) => n.kind === "question" || n.kind === "decision")) return;
  const basis = basisOf(notes);
  if (db.getSettled(roomId)?.basis === basis) return;
  const started = Date.now();
  const keyed = notes.map((n, i) => ({ n, key: `${n.kind === "decision" ? "D" : "Q"}${i + 1}`, order: i }));
  const out = await agent.settleSpace(
    room,
    keyed.map(({ n, key }) => ({ key, kind: n.kind as "decision" | "question", text: n.text, meeting: n.meetingStartedAt })),
  );
  if (!out) return;
  const byKey = new Map(keyed.map((k) => [k.key, k]));
  const rows: Settled["rows"] = [];
  for (const r of out) {
    const a = byKey.get(r.key);
    const b = byKey.get(r.by);
    if (!a || !b || a === b || rows.some((x) => x.noteId === a.n.id)) continue;
    // Only something said later settles it; a decision in the same meeting may answer a question asked after it.
    const later = b.order > a.order || (r.how === "answered" && b.n.meetingId === a.n.meetingId);
    const fits =
      (r.how === "answered" && a.n.kind === "question" && b.n.kind === "decision") ||
      (r.how === "repeated" && a.n.kind === "question" && b.n.kind === "question") ||
      (r.how === "replaced" && a.n.kind === "decision" && b.n.kind === "decision");
    if (later && fits) rows.push({ noteId: a.n.id, byNoteId: b.n.id, how: r.how });
  }
  db.saveSettled(roomId, { at: Date.now(), basis, rows });
  console.log(`[agent] settled ${rows.length} of ${notes.length} decisions and questions in ${roomId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** The space page's Decided and Open cards: decisions with what replaced them, and the questions nothing settled yet. */
export function settledView(db: DB, roomId: string) {
  const notes = spaceRecord(db, roomId).reverse();
  const byId = new Map(notes.map((n) => [n.id, n]));
  const rows = new Map((db.getSettled(roomId)?.rows ?? []).map((r) => [r.noteId, r]));
  const decided = notes
    .filter((n) => n.kind === "decision")
    .map((n) => {
      const r = rows.get(n.id);
      const by = r && byId.get(r.byNoteId);
      const replacedBy: Replaced | undefined = by ? { text: by.text, meetingId: by.meetingId, startedAt: by.meetingStartedAt } : undefined;
      return { ...n, replacedBy };
    });
  return {
    // Standing decisions first, the replaced ones after them.
    decided: [...decided.filter((n) => !n.replacedBy), ...decided.filter((n) => n.replacedBy)],
    open: notes.filter((n) => n.kind === "question" && !rows.has(n.id)),
    /** Questions a later decision answered, as Done Answer tasks with that decision as what closed them. */
    answered: notes.flatMap((n) => {
      const r = rows.get(n.id);
      const by = r?.how === "answered" ? byId.get(r.byNoteId) : undefined;
      return n.kind === "question" && by ? [{ ...n, answeredBy: by.text, doneAt: n.doneAt ?? by.ts }] : [];
    }),
  };
}
