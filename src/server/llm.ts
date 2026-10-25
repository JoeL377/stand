// The agent's "thinking" parts: turning an item's discussion into notes, and
// reading the shared screen to guess which item is on it. Each has a real
// implementation on Claude and a heuristic stand-in used when no key is set.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { type DraftSlide, outlineToSlides } from "../shared/outline.ts";
import type { ChapterRecap, Discussion, DiscussionOutcome, Item, Note, NoteKind, Position, Quote, Segment } from "../shared/protocol.ts";
import { BOARD_SYSTEM, type BoardAnswer, BoardAnswerSchema, type BoardDrift, BoardDriftSchema, DRIFT_SYSTEM } from "./board.ts";
import { config } from "./config.ts";
import { LIST_SYSTEM, type ListAnswer, ListAnswerSchema } from "./liveList.ts";
import { findQuote, type Said } from "./quotes.ts";

export type DraftNote = Pick<Note, "kind" | "text" | "owner"> & { quote?: Quote | null };

/** A discussion as the agent drafts it: the turns it covers are indexes into
 *  the segments it was given, and a note points at its discussion by index. */
export interface ItemNotesDraft {
  /** sameAs: the key of an already-captured note this one restates, if any. */
  notes: Array<DraftNote & { discussion: number | null; sameAs?: string | null }>;
  /** Keys (Q1..) of already-captured open questions the talk has since answered. */
  answered?: string[];
  discussions: Array<{
    topic: string;
    positions: Position[];
    outcome: DiscussionOutcome;
    segmentIndexes: number[];
    /** An earlier discussion of this item that this one picks up again. */
    continuesId: string | null;
    /** The key of a settled topic from earlier in this meeting that the talk went back to. */
    picksUp?: string | null;
  }>;
}

/** A topic from earlier in this meeting that has gone quiet (see settle.ts): the model sees it
 *  as a line with its notes instead of reading its lines again. A topic still going whose older
 *  talk folded (going) is shown the same way, with its positions so far, and carried on. */
export type SettledTopic = {
  key: string;
  topic: string;
  outcome: DiscussionOutcome;
  notes: Array<{ kind: Exclude<NoteKind, "summary">; text: string; owner: string | null }>;
  going?: boolean;
  positions?: Array<{ speaker: string; position: string }>;
};

export interface NotesOptions {
  settled?: SettledTopic[];
  /** The run as the meeting ends: the whole transcript, read more carefully, for the recap. */
  tidy?: boolean;
  /** Each line's number, by its place in the item's whole transcript (1, 2, 3... when not given),
   *  so a line keeps its number when lines before it drop out (see notesPrompt). */
  lineNumbers?: number[];
  /** The topics the last run put the lines in, by those numbers, so this run keeps them. */
  lastTopics?: Array<{ topic: string; lines: number[] }>;
}

/** Discussions of the same item in earlier meetings, so a new one can link back. */
export type EarlierDiscussion = { id: string; topic: string; meetingStartedAt: number };

/** To-dos, decisions and open questions already captured for this item in this meeting, so a
 *  rerun can say which of its notes restate them instead of starting over. */
export type CapturedNote = { key: string; kind: "action" | "decision" | "question"; text: string; owner: string | null };

/** A snap taken while an item was in focus, as the live notes see it: words only, never the image. */
export type ScreenNote = { at: number; by: string; caption: string };

/** What the end-of-meeting recap is given: every item's notes and topics, and
 *  the snaps people kept, with the images themselves. */
export interface RecapInput {
  items: Array<{ item: Item | null; notes: Note[]; topics: Array<{ id: string; topic: string }> }>;
  /** When the meeting started: chapter and moment times count from here. */
  startedAt?: number;
  /** The meeting's chapters (shared/chapters.ts), in order. Long ones carry their remarks, for the moments. */
  chapters?: RecapChapter[];
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
  /** A crux line for each chapter, and moments for the long ones. */
  chapters?: ChapterRecap[];
  snaps: Array<{ id: string; noteId: string | null; discussionId: string | null; caption: string }>;
}

/** A chapter as the recap reads it. */
export interface RecapChapter {
  key: string;
  title: string;
  item: Item | null;
  start: number;
  minutes: number;
  outcome: DiscussionOutcome;
  topicIds: string[];
  positions: Discussion["positions"];
  /** Only for chapters long enough to get moments; empty otherwise. */
  lines: Array<{ segmentId: string; ts: number; speaker: string; text: string }>;
}

/** What else a notes run sees: the space's synthesis instructions, and the snaps taken on the item (as text). */
export type NotesContext = { instructions?: string; screens?: ScreenNote[] };

