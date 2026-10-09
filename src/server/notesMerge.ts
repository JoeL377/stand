// Notes for an item are redrafted from its whole transcript on every refresh.
// A redraft can reword, merge or simply leave out a to-do or decision it wrote
// before, so this carries the earlier ones forward: a redrafted note that
// restates an earlier one keeps that note's id and checked-off state, and an
// earlier one the redraft left out is kept as it was. Nothing captured is lost.
// The host's hand edits win: an edited or added note keeps its wording, and a
// note the host deleted isn't written again.

import type { Note } from "../shared/protocol.ts";
import type { CapturedNote, DraftNote } from "./llm.ts";

type Kept = "action" | "decision";
const KEPT: ReadonlySet<string> = new Set<Kept>(["action", "decision"]);

/** A note to write, with the earlier note's identity when it continues one. */
export type MergedNote = DraftNote & {
  discussionId: string | null;
  id?: string;
  ts?: number;
  doneAt?: number | null;
  doneBy?: string | null;
  editedBy?: string | null;
};

/** Keys the model sees for the earlier notes: A1.. for to-dos, D1.. for decisions. */
export function capturedFor(existing: Note[]): Array<CapturedNote & { id: string }> {
  let a = 0;
  let d = 0;
  return existing
    .filter((n) => KEPT.has(n.kind))
    .map((n) => ({ id: n.id, key: n.kind === "action" ? `A${++a}` : `D${++d}`, kind: n.kind as Kept, text: n.text, owner: n.owner }));
}

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

/** Same task or decision in different words, for when the model forgot to say so. */
function similar(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.6;
}

export function mergeNotes(
  draft: Array<DraftNote & { discussionId: string | null; sameAs?: string | null }>,
  existing: Note[],
  keys: Array<{ id: string; key: string }>,
  dismissed: Array<{ kind: string; text: string }> = [],
): MergedNote[] {
  const byKey = new Map(keys.map((k) => [k.key, existing.find((n) => n.id === k.id)]));
  const claimed = new Set<string>();
  const kept = (e: Note) => KEPT.has(e.kind) || !!e.editedBy;
  const out: MergedNote[] = [];
  for (const { sameAs, ...n } of draft) {
    if (dismissed.some((x) => x.kind === n.kind && similar(x.text, n.text))) continue;
    let prev = sameAs ? byKey.get(sameAs) : undefined;
    if (prev && (prev.kind !== n.kind || claimed.has(prev.id))) prev = undefined;
    prev ??= existing.find((e) => e.kind === n.kind && kept(e) && !claimed.has(e.id) && similar(e.text, n.text));
    if (!prev) {
      out.push(n);
      continue;
    }
    claimed.add(prev.id);
    const mine = prev.editedBy ? { text: prev.text, owner: prev.owner, editedBy: prev.editedBy } : { owner: n.owner ?? prev.owner };
    out.push({ ...n, ...mine, id: prev.id, ts: prev.ts, doneAt: prev.doneAt, doneBy: prev.doneBy });
  }
  // Whatever the redraft left out stays, as it was.
  for (const e of existing) {
    if (!kept(e) || claimed.has(e.id)) continue;
    out.push({
      kind: e.kind,
      text: e.text,
      owner: e.owner,
      discussionId: null,
      id: e.id,
      ts: e.ts,
      doneAt: e.doneAt,
      doneBy: e.doneBy,
      editedBy: e.editedBy ?? null,
    });
  }
  return out;
}
