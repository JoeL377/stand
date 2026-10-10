// The agent's "thinking" parts: turning an item's discussion into notes, and
// reading the shared screen to guess which item is on it. Each has a real
// implementation on Claude and a heuristic stand-in used when no key is set.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { type DraftSlide, outlineToSlides } from "../shared/outline.ts";
import type { DiscussionOutcome, Item, Note, Segment } from "../shared/protocol.ts";
import { config } from "./config.ts";

export type DraftNote = Pick<Note, "kind" | "text" | "owner">;

/** A discussion as the agent drafts it: the turns it covers are indexes into
 *  the segments it was given, and a note points at its discussion by index. */
export interface ItemNotesDraft {
  /** sameAs: the key of an already-captured note this one restates, if any. */
  notes: Array<DraftNote & { discussion: number | null; sameAs?: string | null }>;
  discussions: Array<{
    topic: string;
    positions: Array<{ speaker: string; position: string }>;
    outcome: DiscussionOutcome;
    segmentIndexes: number[];
    /** An earlier discussion of this item that this one picks up again. */
    continuesId: string | null;
  }>;
}

/** Discussions of the same item in earlier meetings, so a new one can link back. */
export type EarlierDiscussion = { id: string; topic: string; meetingStartedAt: number };

/** To-dos and decisions already captured for this item in this meeting, so a
 *  rerun can say which of its notes restate them instead of starting over. */
export type CapturedNote = { key: string; kind: "action" | "decision"; text: string; owner: string | null };

/** A snap taken while an item was in focus, as the live notes see it: words only, never the image. */
export type ScreenNote = { at: number; by: string; caption: string };

/** What the end-of-meeting recap is given: every item's notes and topics, and
 *  the snaps people kept, with the images themselves. */
export interface RecapInput {
  items: Array<{ item: Item | null; notes: Note[]; topics: Array<{ id: string; topic: string }> }>;
  snaps: Array<{
    id: string;
    itemId: string | null;
    at: number;
    by: string;
    /** The line written when it was taken, if any. */
    caption: string | null;
    /** What was said around it, "Name: text". */
    said: string[];
    image: { data: string; mediaType: SnapMedia };
  }>;
}

/** The recap: a few sentences, and where each snap belongs. A snap that backs a
 *  to-do, decision or open question sits under it; otherwise under the topic it
 *  was discussed in. The caption says what it shows and why it mattered. */
export interface RecapDraft {
  summary: string;
  snaps: Array<{ id: string; noteId: string | null; discussionId: string | null; caption: string }>;
}

export interface ScreenMatch {
  itemId: string | null;
  confidence: number;
  reason: string;
}

export interface Agent {
  /** Groups an item's talk into discussions and writes the notes that came out of each. */
  notesFor(
    item: Item | null,
    segments: Segment[],
    earlier?: EarlierDiscussion[],
    captured?: CapturedNote[],
    screens?: ScreenNote[],
  ): Promise<ItemNotesDraft>;
  matchScreen(jpegDataUrl: string, items: Item[], currentItemId: string | null): Promise<ScreenMatch>;
  summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string>;
  /** The recap with the meeting's snaps in view: the summary, plus a home and a caption for each snap. */
  recapMeeting(input: RecapInput): Promise<RecapDraft>;
  /** Slides from a brief: an outline, rough notes or a one-line ask. */
  draftDeck(brief: string): Promise<DraftSlide[]>;
  /** One line on what a snap of the shared screen shows. Null without a model. */
  describeSnap(image: { data: string; mediaType: SnapMedia }, item: Item | null, remarks: string[]): Promise<string | null>;
  /** Whether the screen the agent was reading backs one of the decisions or
   *  to-dos it just wrote: which one (by key), and a caption. Null when it doesn't. */
  frameBacks(
    image: { data: string; mediaType: SnapMedia },
    item: Item | null,
    notes: Array<{ key: string; kind: "action" | "decision"; text: string }>,
  ): Promise<{ key: string; caption: string } | null>;
  /** Tidies the space's suggested agenda: folds duplicates, writes short agenda
   *  lines and reasons, and orders it. Null when there's no model to ask. */
  polishAgenda(space: { name: string; purpose: string }, suggestions: AgendaDraftRow[]): Promise<AgendaPolishRow[] | null>;
}

