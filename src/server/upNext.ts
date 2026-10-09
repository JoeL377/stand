// The agent's draft of a space's next agenda: what's still open from earlier
// meetings and what changed since, ranked, each with a one-line reason.
// Pure ranking over data the room already keeps, so it's cheap enough to
// rebuild on every state change. Nothing joins the agenda until someone adds it.

import type { ItemUpdate, Note, UpNext, UpNextSuggestion } from "../shared/protocol.ts";
import type { DB } from "./db.ts";

export interface UpNextInput {
  now: number;
  /** The space's meetings, in any order. */
  meetings: Array<{ id: string; startedAt: number; endedAt: number | null }>;
  /** When the live meeting started, if one is running; it doesn't count as "earlier". */
  currentStart: number | null;
  /** The space's to-do and question notes. */
  notes: Note[];
  items: Map<string, { title: string; archived: boolean; deck: boolean }>;
  updates: ItemUpdate[];
  /** Suggestion key -> when someone dismissed it. */
  dismissed: Map<string, number>;
  /** For a space with no meetings yet: other spaces its people share that still have open to-dos. */
  otherSpaces: Array<{ id: string; name: string; open: number; lastAt: number }>;
}

/** Claude's pass over the ranked list (see upNextPolish.ts): a shorter agenda
 *  line, a better reason and an order, per suggestion. Each row remembers what
 *  it was written from, so a row whose facts changed since falls back to the
 *  plain ranking instead of showing a stale reason. */
export interface Polish {
  at: number;
  rows: Array<{ key: string; basis: string; title: string; reason: string; sameAs: string | null }>;
}

export const polishBasis = (s: Pick<UpNextSuggestion, "title" | "reason">) => `${s.title}\n${s.reason}`;

/** Meetings with nothing happening on a to-do before it's parked. */
const QUIET_MEETINGS = 2;

const RANK: Record<UpNextSuggestion["kind"], number> = { needs_people: 0, question: 1, todo: 3 };

