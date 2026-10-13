// The meeting brief: what a finished meeting hands to people and agents for
// follow-up. One JSON shape (versioned, stable ids, links back to the source
// ticket or slide) and a Markdown rendering of the same thing.

import { meetingChapters } from "../shared/chapters.ts";
import type { ChapterRecap, Deck, Discussion, DiscussionOutcome, FollowUp, Item, Note, Quote, Segment, Snap } from "../shared/protocol.ts";

type Meeting = {
  id: string;
  roomId: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  synthesis?: string | null;
  chapters?: ChapterRecap[];
};

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
  /** The discussion it came out of: why this needs doing, and who said what. */
  discussion: { id: string; topic: string; positions: BriefPosition[] } | null;
  /** Screenshots that show what this is about (this meeting's brief only). */
  images?: BriefImage[];
  /** The chapter of the meeting it came out of (this meeting's brief only). */
  chapter?: { key: string; title: string; at: string } | null;
}

/** A stretch of the meeting on one subject, as people saw it on the chapter bar: a main topic
 *  with the smaller topics placed inside it, or a small group of topics. In the order talked about. */
export interface BriefChapter {
  key: string;
  title: string;
  item: BriefItemRef;
  /** Time into the meeting it started, like 15:21, and the clock time. */
  at: string;
  startedAt: string;
  minutes: number;
  outcome: DiscussionOutcome;
  /** Where it landed, in a sentence; null when the recap didn't write one. */
  crux: string | null;
  speakers: string[];
  /** Its topics (items[].discussions ids), the main one first. */
  topicIds: string[];
  actionIds: string[];
  decisions: string[];
  openQuestions: string[];
  /** For long chapters: the turning points, in order. */
  moments: Array<{ at: string; startedAt: string; text: string }>;
}

/** A screenshot placed under a note or topic, with what it shows and why it mattered. */
export interface BriefImage {
  snapId: string;
  /** Agents fetch it with the same token they use for the MCP. */
  imageUrl: string;
  caption: string | null;
}

export interface BriefDiscussion {
  id: string;
  topic: string;
  outcome: DiscussionOutcome;
  positions: BriefPosition[];
  decisions: string[];
  actionIds: string[];
  openQuestions: string[];
  /** Screenshots discussed under this topic that back no single note. */
  images: BriefImage[];
  /** The same question discussed in an earlier meeting. */
  continues: { id: string; meetingId: string; startedAt: string; topic: string; recapUrl: string } | null;
  transcript?: Array<{ speaker: string; kind: "speech" | "chat"; at: string; text: string }>;
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
  /** The space, and what it asks the agent to pull out of every meeting (null when nothing). */
  space: { id: string; name: string; synthesisInstructions: string | null };
  /** What those instructions produced for this meeting, as Markdown; null without instructions. */
  synthesis: string | null;
  /** Every action item, across the agenda: the follow-up to-do list. */
  actions: BriefAction[];
  /** Action items from the room's earlier meetings that are still open. */
  carriedOver: BriefAction[];
  /** quote: the words it was settled in, as said (null when the meeting-end run found none). */
  decisions: Array<{ id: string; text: string; item: BriefItemRef; images: BriefImage[]; quote: BriefQuote | null }>;
  openQuestions: Array<{ id: string; text: string; item: BriefItemRef; images: BriefImage[] }>;
  /** The meeting as chapters, in the order they were talked about. */
  chapters: BriefChapter[];
  /** The same notes grouped by agenda item, in agenda order. */
  items: Array<{
    item: BriefItemRef;
    summary: string | null;
    decisions: string[];
    actionIds: string[];
    openQuestions: string[];
    speakers: string[];
    /** The talk grouped into discussions, one per question, in order. */
    discussions: BriefDiscussion[];
    /** Stills of the shared screen taken while this item was in focus. */
    snaps: BriefSnap[];
    transcript?: Array<{ speaker: string; kind: "speech" | "chat"; at: string; text: string }>;
  }>;
}

