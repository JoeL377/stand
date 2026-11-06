// What agents see of Stand, shared by the MCP server (mcp.ts) and the
// "Copy for agent" button: references to single to-dos, decisions, questions
// and topics, the context to act on them, and the two ways to report back.
// Also the notes people save to a space from the Mac's bar, with the snaps
// pinned to them (stand:note/<id>).
// An agent sees exactly the spaces its person is in (spaces are invite only).

import { parseActor, type Actor } from "../shared/actors.ts";
import type { ActionWork, AgentToken, Discussion, Item, ItemUpdate, Jot, Note, TaskState, UpdateStatus, UpNextSuggestion, UpNext, User } from "../shared/protocol.ts";
import { isClosed, stateOf } from "../shared/tasks.ts";
import type { DB } from "./db.ts";
import { ownedBy } from "./spaces.ts";
import { settledView } from "./spaceSettle.ts";
import { CHECK_INSTRUCTIONS, CHECK_LEASE_MS, CHECK_VERSION, SHOW_FROM } from "./decisionCheck.ts";

/** A position as one line, with the person's own words when the meeting-end run kept them. */
const positionLine = (p: Discussion["positions"][number]) => `${p.speaker}: ${p.position}${p.quote ? ` (in their words: "${p.quote.text}")` : ""}`;
import { linkSnaps, type SnapRow } from "./snaps.ts";
import { UPLOAD_LINK_MAX, UPLOAD_LINK_MS, prOf, readyToShip, shotUrl, workingOn, type UploadLinks } from "./workLog.ts";

export type RefKind = "action" | "decision" | "question" | "context" | "topic";
const NOTE_KINDS: Record<string, RefKind> = { action: "action", decision: "decision", question: "question", context: "context" };

export const refOf = (kind: RefKind, id: string) => `stand:${kind}/${id}`;
export const refUrl = (baseUrl: string, kind: RefKind, id: string) => `${baseUrl}/ref/${kind}/${id}`;

/** Reads "stand:action/n8f2k", "action/n8f2k" or a Stand link to one (…/ref/action/n8f2k). */
export function parseRef(input: string): { kind: RefKind; id: string } | null {
  const m = /(?:^|stand:|\/ref\/)(action|decision|question|context|topic)\/([a-z0-9]{4,24})\b/i.exec(input.trim());
  return m ? { kind: m[1].toLowerCase() as RefKind, id: m[2] } : null;
}

/** A note saved from the bar: "stand:note/j8f2k", "note/j8f2k". */
export const noteRef = (id: string) => `stand:note/${id}`;
export function parseNoteRef(input: string): string | null {
  const m = /(?:^|stand:)note\/([a-z0-9]{4,24})\b/i.exec(input.trim());
  return m ? m[1] : null;
}

