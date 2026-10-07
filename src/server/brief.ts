// The meeting brief: what a finished meeting hands to people and agents for
// follow-up. One JSON shape (versioned, stable ids, links back to the source
// ticket or slide) and a Markdown rendering of the same thing.

import type { Deck, Item, Note, Segment } from "../shared/protocol.ts";

type Meeting = { id: string; roomId: string; startedAt: number; endedAt: number | null; summary: string | null };

export const BRIEF_SCHEMA = "stand.meeting-brief/v1";

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
}

export interface BriefAction {
  id: string;
  text: string;
  owner: string | null;
  status: "open";
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

export function buildBrief(input: {
  meeting: Meeting;
  roomName: string;
  groups: Array<{ item: Item | null; segments: Segment[]; notes: Note[] }>;
  decks: Deck[];
  baseUrl: string;
  withTranscript?: boolean;
}): MeetingBrief {
  const { meeting: m, baseUrl } = input;
  const iso = (ts: number) => new Date(ts).toISOString();
  const ref = (it: Item | null): BriefItemRef => {
    if (!it) return { id: null, kind: "general", title: "General / off-agenda", key: null, deck: null, url: null };
    const deck = it.deckId ? input.decks.find((d) => d.id === it.deckId) : undefined;
    return {
      id: it.id,
      kind: it.source === "linear" ? "linear" : it.source === "slide" ? "slide" : "task",
      title: it.title,
      key: it.externalId ?? (it.slideNo ? `Slide ${it.slideNo}` : null),
      deck: deck?.title ?? null,
      url: it.url ?? `${baseUrl}/items/${it.id}`,
    };
  };

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
    decisions: [],
    openQuestions: [],
    items: [],
  };

  for (const g of input.groups) {
    const r = ref(g.item);
    const of = (kind: Note["kind"]) => g.notes.filter((n) => n.kind === kind);
    const actions = of("action").map((n) => ({ id: n.id, text: n.text, owner: n.owner, status: "open" as const, item: r }));
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

/** The brief as Markdown with YAML front matter: easy to paste into an agent or a doc. */
export function briefToMarkdown(b: MeetingBrief): string {
  const label = (r: BriefItemRef) => [r.key, r.deck && r.kind === "slide" ? `${r.deck}: ${r.title}` : r.title].filter(Boolean).join(" · ");
  const link = (r: BriefItemRef) => (r.url ? `[${label(r)}](${r.url})` : label(r));
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
  if (b.actions.length) for (const a of b.actions) out.push(`- [ ] ${a.text}${a.owner ? ` (owner: ${a.owner})` : " (owner: unassigned)"} · ${link(a.item)}`);
  else out.push("None.");
  out.push("");
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
      out.push(`- Action: ${a.text}${a.owner ? ` (${a.owner})` : ""}`);
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