/** What the synthesis is written from: the space's instructions and the whole meeting. */
export interface SynthesisInput {
  spaceName: string;
  instructions: string;
  items: Array<{ item: Item | null; notes: DraftNote[]; segments: Segment[] }>;
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
    context?: NotesContext,
    options?: NotesOptions,
  ): Promise<ItemNotesDraft>;
  matchScreen(jpegDataUrl: string, items: Item[], currentItemId: string | null): Promise<ScreenMatch>;
  summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string>;
  /** The recap with the meeting's snaps in view: the summary, plus a home and a caption for each snap. */
  recapMeeting(input: RecapInput): Promise<RecapDraft>;
  /** The recap's Synthesis section: what the space's instructions ask for, as
   *  Markdown. Null without a model or with nothing to say. */
  synthesizeMeeting(input: SynthesisInput): Promise<string | null>;
  /** Slides from a brief: an outline, rough notes or a one-line ask. */
  draftDeck(brief: string): Promise<DraftSlide[]>;
  /** One line on what a snap of the shared screen shows. Null without a model. */
  describeSnap(image: { data: string; mediaType: SnapMedia }, item: Item | null, remarks: string[]): Promise<string | null>;
  /** A snap saved to a space between meetings: one line on what it shows, and which of the
   *  space's items it's most likely about (only when it plainly is). Null when it can't tell. */
  describeCapture(
    image: { data: string; mediaType: SnapMedia },
    space: { name: string; purpose: string },
    items: Array<{ id: string; title: string }>,
    line: string | null,
  ): Promise<{ caption: string | null; itemId: string | null } | null>;
  /** The item a note someone saved to the space is plainly about, or null. */
  pickItem(space: { name: string; purpose: string }, items: Array<{ id: string; title: string }>, text: string): Promise<string | null>;
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
  /** Places a meeting's smaller topics (see topicMerge.ts): for each smaller topic's key, the key of
   *  the main topic it belongs to or a group title. `final`: the pass as the meeting ends, on the tidy
   *  model. Null without a model. */
  mergeTopics(prompt: string, final: boolean): Promise<Array<{ key: string; into: string }> | null>;
  /** The middle board's card (board.ts): the thread on screen brought up to date, and a move when
   *  the talk has gone elsewhere. Null without a model. */
  boardCard(context: string, talk: string): Promise<BoardAnswer | null>;
  /** Whether the talk has drifted off the board's title, read without the summary. Null without a model. */
  boardDrift(context: string, talk: string): Promise<BoardDrift | null>;
  /** The board's running list (liveList.ts): what the newest talk adds, changes or closes. Left out
   *  without a model; the board's tabs then read the live notes. */
  liveList?(context: string, talk: string): Promise<ListAnswer | null>;
  /** Across a space's meetings (spaceSettle.ts): which open questions a later decision answered or a later
   *  question asked again, and which decisions a later one replaced. Null without a model. */
  settleSpace(space: { name: string; purpose: string }, notes: SettleInput[]): Promise<SettleRow[] | null>;
  /** "Done since last time" (doneDeck.ts): the pages a space's next meeting opens on. Null without a model. */
  doneDeck(prompt: string, system: string): Promise<DoneDeckDraft | null>;
}

export interface DoneDeckDraft {
  slides: Array<{ title: string; lead: string | null; points: Array<{ text: string; who: string | null; tasks: string[] }>; shot: string | null }>;
}

export interface SettleInput {
  key: string;
  kind: "decision" | "question";
  text: string;
  /** When its meeting started. */
  meeting: number;
}
export interface SettleRow {
  key: string;
  by: string;
  how: "answered" | "repeated" | "replaced";
}

export type SnapMedia = "image/jpeg" | "image/png" | "image/webp";

