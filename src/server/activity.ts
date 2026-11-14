// The space's Activity tab (shared/activity.ts): what agents did, newest first, a page at a time.
// Every event is read from the record its action left: reports on to-dos (updates), notes with who
// added or closed them, review slides, the cards of a call's agent, Stand's answers in chat, its
// sweeps, and agent_events for the few actions that leave nothing else. Each source is read down
// from a time, and the pages merge them, so a long history costs one page's worth of rows.

import { type Actor, parseActor } from "../shared/actors.ts";
import type { ActivityEvent, ActivityKind, ActivityPage, ActivityTarget, ActivityWho } from "../shared/activity.ts";
import { STAND_AUTHOR } from "../shared/chat.ts";
import type { AgentCard, ItemUpdate, NoteKind } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import { type Row, toNote, toUpdate } from "./db/rows.ts";
import type { AgentEventBody } from "./db/updates.ts";
import { meetingKindName } from "./meetingNames.ts";
import { currentSweep } from "./questionSweep.ts";
import { prOf } from "./workLog.ts";

export const ACTIVITY_PAGE = 50;
/** How many pages of rows one request reads at most, looking for events a filter lets through. */
const ROUNDS = 8;

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

const REF_KIND: Partial<Record<NoteKind, string>> = { action: "action", decision: "decision", question: "question", context: "context" };
const noteTarget = (n: { id: string; kind: NoteKind; text: string }): ActivityTarget => ({
  text: clip(n.text, 200),
  href: REF_KIND[n.kind] ? `/ref/${REF_KIND[n.kind]}/${n.id}` : undefined,
  taskId: n.kind === "action" || n.kind === "question" ? n.id : undefined,
  kind: n.kind === "summary" ? undefined : n.kind,
});

/** What a source read below a time: its events, and how far down it read when there may be more
 *  (null: it read to the end). */
interface Read {
  events: ActivityEvent[];
  floor: number | null;
}
type Source = (before: number, limit: number) => Read;

/** The people and agents a page names, each once. */
class Whos {
  readonly seen = new Map<string, ActivityWho>();
  private readonly byId = new Map<string, { id: string; name: string; picture: string | null }>();
  private readonly byName = new Map<string, { id: string; name: string; picture: string | null }>();

  constructor(db: DB, roomId: string) {
    const rows = db.raw.prepare("SELECT u.id, u.name, u.picture FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?").all(roomId) as Row[];
    for (const r of rows) {
      const u = { id: r.id as string, name: r.name as string, picture: (r.picture as string) ?? null };
      this.byId.set(u.id, u);
      this.byName.set(u.name.toLowerCase(), u);
    }
  }

  /** The key of whoever this actor is, or null for a person: the tab starts with agents. */
  of(actor: Actor | null | undefined): string | null {
    if (!actor || actor.kind === "person") return null;
    if (actor.kind === "stand") return this.add({ key: "stand", kind: "stand", name: "Stand", short: "Stand", person: null, personId: null, picture: null });
    if (actor.kind === "github") return this.github();
    const u = (actor.personId && this.byId.get(actor.personId)) || (actor.person && this.byName.get(actor.person.toLowerCase())) || null;
    const person = u?.name ?? actor.person;
    const agent = actor.agent?.trim() || "Agent";
    return this.add({
      key: `a:${u?.id ?? (person ?? "").toLowerCase()}:${agent.toLowerCase()}`,
      kind: "agent",
      name: person ? `${first(person)}’s ${agent}` : agent,
      short: agent,
      person: person ?? null,
      personId: u?.id ?? actor.personId ?? null,
      picture: u?.picture ?? null,
    });
  }

  github() {
    return this.add({ key: "github", kind: "github", name: "GitHub", short: "GitHub", person: null, personId: null, picture: null });
  }

  private add(w: ActivityWho) {
    if (!this.seen.has(w.key)) this.seen.set(w.key, w);
    return w.key;
  }
}

