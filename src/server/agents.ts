// What agents see of Stand, shared by the MCP server (mcp.ts) and the
// "Copy for agent" button: references to single to-dos, decisions, questions
// and topics, the context to act on them, and the two ways to report back.
// An agent sees exactly the spaces its person is in (spaces are invite only).

import type { AgentToken, Discussion, Item, ItemUpdate, Note, UpdateStatus, UpNextSuggestion, UpNext, User } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import { ownedBy } from "./spaces.ts";

export type RefKind = "action" | "decision" | "question" | "topic";
const NOTE_KINDS: Record<string, RefKind> = { action: "action", decision: "decision", question: "question" };

export const refOf = (kind: RefKind, id: string) => `stand:${kind}/${id}`;
export const refUrl = (baseUrl: string, kind: RefKind, id: string) => `${baseUrl}/ref/${kind}/${id}`;

/** Reads "stand:action/n8f2k", "action/n8f2k" or a Stand link to one (…/ref/action/n8f2k). */
export function parseRef(input: string): { kind: RefKind; id: string } | null {
  const m = /(?:^|stand:|\/ref\/)(action|decision|question|topic)\/([a-z0-9]{4,24})\b/i.exec(input.trim());
  return m ? { kind: m[1].toLowerCase() as RefKind, id: m[2] } : null;
}

/** An error the agent should see as-is (not found, not allowed, bad input). */
export class AgentError extends Error {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export interface Caller {
  user: User;
  /** The token in use; null when a signed-in person asks from the web app. */
  token: AgentToken | null;
}

export interface AgentDeps {
  db: DB;
  /** Tells people in a live call that something changed on their space. */
  notify: (roomId: string, what: "updates" | "followups") => void;
  /** The meeting brief (stand.meeting-brief/v1) for a meeting. */
  brief: (meetingId: string, baseUrl: string, transcript: boolean) => unknown;
  /** The space's suggested agenda as people see it in the app. */
  suggested: (roomId: string) => { upNext: UpNext };
}

const UPDATE_STATUSES: UpdateStatus[] = ["progress", "blocked", "needs_decision", "done"];

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

  const updateInfo = (u: ItemUpdate) => ({
    by: u.client ? `${u.userName} via ${u.client}` : u.userName,
    status: u.status,
    text: u.text,
    links: u.links.length ? u.links : undefined,
    on: u.noteText ? clip(u.noteText, 120) : undefined,
    at: new Date(u.ts).toISOString(),
  });

  const actionInfo = (n: Note) => ({
    ref: refOf("action", n.id),
    text: n.text,
    owner: n.owner ?? undefined,
    status: n.doneAt ? "done" : "open",
    done_by: n.doneBy ?? undefined,
  });

  /** Short quotes from the turns a topic covers. */
  const quotes = (d: Discussion | null, max = 8) =>
    d ? db.getSegments(d.segmentIds.slice(-max)).map((s) => ({ speaker: s.speakerName, said: clip(s.text, 280) })) : [];

  /** Decisions, open questions and open to-dos on an item, newest first, capped. */
  const onItem = (itemId: string | null, skip?: string) => {
    if (!itemId) return { decisions: [], open_questions: [], open_todos: [] };
    const notes = db.itemNotes(itemId).filter((n) => n.id !== skip);
    // Questions only count from the latest meeting that talked about the item; older ones were answered or carried.
    const latest = notes[0]?.meetingId;
    return {
      decisions: notes
        .filter((n) => n.kind === "decision")
        .slice(0, 6)
        .map((n) => ({ ref: refOf("decision", n.id), text: n.text, on: day(n.meetingStartedAt) })),
      open_questions: notes
        .filter((n) => n.kind === "question" && n.meetingId === latest)
        .slice(0, 5)
        .map((n) => ({ ref: refOf("question", n.id), text: n.text })),
      open_todos: notes
        .filter((n) => n.kind === "action" && !n.doneAt)
        .slice(0, 6)
        .map(actionInfo),
    };
  };