export type SnapMedia = "image/jpeg" | "image/png" | "image/webp";

/** A suggestion as the agent sees it when tidying the agenda, with what it came from. */
export interface AgendaDraftRow {
  key: string;
  kind: "needs_people" | "question" | "todo";
  title: string;
  reason: string;
  owner: string | null;
  /** The agenda item it was raised under, if any. */
  from: string | null;
  /** The newest update reported on it, if any. */
  latestUpdate: string | null;
}
export interface AgendaPolishRow {
  key: string;
  title: string;
  reason: string;
  sameAs: string | null;
}

export function createAgent(): Agent {
  return config.anthropicKey ? new ClaudeAgent(config.anthropicKey) : new HeuristicAgent();
}

const transcriptText = (segments: Segment[]) =>
  segments.map((s) => `${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`).join("\n");

const itemLabel = (item: Item | null) =>
  item ? `${item.externalId ? `${item.externalId} · ` : ""}${item.title}` : "General discussion (no item in focus)";

// ---------------------------------------------------------------------------

const NotesSchema = z.object({
  summary: z.string().describe("One or two sentences on where this item stands after the discussion. Empty if nothing substantive was said."),
  discussions: z.array(
    z.object({
      topic: z.string().describe("The question or subject discussed, as a short title under 70 characters"),
      turns: z.array(z.number().int()).describe("The [numbers] of the transcript lines that belong to this discussion"),
      positions: z
        .array(z.object({ speaker: z.string(), position: z.string().describe("Their stance or contribution, in one short line") }))
        .describe("One per participant who contributed, in the order they first spoke"),
      outcome: z.enum(["decided", "action", "open", "info"]).describe("decided: a decision was made. action: it ended with someone taking work. open: unresolved. info: an update with nothing to resolve."),
      continues: z.string().nullable().describe("The id of the earlier discussion this picks up again, from the list given, or null"),
      decisions: z.array(
        z.object({ text: z.string(), same_as: z.string().nullable().describe("The key (D1, D2...) of the already-captured decision this is, or null if new") }),
      ),
      action_items: z.array(
        z.object({
          text: z.string().describe("Phrased as a task, e.g. 'File the annual-plan pricing bug against billing'"),
          owner: z.string().nullable(),
          same_as: z.string().nullable().describe("The key (A1, A2...) of the already-captured action item this is, or null if new"),
        }),
      ),
      open_questions: z.array(z.string()),
    }),
  ),
});

const ScreenSchema = z.object({
  item_id: z.string().nullable().describe("id of the agenda item shown on screen, or null if none clearly matches"),
  confidence: z.number().describe("0 to 1"),
  reason: z.string().describe("Short, user-facing: what on screen gave it away"),
});

const DeckSchema = z.object({
  slides: z.array(
    z.object({
      layout: z.enum(["title", "bullets", "section", "quote"]),
      title: z.string().describe("Short slide title, under 60 characters"),
      body: z
        .string()
        .describe("title: a subtitle line. bullets: 2-5 short bullet lines separated by newlines, no bullet characters. section: empty or one short line. quote: the quote text."),
      notes: z.string().describe("What the presenter says on this slide, 1-3 sentences"),
    }),
  ),
});

const SnapSchema = z.object({
  caption: z.string().describe("What's on screen, in one short line under 110 characters, naming the specific thing shown"),
});

const BacksSchema = z.object({
  backs: z.string().nullable().describe("The key of the decision or to-do this screen is evidence for, or null if none"),
  caption: z.string().describe("What's on screen, in one short line under 110 characters"),
});