/** What a report on a to-do reads as, by its status. */
const UPDATE_VERB: Record<string, { kind: ActivityKind; verb: string; stand?: string }> = {
  working: { kind: "working", verb: "started on" },
  progress: { kind: "progress", verb: "posted progress on" },
  blocked: { kind: "blocked", verb: "is blocked on" },
  needs_decision: { kind: "needs_decision", verb: "needs a decision on" },
  ready: { kind: "ready", verb: "finished" },
  done: { kind: "done", verb: "completed" },
  added: { kind: "added", verb: "added" },
  note: { kind: "note", verb: "updated" },
  plan: { kind: "plan", verb: "attached a plan to", stand: "drafted a spec for" },
  linked: { kind: "linked", verb: "linked" },
  comment: { kind: "comment", verb: "commented on" },
};
const FLAG: Partial<Record<ActivityKind, ActivityEvent["flag"]>> = { blocked: "Blocked", needs_decision: "Needs a decision", ready: "Ready to ship" };

export function spaceActivity(db: DB, roomId: string, opts: { before?: number; limit?: number; who?: string } = {}): ActivityPage {
  const raw = db.raw;
  const whos = new Whos(db, roomId);
  const limit = Math.min(100, Math.max(1, opts.limit ?? ACTIVITY_PAGE));

  /** Reads rows below a time and turns each into an event (or nothing). */
  const rows = (sql: string, args: (before: number, limit: number) => Array<string | number>, ts: (r: Row) => number, make: (rs: Row[]) => ActivityEvent[]): Source => (before, n) => {
    const got = raw.prepare(sql).all(...args(before, n)) as Row[];
    return { events: make(got), floor: got.length >= n ? ts(got[got.length - 1]) : null };
  };

  const meetingNames = new Map<string, ActivityTarget>();
  const meetingTarget = (id: string): ActivityTarget => {
    let t = meetingNames.get(id);
    if (!t) {
      const m = db.getMeeting(id);
      t = m?.chat ? { text: "the chat" } : { text: m?.title ?? meetingKindName(db, id), href: `/meetings/${id}`, kind: "meeting" };
      meetingNames.set(id, t);
    }
    return t;
  };

  // A flag is only for what still waits: the to-do is open and this is the last word on it.
  const lastWord = raw.prepare(
    `SELECT u.id FROM updates u JOIN notes n ON n.id = u.note_id WHERE u.note_id = ? AND n.done_at IS NULL
     AND u.status NOT IN ('plan', 'linked', 'comment', 'note') ORDER BY u.ts DESC, u.rowid DESC LIMIT 1`,
  );
  const stillWaits = (u: ItemUpdate) => !!u.noteId && (lastWord.get(u.noteId) as Row | undefined)?.id === u.id;
  const hasAdder = raw.prepare("SELECT 1 FROM notes WHERE id = ? AND added_actor_json IS NOT NULL");
  const itemTitle = raw.prepare("SELECT title FROM items WHERE id = ?");

  const updates: Source = rows(
    "SELECT * FROM updates WHERE room_id = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?",
    (before, n) => [roomId, before, n],
    (r) => r.ts as number,
    (rs) =>
      rs.flatMap((r): ActivityEvent[] => {
        const u = toUpdate(r);
        const shape = UPDATE_VERB[u.status];
        if (!shape) return [];
        // A to-do an agent added is listed from the to-do itself (below), with this as its detail.
        if (u.status === "added" && u.noteId && hasAdder.get(u.noteId)) return [];
        const pr = u.links.map((l) => ({ l, pr: prOf(l) })).find((x) => x.pr);
        const prName = pr?.pr ? `PR #${pr.pr.number}` : "a PR";
        // A merge closes a to-do in the name of whoever reported it ready; on the timeline it is GitHub's.
        const shipped = u.status === "done" && (u.actor?.kind === "github" || u.text.startsWith("Shipped: "));
        const unmerged = u.status === "blocked" && / was closed without merging/.test(u.text);
        const who = shipped || unmerged ? whos.github() : whos.of(u.actor);
        if (!who) return [];
        let { kind, verb } = shape;
        if (u.actor?.kind === "stand" && shape.stand) verb = shape.stand;
        if (shipped) [kind, verb] = ["shipped", `${prName} merged, closing`];
        else if (unmerged) verb = `${prName} closed without merging, still open:`;
        else if (u.status === "ready") verb = pr ? `opened ${prName} for` : "finished";
        else if (u.status === "comment" && u.text.startsWith("Review requested")) [kind, verb] = ["review_asked", "asked for a design review of"];
        const title = u.noteId ? null : u.itemId ? ((itemTitle.get(u.itemId) as Row | undefined)?.title as string | undefined) : undefined;
        const target: ActivityTarget | null = u.noteId
          ? { text: clip(u.noteText ?? "a to-do", 200), href: `/ref/action/${u.noteId}`, taskId: u.noteId, kind: "action" }
          : u.itemId
            ? { text: title ?? "an agenda item", href: `/items/${u.itemId}` }
            : null;
        const flag = FLAG[kind] && stillWaits(u) ? FLAG[kind] : undefined;
        return [{ id: `u:${u.id}`, ts: u.ts, who, kind, verb, target, flag, detail: u.text || undefined, links: u.links.length ? u.links : undefined, model: u.actor?.model }];
      }),
  );

  const addedDetail = raw.prepare("SELECT text, links_json FROM updates WHERE note_id = ? AND status = 'added' ORDER BY ts LIMIT 1");
  const ADDED_VERB: Partial<Record<NoteKind, string>> = { action: "added", decision: "recorded", question: "asked", context: "added context:" };
  const added: Source = rows(
    `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
     WHERE m.room_id = ? AND n.added_actor_json IS NOT NULL AND n.ts < ? ORDER BY n.ts DESC, n.rowid DESC LIMIT ?`,
    (before, n) => [roomId, before, n],
    (r) => r.ts as number,
    (rs) =>
      rs.flatMap((r): ActivityEvent[] => {
        const n = toNote(r);
        const who = whos.of(n.addedActor);
        if (!who || !ADDED_VERB[n.kind]) return [];
        const more = addedDetail.get(n.id) as Row | undefined;
        const links = more ? (JSON.parse(more.links_json as string) as string[]) : [];
        return [{ id: `n:${n.id}`, ts: n.ts, who, kind: "added", verb: ADDED_VERB[n.kind]!, target: noteTarget(n), detail: (more?.text as string) || undefined, links: links.length ? links : undefined, model: n.addedActor?.model }];
      }),
  );

  // What an agent closed without a report: a question answered or dropped, a to-do dropped or ticked.
  const closed: Source = rows(
    `SELECT n.* FROM notes n JOIN meetings m ON m.id = n.meeting_id
     WHERE m.room_id = ? AND n.done_at IS NOT NULL AND n.done_at < ? AND n.done_actor_json IS NOT NULL AND n.kind IN ('action', 'question')
     AND NOT EXISTS (SELECT 1 FROM updates u WHERE u.note_id = n.id AND u.status = 'done' AND ABS(u.ts - n.done_at) < 5000)
     ORDER BY n.done_at DESC LIMIT ?`,
    (before, n) => [roomId, before, n],
    (r) => r.done_at as number,
    (rs) =>
      rs.flatMap((r): ActivityEvent[] => {
        const n = toNote(r);
        const who = n.doneActor?.kind === "agent" ? whos.of(n.doneActor) : null;
        if (!who) return [];
        const dropped = n.state === "dropped";
        const [kind, verb]: [ActivityKind, string] = dropped ? ["dropped", "dropped"] : n.kind === "question" ? ["answered_question", "answered"] : ["done", "completed"];
        return [{ id: `d:${n.id}`, ts: n.doneAt!, who, kind, verb, target: noteTarget(n), detail: dropped ? (n.dropReason ?? undefined) : undefined, model: n.doneActor?.model }];
      }),
  );

  // What Stand caught in a call or in the chat: one row for each, however many it caught.
  const caughtNotes = raw.prepare(
    "SELECT id, kind, text FROM notes WHERE meeting_id = ? AND added_actor_json IS NULL AND edited_by IS NULL AND kind IN ('action', 'decision', 'question') ORDER BY ts, rowid",
  );
  const CAUGHT: Array<[NoteKind, string]> = [["action", "to-do"], ["decision", "decision"], ["question", "question"]];
  const caught: Source = rows(
    `SELECT n.meeting_id, MAX(n.ts) AS ts FROM notes n JOIN meetings m ON m.id = n.meeting_id
     WHERE m.room_id = ? AND (m.kind IS NULL OR m.kind = 'chat') AND n.added_actor_json IS NULL AND n.edited_by IS NULL
     AND n.kind IN ('action', 'decision', 'question')
     GROUP BY n.meeting_id HAVING MAX(n.ts) < ? ORDER BY ts DESC LIMIT ?`,
    (before, n) => [roomId, before, n],
    (r) => r.ts as number,
    (rs) =>
      rs.map((r): ActivityEvent => {
        const meetingId = r.meeting_id as string;
        const notes = (caughtNotes.all(meetingId) as Row[]).map((x) => ({ id: x.id as string, kind: x.kind as NoteKind, text: x.text as string }));
        const counts = CAUGHT.map(([k, word]) => [notes.filter((x) => x.kind === k).length, word] as const).filter(([c]) => c > 0);
        const what = counts.length === 1 ? plural(counts[0][0], counts[0][1]) : plural(notes.length, "item");
        return {
          id: `c:${meetingId}`,
          ts: r.ts as number,
          who: whos.of({ kind: "stand", person: null })!,
          kind: "caught",
          verb: `caught ${what} in`,
          target: meetingTarget(meetingId),
          detail: counts.length > 1 ? `${list(counts.map(([c, word]) => plural(c, word)))}.` : undefined,
          items: notes.map(noteTarget),
        };
      }),
  );

  const slides: Source = rows(
    `SELECT s.id, s.title, s.name, s.body, s.added_by, s.created_at, s.note_id, r.id AS review_id FROM review_slides s JOIN reviews r ON r.id = s.review_id
     WHERE r.room_id = ? AND r.kind = 'product' AND s.added_by LIKE '% via %' AND s.created_at < ? ORDER BY s.created_at DESC LIMIT ?`,
    (before, n) => [roomId, before, n],
    (r) => r.created_at as number,
    (rs) =>
      rs.flatMap((r): ActivityEvent[] => {
        const who = whos.of(parseActor(r.added_by as string));
        if (!who) return [];
        const target = { text: clip(((r.name as string) ?? "") || (r.title as string), 120), href: `/s/${roomId}/review/${r.review_id as string}` };
        return [{ id: `s:${r.id as string}`, ts: r.created_at as number, who, kind: "slide", verb: "added a product review slide:", target, detail: clip((r.body as string) ?? "", 600) || undefined }];
      }),
  );

  const LOGGED: Record<string, { kind: ActivityKind; verb: (e: AgentEventBody) => string }> = {
    renamed: { kind: "renamed", verb: (e) => (e.items && e.items.length > 1 ? `named ${plural(e.items.length, "meeting")}` : "named a meeting") },
    design: { kind: "design", verb: (e) => (e.detail?.startsWith("Added context") ? "added context to the design session on" : "set up a design session on") },
    idea_review: { kind: "idea_review", verb: () => "set up an idea review of" },
    project: { kind: "project", verb: () => "made the project" },
    project_edit: {
      kind: "project",
      verb: (e) => ({ renamed: "renamed the project", goal: "set the goal of", archived: "archived the project", restored: "brought back the project" })[e.change ?? "renamed"],
    },
    doc: { kind: "doc", verb: (e) => (e.detail === "saved again" ? "rewrote the doc" : "saved the doc") },
  };
  const logged: Source = rows(
    "SELECT * FROM agent_events WHERE room_id = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?",
    (before, n) => [roomId, before, n],
    (r) => r.ts as number,
    (rs) =>
      rs.flatMap((r): ActivityEvent[] => {
        const actor = JSON.parse(r.actor_json as string) as Actor;
        const shape = LOGGED[r.kind as string];
        const who = whos.of(actor);
        if (!who || !shape) return [];
        const e = JSON.parse(r.event_json as string) as AgentEventBody;
        return [{ id: `e:${r.id as string}`, ts: r.ts as number, who, kind: shape.kind, verb: shape.verb(e), target: e.target, detail: e.detail, items: e.items && e.items.length > 1 ? e.items : undefined, model: actor.model }];
      }),
  );

  // A call's agent keeps its cards with the meeting: answers to what people asked, and options on a question.
  const cards: Source = (before, n) => {
    const got = raw.prepare("SELECT id, started_at, agent_json FROM meetings WHERE room_id = ? AND agent_json IS NOT NULL AND started_at < ? ORDER BY started_at DESC LIMIT ?").all(roomId, before, n) as Row[];
    const events = got.flatMap((m) =>
      (JSON.parse(m.agent_json as string) as AgentCard[]).flatMap((c): ActivityEvent[] => {
        const ts = c.readyAt ?? c.at;
        if (c.status !== "ready" || ts >= before) return [];
        const who = whos.of(c.agent ?? { kind: "stand", person: null });
        if (!who) return [];
        const answer = c.kind === "answer";
        const asked = clip(answer ? c.question : c.about, 300);
        return [{
          id: `a:${m.id as string}:${c.id}`,
          ts,
          who,
          kind: answer ? "answer" : "options",
          verb: answer ? `answered ${first(c.by)} in` : `offered ${plural(c.options.length, "option")} in`,
          target: meetingTarget(m.id as string),
          detail: [asked && `“${asked}”`, c.note && clip(c.note, 600)].filter(Boolean).join("\n") || undefined,
          links: c.sources?.length ? c.sources.slice(0, 5).map((s) => s.url) : undefined,
          model: c.agent?.model ?? c.model ?? undefined,
        }];
      }),
    );
    // A meeting's cards come after it started, so a meeting read here is read whole.
    return { events, floor: got.length >= n ? (got[got.length - 1].started_at as number) : null };
  };

  const chatAnswers: Source = rows(
    `SELECT s.id, s.text, s.ts, (SELECT q.text FROM chat_messages c JOIN segments q ON q.id = c.reply_to WHERE c.segment_id = s.id) AS asked
     FROM segments s JOIN meetings m ON m.id = s.meeting_id
     WHERE m.room_id = ? AND m.kind = 'chat' AND s.speaker_id = ? AND s.ts < ?
     AND NOT EXISTS (SELECT 1 FROM chat_messages c WHERE c.segment_id = s.id AND c.deleted_at IS NOT NULL)
     ORDER BY s.ts DESC LIMIT ?`,
    (before, n) => [roomId, STAND_AUTHOR, before, n],
    (r) => r.ts as number,
    (rs) =>
      rs.map((r): ActivityEvent => ({
        id: `m:${r.id as string}`,
        ts: r.ts as number,
        who: whos.of({ kind: "stand", person: null })!,
        kind: "answer",
        verb: "answered in",
        target: { text: "the chat" },
        detail: [r.asked && `“${clip(r.asked as string, 300)}”`, clip(r.text as string, 600)].filter(Boolean).join("\n"),
      })),
  );

  // Stand's passes over the space keep only their last result, so each is one row at most.
  const passes: Source = (before) => {
    const events: ActivityEvent[] = [];
    const stand = () => whos.of({ kind: "stand", person: null })!;
    const sweep = db.getQuestionSweep(roomId);
    if (sweep?.rows.length && sweep.at < before) {
      const items = sweep.rows.flatMap((x) => {
        const n = db.getNote(x.id);
        return n ? [noteTarget(n)] : [];
      });
      const waits = currentSweep(db, roomId);
      if (items.length)
        events.push({
          id: `sweep:${sweep.at}`, ts: sweep.at, who: stand(), kind: "sweep",
          verb: `suggested closing ${plural(items.length, "open question")}`, target: null, items,
          flag: waits ? "To confirm" : undefined,
          detail: waits ? `${plural(waits.proposals.length, "suggestion")} still to confirm, from the Projects tab.` : undefined,
        });
    }
    const settled = db.getSettled(roomId);
    if (settled?.rows.length && settled.at < before) {
      const items = settled.rows.flatMap((x) => {
        const n = db.getNote(x.noteId);
        return n ? [noteTarget(n)] : [];
      });
      if (items.length) events.push({ id: `settled:${settled.at}`, ts: settled.at, who: stand(), kind: "settled", verb: `matched ${plural(items.length, "decision or question", "decisions and questions")} to a later decision`, target: null, items });
    }
    return { events, floor: null };
  };

  const sources = [updates, added, closed, caught, slides, logged, cards, chatAnswers, passes];
  const out: ActivityEvent[] = [];
  let cursor = opts.before && opts.before > 0 ? opts.before : Number.MAX_SAFE_INTEGER;
  let next: number | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    const reads = sources.map((s) => s(cursor, limit));
    const floors = reads.map((r) => r.floor).filter((f): f is number => f !== null);
    // Below the highest floor some source has more than it read, so only what is above it is in order.
    const horizon = floors.length ? Math.max(...floors) : null;
    const all = reads.flatMap((r) => r.events).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
    let safe = horizon === null ? all : all.filter((e) => e.ts > horizon);
    let more = horizon !== null;
    let until = horizon === null ? 0 : horizon + 1;
    const room = limit - out.length;
    const wanted = opts.who ? safe.filter((e) => e.who === opts.who) : safe;
    if (wanted.length > room) {
      // Cut after the last one that fits, keeping everything else of that same moment.
      const last = wanted[room - 1].ts;
      safe = safe.filter((e) => e.ts >= last);
      more = true;
      until = last;
    }
    out.push(...(opts.who ? safe.filter((e) => e.who === opts.who) : safe));
    if (!more) {
      next = null;
      break;
    }
    // Every row a source read shared one moment: step past it, or the same rows come back.
    next = until >= cursor ? cursor - 1 : until;
    cursor = next;
    if (out.length >= limit) break;
  }

  return { events: out, agents: spaceAgents(db, roomId, whos), next };
}