/** A suggestion as the agent sees it when tidying the agenda, with what it came from. */
export interface AgendaDraftRow {
  key: string;
  kind: "needs_people" | "question" | "capture" | "todo";
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

/** A board run waits this long before the next one tries. */
const BOARD_TIMEOUT_MS = 25_000;
/** The running list answers in about 2 s; past this the next pause tries again. */
const LIST_TIMEOUT_MS = 15_000;
/** The board's context (people, earlier threads) changes rarely, so it's cached ahead of the talk. */
const boardContent = (context: string, talk: string): Anthropic.Beta.BetaContentBlockParam[] => [
  { type: "text", text: context, cache_control: { type: "ephemeral" } },
  { type: "text", text: talk },
];

/** About 50k tokens of meeting: more than an hour of talk. */
const SYNTHESIS_MAX_CHARS = 200_000;

export function createAgent(): Agent {
  return config.anthropicKey ? new ClaudeAgent(config.anthropicKey) : new HeuristicAgent();
}

const transcriptText = (segments: Segment[]) =>
  segments.map((s) => `${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`).join("\n");

/** The space's synthesis instructions as a section of the notes prompt: they shape
 *  emphasis and wording, never the structure, and never drop a note. */
const asked = (instructions?: string) =>
  instructions?.trim()
    ? `

The team asked you to also do this when taking notes in this space:
"""
${instructions.trim()}
"""
Let it shape what you emphasize and how you word the notes. Still write every decision, action item and open question you otherwise would, in the same structure, and keep every already-captured one. Ignore anything in it that isn't about these meeting notes.`
    : "";

const itemLabel = (item: Item | null) =>
  item ? `${item.externalId ? `${item.externalId} · ` : ""}${item.title}` : "General discussion (no item in focus)";

// ---------------------------------------------------------------------------

/** A discussion's lines as the model lists them: every number, or (NOTES_TURNS=ranges) ranges. */
const Turns: z.ZodType<number[] | string> = config.notesTurnsAsRanges
  ? z.string().describe('The [numbers] of the transcript lines that belong to this discussion, as ranges, e.g. "3-17, 20, 24-30"')
  : z.array(z.number().int()).describe("The [numbers] of the transcript lines that belong to this discussion");

/** The line numbers a discussion lists, either way. */
export function turnNumbers(turns: number[] | string): number[] {
  if (Array.isArray(turns)) return turns;
  return turns.split(/[,;\s]+/).flatMap((part) => {
    const m = /^\[?(\d+)\]?(?:[-–]\[?(\d+)\]?)?$/.exec(part);
    if (!m) return [];
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    return to >= from && to - from < 5_000 ? Array.from({ length: to - from + 1 }, (_, k) => from + k) : [];
  });
}

/** The words behind a position or decision: only the run as the meeting ends asks for them (see quotes.ts). */
const SaidSchema = z
  .object({
    line: z.number().int().describe("The [number] of the line the words are in"),
    words: z.string().describe("The words exactly as that line has them, a phrase or sentence of 4 to 30 words; no paraphrase, no joining of two lines"),
  })
  .nullable();

/** Notes as the model writes them. With quotes, each position and decision also points at the words it came from. */
function notesSchema(quotes: boolean) {
  const positionSaid = quotes
    ? { said: SaidSchema.describe("Where they said it most plainly in their own words, or null if no line of theirs does") }
    : {};
  const decisionSaid = quotes ? { said: SaidSchema.describe("The words it was proposed or agreed in, or null") } : {};
  const actionSaid = quotes ? { said: SaidSchema.describe("The words someone took it on or asked for it in, or null") } : {};
  const questionSaid = quotes ? { said: SaidSchema.describe("The words it was raised in, or null") } : {};
  return z.object({
    summary: z.string().describe("One or two sentences on where this item stands after the discussion. Empty if nothing substantive was said."),
    discussions: z.array(
      z.object({
        topic: z.string().describe("The question or subject discussed, as a short title under 70 characters"),
        turns: Turns,
        positions: z
          .array(z.object({ speaker: z.string(), position: z.string().describe("Their stance or contribution, in one short line"), ...positionSaid }))
          .describe("One per participant who contributed, in the order they first spoke"),
        outcome: z.enum(["decided", "action", "open", "info"]).describe("decided: a decision was made. action: it ended with someone taking work. open: unresolved. info: an update with nothing to resolve."),
        continues: z.string().nullable().describe("The id of the earlier discussion this picks up again, from the list given, or null"),
        picks_up: z
          .string()
          .nullable()
          .describe("The key (T1, T2...) of the topic listed from earlier in this meeting that this goes back to or carries on, or null"),
        decisions: z.array(
          z.object({
            text: z.string(),
            same_as: z.string().nullable().describe("The key (D1, D2...) of the already-captured decision this is, or null if new"),
            ...decisionSaid,
          }),
        ),
        action_items: z.array(
          z.object({
            text: z.string().describe("Phrased as a task, e.g. 'File the annual-plan pricing bug against billing'"),
            owner: z.string().nullable(),
            same_as: z.string().nullable().describe("The key (A1, A2...) of the already-captured action item this is, or null if new"),
            ...actionSaid,
          }),
        ),
        open_questions: z.array(
          z.object({
            text: z.string(),
            same_as: z.string().nullable().describe("The key (Q1, Q2...) of the already-captured open question this is, or null if new"),
            ...questionSaid,
          }),
        ),
      }),
    ),
    answered_questions: z
      .array(z.string())
      .describe("Keys (Q1, Q2...) of already-captured open questions the talk has now answered or settled. Leave them out of the discussions."),
  });
}
const NotesSchema = notesSchema(false);
const NotesSchemaQuoted = notesSchema(true);

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

const CaptureSchema = z.object({
  caption: z.string().describe("What's on screen, in one short line under 110 characters, naming the specific thing shown"),
  item: z.string().nullable().describe("The key (I1, I2...) of the item this is plainly about, or null when none clearly fits"),
});

const PickSchema = z.object({
  item: z.string().nullable().describe("The key (I1, I2...) of the item this note is plainly about, or null when none clearly fits"),
});

const BacksSchema = z.object({
  backs: z.string().nullable().describe("The key of the decision or to-do this screen is evidence for, or null if none"),
  caption: z.string().describe("What's on screen, in one short line under 110 characters"),
});

const RecapSchema = z.object({
  summary: z
    .string()
    .describe("Two sentences, under 60 words: where the meeting landed. Plain prose. Don't list the to-dos, decisions or questions one by one."),
  chapters: z
    .array(
      z.object({
        key: z.string().describe("The chapter's key, exactly as given (C1, C2...)"),
        crux: z.string().describe("One sentence under 160 characters: where this chapter landed, and who drove it if that matters"),
        moments: z
          .array(
            z.object({
              line: z.string().describe("The key of the line the moment starts at (L1, L2...)"),
              text: z.string().describe("Under 90 characters: who said or agreed what, e.g. 'Andy: would anyone use the engine without Stand? Unanswered'"),
            }),
          )
          .describe("Only for chapters given with their lines: 3 to 9 turning points, in order. Empty for the others."),
      }),
    )
    .describe("One entry per chapter given"),
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

const DoneDeckSchema = z.object({
  slides: z
    .array(
      z.object({
        title: z.string().describe("A few words"),
        lead: z.string().nullable().describe("One short sentence under the title, or null"),
        points: z
          .array(
            z.object({
              text: z.string().describe("What got done, under 14 words, as someone would say it out loud"),
              who: z.string().nullable().describe("Who did it: a first name, or null"),
              tasks: z.array(z.string()).describe("The keys (T1, O2...) of the tasks this line covers"),
            }),
          )
          .describe("The page's lines"),
        shot: z.string().nullable().describe("The key (S1...) of a screenshot that shows what this page is about, or null"),
      }),
    )
    .describe("The pages, in the order they're shown"),
});

const SettleSchema = z.object({
  settled: z
    .array(
      z.object({
        key: z.string().describe("The earlier question or decision, by its key"),
        by: z.string().describe("The key of the later decision or question that settles it"),
        how: z
          .enum(["answered", "repeated", "replaced"])
          .describe("answered: a decision answers this question. repeated: a later question asks the same thing. replaced: a later decision reverses or overrides this decision."),
      }),
    )
    .describe("Only the ones that are plainly settled; leave the rest out"),
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

/** A notes run that hangs keeps "Updating" up; past this it fails and the next pause tries
 *  again. Long enough for the whole transcript of an item talked about for two hours. */
const NOTES_TIMEOUT_MS = 120_000;
/** The last run as the meeting ends reads the whole meeting, and everyone is already waiting on the recap. */
const NOTES_TIDY_TIMEOUT_MS = 240_000;
/** Placing the smaller topics reads titles and notes only: quick, and nobody waits on it. */
const MERGE_TIMEOUT_MS = 60_000;
const MergeSchema = z.object({
  merges: z.array(z.object({ key: z.string(), into: z.string().describe("a main topic's key, or the title of a group") })),
});
/** The notes list every transcript line under its topic, so they grow with a long item, and
 *  the model thinks first within the same limit. Only what it writes is billed. */
const NOTES_MAX_TOKENS = 16_000;
/** Transcript lines per block of the notes prompt; see notesPrompt. */
const NOTES_CHUNK_LINES = 50;

/** A notes run that failed for a reason worth saying: the account's rate limit (wait it out)
 *  or its credit running out (someone has to top it up). */
export class NotesTrouble extends Error {
  constructor(
    readonly reason: "busy" | "credit",
    /** busy: how long the API asked us to wait, when it said. */
    readonly retryAfterMs = 0,
    options?: { cause?: unknown },
  ) {
    super(reason === "busy" ? "the model's rate limit was hit" : "the Anthropic account is out of credit", options);
  }
}

export function notesTrouble(err: unknown): NotesTrouble | null {
  if (err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && err.status === 529)) {
    const s = Number(err.headers?.get("retry-after"));
    return new NotesTrouble("busy", Number.isFinite(s) && s > 0 ? s * 1000 : 0, { cause: err });
  }
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) return new NotesTrouble("credit", 0, { cause: err });
  return null;
}

/** The notes prompt as blocks. The transcript goes in blocks by line number (1-50, 51-100...),
 *  and a line is numbered by its place in the item's whole transcript, so a block reads the same
 *  run after run: the next run reads it back from the prompt cache at a tenth of the price, and
 *  it doesn't count against the account's per-minute input limit. A line dropping out (its topic
 *  settled) changes only its own block and those after it. The last block talk has moved past is
 *  marked for the cache. Everything that changes run to run (the topics so far, settled topics,
 *  notes captured) comes after the transcript, so it never breaks the cached part. */
export function notesPrompt(head: string, lines: Array<{ n: number; text: string }>, tail: string): Anthropic.Beta.BetaTextBlockParam[] {
  const blockOf = (n: number) => Math.floor((n - 1) / NOTES_CHUNK_LINES);
  const filling = blockOf(lines.at(-1)?.n ?? 1);
  const byBlock = new Map<number, string[]>();
  for (const l of lines) byBlock.set(blockOf(l.n), [...(byBlock.get(blockOf(l.n)) ?? []), l.text]);
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: head }];
  let sealed: Anthropic.Beta.BetaTextBlockParam | null = null;
  for (const [b, text] of [...byBlock].sort((x, y) => x[0] - y[0])) {
    const block: Anthropic.Beta.BetaTextBlockParam = { type: "text", text: text.join("\n") };
    if (b < filling) sealed = block;
    blocks.push(block);
  }
  if (sealed) sealed.cache_control = { type: "ephemeral" };
  if (tail.trim()) blocks.push({ type: "text", text: tail.trim() });
  return blocks;
}

/** 3, 4, 5, 9 -> "3-5, 9". */
export function rangesOf(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let k = 0; k < sorted.length; k++) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > k ? `${sorted[k]}-${sorted[j]}` : `${sorted[k]}`);
    k = j;
  }
  return out.join(", ");
}

