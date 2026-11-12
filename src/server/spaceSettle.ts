// Claude's pass over a space's decisions and open questions across all its meetings, so the space
// page shows where things stand now: an open question a later decision answered (or a later
// question asked again) leaves the Open card. A decision it thinks a later one reversed is only a
// proposal: the decision stays kept until someone confirms, because Stand never decides on its own.
// It runs with the agenda pass (upNextPolish.ts): when a meeting ends and when someone
// opens the space, and only when the space's decisions or questions changed since the last pass.

import { createHash } from "node:crypto";
import type { Note, ReplacedBy } from "../shared/protocol.ts";
import { isClosed, stateOf } from "../shared/tasks.ts";
import type { DB } from "./db.ts";
import type { Agent, SettleRow } from "./llm.ts";

export interface Settled {
  at: number;
  /** The notes the pass looked at, so it reruns only when they change. */
  basis: string;
  rows: Array<{ noteId: string; byNoteId: string; how: SettleRow["how"] }>;
}

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

/** The space page's Decided and Open cards: decisions with what replaced them or may have, and the questions nothing settled yet. */
export function settledView(db: DB, roomId: string) {
  const notes = spaceRecord(db, roomId).reverse();
  const byId = new Map(notes.map((n) => [n.id, n]));
  const rows = new Map((db.getSettled(roomId)?.rows ?? []).map((r) => [r.noteId, r]));
  const confirmed = new Map(db.roomLinks(roomId, "replaces").map((l) => [l.toId, l.fromId]));
  // A check by someone's agent proposes too: later decision first, earlier second.
  const flagged = new Map(db.roomLinks(roomId, "conflicts").map((l) => [l.toId, l.fromId]));
  const turnedDown = new Set(db.roomLinks(roomId, "not_replaced").map((l) => `${l.fromId}>${l.toId}`));
  const shown = (n?: (typeof notes)[number]): ReplacedBy | undefined =>
    n ? { noteId: n.id, text: n.text, meetingId: n.meetingId, startedAt: n.meetingStartedAt } : undefined;
  // The decision someone answered a question with (agents.ts closeQuestion): what the pass found comes second.
  const leaves = db.roomLinks(roomId, "leaves");
  const left = new Map(leaves.map((l) => [l.fromId, l.toId]));
  const asked = new Map(leaves.map((l) => [l.toId, (byId.get(l.fromId) ?? db.getNote(l.fromId))?.text]));
  const decided = notes
    .filter((n) => n.kind === "decision")
    .map((n) => {
      const replacedBy = shown(byId.get(confirmed.get(n.id) ?? ""));
      const r = rows.get(n.id);
      const later = [flagged.get(n.id), r?.how === "replaced" ? r.byNoteId : undefined].find((id) => id && !turnedDown.has(`${id}>${n.id}`));
      return {
        ...n,
        decisionState: replacedBy ? ("replaced" as const) : ("kept" as const),
        /** The question someone answered with it. */
        answers: asked.get(n.id),
        replacedBy,
        mayBeReplacedBy: replacedBy ? undefined : shown(byId.get(later ?? "")),
      };
    });
  const handAnswer = (n: Note) => {
    const id = left.get(n.id);
    return id ? (byId.get(id) ?? db.getNote(id) ?? undefined) : undefined;
  };
  return {
    // Standing decisions first, the replaced ones after them.
    decided: [...decided.filter((n) => !n.replacedBy), ...decided.filter((n) => n.replacedBy)],
    /** Questions the pass didn't settle. One someone answered by hand is closed, and carries its answer. */
    open: notes
      .filter((n) => n.kind === "question" && !rows.has(n.id))
      .map((n): (typeof notes)[number] & { answeredBy?: string } => {
        const by = n.doneAt ? handAnswer(n) : undefined;
        return by ? { ...n, answeredBy: by.text } : n;
      }),
    /** Questions a later decision answered, as Done Answer tasks with that decision as what closed them. */
    answered: notes.flatMap((n) => {
      const r = rows.get(n.id);
      const by = handAnswer(n) ?? (r?.how === "answered" ? byId.get(r.byNoteId) : undefined);
      return n.kind === "question" && r?.how === "answered" && by ? [{ ...n, answeredBy: by.text, doneAt: n.doneAt ?? by.ts }] : [];
    }),
  };
}

/** The decision a question was answered with by hand, if it was. */
export function answerOf(db: DB, question: Pick<Note, "id">): Note | null {
  const [link] = db.linksFrom([question.id], "leaves");
  return (link && db.getNote(link.toId)) || null;
}

/** The questions the space page lists as open, oldest first: nobody answered, dropped or archived
 *  them, and no later decision settled them. */
export function openQuestions(db: DB, roomId: string) {
  const gone = new Set(db.listArchived(roomId).map((a) => a.ref));
  return settledView(db, roomId)
    .open.filter((n) => !isClosed(stateOf(n)) && !gone.has(`question:${n.id}`))
    .reverse();
}