export function computeUpNext(input: UpNextInput): { upNext: UpNext; carried: Record<string, number> } {
  const { notes, items, updates, dismissed } = input;
  const boundary = input.currentStart ?? Infinity;
  const started = new Map(input.meetings.map((m) => [m.id, m.startedAt]));
  const earlier = input.meetings.filter((m) => m.endedAt !== null && m.startedAt < boundary).sort((a, b) => a.startedAt - b.startedAt);
  const last = earlier.at(-1) ?? null;
  const since = last?.startedAt ?? null;

  // Meetings after a note's own meeting, the live one included.
  const carriedOf = (n: Note) => input.meetings.filter((m) => m.startedAt > (started.get(n.meetingId) ?? Infinity)).length;
  const endedAfter = (n: Note) => earlier.filter((m) => m.startedAt > (started.get(n.meetingId) ?? Infinity)).length;
  const fromEarlier = (n: Note) => (started.get(n.meetingId) ?? Infinity) < boundary && earlier.some((m) => m.id === n.meetingId);
  // A note on a task or ticket that's on the agenda already has a home there.
  const homed = (n: Note) => {
    const it = n.itemId ? items.get(n.itemId) : undefined;
    return !!it && !it.archived && !it.deck;
  };
  const noteActivity = (n: Note) => updates.filter((u) => u.noteId === n.id && u.ts > (started.get(n.meetingId) ?? 0));
  const ago = (carried: number) => (carried <= 1 ? "last meeting" : `${carried} meetings ago`);
  const by = (u: ItemUpdate) => (u.client ? `${u.userName.split(" ")[0]}'s agent` : u.userName);
  const urgent = (u: ItemUpdate) => u.status === "blocked" || u.status === "needs_decision";
  const urgentReason = (u: ItemUpdate) => `${u.status === "blocked" ? "Blocked" : "Needs a decision"} · ${by(u)}`;

  type Draft = UpNextSuggestion & { lastActivity: number; parked: boolean; order: number };
  const drafts = new Map<string, Draft>();
  type Group = { title: string; count: number; questions: number; carried: number; acts: ItemUpdate[]; parked: boolean; order: number };
  const groups = new Map<string, Group>();
  // A task that came off the agenda with open to-dos or questions: suggest the task once.
  const offAgenda = (n: Note) => {
    const it = n.itemId ? items.get(n.itemId) : undefined;
    if (!it || !it.archived || it.deck) return null;
    const g = groups.get(n.itemId!) ?? { title: it.title, count: 0, questions: 0, carried: 0, acts: [], parked: true, order: 0 };
    g.carried = Math.max(g.carried, carriedOf(n));
    g.order = Math.max(g.order, n.ts);
    groups.set(n.itemId!, g);
    return g;
  };

  for (const n of notes) {
    if (!fromEarlier(n) || homed(n)) continue;
    const carried = carriedOf(n);
    if (n.kind === "question") {
      // Questions have no done state; only last meeting's still count as open.
      if (!last || n.meetingId !== last.id) continue;
      const g = offAgenda(n);
      if (g) {
        g.questions++;
        g.parked = false;
        continue;
      }
      drafts.set(`note:${n.id}`, {
        key: `note:${n.id}`,
        kind: "question",
        title: n.text,
        reason: "Open question from last meeting",
        noteId: n.id,
        itemId: n.itemId,
        owner: null,
        carried,
        merged: [],
        lastActivity: n.ts,
        parked: false,
        order: n.ts,
      });
      continue;
    }
    if (n.kind !== "action" || n.doneAt) continue;
    const acts = noteActivity(n);
    const lastAct = acts[0] ?? null;
    const parked = !acts.length && endedAfter(n) >= QUIET_MEETINGS;
    const g = offAgenda(n);
    if (g) {
      g.count++;
      g.acts.push(...acts);
      g.parked &&= parked;
      continue;
    }
    drafts.set(`note:${n.id}`, {
      key: `note:${n.id}`,
      kind: lastAct && urgent(lastAct) ? "needs_people" : "todo",
      title: n.text,
      reason: lastAct
        ? urgent(lastAct)
          ? urgentReason(lastAct)
          : `${lastAct.status === "done" ? "Reported done" : "Progress"} · ${by(lastAct)}`
        : `To-do from ${ago(carried)}${n.owner ? ` · ${n.owner}` : ""}`,
      noteId: n.id,
      itemId: n.itemId,
      owner: n.owner,
      carried,
      merged: [],
      lastActivity: lastAct?.ts ?? n.ts,
      parked,
      order: n.ts,
    });
  }

  for (const [itemId, g] of groups) {
    const lastAct = g.acts.sort((x, y) => y.ts - x.ts)[0] ?? null;
    const hot = lastAct && urgent(lastAct) ? lastAct : null;
    drafts.set(`item:${itemId}`, {
      key: `item:${itemId}`,
      kind: hot ? "needs_people" : "todo",
      title: g.title,
      reason: hot
        ? urgentReason(hot)
        : `${[
            g.count && (g.count === 1 ? "Open to-do" : `${g.count} open to-dos`),
            g.questions && (g.questions === 1 ? "open question" : `${g.questions} open questions`),
          ]
            .filter(Boolean)
            .join(", ")
            .replace(/^o/, "O")} · from ${ago(g.carried)}`,
      noteId: null,
      itemId,
      owner: null,
      carried: g.carried,
      merged: [],
      lastActivity: lastAct?.ts ?? g.order,
      parked: g.parked,
      order: g.order,
    });
  }

  // Blockers reported on a task that's off the agenda, with no to-do to hang on.
  for (const u of updates) {
    if (!urgent(u) || u.noteId || !u.itemId || (since !== null && u.ts < since)) continue;
    const it = items.get(u.itemId);
    if (!it || !it.archived || it.deck || drafts.has(`item:${u.itemId}`)) continue;
    drafts.set(`item:${u.itemId}`, {
      key: `item:${u.itemId}`,
      kind: "needs_people",
      title: it.title,
      reason: urgentReason(u),
      noteId: null,
      itemId: u.itemId,
      owner: null,
      carried: 0,
      merged: [],
      lastActivity: u.ts,
      parked: false,
      order: u.ts,
    });
  }

  // A new space: offer to bring over what's still open in spaces its people share.
  if (!earlier.length) {
    for (const o of input.otherSpaces) {
      drafts.set(`space:${o.id}`, {
        key: `space:${o.id}`,
        kind: "todo",
        title: `Open to-dos from ${o.name}`,
        reason: `${o.open} open to-do${o.open === 1 ? "" : "s"} in ${o.name}`,
        noteId: null,
        itemId: null,
        owner: null,
        carried: 0,
        merged: [],
        lastActivity: o.lastAt,
        parked: false,
        order: o.lastAt,
      });
    }
  }

  const kept = [...drafts.values()].filter((d) => {
    const at = dismissed.get(d.key);
    // Dismissed stays dismissed until something new happens on it.
    return at === undefined || d.lastActivity > at;
  });
  const score = (d: Draft) => RANK[d.kind] - (d.kind === "todo" && d.lastActivity > d.order ? 1 : 0);
  kept.sort((a, b) => score(a) - score(b) || b.order - a.order);
  const strip = ({ lastActivity: _l, parked: _p, order: _o, ...s }: Draft): UpNextSuggestion => s;

  // How much of what was open got closed since last time.
  const earlierActions = notes.filter((n) => n.kind === "action" && fromEarlier(n));
  const inWindow = since === null ? [] : earlierActions.filter((n) => n.doneAt === null || n.doneAt >= since);
  const closed = inWindow.filter((n) => n.doneAt !== null).length;

  // Agenda items carrying open to-dos from earlier meetings: the ↻ count.
  const carried: Record<string, number> = {};
  for (const n of earlierActions) {
    if (n.doneAt || !n.itemId || !homed(n)) continue;
    carried[n.itemId] = Math.max(carried[n.itemId] ?? 0, carriedOf(n));
  }

  return {
    upNext: {
      suggestions: kept.filter((d) => !d.parked).map(strip),
      parked: kept.filter((d) => d.parked).map(strip),
      closed,
      total: inWindow.length,
      since,
      meetingsUsed: earlier.length,
      updatesUsed: updates.filter((u) => since === null || u.ts >= since).length,
      builtAt: input.now,
      polishedAt: null,
      polishing: false,
    },
    carried,
  };
}