const RecapSchema = z.object({
  summary: z.string().describe("A 2-4 sentence recap of the meeting. Plain prose, no headings, lead with what matters most."),
  screenshots: z
    .array(
      z.object({
        key: z.string().describe("The screenshot's key, exactly as given (S1, S2...)"),
        note: z.string().nullable().describe("The key (N1, N2...) of the to-do, decision or open question this screenshot backs, or null"),
        topic: z.string().nullable().describe("The key (T1, T2...) of the topic it was discussed in, or null"),
        caption: z
          .string()
          .describe("One line under 140 characters: what the image shows and why it mattered to the conversation"),
      }),
    )
    .describe("One entry per screenshot given"),
});

const AgendaSchema = z.object({
  agenda: z
    .array(
      z.object({
        key: z.string().describe("The suggestion's key, exactly as given"),
        title: z.string().describe("A short agenda line, under 60 characters, in the team's own words"),
        reason: z
          .string()
          .describe("Why it's worth talking about next time, under 70 characters, e.g. 'Blocked on API keys · Andy's agent'"),
        same_as: z.string().nullable().describe("The key of another suggestion this is the same thing as, or null"),
      }),
    )
    .describe("Every suggestion given, once each, in the order the meeting should take them"),
});

class ClaudeAgent implements Agent {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async parse<T>(
    schema: z.ZodType<T>,
    content: Anthropic.Beta.BetaContentBlockParam[] | string,
    system: string,
    effort: "low" | "medium",
    model = config.anthropicModel,
  ): Promise<T | null> {
    // If a safety classifier declines, let the API retry on its recommended
    // fallback model. Haiku has no server-side fallback.
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[], fallbacks: "default" as const };
    const res = await this.client.beta.messages.parse({
      model,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
      ...fallback,
    });
    if (res.stop_reason === "refusal") return null;
    return (res.parsed_output as T | null) ?? null;
  }

  async notesFor(
    item: Item | null,
    segments: Segment[],
    earlier: EarlierDiscussion[] = [],
    captured: CapturedNote[] = [],
    screens: ScreenNote[] = [],
  ): Promise<ItemNotesDraft> {
    if (!segments.length) return { notes: [], discussions: [] };
    const numbered = segments
      .map((s, i) => `[${i + 1}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
      .join("\n");
    const before = earlier.length
      ? `\n\nDiscussions of this item in earlier meetings (newest first):\n${earlier
          .slice(0, 15)
          .map((d) => `- id=${d.id} (${new Date(d.meetingStartedAt).toISOString().slice(0, 10)}): ${d.topic}`)
          .join("\n")}`
      : "";
    const already = captured.length
      ? `\n\nAlready captured from earlier in this meeting (keep every one; reword only if the talk since made it clearer):\n${captured
          .map((c) => `- ${c.key} ${c.kind === "action" ? "action item" : "decision"}: ${c.text}${c.owner ? ` (owner: ${c.owner})` : ""}`)
          .join("\n")}`
      : "";
    const shown = screens.length
      ? `\n\nScreens people saved while this item was in focus (what was on each, as text):\n${screens
          .slice(-10)
          .map((s) => `- ${new Date(s.at).toISOString().slice(11, 16)} ${s.by}: ${s.caption}`)
          .join("\n")}`
      : "";
    const out = await this.parse(
      NotesSchema,
      `Item: ${itemLabel(item)}${item?.description ? `\nItem description: ${item.description.slice(0, 1500)}` : ""}${before}${already}${shown}

What was said while this item was in focus (speech transcript and in-room chat, in order):
${numbered}`,
      `You take notes in a team meeting. You are given what was said while one agenda item (a ticket, task or slide) was in focus.

Group the talk into discussions: a discussion is a stretch of back-and-forth about one question or subject. Most items have one to three. A status update with no back-and-forth is one discussion with outcome "info". Every line belongs to at most one discussion; skip small talk.

For each discussion, give each participant's position in one short line, how it ended, and the decisions actually made, the action items with their owner (the speaker's name; null if nobody took it), and the questions left open. Phrase action items as tasks, not quotes. If it picks up a discussion from an earlier meeting in the list, give that id.

Notes are rewritten as the meeting goes on. Every already-captured action item and decision must appear again, under the discussion it belongs to, with its key in same_as. Never drop or merge two of them into one; only give same_as for a note that is the same task or decision.

Do not invent anything that was not said. Speech-to-text errors are possible; read through them. Keep each line short.`,
      "low",
      config.notesModel,
    );
    if (!out) return { notes: [], discussions: [] };
    const known = new Set(earlier.map((d) => d.id));
    const notes: ItemNotesDraft["notes"] = out.summary.trim() ? [{ kind: "summary", text: out.summary.trim(), owner: null, discussion: null }] : [];
    out.discussions.forEach((d, i) => {
      notes.push(
        ...d.decisions.map((t) => ({ kind: "decision" as const, text: t.text, owner: null, discussion: i, sameAs: t.same_as })),
        ...d.action_items.map((a) => ({ kind: "action" as const, text: a.text, owner: a.owner, discussion: i, sameAs: a.same_as })),
        ...d.open_questions.map((t) => ({ kind: "question" as const, text: t, owner: null, discussion: i })),
      );
    });
    return {
      notes,
      discussions: out.discussions.map((d) => ({
        topic: d.topic.trim().slice(0, 120),
        positions: d.positions.filter((p) => p.position.trim()),
        outcome: d.outcome,
        segmentIndexes: [...new Set(d.turns.map((n) => n - 1).filter((n) => n >= 0 && n < segments.length))].sort((a, b) => a - b),
        continuesId: d.continues && known.has(d.continues) ? d.continues : null,
      })),
    };
  }

  async matchScreen(jpegDataUrl: string, items: Item[], currentItemId: string | null): Promise<ScreenMatch> {
    if (!items.length) return { itemId: null, confidence: 0, reason: "" };
    const data = jpegDataUrl.replace(/^data:image\/jpeg;base64,/, "");
    const list = items
      .map((it) => `- id=${it.id}${it.externalId ? ` key=${it.externalId}` : ""} title="${it.title}"${it.id === currentItemId ? " (currently in focus)" : ""}`)
      .join("\n");
    const out = await this.parse(
      ScreenSchema,
      [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        {
          type: "text",
          text: `This is the screen someone is sharing in a meeting. Which of these agenda items is it showing right now?\n${list}\n\nLook for ticket keys, titles, headings, slide titles, selected rows or open detail panes. If the screen shows a list with no single item selected or open, or nothing matches, return null.`,
        },
      ],
      "You match a shared screen to a meeting agenda. Be conservative: a wrong guess interrupts the meeting host.",
      "low",
    );
    if (!out || !out.item_id || !items.some((i) => i.id === out.item_id)) {
      return { itemId: null, confidence: 0, reason: out?.reason ?? "" };
    }
    return { itemId: out.item_id, confidence: out.confidence, reason: out.reason };
  }

  async draftDeck(brief: string): Promise<DraftSlide[]> {
    const out = await this.parse(
      DeckSchema,
      `Make a slide deck from this brief:\n\n${brief.slice(0, 20000)}`,
      "You write slide decks for team meetings. If the brief is already an outline, keep its structure and wording and only tidy it into slides. Otherwise write a tight deck: a title slide, then one idea per slide, few words per bullet, no filler slides. Every slide will be discussed in the meeting, so make each one something people can react to.",
      "medium",
    );
    if (!out) return outlineToSlides(brief);
    return out.slides.slice(0, 60).map((s) => ({ ...s, image: null }));
  }

  async describeSnap(image: { data: string; mediaType: SnapMedia }, item: Item | null, remarks: string[]): Promise<string | null> {
    const out = await this.parse(
      SnapSchema,
      [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        {
          type: "text",
          text: `Someone in a meeting saved this still of the shared screen while discussing: ${itemLabel(item)}.${
            remarks.length ? `\n\nWhat was being said around then:\n${remarks.slice(0, 6).join("\n")}` : ""
          }\n\nSay what's on screen.`,
        },
      ],
      "You caption screenshots from team meetings so people and agents can find them later. Be concrete: name the ticket, file, chart, page or error shown, and the detail that matters. No preamble.",
      "low",
    );
    return out?.caption.trim().slice(0, 160) || null;
  }

  async frameBacks(
    image: { data: string; mediaType: SnapMedia },
    item: Item | null,
    notes: Array<{ key: string; kind: "action" | "decision"; text: string }>,
  ): Promise<{ key: string; caption: string } | null> {
    if (!notes.length) return null;
    const out = await this.parse(
      BacksSchema,
      [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        {
          type: "text",
          text: `This was on the shared screen while the team discussed ${itemLabel(item)} and wrote down:\n${notes
            .map((n) => `- ${n.key} ${n.kind === "action" ? "to-do" : "decision"}: ${n.text}`)
            .join("\n")}\n\nIs the screen evidence for one of these (it shows the thing decided on or the work to do)? A screen that's merely open at the time doesn't count.`,
        },
      ],
      "You decide whether a meeting screenshot is worth keeping next to a decision or to-do. Keep it only when someone acting on that note later would want to see this screen. When in doubt, null.",
      "low",
    );
    if (!out?.backs || !notes.some((n) => n.key === out.backs)) return null;
    return { key: out.backs, caption: out.caption.trim().slice(0, 160) };
  }

  async polishAgenda(space: { name: string; purpose: string }, suggestions: AgendaDraftRow[]): Promise<AgendaPolishRow[] | null> {
    if (!suggestions.length) return [];
    const list = suggestions
      .map(
        (s) =>
          `- key=${s.key} kind=${s.kind}\n  text: ${s.title}\n  why: ${s.reason}${s.owner ? `\n  owner: ${s.owner}` : ""}${s.from ? `\n  raised under: ${s.from}` : ""}${
            s.latestUpdate ? `\n  latest update: ${s.latestUpdate.slice(0, 300)}` : ""
          }`,
      )
      .join("\n");
    const out = await this.parse(
      AgendaSchema,
      `Space: ${space.name}${space.purpose ? `\nPurpose: ${space.purpose.slice(0, 500)}` : ""}

What's still open from earlier meetings, as the plain ranking has it:
${list}`,
      `You draft the next agenda for a team's recurring meeting from what's still open. The host reads it before the meeting and adds what's worth talking about.

For each suggestion, write a short agenda line (what to talk about, not a copy of the to-do) and a one-line reason. Use the latest update when there is one: it's usually the best reason. Keep owners' names. If two suggestions are the same thing in different words, keep the clearer one and give the other its key in same_as; never fold anything else.

Order: things blocked or waiting on a decision first, then open questions, then to-dos that moved since, then the rest. Return every key exactly once. Do not invent anything.`,
      "low",
      config.notesModel,
    );
    if (!out) return null;
    const known = new Set(suggestions.map((s) => s.key));
    const seen = new Set<string>();
    const rows: AgendaPolishRow[] = [];
    for (const r of out.agenda) {
      if (!known.has(r.key) || seen.has(r.key)) continue;
      seen.add(r.key);
      rows.push({
        key: r.key,
        title: r.title.trim().slice(0, 90) || suggestions.find((s) => s.key === r.key)!.title,
        reason: r.reason.trim().slice(0, 100) || suggestions.find((s) => s.key === r.key)!.reason,
        sameAs: r.same_as && known.has(r.same_as) && r.same_as !== r.key ? r.same_as : null,
      });
    }
    return rows;
  }

  async recapMeeting(input: RecapInput): Promise<RecapDraft> {
    const perItem = input.items.map((g) => ({ item: g.item, notes: g.notes }));
    if (!input.snaps.length) return { summary: await this.summarizeMeeting(perItem), snaps: [] };
    // Short keys for notes, topics and snaps, so the answer can point at them.
    const noteKey = new Map<string, Note>();
    const topicKey = new Map<string, { id: string; itemId: string | null }>();
    const lines: string[] = [];
    for (const g of input.items) {
      if (!g.notes.length && !g.topics.length) continue;
      lines.push(`## ${itemLabel(g.item)}`);
      const gist = g.notes.find((n) => n.kind === "summary");
      if (gist) lines.push(gist.text);
      const tKey = new Map<string, string>();
      for (const t of g.topics) {
        const k = `T${topicKey.size + 1}`;
        topicKey.set(k, { id: t.id, itemId: g.item?.id ?? null });
        tKey.set(t.id, k);
        lines.push(`- ${k} topic: ${t.topic}`);
      }
      for (const n of g.notes) {
        if (n.kind === "summary") continue;
        const k = `N${noteKey.size + 1}`;
        noteKey.set(k, n);
        const kind = n.kind === "action" ? "to-do" : n.kind === "decision" ? "decision" : "open question";
        const under = n.discussionId && tKey.get(n.discussionId) ? ` (under ${tKey.get(n.discussionId)})` : "";
        lines.push(`- ${k} ${kind}: ${n.text}${n.owner ? ` (owner: ${n.owner})` : ""}${under}`);
      }
      lines.push("");
    }
    const label = (itemId: string | null) => itemLabel(input.items.find((g) => (g.item?.id ?? null) === itemId)?.item ?? null);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: "text", text: `The meeting's notes, by agenda item:\n\n${lines.join("\n").trim() || "(no notes)"}\n\nScreenshots people saved during it, in order:` },
    ];
    input.snaps.forEach((s, i) => {
      content.push(
        {
          type: "text",
          text: `S${i + 1}: saved by ${s.by} at ${new Date(s.at).toISOString().slice(11, 16)} while on ${label(s.itemId)}.${
            s.caption ? ` First look: ${s.caption}` : ""
          }${s.said.length ? `\nSaid around then:\n${s.said.slice(0, 6).join("\n")}` : ""}`,
        },
        { type: "image", source: { type: "base64", media_type: s.image.mediaType, data: s.image.data } },
      );
    });
    content.push({ type: "text", text: "Write the recap, and place and caption every screenshot." });
    const out = await this.parse(
      RecapSchema,
      content,
      `You write the recap of a team meeting from its notes, and place the screenshots people saved during it.

Summary: 2-4 sentences, plain prose, no headings, lead with what matters most.

Screenshots: each gets one home. If it backs a to-do, decision or open question (it shows the thing decided on, the work to do, or what the question is about, so someone acting on that note would want to see it), give that note's key. Otherwise give the topic it was discussed in. Prefer notes and topics from the item it was saved on. Give neither only when it relates to nothing in the notes.

Caption: one line saying what the image shows and why it mattered to the conversation. Name the specific thing on screen (the chart, error, design, number or page) and what the team said or decided about it. It may be a problem, but it may just as well be a design under review, a number someone pointed at, or context for the talk. Don't invent anything that isn't in the image or the notes.`,
      "medium",
    );
    if (!out) return { summary: await this.summarizeMeeting(perItem), snaps: [] };
    const snaps: RecapDraft["snaps"] = [];
    for (const r of out.screenshots) {
      const snap = input.snaps[Number(r.key.replace(/^S/i, "")) - 1];
      if (!snap || snaps.some((x) => x.id === snap.id)) continue;
      const note = r.note ? noteKey.get(r.note) : undefined;
      const topic = r.topic ? topicKey.get(r.topic) : undefined;
      snaps.push({
        id: snap.id,
        noteId: note?.id ?? null,
        discussionId: note?.discussionId ?? topic?.id ?? null,
        caption: r.caption.trim().slice(0, 200),
      });
    }
    return { summary: out.summary.trim(), snaps };
  }

  async summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string> {
    const body = perItem
      .filter((p) => p.notes.length)
      .map((p) => `## ${itemLabel(p.item)}\n${p.notes.map((n) => `- ${n.kind}: ${n.text}${n.owner ? ` (${n.owner})` : ""}`).join("\n")}`)
      .join("\n\n");
    if (!body) return "";
    const res = await this.client.beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 2000,
      system: "Write a 2-4 sentence recap of a team meeting from its per-item notes. Plain prose, no headings, lead with what matters most.",
      messages: [{ role: "user", content: body }],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") return "";
    return res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}