  /** Finds what a reference points to, checking the caller is in its space. */
  /** To-dos as agents see them: the ref, owner and status, plus where they came from and the decision behind them. */
  function workRows(rows: Array<Note & { roomName: string; meetingStartedAt: number }>, baseUrl: string) {
    const items = new Map<string, Item | null>();
    return rows.map((n) => {
      if (n.itemId && !items.has(n.itemId)) items.set(n.itemId, db.getItem(n.itemId));
      const item = n.itemId ? items.get(n.itemId)! : null;
      const decision = n.discussionId
        ? db.meetingNotes(n.meetingId).find((x) => x.discussionId === n.discussionId && x.kind === "decision")
        : undefined;
      return {
        ...actionInfo(n),
        space: n.roomName as string | undefined,
        item: item ? { id: item.id, title: item.title, key: item.externalId ?? undefined } : undefined,
        decided: decision?.text,
        from_meeting: day(n.meetingStartedAt),
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
      const r = resolve(caller, refText);
      const item = r.itemId ? db.getItem(r.itemId) : null;
      const where = {
        space: { id: r.room.id, name: r.room.name, purpose: r.room.purpose || undefined },
        item: itemInfo(item, baseUrl),
        meeting: { id: r.meeting.id, on: day(r.meeting.startedAt), live: r.meeting.endedAt === null || undefined },
      };
      const topic = r.topic
        ? {
            ref: refOf("topic", r.topic.id),
            topic: r.topic.topic,
            outcome: r.topic.outcome,
            positions: r.topic.positions.map((p) => `${p.speaker}: ${p.position}`),
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
          url: refUrl(baseUrl, "topic", r.topic!.id),
        };
      }
      const n = r.note;
      // The decision behind a to-do: from its own topic first, else the item's latest decision.
      const sameTopic = r.topic ? db.meetingNotes(r.meeting.id).filter((x) => x.discussionId === r.topic!.id && x.id !== n.id) : [];
      const updates = n.kind === "action" ? db.noteUpdates(n.id) : [];
      return {
        ref: refOf(r.ref.kind, n.id),
        kind: r.ref.kind,
        text: n.text,
        owner: n.owner ?? undefined,
        status: n.kind === "action" ? (n.doneAt ? "done" : "open") : undefined,
        done_by: n.doneBy ?? undefined,
        ...where,
        topic,
        decided_with_it: sameTopic.filter((x) => x.kind === "decision").map((x) => x.text),
        on_this_item: onItem(r.itemId, n.id),
        quotes: quotes(r.topic),
        updates: updates.length ? updates.map(updateInfo) : undefined,
        url: refUrl(baseUrl, r.ref.kind, n.id),
        next:
          n.kind === "action"
            ? "When you finish, call complete_action with this ref (add a note and PR link). For progress or a blocker, call post_update."
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
      const what = { action: "to-do", decision: "decision", question: "open question", topic: "topic" }[r.ref.kind];
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
          ? "Pull the full context with the Stand MCP (get), do the work, then report back with complete_action or post_update."
          : r.ref.kind === "question"
            ? "Pull the full context with the Stand MCP (get), dig into it, then report what you found with post_update (status needs_decision if people must decide)."
            : "Pull the full context with the Stand MCP (get) before acting on it.",
      ];
      return lines.join("\n");
    },

    /** Where a reference lives, for the web app's /ref/... links. */
    locate(caller: Caller, kind: string, id: string) {
      const r = resolve(caller, `stand:${kind}/${id}`);
      return { meetingId: r.meeting.id, roomId: r.room.id, itemId: r.itemId };
    },

    listActions(caller: Caller, opts: { space: string; status?: "open" | "done" | "all"; owner?: string }, baseUrl: string) {
      const status = opts.status ?? "open";
      const q = opts.space.trim().toLowerCase();
      const spaces = db.spaceRows(caller.user.id).filter((r) => r.id === opts.space || r.name.toLowerCase().includes(q));
      if (!q || spaces.length === 0) throw new AgentError(`You're not in a space matching "${opts.space}". list_spaces shows yours.`);
      if (spaces.length > 1 && !spaces.some((r) => r.name.toLowerCase() === q))
        throw new AgentError(`"${opts.space}" matches ${spaces.map((r) => `${r.name} (${r.id})`).join(", ")}. Give one id.`);
      const room = spaces.find((r) => r.id === opts.space || r.name.toLowerCase() === q) ?? spaces[0];
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
      const q = spaceQuery.trim().toLowerCase();
      const spaces = db.spaceRows(caller.user.id).filter((r) => r.id === spaceQuery || r.name.toLowerCase().includes(q));
      if (!q || spaces.length === 0) throw new AgentError(`You're not in a space matching "${spaceQuery}". list_spaces shows yours.`);
      if (spaces.length > 1 && !spaces.some((r) => r.name.toLowerCase() === q))
        throw new AgentError(`"${spaceQuery}" matches ${spaces.map((r) => `${r.name} (${r.id})`).join(", ")}. Give one id.`);
      const room = space((spaces.find((r) => r.id === spaceQuery || r.name.toLowerCase() === q) ?? spaces[0]).id, caller);
      const { upNext } = deps.suggested(room.id);
      const refFor = (key: string) => {
        const [kind, id] = key.split(":");
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
          .map(actionInfo),
        topics: topics.map((d) => ({
          ref: refOf("topic", d.id),
          topic: d.topic,
          outcome: d.outcome,
          on: day(d.meetingStartedAt),
          positions: d.positions.map((p) => `${p.speaker}: ${p.position}`),
        })),
        updates: db.itemUpdates(item.id, 10).map(updateInfo),
        snaps: db.itemSnaps(item.id, 8).map((p) => ({
          image_url: `${baseUrl}/api/snaps/${p.id}.${p.ext}?v=${p.version}`,
          caption: p.caption ?? undefined,
          by: p.source === "agent" ? "the Stand agent (kept because it backs a note)" : p.takenBy,
          backs: p.noteId ? notes.find((n) => n.id === p.noteId)?.text : undefined,
          at: new Date(p.ts).toISOString(),
        })),
        meetings: [...new Set(notes.map((n) => n.meetingId))].length,
      };
    },

    meetingBrief(caller: Caller, opts: { meetingId?: string; spaceId?: string; transcript?: boolean }, baseUrl: string) {
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
      return deps.brief(m.id, baseUrl, !!opts.transcript);
    },

    postUpdate(caller: Caller, args: { itemId?: string; ref?: string; text: string; status?: string; links?: string[] }) {
      requireWrite(caller);
      const text = args.text.trim().slice(0, 2000);
      if (!text) throw new AgentError("An update needs some text.");
      const status = (UPDATE_STATUSES.find((s) => s === args.status) ?? "progress") as UpdateStatus;
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
        status,
        text,
        links: cleanLinks(args.links),
      });
      deps.notify(roomId, "updates");
      return { posted: updateInfo(update), shows_on: itemId ? "the item in Stand, under Since last time" : "the space in Stand" };
    },