/** Lays Claude's last pass over the plain ranking. Rows it wrote from facts
 *  that have since changed, and anything new, keep the plain wording; a new
 *  blocker still goes to the top. Only to-dos and questions can be folded into
 *  another suggestion, since adding the keeper moves them along with it. */
export function applyPolish(upNext: UpNext, polish: Polish | null): UpNext {
  if (!polish) return upNext;
  const byKey = new Map(upNext.suggestions.map((s) => [s.key, s]));
  const fresh = new Map(polish.rows.filter((r) => byKey.get(r.key) && polishBasis(byKey.get(r.key)!) === r.basis).map((r) => [r.key, r]));
  if (!fresh.size) return upNext;
  // A row folds into another only if that one is itself kept, and only to-dos and questions fold.
  const keeperOf = (r: Polish["rows"][number]) => {
    const k = r.sameAs && r.sameAs !== r.key ? fresh.get(r.sameAs) : undefined;
    return k && !k.sameAs && r.key.startsWith("note:") ? k.key : null;
  };
  // One folded into a row that's no longer kept as written goes back to its plain wording.
  for (const r of [...fresh.values()]) if (r.sameAs && !keeperOf(r)) fresh.delete(r.key);
  const out = new Map<string, UpNextSuggestion>();
  for (const r of fresh.values()) if (!keeperOf(r)) out.set(r.key, { ...byKey.get(r.key)!, title: r.title, reason: r.reason, merged: [] });
  for (const r of fresh.values()) {
    const k = keeperOf(r);
    if (k) out.get(k)!.merged.push(r.key);
  }
  const rest = upNext.suggestions.filter((s) => !fresh.has(s.key));
  return {
    ...upNext,
    suggestions: [...rest.filter((s) => s.kind === "needs_people"), ...out.values(), ...rest.filter((s) => s.kind !== "needs_people")],
    polishedAt: polish.at,
  };
}

/** Puts one suggestion on the agenda and returns the agenda item it landed on.
 *  A task that came off the agenda comes back as it was; a loose to-do or
 *  question becomes an agenda line of its own, and the note moves onto it so
 *  it can be checked off there. Open to-dos from another space become one
 *  agenda line here, copied into this meeting, and are closed over there as
 *  carried. Suggestions folded into this one move onto the same item. */
export function addUpNext(db: DB, roomId: string, s: Pick<UpNextSuggestion, "key" | "merged">, meeting: { id: string }): string | null {
  const itemId = addOne(db, roomId, s.key, meeting);
  if (!itemId) return null;
  for (const key of s.merged) {
    const [kind, id] = key.split(":");
    const note = kind === "note" ? db.getNote(id) : null;
    if (note && note.roomId === roomId) db.moveNote(note.id, itemId);
  }
  return itemId;
}

function addOne(db: DB, roomId: string, key: string, meeting: { id: string }): string | null {
  const [kind, id] = key.split(":");
  if (!id) return null;
  if (kind === "item") return db.restoreItem(roomId, id) ? id : null;
  if (kind === "space") return carrySpace(db, roomId, id, meeting);
  if (kind !== "note") return null;
  const note = db.getNote(id);
  if (!note || note.roomId !== roomId) return null;
  const from = note.itemId ? db.getItem(note.itemId) : null;
  if (from && from.roomId === roomId && !from.deckId && db.restoreItem(roomId, from.id)) return from.id;
  const title = note.text.length > 140 ? `${note.text.slice(0, 139)}…` : note.text;
  const created = newAgendaLine(db, roomId, title, from ? `Carried over from “${from.title}”` : "Carried over");
  if (!created) return null;
  db.moveNote(note.id, created);
  return created;
}

function newAgendaLine(db: DB, roomId: string, title: string, description: string): string | null {
  const before = new Set(db.listItems(roomId).map((i) => i.id));
  const after = db.addItems(roomId, [{ source: "agenda", externalId: null, title, url: null, description }]);
  return after.find((i) => !before.has(i.id))?.id ?? null;
}

function carrySpace(db: DB, roomId: string, fromId: string, meeting: { id: string }): string | null {
  const here = db.getRoom(roomId);
  const from = db.getRoom(fromId);
  const open = db.openActions(fromId).slice(0, 30);
  if (!here || !from || !open.length) return null;
  const itemId = newAgendaLine(db, roomId, `To-dos from ${from.name}`, `Carried over from “${from.name}”`);
  if (!itemId) return null;
  for (const n of open) {
    db.addNote(meeting.id, itemId, { kind: "action", text: n.text, owner: n.owner }, null);
    db.setActionDone(fromId, n.id, `carry-over to “${here.name}”`);
  }
  return itemId;
}