export interface BriefSnap {
  id: string;
  /** The image; agents fetch it with the same token they use for the MCP. */
  imageUrl: string;
  at: string;
  takenBy: string;
  /** "agent" when the agent kept it because it backs a decision or to-do. */
  source: "person" | "agent";
  caption: string | null;
  topic: string | null;
  /** The to-do, decision or open question it backs, if any. */
  noteId: string | null;
  /** What was said around it. */
  said: Array<{ speaker: string; text: string }>;
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

type DiscussionLookup = (id: string) => Pick<Discussion, "id" | "topic" | "positions"> | null | undefined;

function toAction(n: Note, item: BriefItemRef, discussionById?: DiscussionLookup): BriefAction {
  const d = n.discussionId ? discussionById?.(n.discussionId) : null;
  return {
    id: n.id,
    text: n.text,
    owner: n.owner,
    status: n.doneAt ? "done" : "open",
    doneAt: n.doneAt ? iso(n.doneAt) : null,
    doneBy: n.doneBy,
    meetingId: n.meetingId,
    item,
    discussion: d ? { id: d.id, topic: d.topic, positions: briefPositions(d.positions) } : null,
  };
}

/** Someone's own words, from the transcript, behind a position or decision. */
export type BriefQuote = { speaker: string; text: string; at: string };
/** Where someone stood, with their own words when the meeting-end run found them. */
export type BriefPosition = { speaker: string; position: string; quote?: BriefQuote | null };
const briefQuote = (q: Quote | null | undefined): BriefQuote | null => (q ? { speaker: q.speaker, text: q.text, at: iso(q.ts) } : null);
/** Positions with their words as said, for people and agents reading the brief. */
const briefPositions = (ps: Discussion["positions"]): BriefPosition[] =>
  ps.map((p) => ({ speaker: p.speaker, position: p.position, ...(p.quote ? { quote: briefQuote(p.quote) } : {}) }));

export function buildBrief(input: {
  meeting: Meeting;
  roomName: string;
  /** The space's synthesis instructions, if it has any. */
  synthesisInstructions?: string;
  groups: Array<{ item: Item | null; segments: Segment[]; notes: Note[]; discussions?: Discussion[]; snaps?: Snap[] }>;
  decks: Deck[];
  baseUrl: string;
  /** The room's action items from other meetings; open ones from before this meeting carry over. */
  followUps?: FollowUp[];
  itemById?: (id: string) => Item | null;
  /** Finds discussions from other meetings, for carried-over action items. */
  discussionById?: DiscussionLookup;
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
    space: { id: m.roomId, name: input.roomName, synthesisInstructions: input.synthesisInstructions?.trim() || null },
    synthesis: m.synthesis ?? null,
    actions: [],
    carriedOver: (input.followUps ?? [])
      .filter((f) => f.meetingId !== m.id && f.meetingStartedAt < m.startedAt && !f.doneAt)
      .map((f) => toAction(f, ref(f.itemId ? (input.itemById?.(f.itemId) ?? null) : null), input.discussionById)),
    decisions: [],
    openQuestions: [],
    chapters: [],
    items: [],
  };

  const turn = (s: Segment) => ({ speaker: s.speakerName, kind: s.kind, at: iso(s.ts), text: s.text });
  // Each snap has one home: the note it backs, else the topic it was discussed in.
  const noteIds = new Set(input.groups.flatMap((g) => g.notes.map((n) => n.id)));
  const allSnaps = input.groups.flatMap((g) => g.snaps ?? []);
  const image = (p: Snap): BriefImage => ({ snapId: p.id, imageUrl: p.url.startsWith("/") ? `${baseUrl}${p.url}` : p.url, caption: p.caption });
  const imagesOfNote = (id: string) => allSnaps.filter((p) => p.noteId === id).map(image);
  const imagesOfTopic = (id: string) => allSnaps.filter((p) => !(p.noteId && noteIds.has(p.noteId)) && p.discussionId === id).map(image);
  for (const g of input.groups) {
    const r = ref(g.item);
    const discussions = g.discussions ?? [];
    const here = new Map(discussions.map((d) => [d.id, d]));
    const of = (kind: Note["kind"]) => g.notes.filter((n) => n.kind === kind);
    const actions = of("action").map((n) => ({ ...toAction(n, r, (id) => here.get(id)), images: imagesOfNote(n.id) }));
    brief.actions.push(...actions);
    brief.decisions.push(...of("decision").map((n) => ({ id: n.id, text: n.text, item: r, images: imagesOfNote(n.id), quote: briefQuote(n.quote) })));
    brief.openQuestions.push(...of("question").map((n) => ({ id: n.id, text: n.text, item: r, images: imagesOfNote(n.id) })));
    brief.items.push({
      item: r,
      summary: of("summary")[0]?.text ?? null,
      decisions: of("decision").map((n) => n.text),
      actionIds: actions.map((a) => a.id),
      openQuestions: of("question").map((n) => n.text),
      speakers: [...new Set(g.segments.map((s) => s.speakerName))],
      discussions: discussions.map((d) => {
        const mine = (kind: Note["kind"]) => g.notes.filter((n) => n.kind === kind && n.discussionId === d.id);
        return {
          id: d.id,
          topic: d.topic,
          outcome: d.outcome,
          positions: briefPositions(d.positions),
          decisions: mine("decision").map((n) => n.text),
          actionIds: mine("action").map((n) => n.id),
          openQuestions: mine("question").map((n) => n.text),
          images: imagesOfTopic(d.id),
          continues: d.continues
            ? { ...d.continues, startedAt: iso(d.continues.startedAt), recapUrl: `${baseUrl}/meetings/${d.continues.meetingId}` }
            : null,
          ...(input.withTranscript && {
            transcript: d.segmentIds.flatMap((id) => g.segments.filter((s) => s.id === id)).map(turn),
          }),
        };
      }),
      snaps: (g.snaps ?? []).map((p) => ({
        id: p.id,
        imageUrl: image(p).imageUrl,
        at: iso(p.ts),
        takenBy: p.takenBy,
        source: p.source,
        caption: p.caption,
        topic: (p.discussionId && here.get(p.discussionId)?.topic) || null,
        noteId: p.noteId,
        said: p.segmentIds.flatMap((id) => g.segments.filter((x) => x.id === id)).map((x) => ({ speaker: x.speakerName, text: x.text })),
      })),
      ...(input.withTranscript && { transcript: g.segments.map(turn) }),
    });
  }
  // Chapters: the same ones the recap page and the meeting's chapter bar show.
  const allDiscussions = input.groups.flatMap((g) => g.discussions ?? []);
  const allSegments = input.groups.flatMap((g) => g.segments);
  const allNotes = input.groups.flatMap((g) => g.notes);
  const written = new Map((m.chapters ?? []).map((c) => [c.key, c]));
  const chapters = meetingChapters(allDiscussions, allSegments, m.endedAt ?? Infinity);
  const chapterOfTopic = new Map(chapters.flatMap((c) => c.topicIds.map((id) => [id, c] as const)));
  for (const c of chapters) {
    const mine = (kind: Note["kind"]) => allNotes.filter((n) => n.kind === kind && n.discussionId && c.topicIds.includes(n.discussionId));
    const w = written.get(c.key);
    brief.chapters.push({
      key: c.key,
      title: c.title,
      item: ref(input.groups.find((g) => (g.item?.id ?? null) === c.itemId)?.item ?? null),
      at: offset(c.start, m.startedAt),
      startedAt: iso(c.start),
      minutes: Math.max(1, Math.round(c.minutes)),
      outcome: c.outcome,
      crux: w?.crux || null,
      speakers: c.speakers,
      topicIds: c.topicIds,
      actionIds: mine("action").map((n) => n.id),
      decisions: mine("decision").map((n) => n.text),
      openQuestions: mine("question").map((n) => n.text),
      moments: (w?.moments ?? []).map((x) => ({ at: offset(x.ts, m.startedAt), startedAt: iso(x.ts), text: x.text })),
    });
  }
  for (const a of brief.actions) {
    const c = a.discussion ? chapterOfTopic.get(a.discussion.id) : undefined;
    a.chapter = c ? { key: c.key, title: c.title, at: offset(c.start, m.startedAt) } : null;
  }
  return brief;
}

/** Time into the meeting, like 15:21 or 1:02:04. */
export function offset(ts: number, startedAt: number): string {
  const s = Math.max(0, Math.round((ts - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

const OUTCOME_LABEL: Record<DiscussionOutcome, string> = { decided: "decided", action: "action taken", open: "still open", info: "FYI, nothing to decide" };

const label = (r: BriefItemRef) => [r.key, r.deck && r.kind === "slide" ? `${r.deck}: ${r.title}` : r.title].filter(Boolean).join(" · ");
const link = (r: BriefItemRef) => (r.url ? `[${label(r)}](${r.url})` : label(r));
const actionLine = (a: BriefAction) =>
  `- [${a.status === "done" ? "x" : " "}] ${a.text} (owner: ${a.owner ?? "unassigned"}${a.doneBy ? `, done by ${a.doneBy}` : ""}) · ${link(a.item)}${
    a.discussion ? ` · from "${a.discussion.topic}"` : ""
  }`;
/** Screenshots as Markdown images, indented under the line they belong to. */
const imageLines = (images: BriefImage[] | undefined, indent = "  ") =>
  (images ?? []).map((p) => `${indent}![${(p.caption ?? "Screenshot").replace(/[[\]]/g, "")}](${p.imageUrl})`);

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
    ...(b.space.synthesisInstructions ? [`synthesis_instructions: ${JSON.stringify(b.space.synthesisInstructions)}`] : []),
    "---",
    "",
    `# ${b.meeting.room.name} · ${date}`,
    "",
  ];
  if (b.summary) out.push(b.summary, "");
  if (b.synthesis) out.push("## Synthesis", "", b.synthesis.trim(), "");

  out.push("## Action items", "");
  if (b.actions.length) for (const a of b.actions) out.push(actionLine(a), ...imageLines(a.images));
  else out.push("None.");
  out.push("");
  if (b.carriedOver.length) {
    out.push("## Still open from earlier meetings", "");
    for (const a of b.carriedOver) out.push(actionLine(a));
    out.push("");
  }
  if (b.decisions.length) {
    out.push("## Decisions", "");
    for (const d of b.decisions) out.push(`- ${d.text}${d.quote ? ` (${d.quote.speaker}: "${d.quote.text}")` : ""} · ${link(d.item)}`, ...imageLines(d.images));
    out.push("");
  }
  if (b.openQuestions.length) {
    out.push("## Open questions", "");
    for (const q of b.openQuestions) out.push(`- ${q.text} · ${link(q.item)}`, ...imageLines(q.images));
    out.push("");
  }

  if (b.chapters.length) {
    out.push("## Chapters", "");
    for (const c of b.chapters) {
      out.push(`### ${c.at} · ${c.title} · ${c.minutes} min · ${OUTCOME_LABEL[c.outcome]}`, "");
      if (c.crux) out.push(c.crux, "");
      for (const x of c.moments) out.push(`- ${x.at} ${x.text}`);
      if (c.moments.length) out.push("");
    }
  }

  out.push("## By agenda item", "");
  const actionText = new Map(b.actions.map((a) => [a.id, a]));
  for (const g of b.items) {
    out.push(`### ${link(g.item)}`, "");
    if (g.speakers.length) out.push(`Speakers: ${g.speakers.join(", ")}`, "");
    if (g.summary) out.push(g.summary, "");
    const actionLine2 = (id: string) => {
      const a = actionText.get(id)!;
      return `- Action${a.status === "done" ? " (done)" : ""}: ${a.text}${a.owner ? ` (${a.owner})` : ""}`;
    };
    const inDiscussion = new Set(g.discussions.flatMap((d) => d.actionIds));
    for (const d of g.discussions) {
      out.push(`#### ${d.topic} · ${OUTCOME_LABEL[d.outcome]}`, "");
      if (d.continues) out.push(`Continues "${d.continues.topic}" from [${d.continues.startedAt.slice(0, 10)}](${d.continues.recapUrl}).`, "");
      for (const p of d.positions) out.push(`- ${p.speaker}: ${p.position}${p.quote ? ` (said: "${p.quote.text}")` : ""}`);
      if (d.positions.length) out.push("");
      for (const t of d.decisions) out.push(`- Decision: ${t}`);
      for (const id of d.actionIds) out.push(actionLine2(id));
      for (const q of d.openQuestions) out.push(`- Question: ${q}`);
      if (d.images.length) out.push(...imageLines(d.images, ""));
      if (d.decisions.length || d.actionIds.length || d.openQuestions.length || d.images.length) out.push("");
    }
    // Notes from before discussions existed, or that belong to none.
    const inAny = new Set(g.discussions.flatMap((d) => [...d.decisions, ...d.openQuestions]));
    const loose = [
      ...g.decisions.filter((d) => !inAny.has(d)).map((d) => `- Decision: ${d}`),
      ...g.actionIds.filter((id) => !inDiscussion.has(id)).map(actionLine2),
      ...g.openQuestions.filter((q) => !inAny.has(q)).map((q) => `- Question: ${q}`),
    ];
    if (loose.length) out.push(...loose, "");
    for (const p of g.snaps)
      out.push(`- Snap ${p.at.slice(11, 16)} by ${p.takenBy}${p.caption ? `: ${p.caption}` : ""} (${p.imageUrl})`);
    if (g.snaps.length) out.push("");
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
  discussionById?: DiscussionLookup;
}): FollowUpsFeed {
  const { baseUrl } = input;
  return {
    schema: FOLLOW_UPS_SCHEMA,
    room: { ...input.room, url: `${baseUrl}/r/${input.room.id}` },
    status: input.status,
    actions: input.followUps
      .filter((f) => input.status === "all" || (input.status === "done") === Boolean(f.doneAt))
      .map((f) => ({
        ...toAction(f, itemRef(f.itemId ? input.itemById(f.itemId) : null, input.decks, baseUrl), input.discussionById),
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