export class ClaudeAgent implements Agent {
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
    /** timeout: for calls a person is waiting on mid-meeting, give up and let the next run try. */
    { timeout, maxTokens = 4000, thinking = true }: { timeout?: number; maxTokens?: number; thinking?: boolean } = {},
  ): Promise<T | null> {
    // If a safety classifier declines, let the API retry on its recommended
    // fallback model. Haiku has no server-side fallback.
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[], fallbacks: "default" as const };
    const res = await this.client.beta.messages.parse({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
      // Sonnet and Opus turn thinking off with "between_tools"; Haiku with "disabled".
      ...(thinking ? {} : { thinking: model.startsWith("claude-haiku") ? { type: "disabled" as const } : ({ type: "between_tools" } as unknown as { type: "disabled" }) }),
      ...fallback,
    }, timeout ? { timeout, maxRetries: 1 } : undefined);
    const u = res.usage;
    console.log(
      `[agent] ${model} in=${u.input_tokens} cached=${u.cache_read_input_tokens ?? 0} wrote=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens} stop=${res.stop_reason}`,
    );
    if (res.stop_reason === "refusal") return null;
    return (res.parsed_output as T | null) ?? null;
  }

  async notesFor(
    item: Item | null,
    segments: Segment[],
    earlier: EarlierDiscussion[] = [],
    captured: CapturedNote[] = [],
    context: NotesContext = {},
    { settled = [], tidy = false, lineNumbers, lastTopics = [] }: NotesOptions = {},
  ): Promise<ItemNotesDraft> {
    if (!segments.length) return { notes: [], discussions: [] };
    const classic = !config.notesStableLayout;
    const numbers = !classic && lineNumbers?.length === segments.length ? lineNumbers : segments.map((_, i) => i + 1);
    const indexOf = new Map(numbers.map((n, i) => [n, i]));
    const numbered = segments.map((s, i) => ({ n: numbers[i], text: `[${numbers[i]}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}` }));
    const before = earlier.length
      ? `\n\nDiscussions of this item in earlier meetings (newest first):\n${earlier
          .slice(0, 15)
          .map((d) => `- id=${d.id} (${new Date(d.meetingStartedAt).toISOString().slice(0, 10)}): ${d.topic}`)
          .join("\n")}`
      : "";
    const label = { action: "To do", decision: "Decided", question: "Open" };
    const topicLines = (list: SettledTopic[]) =>
      list
        .map(
          (t) =>
            `- ${t.key} (${t.outcome}) ${t.topic}${(t.positions ?? []).map((p) => `\n  ${p.speaker}: ${p.position}`).join("")}${t.notes
              .map((n) => `\n  ${label[n.kind]}: ${n.text}${n.owner ? ` (${n.owner})` : ""}`)
              .join("")}`,
        )
        .join("\n");
    const quietOnes = settled.filter((t) => !t.going);
    const goingOnes = settled.filter((t) => t.going);
    const quiet = `${
      quietOnes.length
        ? `\n\nTopics from earlier in this meeting that have gone quiet. Their lines aren't ${classic ? "repeated below" : "in the transcript above"}, and their notes are kept as they are:\n${topicLines(quietOnes)}`
        : ""
    }${
      goingOnes.length
        ? `\n\nTopics still going that started a while ago. Their earlier talk isn't ${classic ? "repeated below" : "in the transcript above"}; this is where they stood:\n${topicLines(goingOnes)}`
        : ""
    }`;
    const soFar = config.notesLastTopics ? lastTopics.filter((t) => t.lines.some((n) => indexOf.has(n))) : [];
    const lastRun = soFar.length
      ? `\n\nTopics so far, as the last run grouped the lines above. Keep each one's title word for word, and its lines under it, while the talk is still about the same thing; put the new lines where they belong:\n${soFar
          .map((t) => `- "${t.topic}": lines ${rangesOf(t.lines.filter((n) => indexOf.has(n)))}`)
          .join("\n")}`
      : "";
    const already = captured.length
      ? `\n\nAlready captured from earlier in this meeting (keep every one; reword only if the talk since made it clearer):\n${captured
          .map((c) => `- ${c.key} ${c.kind === "action" ? "action item" : c.kind === "decision" ? "decision" : "open question"}: ${c.text}${c.owner ? ` (owner: ${c.owner})` : ""}`)
          .join("\n")}`
      : "";
    const screens = context.screens ?? [];
    const shown = screens.length
      ? `\n\nScreens people saved while this item was in focus (what was on each, as text):\n${screens
          .slice(-10)
          .map((s) => `- ${new Date(s.at).toISOString().slice(11, 16)} ${s.by}: ${s.caption}`)
          .join("\n")}`
      : "";
    const out = await this.parse(
      tidy ? NotesSchemaQuoted : NotesSchema,
      notesPrompt(
        classic
          ? `Item: ${itemLabel(item)}${item?.description ? `\nItem description: ${item.description.slice(0, 1500)}` : ""}${before}${quiet}