// ---------------------------------------------------------------------------
// Stand-in used without an API key. Good enough to demo the flow, and labelled
// in the UI as heuristic notes.

const DECISION = /\b(let'?s go with|we('| wi)ll go with|decided|decision|agreed|we('| a)re going (to|with)|ship it|final answer)\b/i;
const ACTION = /\b(i'?ll|i will|can you|could you|will you|action item|todo|to-do|follow up|take that|on it|by (monday|tuesday|wednesday|thursday|friday|tomorrow|eod|end of day))\b/i;

export class HeuristicAgent implements Agent {
  async notesFor(item: Item | null, segments: Segment[]): Promise<ItemNotesDraft> {
    if (!segments.length) return { notes: [], discussions: [] };
    const notes: ItemNotesDraft["notes"] = [];
    for (const s of segments) {
      const sentences = s.text.split(/(?<=[.!?])\s+/).filter(Boolean);
      for (const t of sentences) {
        if (DECISION.test(t)) notes.push({ kind: "decision", text: t, owner: null, discussion: 0 });
        else if (ACTION.test(t)) {
          const asks = /\b(can|could|will) you\b/i.test(t);
          const named = t.match(/^([A-Z][a-z]+),/)?.[1];
          notes.push({ kind: "action", text: t, owner: asks ? (named ?? null) : s.speakerName, discussion: 0 });
        } else if (t.trim().endsWith("?") && t.split(" ").length > 3) notes.push({ kind: "question", text: t, owner: null, discussion: 0 });
      }
    }
    const speakers = [...new Set(segments.filter((s) => s.kind === "speech").map((s) => s.speakerName))];
    notes.unshift({
      kind: "summary",
      text: `${speakers.length ? speakers.join(", ") : "The team"} discussed this (${segments.length} remark${segments.length === 1 ? "" : "s"}).`,
      owner: null,
      discussion: null,
    });
    // Without a model, the whole item is one discussion and each person's
    // position is the first thing they said.
    const first = new Map<string, string>();
    for (const s of segments) if (!first.has(s.speakerName)) first.set(s.speakerName, s.text);
    const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
    const has = (k: Note["kind"]) => notes.some((n) => n.kind === k);
    return {
      notes,
      discussions: [
        {
          topic: clip(item?.title ?? segments[0].text, 70),
          positions: [...first].map(([speaker, text]) => ({ speaker, position: clip(text, 90) })),
          outcome: has("decision") ? "decided" : has("action") ? "action" : has("question") ? "open" : "info",
          segmentIndexes: segments.map((_, i) => i),
          continuesId: null,
        },
      ],
    };
  }

  async matchScreen(_jpeg: string, items: Item[], currentItemId: string | null): Promise<ScreenMatch> {
    // Without vision we can only notice that the screen changed. Suggest the
    // next item so the confirm flow can be exercised.
    if (!items.length) return { itemId: null, confidence: 0, reason: "" };
    const idx = items.findIndex((i) => i.id === currentItemId);
    const next = items[(idx + 1) % items.length];
    return { itemId: next.id, confidence: 0.6, reason: "The screen changed (mock agent guesses the next item)" };
  }

  async draftDeck(brief: string): Promise<DraftSlide[]> {
    return outlineToSlides(brief);
  }

  async polishAgenda(): Promise<AgendaPolishRow[] | null> {
    return null;
  }

  async describeSnap(): Promise<string | null> {
    return null;
  }

  async frameBacks(): Promise<{ key: string; caption: string } | null> {
    return null;
  }

  async recapMeeting(input: RecapInput): Promise<RecapDraft> {
    return { summary: await this.summarizeMeeting(input.items), snaps: [] };
  }

  async summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string> {
    const discussed = perItem.filter((p) => p.notes.length);
    const decisions = discussed.flatMap((p) => p.notes.filter((n) => n.kind === "decision")).length;
    const actions = discussed.flatMap((p) => p.notes.filter((n) => n.kind === "action")).length;
    if (!discussed.length) return "";
    return `Covered ${discussed.length} item${discussed.length === 1 ? "" : "s"} with ${decisions} decision${decisions === 1 ? "" : "s"} and ${actions} action item${actions === 1 ? "" : "s"}.`;
  }
}
