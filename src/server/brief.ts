// The meeting brief: what a finished meeting hands to people and agents for
// follow-up. One JSON shape (versioned, stable ids, links back to the source
// ticket or slide) and a Markdown rendering of the same thing.

import type { Deck, FollowUp, Item, Note, Segment } from "../shared/protocol.ts";

type Meeting = { id: string; roomId: string; startedAt: number; endedAt: number | null; summary: string | null };

export const BRIEF_SCHEMA = "stand.meeting-brief/v1";
export const FOLLOW_UPS_SCHEMA = "stand.follow-ups/v1";

export interface BriefItemRef {
  /** Stand's id for the agenda item; null for talk with no item in focus. */
  id: string | null;
  kind: "task" | "linear" | "slide" | "general";
  title: string;
  /** Ticket key (ENG-142) or "Slide 3". */
  key: string | null;
  deck: string | null;
  /** The ticket in Linear, or the item's history page in Stand. */
  url: string | null;
  /** Everything said and noted about this item across meetings, in Stand. */
  historyUrl: string | null;
  /** For slides: the deck page in Stand, with every slide's discussion. */
  deckUrl: string | null;
}

export interface BriefAction {
  id: string;
  text: string;
  owner: string | null;
  status: "open" | "done";
  doneAt: string | null;
  doneBy: string | null;
  /** The meeting it came up in. */
  meetingId: string;
  item: BriefItemRef;
}

export interface MeetingBrief {
  schema: typeof BRIEF_SCHEMA;
  meeting: {
    id: string;
    room: { id: string; name: string };
    startedAt: string;
    endedAt: string | null;
    durationMinutes: number | null;
    attendees: string[];
    recapUrl: string;
  };
  summary: string | null;
  /** Every action item, across the agenda: the follow-up to-do list. */
  actions: BriefAction[];
  /** Action items from the room's earlier meetings that are still open. */
  carriedOver: BriefAction[];
  decisions: Array<{ id: string; text: string; item: BriefItemRef }>;
  openQuestions: Array<{ id: string; text: string; item: BriefItemRef }>;
  /** The same notes grouped by agenda item, in agenda order. */
  items: Array<{
    item: BriefItemRef;
    summary: string | null;
    decisions: string[];
    actionIds: string[];
    openQuestions: string[];
    speakers: string[];
    transcript?: Array<{ speaker: string; kind: "speech" | "chat"; at: string; text: string }>;
  }>;
}

/** Links an agenda item back to its source and to its pages in Stand. */
export function itemRef(it: Item | null, decks: Deck[], baseUrl: string): BriefItemRef {
  if (!it) return { id: null, kind: "general", title: "General / off-agenda", key: null, deck: null, url: null, historyUrl: null, deckUrl: null };
  const deck = it.deckId ? decks.find((d) => d.id === it.deckId) : undefined;
  return {
    id: it.id,
    kind: it.source === "linear" ? "linear" : it.source === "slide" ? "slide" : "task",
    title: it.title,
    key: it.externalId ?? (it.slideNo ? `Slide ${it.slideNo}` : null),
    deck: deck?.title ?? null,
    url: it.url ?? `${baseUrl}/items/${it.id}`,
    historyUrl: `${baseUrl}/items/${it.id}`,
    deckUrl: it.deckId ? `${baseUrl}/decks/${it.deckId}` : null,
  };
}

const iso = (ts: number) => new Date(ts).toISOString();

function toAction(n: Note, item: BriefItemRef): BriefAction {
  return {
    id: n.id,
    text: n.text,
    owner: n.owner,
    status: n.doneAt ? "done" : "open",
    doneAt: n.doneAt ? iso(n.doneAt) : null,
    doneBy: n.doneBy,
    meetingId: n.meetingId,
    item,
  };
}

export function buildBrief(input: {
  meeting: Meeting;
  roomName: string;
  groups: Array<{ item: Item | null; segments: Segment[]; notes: Note[] }>;
  decks: Deck[];
  baseUrl: string;
  /** The room's action items from other meetings; open ones from before this meeting carry over. */
  followUps?: FollowUp[];
  itemById?: (id: string) => Item | null;
  withTranscript?: boolean;
}): MeetingBrief {
  const { meeting: m, baseUrl } = input;
  const ref = (it: Item | null) => itemRef(it, input.decks, baseUrl);

  const brief: MeetingBrief = {
    schema: BRIEF_SCHEMA,
    meeting: {
      id: m.id,
      room: { id: m.roomId, name: input.roomName },
      startedAt: iso(m.startedAt),
      endedAt: m.endedAt ? iso(m.endedAt) : null,
      durationMinutes: m.endedAt ? Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000)) : null,
      attendees: [...new Set(input.groups.flatMap((g) => g.segments.map((s) => s.speakerName)))],
      recapUrl: `${baseUrl}/meetings/${m.id}`,
    },
    summary: m.summary,
    actions: [],
    carriedOver: (input.followUps ?? [])
      .filter((f) => f.meetingId !== m.id && f.meetingStartedAt < m.startedAt && !f.doneAt)
      .map((f) => toAction(f, ref(f.itemId ? (input.itemById?.(f.itemId) ?? null) : null))),
    decisions: [],
    openQuestions: [],
    items: [],
  };

  for (const g of input.groups) {
    const r = ref(g.item);
    const of = (kind: Note["kind"]) => g.notes.filter((n) => n.kind === kind);
    const actions = of("action").map((n) => toAction(n, r));
    brief.actions.push(...actions);
    brief.decisions.push(...of("decision").map((n) => ({ id: n.id, text: n.text, item: r })));
    brief.openQuestions.push(...of("question").map((n) => ({ id: n.id, text: n.text, item: r })));
    brief.items.push({
      item: r,
      summary: of("summary")[0]?.text ?? null,
      decisions: of("decision").map((n) => n.text),
      actionIds: actions.map((a) => a.id),
      openQuestions: of("question").map((n) => n.text),
      speakers: [...new Set(g.segments.map((s) => s.speakerName))],
      ...(input.withTranscript && {
        transcript: g.segments.map((s) => ({ speaker: s.speakerName, kind: s.kind, at: iso(s.ts), text: s.text })),
      }),
    });
  }
  return brief;
}

