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
  notes: Array<DraftNote & { discussion: number | null }>;
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

export interface ScreenMatch {
  itemId: string | null;
  confidence: number;
  reason: string;
}

export interface Agent {
  /** Groups an item's talk into discussions and writes the notes that came out of each. */
  notesFor(item: Item | null, segments: Segment[], earlier?: EarlierDiscussion[]): Promise<ItemNotesDraft>;
  matchScreen(jpegDataUrl: string, items: Item[], currentItemId: string | null): Promise<ScreenMatch>;
  summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string>;
  /** Slides from a brief: an outline, rough notes or a one-line ask. */
  draftDeck(brief: string): Promise<DraftSlide[]>;
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
      decisions: z.array(z.string()),
      action_items: z.array(z.object({ text: z.string().describe("Phrased as a task, e.g. 'File the annual-plan pricing bug against billing'"), owner: z.string().nullable() })),
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

  async notesFor(item: Item | null, segments: Segment[], earlier: EarlierDiscussion[] = []): Promise<ItemNotesDraft> {
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
    const out = await this.parse(
      NotesSchema,
      `Item: ${itemLabel(item)}${item?.description ? `\nItem description: ${item.description.slice(0, 1500)}` : ""}${before}

What was said while this item was in focus (speech transcript and in-room chat, in order):
${numbered}`,
      `You take notes in a team meeting. You are given what was said while one agenda item (a ticket, task or slide) was in focus.

Group the talk into discussions: a discussion is a stretch of back-and-forth about one question or subject. Most items have one to three. A status update with no back-and-forth is one discussion with outcome "info". Every line belongs to at most one discussion; skip small talk.

For each discussion, give each participant's position in one short line, how it ended, and the decisions actually made, the action items with their owner (the speaker's name; null if nobody took it), and the questions left open. Phrase action items as tasks, not quotes. If it picks up a discussion from an earlier meeting in the list, give that id.

Do not invent anything that was not said. Speech-to-text errors are possible; read through them. Keep each line short.`,
      "low",
      config.notesModel,
    );
    if (!out) return { notes: [], discussions: [] };
    const known = new Set(earlier.map((d) => d.id));
    const notes: ItemNotesDraft["notes"] = out.summary.trim() ? [{ kind: "summary", text: out.summary.trim(), owner: null, discussion: null }] : [];
    out.discussions.forEach((d, i) => {
      notes.push(
        ...d.decisions.map((t) => ({ kind: "decision" as const, text: t, owner: null, discussion: i })),
        ...d.action_items.map((a) => ({ kind: "action" as const, text: a.text, owner: a.owner, discussion: i })),
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

  async summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string> {
    const discussed = perItem.filter((p) => p.notes.length);
    const decisions = discussed.flatMap((p) => p.notes.filter((n) => n.kind === "decision")).length;
    const actions = discussed.flatMap((p) => p.notes.filter((n) => n.kind === "action")).length;
    if (!discussed.length) return "";
    return `Covered ${discussed.length} item${discussed.length === 1 ? "" : "s"} with ${decisions} decision${decisions === 1 ? "" : "s"} and ${actions} action item${actions === 1 ? "" : "s"}.`;
  }
}