/** An error the agent should see as-is (not found, not allowed, bad input). */
export class AgentError extends Error {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
/** How far back whats_new looks when it isn't told. */
const WHATS_NEW_DAYS = 7;

export interface Caller {
  user: User;
  /** The token in use; null when a signed-in person asks from the web app. */
  token: AgentToken | null;
  /** The model doing this work, if the agent said. */
  model?: string;
}

export interface AgentDeps {
  /** The meeting running in a space right now, if any. Merging redeploys Stand, which cuts it. */
  liveMeeting?: (roomId: string) => { meeting_id: string; people: string[] } | null;
  db: DB;
  /** Tells people in a live call that something changed on their space. */
  notify: (roomId: string, what: "updates" | "followups") => void;
  /** The meeting brief (stand.meeting-brief/v1) for a meeting. */
  brief: (meetingId: string, baseUrl: string, transcript: boolean) => unknown;
  /** The space's suggested agenda as people see it in the app. */
  suggested: (roomId: string) => { upNext: UpNext };
  /** Hands out the links agents upload screenshots to. */
  uploads: UploadLinks;
  /** A to-do was just reported ready to ship: look at its PR now rather than on the next round. */
  readyToShip?: () => void;
}

type Work = Pick<ActionWork, "working" | "ready">;

const PLAN_MAX = 100_000;

const UPDATE_STATUSES: UpdateStatus[] = ["working", "progress", "blocked", "needs_decision", "ready", "done", "comment"];

export function agentApi(deps: AgentDeps) {
  const { db } = deps;

  const space = (roomId: string, caller: Caller) => {
    const room = db.getRoom(roomId);
    // Spaces are invite only, so a space you're not in reads as not there at all.
    if (!room || !db.isMember(room.id, caller.user.id)) throw new AgentError("Not found, or you're not in that space.");
    return room;
  };

  const itemInfo = (item: Item | null, baseUrl: string) => {
    if (!item) return { id: null, title: "General / off-agenda" };
    const deck = item.deckId ? db.getDeck(item.deckId) : null;
    return {
      id: item.id,
      title: item.title,
      key: item.externalId ?? (item.slideNo ? `Slide ${item.slideNo}` : undefined),
      deck: deck?.title,
      ticket: item.url ?? undefined,
      stand_url: `${baseUrl}/items/${item.id}`,
    };
  };

  const updateInfo = (u: ItemUpdate, baseUrl?: string) => {
    const shots = baseUrl && u.noteId ? db.noteWorkShots([u.noteId]).filter((s) => s.updateId === u.id) : [];
    return {
      by: u.client ? `${u.userName} via ${u.client}` : u.userName,
      actor: u.actor ?? undefined,
      status: u.status,
      text: u.text,
      links: u.links.length ? u.links : undefined,
      screenshots: shots.length ? shots.map((s) => ({ image_url: shotUrl(s, baseUrl), caption: s.caption ?? undefined })) : undefined,
      on: u.noteText ? clip(u.noteText, 120) : undefined,
      at: new Date(u.ts).toISOString(),
    };
  };

  /** Why a decision was made, from what's already kept: the discussion it came out of and the words it was settled in. */
  const whyOf = (n: Note) => {
    const d = n.discussionId ? db.getDiscussion(n.discussionId) : null;
    if (!d && !n.quote) return undefined;
    return {
      topic: d?.topic,
      positions: d?.positions.length ? d.positions.map(positionLine) : undefined,
      in_their_words: n.quote ? `${n.quote.speaker}: "${n.quote.text}"` : undefined,
    };
  };

  /** Whether a decision still stands, for agents. Only a person's confirm replaces one. */
  const decisionInfo = (n?: ReturnType<typeof settledView>["decided"][number]) =>
    n
      ? {
          state: n.decisionState,
          why: whyOf(n),
          replaced_by: n.replacedBy ? { ref: refOf("decision", n.replacedBy.noteId), text: n.replacedBy.text } : undefined,
          may_be_replaced_by: n.mayBeReplacedBy ? { ref: refOf("decision", n.mayBeReplacedBy.noteId), text: n.mayBeReplacedBy.text } : undefined,
        }
      : {};

  /** Who's on each to-do right now and what waits to ship: the same reading as the pills on the Tasks page. */
  const workOn = (notes: Note[]) => {
    const updates = db.notesUpdates(notes.map((n) => n.id));
    return new Map(
      notes.map((n): [string, Work] => {
        const mine = updates.filter((u) => u.noteId === n.id);
        return [n.id, { working: workingOn(mine, !!n.doneAt), ready: readyToShip(mine, !!n.doneAt) }];
      }),
    );
  };
  const workInfo = (work?: Work) => ({
    working: work?.working ? { by: work.working.by, since: new Date(work.working.since).toISOString(), doing: work.working.text } : undefined,
    ready: work?.ready ? { by: work.ready.by, since: new Date(work.ready.since).toISOString(), pr: work.ready.pr ?? undefined } : undefined,
  });

  const actionInfo = (n: Note, work?: Work) => ({
    ref: refOf("action", n.id),
    text: n.text,
    owner: n.owner ?? undefined,
    status: stateOf(n, work),
    ...workInfo(work),
    done_by: n.doneBy ?? undefined,
    done_actor: n.doneActor ?? undefined,
    why_dropped: n.state === "dropped" ? (n.dropReason ?? undefined) : undefined,
  });

  /** "joe via Claude Code", or just the name from the web app. */
  const byOf = (caller: Caller) => (caller.token ? `${caller.user.name} via ${caller.token.label}` : caller.user.name);
  /** The same, as fields: whose agent, which one, through which connection. */
  const actorOf = (caller: Caller): Actor => {
    const person = { person: caller.user.name, personId: caller.user.id };
    return caller.token
      ? { kind: "agent", ...person, agent: caller.token.label, connection: caller.token.id, model: caller.model }
      : { kind: "person", ...person };
  };
  /** "me" is the caller; "unassigned", "none" or nothing leaves it open to anyone. */
  const ownerFor = (caller: Caller, owner: string): string | null => {
    const o = oneLine(owner, 80);
    if (!o || /^(unassigned|none|nobody)$/i.test(o)) return null;
    return /^(me|myself)$/i.test(o) ? caller.user.name : o;
  };

  /** Moves a to-do to a new state and puts the summary (and links) in its log, as people see it in Stand. */
  function applyChange(caller: Caller, roomId: string, note: Note, change: TaskChange) {
    const by = byOf(caller);
    const links = cleanLinks(change.links);
    const pr = links.find((l) => prOf(l));
    const summary = (change.summary ?? "").trim().slice(0, 4000);
    const state = change.status ? TASK_STATES.find((s) => s === change.status) : undefined;
    if (change.status && !state) throw new AgentError(`Status is one of ${TASK_STATES.join(", ")}.`);
    let now = note;
    const moved = !!state && state !== stateOf(note);
    if (state && moved) {
      now =
        db.setTaskState(roomId, note.id, {
          state,
          by,
          actor: actorOf(caller),
          closedBy: state === "done" ? (pr ? `pr:${pr}` : caller.token ? "agent" : "confirmed") : null,
          reason: state === "dropped" ? oneLine(change.reason || summary, 200) || null : null,
        }) ?? note;
    }
    let update: ItemUpdate | null = null;
    if (summary || links.length) {
      update = db.addUpdate({
        roomId,
        itemId: note.itemId,
        noteId: note.id,
        noteText: now.text,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
        actor: actorOf(caller),
        // Only done and doing read as reports on the work; the rest is more about the to-do, and
        // mustn't show it as being worked on (workLog.ts).
        status: stateOf(now) === "done" ? "done" : stateOf(now) === "doing" ? "progress" : change.adding ? "added" : "note",
        text: summary || (stateOf(now) === "done" ? `Done: ${clip(now.text, 200)}` : "Added links"),
        links,
      });
      db.claimWorkShots(note.id, caller.user.id, update.id);
    }
    return { now, update, unchanged: !moved && !update };
  }

  /** Short quotes from the turns a topic covers. */
  const quotes = (d: Discussion | null, max = 8) =>
    d ? db.getSegments(d.segmentIds.slice(-max)).map((s) => ({ speaker: s.speakerName, said: clip(s.text, 280) })) : [];

  /** Decisions, open questions and open to-dos on an item, newest first, capped. */
  const onItem = (itemId: string | null, skip?: string) => {
    if (!itemId) return { decisions: [], open_questions: [], open_todos: [] };
    const notes = db.itemNotes(itemId).filter((n) => n.id !== skip);
    // Questions only count from the latest meeting that talked about the item; older ones were answered or carried.
    const latest = notes[0]?.meetingId;
    const openTodos = notes.filter((n) => n.kind === "action" && !n.doneAt).slice(0, 6);
    const work = workOn(openTodos);
    return {
      decisions: notes
        .filter((n) => n.kind === "decision")
        .slice(0, 6)
        .map((n) => ({ ref: refOf("decision", n.id), text: n.text, on: day(n.meetingStartedAt) })),
      open_questions: notes
        .filter((n) => n.kind === "question" && n.meetingId === latest)
        .slice(0, 5)
        .map((n) => ({ ref: refOf("question", n.id), text: n.text })),
      open_todos: openTodos.map((n) => actionInfo(n, work.get(n.id))),
    };
  };

  /** A snap of the screen as agents see it: the image (fetched with the same token) and what's on it. */
  const snapInfo = (p: SnapRow, notes: Note[], baseUrl: string) => ({
    pinned_to: p.jotId ? noteRef(p.jotId) : undefined,
    image_url: `${baseUrl}/api/snaps/${p.id}.${p.ext}?v=${p.version}`,
    caption: p.caption ?? undefined,
    note: p.line ?? undefined,
    text_on_screen: p.screenText ?? undefined,
    by: p.source === "agent" ? "the Stand agent (kept because it backs a note)" : p.takenBy,
    backs: p.noteId ? notes.find((n) => n.id === p.noteId)?.text : undefined,
    at: new Date(p.ts).toISOString(),
  });

  /** A meeting's snaps that belong with a topic or a note: where the recap put them, else the topic of the remarks around them. */
  function snapsWith(meetingId: string, belongs: (s: { noteId: string | null; discussionId: string | null }) => boolean, baseUrl: string) {
    const rows = db.meetingSnaps(meetingId);
    if (!rows.length) return undefined;
    const linked = new Map(linkSnaps(rows, db.meetingSegments(meetingId), db.meetingDiscussions(meetingId)).map((s) => [s.id, s]));
    const notes = db.meetingNotes(meetingId);
    const mine = rows.filter((p) => belongs({ noteId: p.noteId, discussionId: linked.get(p.id)?.discussionId ?? null }));
    return mine.length ? mine.slice(0, 8).map((p) => snapInfo(p, notes, baseUrl)) : undefined;
  }

  /** One of the caller's spaces by id or (part of its) name. */
  function findSpace(caller: Caller, query: string) {
    const q = query.trim().toLowerCase();
    const spaces = db.spaceRows(caller.user.id).filter((r) => r.id === query || r.name.toLowerCase().includes(q));
    if (!q || spaces.length === 0) throw new AgentError(`You're not in a space matching "${query}". list_spaces shows yours.`);
    if (spaces.length > 1 && !spaces.some((r) => r.name.toLowerCase() === q))
      throw new AgentError(`"${query}" matches ${spaces.map((r) => `${r.name} (${r.id})`).join(", ")}. Give one id.`);
    return space((spaces.find((r) => r.id === query || r.name.toLowerCase() === q) ?? spaces[0]).id, caller);
  }

  /** A note saved from the bar, with the snaps pinned to it. */
  const noteInfo = (j: Jot, baseUrl: string) => {
    const item = j.itemId ? db.getItem(j.itemId) : null;
    const snaps = db.jotSnaps(j.id);
    return {
      ref: noteRef(j.id),
      text: j.text,
      by: j.by,
      at: new Date(j.ts).toISOString(),
      item: item
        ? { id: item.id, title: item.title, filed_by: j.itemSuggested ? "the Stand agent (not confirmed yet)" : "a person" }
        : undefined,
      snaps: snaps.length ? snaps.map((p) => ({ ...snapInfo(p, [], baseUrl), pinned_to: undefined })) : undefined,
    };
  };

  /** Finds what a reference points to, checking the caller is in its space. */
  /** What a to-do waits on and what waits on it, with who's on each. A signal only: nothing here stops anyone. */
  const dependenciesOf = (n: Pick<Note, "id"> & { roomId: string }) => {
    const links = db.roomLinks(n.roomId, "depends_on");
    const todos = (ids: string[]) => {
      const notes = ids.map((id) => db.getNote(id)).filter((x) => x !== null);
      const work = workOn(notes);
      return notes.map((x) => ({ ...actionInfo(x, work.get(x.id)), done_by: undefined, done_actor: undefined }));
    };
    const waitsOn = todos(links.filter((l) => l.fromId === n.id).map((l) => l.toId));
    const waitingOnThis = todos(links.filter((l) => l.toId === n.id).map((l) => l.fromId));
    return { waits_on: waitsOn.length ? waitsOn : undefined, waiting_on_this: waitingOnThis.length ? waitingOnThis : undefined };
  };

  /** To-dos as agents see them: the ref, owner and status, plus where they came from and the decision behind them. */
  function workRows(rows: Array<Note & { roomName: string; meetingStartedAt: number; addedByHand?: boolean }>, baseUrl: string) {
    const items = new Map<string, Item | null>();
    const work = workOn(rows);
    const planned = db.plannedNotes(rows.map((n) => n.id));
    const waits = db.linksFrom(rows.map((n) => n.id), "depends_on").filter((l) => {
      const dep = db.getNote(l.toId);
      return dep && !isClosed(stateOf(dep));
    });
    return rows.map((n) => {
      const waitsOn = waits.filter((l) => l.fromId === n.id).map((l) => refOf("action", l.toId));
      if (n.itemId && !items.has(n.itemId)) items.set(n.itemId, db.getItem(n.itemId));
      const item = n.itemId ? items.get(n.itemId)! : null;
      const decision = n.discussionId
        ? db.meetingNotes(n.meetingId).find((x) => x.discussionId === n.discussionId && x.kind === "decision")
        : undefined;
      return {
        ...actionInfo(n, work.get(n.id)),
        has_plan: planned.has(n.id) || undefined,
        waits_on: waitsOn.length ? waitsOn : undefined,
        space: n.roomName as string | undefined,
        item: item ? { id: item.id, title: item.title, key: item.externalId ?? undefined } : undefined,
        decided: decision?.text,
        from_meeting: n.addedByHand ? undefined : day(n.meetingStartedAt),
        added: n.addedByHand ? { by: n.editedBy ?? undefined, actor: n.addedActor ?? parseActor(n.editedBy) ?? undefined, on: day(n.meetingStartedAt) } : undefined,
        url: refUrl(baseUrl, "action", n.id),
      };
    });
  }

  function resolve(caller: Caller, refText: string) {
    const ref = parseRef(refText);
    if (!ref) throw new AgentError(`"${clip(refText, 60)}" isn't a Stand reference. They look like stand:action/k3m9xq2p.`);
    if (ref.kind === "topic") {
      const d = db.getDiscussion(ref.id);
      const m = d && db.getMeeting(d.meetingId);
      if (!d || !m)
        throw new AgentError(
          "That topic no longer exists. It may have been regrouped while the meeting was live; ask for the item's context instead.",
        );
      return { ref, note: null, topic: d, room: space(m.roomId, caller), meeting: m, itemId: d.itemId };
    }
    const n = db.getNote(ref.id);
    if (!n || NOTE_KINDS[n.kind] !== ref.kind) throw new AgentError("That reference doesn't point to anything in Stand.");
    const m = db.getMeeting(n.meetingId)!;
    const topic = n.discussionId ? db.getDiscussion(n.discussionId) : null;
    return { ref, note: n, topic, room: space(n.roomId, caller), meeting: m, itemId: n.itemId };
  }

  return {
    /** One to-do, decision, open question or topic with just enough context to act on it. */
    get(caller: Caller, refText: string, baseUrl: string) {
      const jotId = parseNoteRef(refText);
      if (jotId) {
        const j = db.getJot(jotId);
        if (!j) throw new AgentError("That note doesn't exist any more.");
        const room = space(j.roomId, caller);
        return {
          kind: "note",
          ...noteInfo(j, baseUrl),
          space: { id: room.id, name: room.name, purpose: room.purpose || undefined },
          on_this_item: j.itemId ? onItem(j.itemId) : undefined,
          url: `${baseUrl}/s/${room.id}`,
        };
      }
      const r = resolve(caller, refText);
      const item = r.itemId ? db.getItem(r.itemId) : null;
      const where = {
        space: { id: r.room.id, name: r.room.name, purpose: r.room.purpose || undefined },
        item: itemInfo(item, baseUrl),
        meeting: r.meeting.added ? undefined : { id: r.meeting.id, on: day(r.meeting.startedAt), live: r.meeting.endedAt === null || undefined },
        // A to-do someone added by hand (create_action) rather than one a meeting caught.
        added: r.meeting.added
          ? { by: r.note?.editedBy ?? undefined, actor: r.note?.addedActor ?? parseActor(r.note?.editedBy) ?? undefined, on: day(r.meeting.startedAt) }
          : undefined,
      };
      const topic = r.topic
        ? {
            ref: refOf("topic", r.topic.id),
            topic: r.topic.topic,
            outcome: r.topic.outcome,
            positions: r.topic.positions.map(positionLine),
          }
        : undefined;
      if (!r.note) {
        const notes = db.meetingNotes(r.meeting.id).filter((n) => n.discussionId === r.topic!.id);
        return {
          ref: refOf("topic", r.topic!.id),
          kind: "topic",
          topic: r.topic!.topic,
          outcome: r.topic!.outcome,
          positions: topic!.positions,
          came_out_of_it: notes
            .filter((n) => n.kind !== "summary")
            .map((n) => ({ ref: refOf(NOTE_KINDS[n.kind], n.id), kind: n.kind, text: n.text, owner: n.owner ?? undefined })),
          ...where,
          quotes: quotes(r.topic),
          snaps: snapsWith(r.meeting.id, (s) => s.discussionId === r.topic!.id || notes.some((n) => n.id === s.noteId), baseUrl),
          url: refUrl(baseUrl, "topic", r.topic!.id),
        };
      }
      const n = r.note;
      // The decision behind a to-do: from its own topic first, else the item's latest decision.
      const sameTopic = r.topic ? db.meetingNotes(r.meeting.id).filter((x) => x.discussionId === r.topic!.id && x.id !== n.id) : [];
      const updates = n.kind === "action" ? db.noteUpdates(n.id) : [];
      const work = n.kind === "action" ? workOn([n]).get(n.id) : undefined;
      const plan = n.kind === "action" ? db.notePlan(n.id) : null;
      return {
        ref: refOf(r.ref.kind, n.id),
        kind: r.ref.kind,
        text: n.text,
        in_their_words: n.quote ? `${n.quote.speaker}: "${n.quote.text}"` : undefined,
        owner: n.owner ?? undefined,
        status: n.kind === "action" ? stateOf(n, work) : undefined,
        ...workInfo(work),
        plan: plan ? { text: plan.text, by: plan.by, actor: plan.actor, at: new Date(plan.ts).toISOString(), versions: plan.versions } : undefined,
        ...(n.kind === "action" ? dependenciesOf(n) : {}),
        done_by: n.doneBy ?? undefined,
        ...(n.kind === "decision" ? decisionInfo(settledView(db, r.room.id).decided.find((x) => x.id === n.id)) : {}),
        why_dropped: n.kind === "action" && n.state === "dropped" ? (n.dropReason ?? undefined) : undefined,
        ...where,
        topic,
        decided_with_it: sameTopic.filter((x) => x.kind === "decision").map((x) => x.text),
        on_this_item: onItem(r.itemId, n.id),
        quotes: quotes(r.topic),
        // Snaps that back this note, and ones from its topic that don't back another note.
        snaps: snapsWith(
          r.meeting.id,
          (s) => s.noteId === n.id || (!s.noteId && n.discussionId !== null && s.discussionId === n.discussionId),
          baseUrl,
        ),
        updates: updates.length ? updates.map((u) => updateInfo(u, baseUrl)) : undefined,
        url: refUrl(baseUrl, r.ref.kind, n.id),
        next:
          n.kind === "action"
            ? "When you start, call start_work with this ref so people and other agents see you're on it. If you write a plan or spec, attach_plan keeps it on this to-do. If it needs another to-do done first, link_todos says so. If the change shows on screen, attach screenshots before you report: screenshot_upload_url. When the work is in a PR, put this ref in the PR description and call post_update with status ready, a short summary of what changed and the PR link: Stand checks the to-do off when the PR merges. When it's finished with nothing left to ship, call complete_action with the summary. For progress or a blocker, call post_update."
            : undefined,
      };
    },

    /** The short prompt "Copy for agent" puts on the clipboard: makes sense even without the MCP. */
    prompt(caller: Caller, refText: string, baseUrl: string): string {
      const r = resolve(caller, refText);
      const item = r.itemId ? db.getItem(r.itemId) : null;
      const where = [
        r.note?.owner && `owner: ${r.note.owner}`,
        `space: ${r.room.name}`,
        item && `item: ${item.externalId ? `${item.externalId} ` : ""}${item.title}`,
      ]
        .filter(Boolean)
        .join(", ");
      const ref = refOf(r.ref.kind, r.note?.id ?? r.topic!.id);
      const what = { action: "to-do", decision: "decision", question: "open question", context: "line of context", topic: "topic" }[r.ref.kind];
      const text = r.note?.text ?? r.topic!.topic;
      const decided =
        r.note?.kind === "decision"
          ? []
          : (r.topic ? db.meetingNotes(r.meeting.id).filter((x) => x.discussionId === r.topic!.id) : [])
              .filter((x) => x.kind === "decision")
              .slice(0, 2);
      const fallback = decided.length
        ? []
        : r.itemId
          ? db
              .itemNotes(r.itemId)
              .filter((x) => x.kind === "decision" && x.id !== r.note?.id)
              .slice(0, 1)
          : [];
      const lines = [
        `${r.ref.kind === "action" ? "Work on" : "Look at"} this Stand ${what}: ${ref}`,
        `"${clip(text, 200)}" (${where})`,
        ...[...decided, ...fallback].map((d) => `Decided: ${clip(d.text, 200)}`),
        r.ref.kind === "action"
          ? "Call start_work with the Stand MCP when you start: it marks the to-do as yours and gives you the full context. Do the work, attach screenshots of anything that shows on screen (screenshot_upload_url), then report back: if it's a PR, put the ref in its description and post_update with status ready and the PR link (Stand checks it off when the PR merges), else complete_action with a summary of what changed."
          : r.ref.kind === "question"
            ? "Pull the full context with the Stand MCP (get), dig into it, then report what you found with post_update (status needs_decision if people must decide)."
            : "Pull the full context with the Stand MCP (get) before acting on it.",
      ];
      return lines.join("\n");
    },

    /** Where a reference lives, for the web app's /ref/... links. */
    locate(caller: Caller, kind: string, id: string) {
      const r = resolve(caller, `stand:${kind}/${id}`);
      return { meetingId: r.meeting.id, roomId: r.room.id, itemId: r.itemId, added: r.meeting.added || undefined };
    },

    listActions(caller: Caller, opts: { space: string; status?: "open" | "done" | "all"; owner?: string }, baseUrl: string) {
      const status = opts.status ?? "open";
      const room = findSpace(caller, opts.space);
      const who = opts.owner?.trim().toLowerCase();
      const rows = db
        .memberActions(caller.user.id)
        .filter((n) => n.roomId === room.id)
        .filter((n) => (status === "all" ? true : status === "done" ? !!n.doneAt : !n.doneAt))
        .filter((n) => {
          if (!who) return true;
          if (who === "unassigned" || who === "none") return !n.owner;
          if (!n.owner) return false;
          const o = n.owner.trim().toLowerCase();
          return o === who || o.split(/\s+/)[0] === who || who.split(/\s+/)[0] === o;
        });
      return {
        space: { id: room.id, name: room.name },
        status,
        owner: opts.owner || undefined,
        count: rows.length,
        actions: workRows(rows.slice(0, 100), baseUrl).map((w) => ({ ...w, space: undefined })),
        note: rows.length > 100 ? "Showing the newest 100. Filter by status or owner to see the rest." : undefined,
      };
    },

    /** The next agenda the agent drafted for a space, ranked, each with why. */
    suggestedAgenda(caller: Caller, spaceQuery: string, baseUrl: string) {
      const room = findSpace(caller, spaceQuery);
      const { upNext } = deps.suggested(room.id);
      const refFor = (key: string) => {
        const [kind, id] = key.split(":");
        if (kind === "jot") return noteRef(id);
        const note = kind === "note" ? db.getNote(id) : null;
        return note && (note.kind === "action" || note.kind === "question") ? refOf(note.kind, note.id) : undefined;
      };
      const row = (s: UpNextSuggestion) => {
        const item = s.itemId ? db.getItem(s.itemId) : null;
        return {
          kind: s.kind,
          title: s.title,
          why: s.reason,
          ref: refFor(s.key),
          owner: s.owner ?? undefined,
          item: item ? { id: item.id, title: item.title, stand_url: `${baseUrl}/items/${item.id}` } : undefined,
          carried_meetings: s.carried || undefined,
          also_covers: s.merged.length ? s.merged.map(refFor).filter(Boolean) : undefined,
        };
      };
      return {
        schema: "stand.suggested-agenda/v1",
        space: { id: room.id, name: room.name },
        suggested: upNext.suggestions.map(row),
        parked: upNext.parked.map(row),
        progress: upNext.since ? { closed: upNext.closed, of: upNext.total, since: new Date(upNext.since).toISOString() } : undefined,
        drafted_by: upNext.polishedAt ? "the Stand agent, tidied by Claude" : "the Stand agent (plain ranking)",
        note: "Nothing here is on the agenda until the meeting host adds it. To push something up, post_update with status blocked or needs_decision.",
      };
    },

    /** Notes saved to a space from the bar, newest first, with their snaps; and snaps saved on their own. */
    listNotes(caller: Caller, opts: { space: string; itemId?: string; since?: string; limit?: number }, baseUrl: string) {
      const room = findSpace(caller, opts.space);
      let since = 0;
      if (opts.since) {
        since = Date.parse(opts.since);
        if (Number.isNaN(since)) throw new AgentError(`"${clip(opts.since, 40)}" isn't a date. Use one like 2026-10-11 or 2026-10-11T08:00:00Z.`);
      }
      if (opts.itemId && db.getItem(opts.itemId)?.roomId !== room.id) throw new AgentError("That item isn't in this space. list_spaces shows each space's items.");
      const limit = Math.max(1, Math.min(100, Math.round(opts.limit ?? 30)));
      const onItemOnly = <T extends { itemId: string | null }>(rows: T[]) => (opts.itemId ? rows.filter((r) => r.itemId === opts.itemId) : rows);
      const notes = onItemOnly(db.spaceJots(room.id, since, 500)).slice(0, limit);
      const alone = onItemOnly(db.spaceSnaps(room.id, since, 500)).slice(0, limit);
      return {
        space: { id: room.id, name: room.name },
        since: opts.since ? new Date(since).toISOString() : undefined,
        notes: notes.map((j) => noteInfo(j, baseUrl)),
        snaps_on_their_own: alone.length
          ? alone.map((p) => {
              const item = p.itemId ? db.getItem(p.itemId) : null;
              return { ...snapInfo(p, [], baseUrl), item: item ? { id: item.id, title: item.title } : undefined };
            })
          : undefined,
        note: notes.length || alone.length ? undefined : "Nothing saved here yet. People save notes and snaps from the Stand bar in the Mac app.",
      };
    },

    listSpaces(caller: Caller) {
      return db.spaceRows(caller.user.id).map((row) => ({
        id: row.id,
        name: row.name,
        purpose: row.purpose || undefined,
        open_todos: row.notes.filter((n) => n.kind === "action" && !n.done).length,
        yours: row.notes.filter((n) => n.kind === "action" && !n.done && ownedBy(n.owner, caller.user.name)).length,
        items: db
          .listItems(row.id)
          .filter((i) => i.source !== "slide")
          .slice(0, 25)
          .map((i) => ({ id: i.id, title: i.externalId ? `${i.externalId} ${i.title}` : i.title })),
        latest_meeting_id: db.latestMeeting(row.id) ?? undefined,
        live: deps.liveMeeting?.(row.id) ?? null,
      }));
    },

    listMyWork(caller: Caller, opts: { space?: string; status?: "open" | "done" | "all"; includeUnassigned?: boolean }, baseUrl: string) {
      const status = opts.status ?? "open";
      const q = opts.space?.trim().toLowerCase();
      const all = db
        .memberActions(caller.user.id)
        .filter((n) => !q || n.roomId === opts.space || n.roomName.toLowerCase().includes(q))
        .filter((n) => (status === "all" ? true : status === "done" ? !!n.doneAt : !n.doneAt));
      const mine = all.filter((n) => ownedBy(n.owner, caller.user.name) || (opts.includeUnassigned && !n.owner));
      const work = workRows(mine.slice(0, 50), baseUrl);
      return {
        you: caller.user.name,
        count: mine.length,
        work,
        note: work.length
          ? undefined
          : `No ${status === "all" ? "" : `${status} `}to-dos owned by ${caller.user.name}. Owners are matched by name ("${caller.user.name.split(/\s+/)[0]}" or "${caller.user.name}"). Try include_unassigned, or list_spaces and get_meeting_brief.`,
      };
    },

    itemContext(caller: Caller, itemId: string, baseUrl: string) {
      const item = db.getItem(itemId);
      if (!item) throw new AgentError("No item with that id. list_spaces shows each space's items.");
      const room = space(item.roomId, caller);
      const notes = db.itemNotes(item.id);
      const topics = db.itemDiscussions(item.id).slice(0, 5);
      return {
        item: { ...itemInfo(item, baseUrl), description: item.description ? clip(item.description, 800) : undefined },
        space: { id: room.id, name: room.name, purpose: room.purpose || undefined },
        ...onItem(item.id),
        recently_done: notes
          .filter((n) => n.kind === "action" && n.doneAt)
          .slice(0, 5)
          .map((n) => actionInfo(n)),
        topics: topics.map((d) => ({
          ref: refOf("topic", d.id),
          topic: d.topic,
          outcome: d.outcome,
          on: day(d.meetingStartedAt),
          positions: d.positions.map(positionLine),
        })),
        updates: db.itemUpdates(item.id, 10).map((u) => updateInfo(u, baseUrl)),
        saved_notes: (() => {
          const saved = db.itemJots(item.id, 8);
          return saved.length ? saved.map((j) => noteInfo(j, baseUrl)) : undefined;
        })(),
        // Snaps pinned to a note show with it, above.
        snaps: db
          .itemSnaps(item.id, 20)
          .filter((p) => !p.jotId)
          .slice(0, 8)
          .map((p) => snapInfo(p, notes, baseUrl)),
        meetings: [...new Set(notes.map((n) => n.meetingId))].length,
      };
    },

    meetingBrief(caller: Caller, opts: { meetingId?: string; spaceId?: string; transcript?: boolean; carriedOver?: boolean }, baseUrl: string) {
      let meetingId = opts.meetingId;
      if (!meetingId) {
        if (!opts.spaceId) throw new AgentError("Give a meeting_id, or a space_id for its latest meeting.");
        space(opts.spaceId, caller);
        meetingId = db.latestMeeting(opts.spaceId) ?? undefined;
        if (!meetingId) throw new AgentError("That space hasn't had a meeting yet.");
      }
      const m = db.getMeeting(meetingId);
      if (!m) throw new AgentError("No meeting with that id.");
      space(m.roomId, caller);
      const brief = deps.brief(m.id, baseUrl, !!opts.transcript) as { carriedOver?: unknown[] };
      // Every open to-do from earlier meetings: more than the rest of a brief put together, and list_actions has them.
      if (opts.carriedOver || !brief.carriedOver) return brief;
      const { carriedOver, ...rest } = brief;
      return { ...rest, carried_over_count: carriedOver.length };
    },

    postUpdate(caller: Caller, args: { itemId?: string; ref?: string; text?: string; status?: string; links?: string[] }, baseUrl = "") {
      requireWrite(caller);
      const status = (UPDATE_STATUSES.find((s) => s === args.status && s !== "done") ?? "progress") as UpdateStatus;
      if (status === "working" && !(args.ref && parseRef(args.ref)?.kind === "action"))
        throw new AgentError("Working is for a to-do: give its ref, stand:action/<id>.");
      if (status === "ready" && !(args.ref && parseRef(args.ref)?.kind === "action"))
        throw new AgentError("Ready is for a to-do: give its ref, stand:action/<id>.");
      if (status === "comment" && !(args.ref && ["action", "question"].includes(parseRef(args.ref)?.kind ?? "")))
        throw new AgentError("Give the to-do or question ref to post a comment.");
      const text = (args.text ?? "").trim().slice(0, 4000) || (status === "working" ? "Started on it" : "");
      if (!text) throw new AgentError("An update needs some text.");
      let roomId: string;
      let itemId: string | null = null;
      let note: Note | null = null;
      if (args.ref) {
        const r = resolve(caller, args.ref);
        roomId = r.room.id;
        itemId = r.itemId;
        note = r.note;
      } else if (args.itemId) {
        const item = db.getItem(args.itemId);
        if (!item) throw new AgentError("No item with that id.");
        roomId = space(item.roomId, caller).id;
        itemId = item.id;
      } else throw new AgentError("Say what the update is about: an item_id or a ref.");
      const update = db.addUpdate({
        roomId,
        itemId,
        noteId: note?.id ?? null,
        noteText: note?.text ?? null,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
        actor: actorOf(caller),
        status,
        text,
        links: cleanLinks(args.links),
      });
      if (note && status !== "comment") db.claimWorkShots(note.id, caller.user.id, update.id);
      deps.notify(roomId, "updates");
      const pr = update.links.find((l) => prOf(l));
      if (status === "ready" && pr) deps.readyToShip?.();
      return {
        posted: updateInfo(update, baseUrl),
        shows_on: note?.kind === "action" ? "the to-do in Stand, in its log" : itemId ? "the item in Stand, under Since last time" : "the space in Stand",
        working:
          note?.kind === "action" && (status === "working" || status === "progress")
            ? "The to-do shows as being worked on until you complete it, post ready, blocked or needs_decision, or go 30 minutes without an update."
            : undefined,
        ships:
          status === "ready"
            ? pr
              ? `The to-do shows as ready to ship. Stand checks it off by itself when ${pr} merges, with your text as the summary; no need to come back to it.`
              : "The to-do shows as ready to ship, but with no GitHub PR link Stand can't tell when it ships: call complete_action when it does, or post ready again with the PR link."
            : undefined,
      };
    },

    /** Starting on a to-do, in one call: says you're on it and gives back all you need, with anything
     *  worth knowing first. Nothing here stops anyone; a heads-up is for the agent and its person to weigh. */
    startWork(caller: Caller, args: { ref: string; note?: string }, baseUrl = "") {
      requireWrite(caller);
      const ref = args.ref.includes("/") ? args.ref : `stand:action/${args.ref}`;
      const r = resolve(caller, ref);
      if (!r.note || r.note.kind !== "action") throw new AgentError("start_work takes a to-do (stand:action/...). For anything else, use get.");
      const n = r.note;
      const work = workOn([n]).get(n.id);
      const closed = isClosed(stateOf(n));
      const dependencies = dependenciesOf(n);
      const who = (d: NonNullable<typeof dependencies.waits_on>[number]) => d.working?.by ?? d.owner ?? "nobody yet";
      const open = (list?: typeof dependencies.waits_on) => (list ?? []).filter((d) => d.status !== "done" && d.status !== "dropped");
      const headsUp = [
        closed ? `This to-do is already ${stateOf(n)}, so it wasn't marked as started.` : undefined,
        work?.working && work.working.by !== byOf(caller)
          ? `${work.working.by} is already on this, since ${new Date(work.working.since).toISOString()}. Their last word: ${clip(work.working.text, 200)}`
          : undefined,
        work?.ready ? `${work.ready.by} reported this ready to ship${work.ready.pr ? `: ${work.ready.pr}` : ""}.` : undefined,
        ...open(dependencies.waits_on).map((d) => `This waits on "${clip(d.text, 120)}" (${d.status}, ${who(d)}): ${d.ref}`),
        ...open(dependencies.waiting_on_this).map((d) => `"${clip(d.text, 120)}" waits on this (${d.status}, ${who(d)}): ${d.ref}`),
      ].filter((line) => line !== undefined);
      if (!closed) this.postUpdate(caller, { ref, status: "working", text: args.note }, baseUrl);
      const others = db.memberActions(caller.user.id).filter((x) => x.roomId === r.room.id && x.id !== n.id && !isClosed(stateOf(x)));
      const othersWork = workOn(others);
      return {
        started: !closed,
        heads_up: headsUp.length ? headsUp : undefined,
        ...(this.get(caller, ref, baseUrl) as object),
        also_being_worked_on: others
          .filter((x) => othersWork.get(x.id)?.working)
          .map((x) => ({ ref: refOf("action", x.id), text: clip(x.text, 160), by: othersWork.get(x.id)!.working!.by, doing: clip(othersWork.get(x.id)!.working!.text, 160) })),
        next: "Do the work. attach_plan if you write a plan or spec, link_todos if it needs another to-do done first. When it's in a PR, put this ref in the description and post_update with status ready and the PR link: Stand checks it off when the PR merges. With nothing to ship, complete_action with a summary.",
      };
    },

    /** Keeps a plan or spec on a to-do, as a new version. It says nothing about who's on it. */
    attachPlan(caller: Caller, args: { ref: string; plan: string }, baseUrl = "") {
      requireWrite(caller);
      const r = resolve(caller, args.ref.includes("/") ? args.ref : `stand:action/${args.ref}`);
      if (!r.note || r.note.kind !== "action") throw new AgentError("Plans go on to-dos (stand:action/...).");
      const plan = args.plan.trim();
      if (!plan) throw new AgentError("The plan is empty.");
      if (plan.length > PLAN_MAX) throw new AgentError(`That plan is ${plan.length} characters. Stand keeps up to ${PLAN_MAX}.`);
      const actor = actorOf(caller);
      db.addPlan(r.room.id, r.note.id, plan, byOf(caller), actor);
      const update = db.addUpdate({
        roomId: r.room.id,
        itemId: r.itemId,
        noteId: r.note.id,
        noteText: r.note.text,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
        actor,
        status: "plan",
        text: clip(plan.replace(/^[#\s]+/, "").split("\n")[0], 160),
        links: [],
      });
      deps.notify(r.room.id, "updates");
      return { attached: updateInfo(update, baseUrl), versions: db.notePlan(r.note.id)?.versions, shows_on: "the to-do in Stand, and in get" };
    },

    /** Says one to-do waits on another, or takes that back. It's a signal: nothing waits because of it. */
    linkTodos(caller: Caller, args: { ref: string; dependsOn: string; remove?: boolean }, baseUrl = "") {
      requireWrite(caller);
      const todo = (ref: string) => {
        const r = resolve(caller, ref.includes("/") ? ref : `stand:action/${ref}`);
        if (!r.note || r.note.kind !== "action") throw new AgentError("Only to-dos (stand:action/...) can depend on each other.");
        return { note: r.note, room: r.room, itemId: r.itemId };
      };
      const from = todo(args.ref);
      const to = todo(args.dependsOn);
      if (from.note.id === to.note.id) throw new AgentError("A to-do can't depend on itself.");
      if (from.room.id !== to.room.id) throw new AgentError("Those to-dos are in different spaces. Dependencies stay inside one space.");
      if (args.remove) {
        if (!db.removeLink(from.note.id, to.note.id, "depends_on")) return { unchanged: true, ...dependenciesOf(from.note) };
      } else {
        const links = db.roomLinks(from.room.id, "depends_on");
        if (links.some((l) => l.fromId === from.note.id && l.toId === to.note.id)) return { unchanged: true, ...dependenciesOf(from.note) };
        // Following what the other one waits on must not lead back here.
        const seen = new Set<string>();
        const walk = [to.note.id];
        while (walk.length) {
          const id = walk.pop()!;
          if (id === from.note.id) throw new AgentError("That would make the two to-dos wait on each other.");
          if (seen.has(id)) continue;
          seen.add(id);
          walk.push(...links.filter((l) => l.fromId === id).map((l) => l.toId));
        }
        db.addLink(from.room.id, from.note.id, to.note.id, "depends_on", byOf(caller), actorOf(caller));
      }
      const update = db.addUpdate({
        roomId: from.room.id,
        itemId: from.itemId,
        noteId: from.note.id,
        noteText: from.note.text,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
        actor: actorOf(caller),
        status: "linked",
        text: `${args.remove ? "No longer waits on" : "Waits on"}: ${clip(to.note.text, 160)}`,
        links: [],
      });
      deps.notify(from.room.id, "updates");
      return { linked: updateInfo(update, baseUrl), ...dependenciesOf(from.note) };
    },

    completeAction(caller: Caller, args: { ref: string; note?: string; links?: string[] }, baseUrl = "") {
      requireWrite(caller);
      const r = resolve(caller, args.ref.includes("/") ? args.ref : `stand:action/${args.ref}`);
      if (!r.note || r.note.kind !== "action") throw new AgentError("Only to-dos (stand:action/...) can be completed.");
      const by = caller.token ? `${caller.user.name} via ${caller.token.label}` : caller.user.name;
      const already = !!r.note.doneAt;
      const pr = cleanLinks(args.links).find((l) => prOf(l));
      const done = already ? r.note : db.setActionDone(r.room.id, r.note.id, by, pr ? `pr:${pr}` : "agent", actorOf(caller));
      if (!done) throw new AgentError("Couldn't check that to-do off.");
      const update = db.addUpdate({
        roomId: r.room.id,
        itemId: r.itemId,
        noteId: r.note.id,
        noteText: r.note.text,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
        actor: actorOf(caller),
        status: "done",
        text: args.note?.trim().slice(0, 4000) || `Done: ${clip(r.note.text, 200)}`,
        links: cleanLinks(args.links),
      });
      db.claimWorkShots(r.note.id, caller.user.id, update.id);
      deps.notify(r.room.id, "followups");
      return {
        ref: refOf("action", r.note.id),
        status: "done",
        was_already_done: already || undefined,
        done_by: done.doneBy,
        update: updateInfo(update, baseUrl),
      };
    },

    /** A to-do nobody said in a meeting: added to a space by hand, with its state and a summary if given. */
    createAction(caller: Caller, args: TaskChange & { space: string; text: string; itemId?: string }, baseUrl = "") {
      requireWrite(caller);
      const room = findSpace(caller, args.space);
      const text = oneLine(args.text, 500);
      if (!text) throw new AgentError("A to-do needs its text: what needs doing, in a line.");
      let itemId: string | null = null;
      if (args.itemId) {
        const item = db.getItem(args.itemId);
        if (!item || item.roomId !== room.id) throw new AgentError("That item isn't in this space. list_spaces shows each space's items.");
        itemId = item.id;
      }
      const note = db.addTask(room.id, { text, owner: ownerFor(caller, args.owner ?? "me"), itemId }, byOf(caller));
      db.setAddedActor(note.id, actorOf(caller));
      const { now, update } = applyChange(caller, room.id, note, { ...args, adding: true });
      deps.notify(room.id, "followups");
      return {
        created: { ...actionInfo(now), space: room.name, item: itemId ? db.getItem(itemId)?.title : undefined, url: refUrl(baseUrl, "action", now.id) },
        log: update ? updateInfo(update, baseUrl) : undefined,
        shows_on: `The space's Tasks tab in Stand, and the next meeting's check-in while it's open.`,
      };
    },

    /** Hands an agent the newest decision nobody has checked yet, with what it should be checked against. */
    nextCheck(caller: Caller, spaceQuery: string) {
      requireWrite(caller);
      const room = findSpace(caller, spaceQuery);
      const { decided } = settledView(db, room.id);
      const standing = decided
        .filter((n) => n.decisionState === "kept")
        .sort((a, b) => a.meetingStartedAt - b.meetingStartedAt || a.ts - b.ts);
      const taken = db.takenChecks(room.id);
      const waiting = standing.slice(1).filter((n) => !taken.has(n.id));
      const next = waiting.at(-1);
      if (!next) return { waiting: 0 };
      db.claimCheck(room.id, next.id, CHECK_VERSION, Date.now() + CHECK_LEASE_MS, actorOf(caller));
      const shown = (n: (typeof standing)[number]) => ({ ref: refOf("decision", n.id), on: day(n.meetingStartedAt), text: n.text, why: whyOf(n) });
      return {
        waiting: waiting.length,
        version: CHECK_VERSION,
        instructions: CHECK_INSTRUCTIONS,
        new_decision: shown(next),
        earlier_decisions: standing.slice(0, standing.indexOf(next)).map(shown),
        then: "Judge it yourself and call submit_check with the ref, even if you found nothing.",
      };
    },

    /** Takes back what an agent found. Findings are proposals: nothing changes until a person confirms. */
    submitCheck(
      caller: Caller,
      args: { ref: string; findings: Array<{ ref: string; relation: "replaces" | "duplicate"; confidence: number; why?: string }>; version?: string },
    ) {
      requireWrite(caller);
      const r = resolve(caller, args.ref);
      if (r.note?.kind !== "decision") throw new AgentError("Give the decision you checked: stand:decision/<id>.");
      const checked = r.note;
      const standing = settledView(db, r.room.id).decided;
      const self = standing.find((n) => n.id === checked.id);
      const known = (ref: string) => {
        const id = parseRef(ref)?.id;
        const n = standing.find((x) => x.id === id);
        return n && self && n.id !== self.id && n.meetingStartedAt <= self.meetingStartedAt ? n : null;
      };
      const findings = args.findings.flatMap((f) => {
        const n = known(f.ref);
        const confidence = Math.min(1, Math.max(0, Number(f.confidence) || 0));
        return n ? [{ id: n.id, relation: f.relation, confidence, why: oneLine(f.why ?? "", 300) }] : [];
      });
      // An agent can check a decision without having taken it, so make sure there's a row to finish.
      db.claimCheck(r.room.id, checked.id, CHECK_VERSION, 0, actorOf(caller));
      if (!db.finishCheck(checked.id, actorOf(caller), findings, args.version ?? CHECK_VERSION)) return { ref: args.ref, already_checked: true };
      const shown = findings.filter((f) => f.relation === "replaces" && f.confidence >= SHOW_FROM);
      for (const f of shown) db.addLink(r.room.id, checked.id, f.id, "conflicts", byOf(caller), actorOf(caller));
      if (shown.length) deps.notify(r.room.id, "followups");
      return { ref: args.ref, kept: findings.length, dropped: args.findings.length - findings.length, shown_as_proposals: shown.length };
    },

    /** Says a later decision replaced an earlier one, or that both stand. Anyone in the space can. */
    confirmReplaced(caller: Caller, args: { ref: string; by: string; replaced: boolean }) {
      requireWrite(caller);
      const old = resolve(caller, args.ref);
      const later = resolve(caller, args.by);
      if (old.note?.kind !== "decision" || later.note?.kind !== "decision" || old.room.id !== later.room.id)
        throw new AgentError("Give two decisions from the same space: stand:decision/<id>.");
      if (old.note.id === later.note.id) throw new AgentError("A decision can't replace itself.");
      db.addLink(old.room.id, later.note.id, old.note.id, args.replaced ? "replaces" : "not_replaced", byOf(caller), actorOf(caller));
      deps.notify(old.room.id, "followups");
      return { ...decisionInfo(settledView(db, old.room.id).decided.find((n) => n.id === old.note!.id)), ref: refOf("decision", old.note.id) };
    },

    /** Keeps a line of context: what's true in the space that nobody had to choose. */
    addContext(caller: Caller, args: { space: string; text: string; replaces?: string }, baseUrl = "") {
      requireWrite(caller);
      const room = findSpace(caller, args.space);
      const text = oneLine(args.text, 1000);
      if (!text) throw new AgentError("Context needs its text: what's true, in a line.");
      const old = args.replaces ? resolve(caller, args.replaces) : null;
      if (old && (old.note?.kind !== "context" || old.room.id !== room.id))
        throw new AgentError("replaces takes a line of context from the same space: stand:context/<id>.");
      const by = byOf(caller);
      const note = db.addOutsideMeeting(room.id, { kind: "context", text, owner: null, itemId: null }, by);
      db.setAddedActor(note.id, actorOf(caller));
      if (old?.note) db.addLink(room.id, note.id, old.note.id, "replaces", by, actorOf(caller));
      deps.notify(room.id, "followups");
      return {
        created: { ref: refOf("context", note.id), text: note.text, by, url: refUrl(baseUrl, "context", note.id) },
        replaced: old?.note ? { ref: refOf("context", old.note.id), text: old.note.text } : undefined,
        shows_on: "The space's Decisions tab in Stand.",
      };
    },

    /** What changed in a space since a date, in one call. */
    whatsNew(caller: Caller, opts: { space: string; since?: string; allUpdates?: boolean }, baseUrl = "") {
      const room = findSpace(caller, opts.space);
      const since = opts.since ? Date.parse(opts.since) : Date.now() - WHATS_NEW_DAYS * 86_400_000;
      if (Number.isNaN(since)) throw new AgentError(`"${clip(opts.since ?? "", 40)}" isn't a date. Use one like 2026-10-11 or 2026-10-11T08:00.`);
      const recent = (kind: "decision" | "question" | "context") => db.spaceNotes(room.id, kind, 200).filter((n) => n.ts >= since);
      const standing = new Map(settledView(db, room.id).decided.map((n) => [n.id, n]));
      const line = (kind: RefKind) => (n: Note) => ({
        ...decisionInfo(standing.get(n.id)), ref: refOf(kind, n.id), text: n.text, on: day(n.ts), url: refUrl(baseUrl, kind, n.id) });
      const actions = db.memberActions(caller.user.id).filter((n) => n.roomId === room.id);
      const open = actions.filter((n) => !isClosed(stateOf(n)));
      const work = workOn(open);
      const closed = actions.filter((n) => (n.doneAt ?? 0) >= since);
      const closedIds = new Set(closed.map((n) => n.id));
      const reports = db.roomUpdates(room.id, since, 300);
      // Newest first, so the first report on a to-do is its latest word.
      const latest = new Map<string, { update: ItemUpdate; reports: number }>();
      for (const u of reports) {
        const key = u.noteId ?? u.id;
        const seen = latest.get(key);
        if (seen) seen.reports++;
        else latest.set(key, { update: u, reports: 1 });
      }
      const summaryOf = (n: Note) => {
        const u = reports.find((x) => x.noteId === n.id && x.status === "done");
        return u ? clip(u.text, 300) : undefined;
      };
      return {
        space: { id: room.id, name: room.name },
        since: new Date(since).toISOString(),
        meetings: db
          .feedMeetings(room.id)
          .filter((m) => m.startedAt >= since)
          .map((m) => ({
            id: m.id,
            on: day(m.startedAt),
            minutes: Math.round((m.endedAt - m.startedAt) / 60_000),
            summary: m.summary ?? undefined,
            to_dos: m.todos,
            decided: m.decided,
            open: m.open,
          })),
        decided: recent("decision").map(line("decision")),
        open_questions: recent("question")
          .filter((n) => !isClosed(stateOf(n)))
          .map(line("question")),
        context: recent("context").map(line("context")),
        being_worked_on: open
          .filter((n) => stateOf(n, work.get(n.id)) === "doing" || work.get(n.id)?.ready)
          .map((n) => actionInfo(n, work.get(n.id))),
        new_to_dos: open.filter((n) => n.ts >= since).map((n) => actionInfo(n, work.get(n.id))),
        closed_to_dos: closed.map((n) => ({ ...actionInfo(n), done_actor: undefined, closed_by: n.closedBy ?? undefined, summary: summaryOf(n) })),
        updates: opts.allUpdates
          ? reports.slice(0, 50).map((u) => updateInfo(u))
          : [...latest.values()]
              .filter(({ update }) => !update.noteId || !closedIds.has(update.noteId))
              .map(({ update, reports }) => {
                const n = update.noteId ? db.getNote(update.noteId) : null;
                return {
                  ref: n ? refOf(NOTE_KINDS[n.kind], n.id) : undefined,
                  on: update.noteText ? clip(update.noteText, 120) : undefined,
                  by: update.client ? `${update.userName} via ${update.client}` : update.userName,
                  status: update.status,
                  text: clip(update.text, 300),
                  links: update.links.length ? update.links : undefined,
                  at: new Date(update.ts).toISOString(),
                  reports: reports > 1 ? reports : undefined,
                };
              }),
      };
    },

    /** What's true in a space, without what a later line replaced. */
    listContext(caller: Caller, spaceQuery: string, baseUrl = "") {
      const room = findSpace(caller, spaceQuery);
      const rows = db.spaceContext(room.id);
      return {
        space: { id: room.id, name: room.name },
        count: rows.length,
        context: rows.map((n) => ({
          ref: refOf("context", n.id),
          text: n.text,
          by: n.editedBy ?? undefined,
          actor: n.addedActor ?? parseActor(n.editedBy) ?? undefined,
          on: day(n.ts),
          url: refUrl(baseUrl, "context", n.id),
        })),
      };
    },

    /** Changes a to-do: its wording, owner or state, and adds a summary to its log. */
    updateAction(caller: Caller, args: TaskChange & { ref: string; text?: string }, baseUrl = "") {
      requireWrite(caller);
      const r = resolve(caller, args.ref.includes("/") ? args.ref : `stand:action/${args.ref}`);
      if (!r.note || r.note.kind !== "action") throw new AgentError("Only to-dos (stand:action/...) can be updated here. For anything else, post_update.");
      let note: Note = r.note;
      const text = args.text === undefined ? note.text : oneLine(args.text, 500);
      if (!text) throw new AgentError("A to-do can't have empty text. To close it, set status done or dropped.");
      const owner = args.owner === undefined ? note.owner : ownerFor(caller, args.owner);
      if (text !== note.text || owner !== note.owner)
        // Who added a to-do by hand is what its pill shows, so an edit keeps that name.
        note = db.editNote(note.id, { text, owner }, r.meeting.added ? (note.editedBy ?? byOf(caller)) : byOf(caller)) ?? note;
      const { now, update, unchanged } = applyChange(caller, r.room.id, note, args);
      if (unchanged && text === r.note.text && owner === r.note.owner)
        throw new AgentError("Nothing to change: give text, owner, status or a summary.");
      deps.notify(r.room.id, "followups");
      return {
        updated: { ...actionInfo(now), url: refUrl(baseUrl, "action", now.id) },
        log: update ? updateInfo(update, baseUrl) : undefined,
      };
    },

    /** A link the agent uploads screenshots to (with curl); they join its next report on the to-do. */
    screenshotUploadUrl(caller: Caller, args: { ref: string }, baseUrl: string) {
      requireWrite(caller);
      const r = resolve(caller, args.ref.includes("/") ? args.ref : `stand:action/${args.ref}`);
      if (!r.note || r.note.kind !== "action") throw new AgentError("Screenshots go on a to-do (stand:action/...).");
      const secret = deps.uploads.create({
        roomId: r.room.id,
        noteId: r.note.id,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
      });
      const url = `${baseUrl}/api/work-uploads/${secret}`;
      return {
        upload_url: url,
        how: `curl -sS --data-binary @screenshot.png -H "Content-Type: image/png" "${url}?caption=What%20it%20shows"`,
        rules: `PNG, JPEG, WebP or GIF, up to 10 MB each, up to ${UPLOAD_LINK_MAX} images, for ${UPLOAD_LINK_MS / 60_000} minutes. No token needed: the link is the permission, so don't share it. The screenshots join your next post_update or complete_action on this to-do.`,
      };
    },
  };
}

const TASK_STATES: TaskState[] = ["open", "doing", "done", "dropped"];

/** What create_action and update_action can set besides the text. */
interface TaskChange {
  /** A name, "me", or "unassigned". */
  owner?: string;
  status?: string;
  /** Goes in the to-do's log in Stand, like a report. */
  summary?: string;
  /** Why it was dropped. */
  reason?: string;
  links?: string[];
  /** The to-do is being added now: its summary is what it's about, not news on it. */
  adding?: boolean;
}

const oneLine = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function requireWrite(caller: Caller) {
  if (caller.token && caller.token.scope !== "write")
    throw new AgentError(
      'This agent token is read only. Make a token with "Read and update" on Stand\'s Connect an agent page to report back.',
    );
}

/** Up to five http(s) links. */
function cleanLinks(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  return links
    .map((l) => String(l).trim())
    .filter((l) => {
      try {
        const u = new URL(l);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    })
    .slice(0, 5)
    .map((l) => l.slice(0, 500));
}

export type AgentApi = ReturnType<typeof agentApi>;