    completeAction(caller: Caller, args: { ref: string; note?: string; links?: string[] }) {
      requireWrite(caller);
      const r = resolve(caller, args.ref.includes("/") ? args.ref : `stand:action/${args.ref}`);
      if (!r.note || r.note.kind !== "action") throw new AgentError("Only to-dos (stand:action/...) can be completed.");
      const by = caller.token ? `${caller.user.name} via ${caller.token.label}` : caller.user.name;
      const already = !!r.note.doneAt;
      const done = already ? r.note : db.setActionDone(r.room.id, r.note.id, by);
      if (!done) throw new AgentError("Couldn't check that to-do off.");
      const update = db.addUpdate({
        roomId: r.room.id,
        itemId: r.itemId,
        noteId: r.note.id,
        noteText: r.note.text,
        userId: caller.user.id,
        userName: caller.user.name,
        client: caller.token?.label ?? null,
        status: "done",
        text: args.note?.trim().slice(0, 2000) || `Done: ${clip(r.note.text, 200)}`,
        links: cleanLinks(args.links),
      });
      deps.notify(r.room.id, "followups");
      return {
        ref: refOf("action", r.note.id),
        status: "done",
        was_already_done: already || undefined,
        done_by: done.doneBy,
        update: updateInfo(update),
      };
    },
  };
}

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
