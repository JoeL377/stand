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
}

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
      lastActivity: u.ts,
      parked: false,
      order: u.ts,
    });
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
    },
    carried,
  };
}

/** Puts one suggestion on the agenda. A task that came off the agenda comes
 *  back as it was; a loose to-do or question becomes an agenda line of its own,
 *  and the note moves onto it so it can be checked off there. */
export function addUpNext(db: DB, roomId: string, key: string): boolean {
  const [kind, id] = key.split(":");
  if (!id) return false;
  if (kind === "item") return db.restoreItem(roomId, id);
  if (kind !== "note") return false;
  const note = db.getNote(id);
  if (!note || note.roomId !== roomId) return false;
  const from = note.itemId ? db.getItem(note.itemId) : null;
  if (from && from.roomId === roomId && !from.deckId && db.restoreItem(roomId, from.id)) return true;
  const before = new Set(db.listItems(roomId).map((i) => i.id));
  const title = note.text.length > 140 ? `${note.text.slice(0, 139)}…` : note.text;
  const after = db.addItems(roomId, [
    { source: "agenda", externalId: null, title, url: null, description: from ? `Carried over from “${from.title}”` : "Carried over" },
  ]);
  const created = after.find((i) => !before.has(i.id));
  if (!created) return false;
  db.moveNote(note.id, created.id);
  return true;
}