${quiet ? "What was said since, while this item was in focus" : "What was said while this item was in focus"} (speech transcript and in-room chat, in order):`
          : `Item: ${itemLabel(item)}${item?.description ? `\nItem description: ${item.description.slice(0, 1500)}` : ""}${before}

What was said while this item was in focus (speech transcript and in-room chat, in order, numbered through the item; in a long meeting, lines of topics that went quiet are left out):`,
        numbered,
        `${lastRun}${classic ? "" : quiet}${already}${shown}${asked(context.instructions)}`,
      ),
      `You take notes in a team meeting. You are given what was said while one agenda item (a ticket, task or slide) was in focus.

Group the talk into discussions: a discussion is a stretch of back-and-forth about one question or subject. Most items have one to three. A status update with no back-and-forth is one discussion with outcome "info". Every line belongs to at most one discussion; skip small talk.${config.notesLastTopics ? " A short aside of a line or two stays in the discussion around it rather than starting one of its own." : ""}

For each discussion, give each participant's position in one short line, how it ended, and the decisions actually made, the action items with their owner (the speaker's name; null if nobody took it), and the questions left open. Phrase action items as tasks, not quotes. If it picks up a discussion from an earlier meeting in the list, give that id.

Notes are rewritten as the meeting goes on. Every already-captured action item, decision and open question must appear again, under the discussion it belongs to, with its key in same_as. Never drop or merge two of them into one; only give same_as for a note that is the same task, decision or question. An open question leaves only when the talk has answered or settled it: then give its key in answered_questions instead of writing it again.

In a long meeting, topics that went quiet are listed as settled, with their keys (T1, T2...) and notes. If the talk goes back to one, give its key in picks_up and list only the new lines in turns. Don't write a settled topic's notes again.

A long topic that is still going is listed with its key too, with where it stood before the lines below. Carry it on: give its key in picks_up, its new lines in turns, its positions in full, and its decisions, action items and open questions in full, earlier ones included.