/** Everyone the filter can show: each person's agents that reported in the space, the busiest first,
 *  then Stand and GitHub, and whoever else this page named. */
function spaceAgents(db: DB, roomId: string, whos: Whos): ActivityWho[] {
  const page = [...whos.seen.keys()];
  const reported = db.raw
    .prepare("SELECT user_id, user_name, client, MAX(actor_json) AS actor_json, COUNT(*) AS n FROM updates WHERE room_id = ? AND client IS NOT NULL GROUP BY user_id, client ORDER BY n DESC LIMIT 40")
    .all(roomId) as Row[];
  const order: string[] = [];
  for (const r of reported) {
    const actor = r.actor_json ? (JSON.parse(r.actor_json as string) as Actor) : parseActor(`${r.user_name as string} via ${r.client as string}`);
    const key = whos.of(actor?.kind === "agent" && !actor.personId ? { ...actor, personId: r.user_id as string } : actor);
    if (key && !order.includes(key)) order.push(key);
  }
  if (db.raw.prepare("SELECT 1 FROM meetings WHERE room_id = ? AND kind IS NULL LIMIT 1").get(roomId)) whos.of({ kind: "stand", person: null });
  const rank = (k: string) => (k === "stand" ? 1 : k === "github" ? 2 : 0);
  const keys = [...new Set([...order, ...page, ...whos.seen.keys()])];
  return keys.sort((a, b) => rank(a) - rank(b)).map((k) => whos.seen.get(k)!);
}