const label = (r: BriefItemRef) => [r.key, r.deck && r.kind === "slide" ? `${r.deck}: ${r.title}` : r.title].filter(Boolean).join(" · ");
const link = (r: BriefItemRef) => (r.url ? `[${label(r)}](${r.url})` : label(r));
const actionLine = (a: BriefAction) =>
  `- [${a.status === "done" ? "x" : " "}] ${a.text} (owner: ${a.owner ?? "unassigned"}${a.doneBy ? `, done by ${a.doneBy}` : ""}) · ${link(a.item)}`;

/** The brief as Markdown with YAML front matter: easy to paste into an agent or a doc. */
export function briefToMarkdown(b: MeetingBrief): string {
  const date = b.meeting.startedAt.slice(0, 10);
  const out: string[] = [
    "---",
    `schema: ${b.schema}`,
    `meeting_id: ${b.meeting.id}`,
    `room: ${JSON.stringify(b.meeting.room.name)}`,
    `started_at: ${b.meeting.startedAt}`,
    ...(b.meeting.durationMinutes ? [`duration_minutes: ${b.meeting.durationMinutes}`] : []),
    `attendees: [${b.meeting.attendees.map((a) => JSON.stringify(a)).join(", ")}]`,
    `recap: ${b.meeting.recapUrl}`,
    "---",
    "",
    `# ${b.meeting.room.name} · ${date}`,
    "",
  ];
  if (b.summary) out.push(b.summary, "");

  out.push("## Action items", "");
  if (b.actions.length) for (const a of b.actions) out.push(actionLine(a));
  else out.push("None.");
  out.push("");
  if (b.carriedOver.length) {
    out.push("## Still open from earlier meetings", "");
    for (const a of b.carriedOver) out.push(actionLine(a));
    out.push("");
  }
  if (b.decisions.length) {
    out.push("## Decisions", "");
    for (const d of b.decisions) out.push(`- ${d.text} · ${link(d.item)}`);
    out.push("");
  }
  if (b.openQuestions.length) {
    out.push("## Open questions", "");
    for (const q of b.openQuestions) out.push(`- ${q.text} · ${link(q.item)}`);
    out.push("");
  }

  out.push("## By agenda item", "");
  const actionText = new Map(b.actions.map((a) => [a.id, a]));
  for (const g of b.items) {
    out.push(`### ${link(g.item)}`, "");
    if (g.speakers.length) out.push(`Speakers: ${g.speakers.join(", ")}`, "");
    if (g.summary) out.push(g.summary, "");
    for (const d of g.decisions) out.push(`- Decision: ${d}`);
    for (const id of g.actionIds) {
      const a = actionText.get(id)!;
      out.push(`- Action${a.status === "done" ? " (done)" : ""}: ${a.text}${a.owner ? ` (${a.owner})` : ""}`);
    }
    for (const q of g.openQuestions) out.push(`- Question: ${q}`);
    if (g.decisions.length || g.actionIds.length || g.openQuestions.length) out.push("");
    if (g.transcript?.length) {
      out.push("<details><summary>Transcript</summary>", "");
      for (const s of g.transcript) out.push(`- ${s.speaker}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`);
      out.push("", "</details>", "");
    }
  }
  return out.join("\n").trimEnd() + "\n";
}

/** A room's follow-ups across all its meetings: the standing to-do list an
 *  agent can pick work from, each entry linked to its task, ticket or slide. */
export interface FollowUpsFeed {
  schema: typeof FOLLOW_UPS_SCHEMA;
  room: { id: string; name: string; url: string };
  status: "open" | "done" | "all";
  actions: Array<BriefAction & { raisedAt: string; meetingUrl: string }>;
}

export function buildFollowUps(input: {
  room: { id: string; name: string };
  followUps: FollowUp[];
  itemById: (id: string) => Item | null;
  decks: Deck[];
  baseUrl: string;
  status: FollowUpsFeed["status"];
}): FollowUpsFeed {
  const { baseUrl } = input;
  return {
    schema: FOLLOW_UPS_SCHEMA,
    room: { ...input.room, url: `${baseUrl}/r/${input.room.id}` },
    status: input.status,
    actions: input.followUps
      .filter((f) => input.status === "all" || (input.status === "done") === Boolean(f.doneAt))
      .map((f) => ({
        ...toAction(f, itemRef(f.itemId ? input.itemById(f.itemId) : null, input.decks, baseUrl)),
        raisedAt: iso(f.meetingStartedAt),
        meetingUrl: `${baseUrl}/meetings/${f.meetingId}`,
      })),
  };
}

export function followUpsToMarkdown(f: FollowUpsFeed): string {
  const out = [
    "---",
    `schema: ${f.schema}`,
    `room: ${JSON.stringify(f.room.name)}`,
    `status: ${f.status}`,
    "---",
    "",
    `# ${f.room.name} · ${f.status === "open" ? "open follow-ups" : f.status === "done" ? "done follow-ups" : "follow-ups"}`,
    "",
  ];
  if (!f.actions.length) out.push("None.");
  for (const a of f.actions) out.push(`${actionLine(a)} · raised [${a.raisedAt.slice(0, 10)}](${a.meetingUrl})`);
  return out.join("\n").trimEnd() + "\n";
}