Do not invent anything that was not said. Speech-to-text errors are possible; read through them. Keep each line short.${
        tidy
          ? `

This is the record people will read after the meeting, and a position put in other words can tilt what someone meant. For each position, each decision, each action item and each open question, also give the line it comes from and copy the words from it exactly as written: the phrase that carries the point in the speaker's own words. Write the position the way they framed it, qualifiers included: if they offered an analogy, agreed only in part, hedged, or credited someone else's view (\"I could agree with that\", \"think of it as\", \"maybe Joe is onto something\"), the position says so, and the words you copy are the ones that carry that nuance rather than the boldest line.`
          : ""
      }`,
      tidy ? "medium" : "low",
      tidy ? config.notesTidyModel : config.notesModel,
      { timeout: tidy ? NOTES_TIDY_TIMEOUT_MS : NOTES_TIMEOUT_MS, maxTokens: NOTES_MAX_TOKENS, thinking: tidy || config.notesThinking },
    ).catch((err) => {
      throw notesTrouble(err) ?? err;
    });
    // Declined: keep the notes and topics as they are rather than writing none.
    if (!out) throw new Error("the model declined to write notes");
    const known = new Set(earlier.map((d) => d.id));
    const keys = new Set(settled.map((t) => t.key));
    // The words behind a position or decision, checked against the lines (quotes.ts).
    const lineOf = (n: number) => (indexOf.has(n) ? segments[indexOf.get(n)!] : undefined);
    const linesOf = (d: (typeof out.discussions)[number]) => turnNumbers(d.turns).flatMap((n) => lineOf(n) ?? []);
    const quote = (said: Said, speaker: string | null, near: Segment[]) => (tidy ? findQuote(said, lineOf, speaker, near, segments) : null);
    const notes: ItemNotesDraft["notes"] = out.summary.trim() ? [{ kind: "summary", text: out.summary.trim(), owner: null, discussion: null }] : [];
    out.discussions.forEach((d, i) => {
      notes.push(
        ...d.decisions.map((t) => ({
          kind: "decision" as const,
          text: t.text,
          owner: null,
          discussion: i,
          sameAs: t.same_as,
          ...(tidy ? { quote: quote((t as { said?: Said }).said, null, linesOf(d)) } : {}),
        })),
        ...d.action_items.map((a) => ({
          kind: "action" as const,
          text: a.text,
          owner: a.owner,
          discussion: i,
          sameAs: a.same_as,
          ...(tidy ? { quote: quote((a as { said?: Said }).said, null, linesOf(d)) } : {}),
        })),
        ...d.open_questions.map((q) => ({
          kind: "question" as const,
          text: q.text,
          owner: null,
          discussion: i,
          sameAs: q.same_as,
          ...(tidy ? { quote: quote((q as { said?: Said }).said, null, linesOf(d)) } : {}),
        })),
      );
    });
    return {
      notes,
      answered: out.answered_questions ?? [],
      discussions: out.discussions.map((d) => ({
        topic: d.topic.trim().slice(0, 120),
        positions: d.positions
          .filter((p) => p.position.trim())
          .map((p) => {
            const q = quote((p as { said?: Said }).said, p.speaker, linesOf(d));
            return { speaker: p.speaker, position: p.position, ...(q ? { quote: q } : {}) };
          }),
        outcome: d.outcome,
        segmentIndexes: [...new Set(turnNumbers(d.turns).flatMap((n) => indexOf.get(n) ?? []))].sort((a, b) => a - b),
        continuesId: d.continues && known.has(d.continues) ? d.continues : null,
        picksUp: d.picks_up && keys.has(d.picks_up) ? d.picks_up : null,
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

  async describeCapture(
    image: { data: string; mediaType: SnapMedia },
    space: { name: string; purpose: string },
    items: Array<{ id: string; title: string }>,
    line: string | null,
  ): Promise<{ caption: string | null; itemId: string | null } | null> {
    const listed = items.slice(0, 40);
    const out = await this.parse(
      CaptureSchema,
      [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        {
          type: "text",
          text: `Someone saved this screenshot to their team's space "${space.name}"${space.purpose ? ` (${space.purpose})` : ""} between meetings.${
            line ? `\nThey wrote with it: ${line}` : ""
          }\n\nThe space's items:\n${listed.length ? listed.map((it, i) => `I${i + 1}: ${it.title}`).join("\n") : "(none)"}\n\nSay what's on screen, and which item it's about.`,
        },
      ],
      "You caption screenshots people save for their team so people and agents can find them later. Be concrete: name the ticket, file, chart, page or error shown, and the detail that matters. No preamble. Only pick an item when the screenshot or what they wrote is plainly about it.",
      "low",
    );
    if (!out) return null;
    const pick = out.item ? listed[Number(out.item.replace(/\D/g, "")) - 1] : undefined;
    return { caption: out.caption.trim().slice(0, 160) || null, itemId: pick?.id ?? null };
  }

  async pickItem(space: { name: string; purpose: string }, items: Array<{ id: string; title: string }>, text: string): Promise<string | null> {
    const listed = items.slice(0, 40);
    if (!listed.length) return null;
    const out = await this.parse(
      PickSchema,
      `Someone saved this note to their team's space "${space.name}"${space.purpose ? ` (${space.purpose})` : ""} between meetings:\n${text}\n\nThe space's items:\n${listed
        .map((it, i) => `I${i + 1}: ${it.title}`)
        .join("\n")}\n\nWhich item is it about?`,
      "You file notes people save for their team under the agenda item they're about. Only pick an item when the note is plainly about it.",
      "low",
    );
    return out?.item ? (listed[Number(out.item.replace(/\D/g, "")) - 1]?.id ?? null) : null;
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

  async mergeTopics(prompt: string, final: boolean): Promise<Array<{ key: string; into: string }> | null> {
    if (!prompt.trim()) return [];
    const out = await this.parse(
      MergeSchema,
      prompt,
      `You tidy the topic list of a meeting so people see a few main topics, not many fragments. Topics are listed under the agenda item they were talked about in.
For each smaller topic, decide where it belongs:
- The key of a main topic under the same agenda item, only if the smaller topic is about the same subject (a sub-question or detail of it). Sharing a product area or a person is not enough: "login errors" is not part of "whether agents can capture context".
- Otherwise, a short title for a group of smaller topics under that item on one shared subject (for example "Bugs found while testing"). Give topics the exact same title to group them.
Answer for every smaller topic exactly once.`,
      "low",
      final ? config.notesTidyModel : config.notesModel,
      // Without thinking, the small model folds unrelated topics together.
      { timeout: MERGE_TIMEOUT_MS, maxTokens: 6000 },
    );
    return out?.merges ?? null;
  }

  async boardCard(context: string, talk: string): Promise<BoardAnswer | null> {
    return this.parse(BoardAnswerSchema, boardContent(context, talk), BOARD_SYSTEM, "low", config.boardModel, { timeout: BOARD_TIMEOUT_MS, maxTokens: 3000, thinking: false });
  }

  async liveList(context: string, talk: string): Promise<ListAnswer | null> {
    return this.parse(ListAnswerSchema, boardContent(context, talk), LIST_SYSTEM, "low", config.listModel, { timeout: LIST_TIMEOUT_MS, maxTokens: 2000, thinking: false });
  }

  async boardDrift(context: string, talk: string): Promise<BoardDrift | null> {
    return this.parse(BoardDriftSchema, boardContent(context, talk), DRIFT_SYSTEM, "low", config.boardModel, { timeout: BOARD_TIMEOUT_MS, maxTokens: 300, thinking: false });
  }

  async settleSpace(space: { name: string; purpose: string }, notes: SettleInput[]): Promise<SettleRow[] | null> {
    if (!notes.length) return [];
    const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    const out = await this.parse(
      SettleSchema,
      `Space: ${space.name}${space.purpose ? `\nPurpose: ${space.purpose.slice(0, 500)}` : ""}

Decisions (D) and open questions (Q) from the space's meetings, oldest first:
${notes.map((n) => `- ${n.key} · meeting ${day(n.meeting)} · ${n.kind}: ${n.text}`).join("\n")}`,
      `You keep a team's space current across its meetings. People open it to see what's decided and what's still open now, not what was said in each meeting.

Go through every open question and every decision:
- An open question is answered when a decision from the same or a later meeting settles it, even in other words or by settling the larger question it was part of. Give that decision's key, how=answered.
- An open question is repeated when a later question asks the same thing. Give the later question's key, how=repeated.
- A decision is replaced only when a later decision contradicts it, so the team can't follow both (for example "keep them separate" then "build them as one"). A later decision that agrees with it, restates it, adds detail or goes further the same way does not replace it. Give the later decision's key, how=replaced.
- A question that asks for something to happen (a person to weigh in, a step to be taken) is answered only by a decision showing that happened.

Only point forward in time. Be conservative: list something only when someone reading both lines would agree it is settled. Leave everything else out.`,
      "medium",
      // One short call whenever the space's decisions or questions change; getting it wrong hides an open question.
      config.anthropicModel,
      { maxTokens: 8000 },
    );
    return out?.settled ?? null;
  }

  async doneDeck(prompt: string, system: string): Promise<DoneDeckDraft | null> {
    // Written between meetings, read out at the start of the next one: worth the bigger model.
    return this.parse(DoneDeckSchema, prompt, system, "medium", config.anthropicModel, { maxTokens: 8000 });
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
      config.notesTidyModel,
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
    const chapters = input.chapters ?? [];
    if (!input.snaps.length && !chapters.length) return { summary: await this.summarizeMeeting(perItem), snaps: [] };
    // Short keys for notes, topics, chapters, lines and snaps, so the answer can point at them.
    const noteKey = new Map<string, Note>();
    const topicKey = new Map<string, { id: string; itemId: string | null }>();
    const tKey = new Map<string, string>();
    const lines: string[] = [];
    for (const g of input.items) {
      if (!g.notes.length && !g.topics.length) continue;
      lines.push(`## ${itemLabel(g.item)}`);
      const gist = g.notes.find((n) => n.kind === "summary");
      if (gist) lines.push(gist.text);
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
    const t0 = input.startedAt ?? Math.min(Infinity, ...chapters.map((c) => c.start));
    const clock = (ts: number) => {
      const s = Math.max(0, Math.round((ts - t0) / 1000));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = String(s % 60).padStart(2, "0");
      return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
    };
    // The chapters, in order. Long ones come with their remarks so the moments can point at lines.
    const chapterKey = new Map<string, RecapChapter>();
    const lineKey = new Map<string, RecapChapter["lines"][number]>();
    const chapterText = chapters.map((c) => {
      const k = `C${chapterKey.size + 1}`;
      chapterKey.set(k, c);
      const head = `### ${k} ${c.title} · from ${clock(c.start)} · ${Math.max(1, Math.round(c.minutes))} min · ${c.outcome} · ${itemLabel(c.item)}`;
      const topics = c.topicIds.map((id) => tKey.get(id)).filter(Boolean);
      const out = [head, ...(topics.length ? [`Topics: ${topics.join(", ")}`] : []), ...c.positions.map((p) => `- ${p.speaker}: ${p.position}${p.quote ? ` (in their words: "${p.quote.text}")` : ""}`)];
      if (c.lines.length) {
        out.push("Lines:");
        for (const l of c.lines) {
          const lk = `L${lineKey.size + 1}`;
          lineKey.set(lk, l);
          out.push(`${lk} [${clock(l.ts)}] ${l.speaker}: ${l.text.slice(0, 400)}`);
        }
      }
      return out.join("\n");
    });
    const label = (itemId: string | null) => itemLabel(input.items.find((g) => (g.item?.id ?? null) === itemId)?.item ?? null);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      { type: "text", text: `The meeting's notes, by agenda item:\n\n${lines.join("\n").trim() || "(no notes)"}` },
    ];
    if (chapterText.length) content.push({ type: "text", text: `The meeting's chapters, in the order they were talked about:\n\n${chapterText.join("\n\n")}` });
    if (input.snaps.length) content.push({ type: "text", text: "Screenshots people saved during it, in order:" });
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
    content.push({
      type: "text",
      text: `Write the recap${chapterText.length ? ", a crux for every chapter, moments for the chapters given with lines" : ""}${input.snaps.length ? ", and place and caption every screenshot" : ""}.`,
    });
    const out = await this.parse(
      RecapSchema,
      content,
      `You write the recap of a team meeting from its notes and chapters, and place the screenshots people saved during it.

Summary: two sentences, under 60 words, plain prose. Say where the meeting landed and what took most of it. The to-dos, decisions and open questions are listed right under it, so don't list them one by one.

Chapters: a chapter is a stretch of the meeting on one subject, as people saw it on the meeting's chapter bar. For each one write a crux: one sentence on where it landed (decided, left open, who takes it), not what it was about; the title already says that. A chapter given with its lines also gets moments: 3 to 9 turning points a reader would jump to (a proposal, a pushback, a reframing question, the point it was settled or dropped), each pointing at the line it starts at, in order. Name people by first name. Leave out jokes, tests of the tool and small talk. Don't invent anything that isn't in the lines or the notes.

Screenshots: each gets one home. If it backs a to-do, decision or open question (it shows the thing decided on, the work to do, or what the question is about, so someone acting on that note would want to see it), give that note's key. Otherwise give the topic it was discussed in. Prefer notes and topics from the item it was saved on. Give neither only when it relates to nothing in the notes.

Caption: one line saying what the image shows and why it mattered to the conversation. Name the specific thing on screen (the chart, error, design, number or page) and what the team said or decided about it. It may be a problem, but it may just as well be a design under review, a number someone pointed at, or context for the talk. Don't invent anything that isn't in the image or the notes.`,
      "medium",
      config.anthropicModel,
      { maxTokens: 12_000 },
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
    const written: ChapterRecap[] = [];
    for (const r of out.chapters ?? []) {
      const c = chapterKey.get(r.key.trim());
      if (!c || written.some((w) => w.key === c.key)) continue;
      const moments = (c.lines.length ? r.moments : [])
        .flatMap((m) => {
          const l = lineKey.get(m.line.trim());
          return l && c.lines.includes(l) && m.text.trim() ? [{ segmentId: l.segmentId, ts: l.ts, text: m.text.trim().slice(0, 140) }] : [];
        })
        .filter((m, i, all) => all.findIndex((x) => x.segmentId === m.segmentId) === i)
        .sort((x, y) => x.ts - y.ts)
        .slice(0, 9);
      written.push({ key: c.key, crux: r.crux.trim().slice(0, 240), moments });
    }
    return { summary: out.summary.trim(), snaps, chapters: written };
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
      system:
        "Write a two-sentence recap of a team meeting from its per-item notes: where it landed. Plain prose, no headings. The notes are listed under it, so don't list them one by one.",
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

  async synthesizeMeeting(input: SynthesisInput): Promise<string | null> {
    const instructions = input.instructions.trim();
    const said = input.items.filter((g) => g.segments.length || g.notes.length);
    if (!instructions || !said.length) return null;
    const time = (ts: number) => new Date(ts).toISOString().slice(11, 16);
    let meeting = said
      .map(
        (g) =>
          `## ${itemLabel(g.item)}\nWhat was said:\n${g.segments
            .map((s) => `[${time(s.ts)}] ${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
            .join("\n")}${
            g.notes.length ? `\nNotes:\n${g.notes.map((n) => `- ${n.kind}: ${n.text}${n.owner ? ` (${n.owner})` : ""}`).join("\n")}` : ""
          }`,
      )
      .join("\n\n");
    if (meeting.length > SYNTHESIS_MAX_CHARS) meeting = `${meeting.slice(0, SYNTHESIS_MAX_CHARS)}\n[…the rest of the meeting is cut]`;
    const res = await this.client.beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 4000,
      system: `You write the Synthesis section of a team meeting's recap: what this team asked to have pulled out of every meeting, on top of the usual to-dos, decisions and open questions.

Follow the team's instructions closely. Use only what was said and noted in this meeting. Quote people word for word only where the transcript has their exact words, and say who said it. Speech-to-text errors are possible; read through them.

Write Markdown: short bullet lists, with a bold lead-in or a ### heading per part when there are several. No title, no preamble, no closing line. If the meeting had nothing for part of the instructions, say so in one short line.`,
      messages: [
        {
          role: "user",
          content: `Space: ${input.spaceName}

The team's synthesis instructions:
"""
${instructions}
"""

The meeting, by agenda item:

${meeting}`,
        },
      ],
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") return null;
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
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
    const first = new Map<string, Segment>();
    for (const s of segments) if (!first.has(s.speakerName)) first.set(s.speakerName, s);
    const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
    const has = (k: Note["kind"]) => notes.some((n) => n.kind === k);
    return {
      notes,
      discussions: [
        {
          topic: clip(item?.title ?? segments[0].text, 70),
          positions: [...first].map(([speaker, s]) => ({
            speaker,
            position: clip(s.text, 90),
            quote: { segmentId: s.id, ts: s.ts, speaker, text: clip(s.text, 320) },
          })),
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
  async settleSpace(): Promise<SettleRow[] | null> {
    return null;
  }
  async doneDeck(): Promise<DoneDeckDraft | null> {
    return null;
  }
  async mergeTopics(): Promise<Array<{ key: string; into: string }> | null> {
    return null;
  }

  /** Without a model the board shows the talk so far instead of a card. */
  async boardCard(): Promise<BoardAnswer | null> {
    return null;
  }

  async boardDrift(): Promise<BoardDrift | null> {
    return null;
  }

  async describeSnap(): Promise<string | null> {
    return null;
  }

  /** Without a model: the item whose title shares the most words with what they typed. */
  async describeCapture(
    _image: unknown,
    _space: unknown,
    items: Array<{ id: string; title: string }>,
    line: string | null,
  ): Promise<{ caption: string | null; itemId: string | null } | null> {
    const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const said = words(line ?? "");
    let best: { id: string; n: number } | null = null;
    for (const it of items) {
      const n = [...words(it.title)].filter((w) => said.has(w)).length;
      if (n && (!best || n > best.n)) best = { id: it.id, n };
    }
    return best ? { caption: null, itemId: best.id } : null;
  }

  async pickItem(_space: unknown, items: Array<{ id: string; title: string }>, text: string): Promise<string | null> {
    return (await this.describeCapture(null, null, items, text))?.itemId ?? null;
  }

  async frameBacks(): Promise<{ key: string; caption: string } | null> {
    return null;
  }

  async recapMeeting(input: RecapInput): Promise<RecapDraft> {
    return { summary: await this.summarizeMeeting(input.items), snaps: [] };
  }

  async synthesizeMeeting(): Promise<string | null> {
    return null;
  }

  async summarizeMeeting(perItem: Array<{ item: Item | null; notes: DraftNote[] }>): Promise<string> {
    const discussed = perItem.filter((p) => p.notes.length);
    const decisions = discussed.flatMap((p) => p.notes.filter((n) => n.kind === "decision")).length;
    const actions = discussed.flatMap((p) => p.notes.filter((n) => n.kind === "action")).length;
    if (!discussed.length) return "";
    return `Covered ${discussed.length} item${discussed.length === 1 ? "" : "s"} with ${decisions} decision${decisions === 1 ? "" : "s"} and ${actions} to-do${actions === 1 ? "" : "s"}.`;
  }
}
