// ✦ Stand, the meeting's own agent: the reference for what an agent can do in a live call. Two
// things, each only when someone asks:
// - On a click, an open question on the board's list ("where do we move off Railway?") gets a card
//   of options, each with its tradeoff, and what the space already said about it. Anyone can take
//   an option as a decision or a to-do, or dismiss the card.
// - Push-to-talk: someone holds Ask Stand, says their question and lets go (or types @stand in the
//   chat). Stand answers in the Chat, which is the meeting's history with it; asking again soon
//   after follows up on the last answer. An answer can suggest a next step anyone can take as a
//   to-do. It never decides anything (Oct 28 call).
// Nothing reaches the board's list or the space without a click.
//
// A run reads the question, the last few minutes of talk, and the space's history (decisions,
// open to-dos, open questions, notes from the bar), and may search the web a few times. Each card
// is kept with the meeting and records who asked, when, the model and what it cost, so it doubles
// as the agent's log.
import { partialParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser";
import { z } from "zod";
import type { AgentCard, AgentDraft, AgentOption, Segment } from "../shared/protocol.ts";

/** Most runs one meeting may start: a cost cap while it's tried on real calls. */
export const AGENT_MAX_RUNS = 20;
/** How long after the button comes up Stand keeps taking down the question: the last words'
 *  transcript lands a moment after they're said. */
export const ASK_SETTLE_MS = 2_500;
/** Speech that started this long before the button went down still counts: people start as they press. */
const ASK_LEAD_MS = 1_000;
/** Longest a hold may run before Stand answers what it has. */
export const ASK_MAX_MS = 60_000;
/** An answer within this long of the last one follows up on it. */
const FOLLOW_MS = 5 * 60_000;
/** A question typed to Stand in the chat. */
const AT_STAND = /^@stand\b[\s,:]*/i;
/** How much recent talk a run reads. */
const TALK_MS = 4 * 60_000;
/** Most lines of each kind of space history a run is shown. */
const HISTORY_EACH = 40;

export const OptionsAnswerSchema = z.object({
  options: z
    .array(
      z.object({
        title: z.string().describe("The option as a line that stands on its own as a decision, at most 10 words: \"Move hosting to Fly.io\", not \"Fly.io\""),
        why: z.string().describe("Its main tradeoff for this team, at most 25 words, plain"),
        source_url: z.string().nullable().describe("The page it leans on most, from your searches; null if none"),
        source_title: z.string().nullable().describe("That page's short title; null if none"),
      }),
    )
    .describe("2 to 4 distinct options, the one you'd pick first. Empty when the question isn't a choice"),
  from_space: z
    .array(z.object({ key: z.string().describe("The history line's key, D1, T1, Q1 or N1"), line: z.string().describe("How it bears on the question, at most 20 words") }))
    .describe("History lines that bear on this question. Usually empty; never stretch"),
  note: z.string().nullable().describe("One line when there are no options: why, or the answer the space already has. Otherwise null"),
});
export type OptionsAnswer = z.infer<typeof OptionsAnswerSchema>;

export const OPTIONS_SYSTEM = `You are Stand, the agent in a team's live meeting. Someone on the call clicked "Find options" on an open question the group raised and couldn't answer. They are still talking; your card shows up on everyone's middle screen in a minute or so.

Give them 2 to 4 real options to choose between, each with the tradeoff that matters for this team, so they can settle it on the call. Ground options in what the team said and in the web: when the options are products, services or tools, always search at least once to check current prices and limits before you answer (twice at most), and give each option the one source it leans on most. Order them best first for this team as you understand it.

You also get the space's history. If an earlier decision, to-do, question or note bears on this question (it was decided before, someone already owns it, a constraint was named), list it in from_space with its key. That is often the most useful thing on the card: teams forget what they already settled.

If the question is not a choice between options (it needs a fact, a person, or a yes or no), return no options and put a one-line answer or the reason in note. If the history already answers it, say so in note and list that line.

Plain words, no hype, no hedging. Never invent prices, limits or quotes you didn't find.`;

/** Dollars per million tokens: input, output, cache read, cache write. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
/** Dollars per web search. */
const SEARCH_USD = 0.01;

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  searches: number;
}

/** What a run cost, in dollars; null when its model's price isn't known here. */
export function costOf(model: string, u: RunUsage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const usd = (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6 + u.searches * SEARCH_USD;
  return Math.round(usd * 10_000) / 10_000;
}

/** What a run needs from the model: the answer (null when it couldn't give one), what it cost and on which model. */
export interface OptionsModel {
  findOptions(prompt: string): Promise<{ answer: OptionsAnswer | null; model: string; usage: RunUsage }>;
}

/** The space's history as a run reads it. */
export interface SpaceHistory {
  name: string;
  purpose: string;
  decisions: Array<{ text: string; ts: number }>;
  tasks: Array<{ text: string; owner: string | null; ts: number }>;
  questions: Array<{ text: string; ts: number }>;
  notes: Array<{ text: string; by: string; ts: number }>;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The history with keys, and what each key stands for, so the answer's keys can be turned back into lines. */
function keyed(h: SpaceHistory) {
  const lines: Array<{ key: string; text: string; ts: number; shown: string }> = [];
  h.decisions.slice(0, HISTORY_EACH).forEach((d, i) => lines.push({ key: `D${i + 1}`, text: d.text, ts: d.ts, shown: `decided: ${clip(d.text, 200)}` }));
  h.tasks.slice(0, HISTORY_EACH).forEach((t, i) => lines.push({ key: `T${i + 1}`, text: t.text, ts: t.ts, shown: `open to-do${t.owner ? ` (${t.owner})` : ""}: ${clip(t.text, 200)}` }));
  h.questions.slice(0, HISTORY_EACH).forEach((q, i) => lines.push({ key: `Q${i + 1}`, text: q.text, ts: q.ts, shown: `open question: ${clip(q.text, 200)}` }));
  h.notes.slice(0, HISTORY_EACH).forEach((n, i) => lines.push({ key: `N${i + 1}`, text: n.text, ts: n.ts, shown: `note by ${n.by}: ${clip(n.text, 300)}` }));
  return lines;
}

/** The prompt for one run. */
export function optionsPrompt(question: string, talk: Segment[], now: number, history: SpaceHistory): string {
  const lines = keyed(history);
  const recent = talk
    .filter((s) => s.ts >= now - TALK_MS && s.ts <= now)
    .map((s) => `${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
    .join("\n");
  return `Space: ${history.name}${history.purpose ? `\nWhat it's for: ${clip(history.purpose, 500)}` : ""}
Today: ${day(now)}

Open question on the board: ${question}

The last few minutes of the call:
${recent || "(nothing yet)"}

The space's history, newest first:
${lines.map((l) => `- ${l.key} (${day(l.ts)}) ${l.shown}`).join("\n") || "(none)"}`;
}

/** The answer as card fields: options cleaned up, and from_space keys turned back into lines with their dates. */
export function toCard(answer: OptionsAnswer, history: SpaceHistory): Pick<AgentCard, "options" | "fromSpace" | "note"> {
  const lines = keyed(history);
  const options: AgentOption[] = answer.options
    .filter((o) => o.title.trim())
    .slice(0, 4)
    .map((o) => {
      const url = o.source_url?.trim() ?? "";
      return {
        title: clip(o.title.trim(), 80),
        why: clip(o.why.trim(), 240),
        source: /^https?:\/\//.test(url) ? { title: clip(o.source_title?.trim() || new URL(url).hostname, 80), url } : null,
      };
    });
  const seen = new Set<string>();
  const fromSpace = answer.from_space
    .map((f) => ({ f, l: lines.find((l) => l.key === f.key.trim().toUpperCase()) }))
    .filter(({ l }) => l && !seen.has(l.key) && seen.add(l.key))
    .slice(0, 3)
    .map(({ f, l }) => ({ text: clip(f.line.trim() || l!.text, 200), when: l!.ts }));
  return { options, fromSpace, note: answer.note?.trim() ? clip(answer.note.trim(), 240) : null };
}

export const AnswerSchema = z.object({
  answer: z.string().describe("The answer, at most 60 words, plain. Lead with it; no preamble"),
  sources: z
    .array(z.object({ url: z.string(), title: z.string().describe("The page's short title") }))
    .describe("At most 2 pages from your searches that the answer leans on. Empty when you didn't search"),
  todo: z
    .string()
    .nullable()
    .describe("A next step the answer points to, as a to-do of at most 10 words starting with its verb, when there is a clear one. Usually null"),
  from_space: z
    .array(z.object({ key: z.string().describe("The history line's key, D1, T1, Q1 or N1"), line: z.string().describe("How it bears on the question, at most 20 words") }))
    .describe("History lines that bear on the question. Usually empty; never stretch"),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const ANSWER_SYSTEM = `You are Stand, the agent in a team's live meeting. Someone on the call held the Ask Stand button and asked you something out loud, or typed it to you in the chat. Everyone on the call reads your answer in the meeting chat a few seconds from now, while they keep talking.

Answer the question itself, briefly: what they would want from a sharp colleague who looked it up. The question comes from speech-to-text, so read through misheard words, and use the last few minutes of the call to know what they're talking about. When it needs current facts (products, prices, limits, how something works now), search the web, at most twice, and give the pages you leaned on. When it follows up an earlier answer, build on that answer.

You also get the space's history. If an earlier decision, to-do, question or note bears on the question, say so in the answer and list it in from_space with its key: teams forget what they already settled.

Never decide anything for the team and never say something was decided. When the answer points to a clear next step, offer it as todo; people choose whether to take it.

Plain words, no hype, no hedging. Never invent prices, limits or quotes you didn't find. If you can't tell what they asked, say so in a line.`;

/** The question typed to Stand in the chat ("@stand which plan has SSO?"), or null when the message isn't one. */
export function typedAsk(text: string): string | null {
  if (!AT_STAND.test(text)) return null;
  const q = text.replace(AT_STAND, "").trim();
  return q.length >= 3 ? q : null;
}

/** The prompt for one answer. `earlier`: the answers it may follow up on, oldest first. */
export function answerPrompt(question: string, by: string, talk: Segment[], now: number, history: SpaceHistory, earlier: Array<{ by: string; question: string; answer: string }> = []): string {
  const lines = keyed(history);
  const recent = talk
    .filter((s) => s.ts >= now - TALK_MS && s.ts <= now)
    .map((s) => `${s.speakerName}${s.kind === "chat" ? " (chat)" : ""}: ${s.text}`)
    .join("\n");
  const before = earlier.map((e) => `${e.by} asked: ${e.question}\nYou answered: ${e.answer}`).join("\n\n");
  return `Space: ${history.name}${history.purpose ? `\nWhat it's for: ${clip(history.purpose, 500)}` : ""}
Today: ${day(now)}
${before ? `\nWhat you were asked just before, and answered:\n${before}\n` : ""}
${by} asks you: ${question}

The last few minutes of the call:
${recent || "(nothing yet)"}

The space's history, newest first:
${lines.map((l) => `- ${l.key} (${day(l.ts)}) ${l.shown}`).join("\n") || "(none)"}`;
}

/** The answer as card fields: real links only, history keys back to dated lines. */
export function toAnswer(answer: Answer, history: SpaceHistory): Pick<AgentCard, "note" | "sources" | "todo" | "fromSpace"> {
  const lines = keyed(history);
  const seen = new Set<string>();
  const fromSpace = answer.from_space
    .map((f) => ({ f, l: lines.find((l) => l.key === f.key.trim().toUpperCase()) }))
    .filter(({ l }) => l && !seen.has(l.key) && seen.add(l.key))
    .slice(0, 3)
    .map(({ f, l }) => ({ text: clip(f.line.trim() || l!.text, 200), when: l!.ts }));
  const sources = answer.sources
    .filter((x) => /^https?:\/\//.test(x.url.trim()))
    .slice(0, 2)
    .map((x) => ({ url: x.url.trim(), title: clip(x.title.trim() || new URL(x.url.trim()).hostname, 80) }));
  return { note: clip(answer.answer.trim(), 600) || null, sources, todo: answer.todo?.trim() ? clip(answer.todo.trim(), 120) : null, fromSpace };
}

/** Push-to-talk: what each person says while their Ask Stand button is down. */
export class AskCapture {
  private open = new Map<string, { cardId: string; from: number; until: number | null; parts: string[] }>();

  /** The button went down. False when this person is already asking. */
  start(who: string, cardId: string, at: number): boolean {
    if (this.open.has(who)) return false;
    this.open.set(who, { cardId, from: at, until: null, parts: [] });
    return true;
  }

  /** The button came up: speech that started after this no longer counts. Returns the card's id. */
  end(who: string, at: number): string | null {
    const a = this.open.get(who);
    if (!a || a.until !== null) return null;
    a.until = at;
    return a.cardId;
  }

  asking(who: string): boolean {
    return this.open.has(who);
  }

  /** A line of transcript from this person; kept when it was said while the button was down. */
  hear(who: string, text: string, startedAt: number) {
    const a = this.open.get(who);
    if (!a || startedAt < a.from - ASK_LEAD_MS || (a.until !== null && startedAt > a.until)) return;
    a.parts.push(text.trim());
  }

  /** The question as heard, once; the capture ends. */
  take(who: string): { cardId: string; question: string } | null {
    const a = this.open.get(who);
    if (!a) return null;
    this.open.delete(who);
    return { cardId: a.cardId, question: a.parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim() };
  }
}

/** Keeps one meeting's cards. */
export class AgentKeeper {
  private cards: AgentCard[];
  private n: number;

  constructor(saved?: AgentCard[] | null) {
    this.cards = saved ?? [];
    this.n = Math.max(0, ...this.cards.map((c) => Number(c.id.slice(3)) || 0));
    // A question being taken down when the server restarted is lost with the hold.
    for (const c of this.cards) if (c.status === "listening") Object.assign(c, { status: "failed", readyAt: c.at, note: "Stand restarted while you were asking. Ask again." });
  }

  all(): AgentCard[] {
    return this.cards;
  }

  get(id: string): AgentCard | undefined {
    return this.cards.find((c) => c.id === id);
  }

  /** The card already on a question, unless it was dismissed or failed. */
  onQuestion(about: string): AgentCard | undefined {
    return this.cards.find((c) => c.kind === "options" && c.about === about && !c.dismissed && c.status !== "failed");
  }

  /** Whether another run may start: under the meeting's cap. */
  canRun(): boolean {
    return this.cards.length < AGENT_MAX_RUNS;
  }

  start(about: string, question: string, by: string, at = Date.now()): AgentCard {
    const card: AgentCard = {
      id: `ag_${++this.n}`,
      kind: "options",
      about,
      question,
      status: "working",
      by,
      at,
      readyAt: null,
      options: [],
      fromSpace: [],
      note: null,
      picked: null,
      dismissed: null,
      model: null,
      costUsd: null,
    };
    this.cards.push(card);
    return card;
  }

  /** Someone asked Stand something: by push-to-talk (listening until the button comes up) or typed.
   *  follows: asked on an answer card's own box, the answer it follows up (null: a new card). Left out,
   *  it follows up the last answer if that came back a moment ago. */
  ask(by: string, who: string, question: string | null, at = Date.now(), follows?: string | null): AgentCard {
    const card = this.start(who, question ?? "", by, at);
    card.kind = "answer";
    card.status = question === null ? "listening" : "working";
    card.sources = [];
    card.todo = null;
    card.follows = null;
    if (follows !== undefined) {
      const up = follows ? this.get(follows) : undefined;
      // It shows on that card straight away, while Stand works on it.
      card.follows = up?.kind === "answer" ? up.id : null;
      this.chosen.add(card.id);
    }
    return card;
  }

  /** The answers a new one follows up on, as its asker chose them on a card: the one it follows and the
   *  one before that. Undefined when the asker didn't choose (push-to-talk from the bar, @stand). */
  chosenFollowUp(id: string): AgentCard[] | undefined {
    const card = this.get(id);
    if (!card || !this.chosen.has(id)) return undefined;
    const out: AgentCard[] = [];
    let up = card.follows ? this.get(card.follows) : undefined;
    while (up && out.length < 2) {
      if (up.status === "ready" && up.note) out.unshift(up);
      up = up.follows ? this.get(up.follows) : undefined;
    }
    return out;
  }

  /** Answers asked on a card's own box, whose place (card.follows) the asker chose. */
  private chosen = new Set<string>();

  /** What Stand heard while the button was down; nothing heard fails the card. */
  heard(id: string, question: string): AgentCard | null {
    const card = this.get(id);
    if (!card || card.kind !== "answer" || card.status !== "listening") return null;
    if (!question) {
      card.status = "failed";
      card.readyAt = Date.now();
      card.note = "Didn't catch a question. Hold Ask Stand while you talk, then let go.";
      return card;
    }
    card.question = clip(question, 1000);
    card.status = "working";
    return card;
  }

  /** The answers a new one may follow up on: the last two, if the latest came back a moment ago. */
  followUp(now = Date.now()): AgentCard[] {
    const done = this.cards.filter((c) => c.kind === "answer" && c.status === "ready" && c.note);
    const last = done.at(-1);
    if (!last || now - (last.readyAt ?? last.at) > FOLLOW_MS) return [];
    return done.slice(-2);
  }

  /** How an answer run ended. */
  /** What a working card has so far, as the run streams it (null once it's done). */
  draft(id: string, draft: AgentDraft | null) {
    const card = this.get(id);
    if (!card || (draft && card.status !== "working")) return null;
    card.draft = draft;
    return card;
  }

  finishAnswer(id: string, out: { fields: Pick<AgentCard, "note" | "sources" | "todo" | "fromSpace"> | null; follows: string | null; model: string | null; costUsd: number | null }, at = Date.now()) {
    const card = this.get(id);
    if (!card || card.kind !== "answer") return null;
    // What it searched and read stays, folded under the answer; the words are the answer now.
    card.draft = card.draft?.searches.length ? { ...card.draft, text: null, options: [] } : null;
    card.readyAt = at;
    card.model = out.model;
    card.costUsd = out.costUsd;
    card.follows = out.follows;
    if (out.fields?.note) {
      Object.assign(card, out.fields);
      card.status = "ready";
    } else {
      card.status = "failed";
      card.note = "Couldn't answer that this time.";
    }
    return card;
  }

  /** Someone took an answer's next step as a to-do. */
  takeTodo(id: string, by: string, at = Date.now()) {
    const card = this.get(id);
    if (!card || card.kind !== "answer" || card.status !== "ready" || !card.todo || card.picked) return null;
    card.picked = { index: 0, as: "task", by, at };
    return card;
  }

  /** How a run ended: its answer as a card, or failed. */
  finish(id: string, out: { fields: Pick<AgentCard, "options" | "fromSpace" | "note"> | null; model: string | null; costUsd: number | null }, at = Date.now()) {
    const card = this.get(id);
    if (!card) return null;
    card.draft = null;
    card.readyAt = at;
    card.model = out.model;
    card.costUsd = out.costUsd;
    if (out.fields && (out.fields.options.length || out.fields.note || out.fields.fromSpace.length)) {
      Object.assign(card, out.fields);
      card.status = "ready";
    } else {
      card.status = "failed";
      card.note = "Couldn't find options this time.";
    }
    return card;
  }

  pick(id: string, index: number, as: "decision" | "task", by: string, at = Date.now()) {
    const card = this.get(id);
    if (!card || card.kind !== "options" || card.status !== "ready" || card.picked || card.dismissed || !card.options[index]) return null;
    card.picked = { index, as, by, at };
    return card;
  }

  dismiss(id: string, by: string, at = Date.now()) {
    const card = this.get(id);
    if (!card || card.dismissed) return null;
    card.dismissed = { by, at };
    return card;
  }
}

/** JSON cut off mid-stream, read as far as it goes, including a string still being written (the SDK's
 *  partial parser leaves those out, which would hold back every word until the field closes). */
export function readPartial(json: string): unknown {
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === "\\" && inString) i++;
    else if (c === '"') inString = !inString;
  }
  let text = json;
  if (inString) {
    // Close the open string, minus a half-written escape at its end.
    text = text.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/(^|[^\\])((?:\\\\)*)\\$/, "$1$2");
    text += '"';
  }
  try {
    return partialParse(text);
  } catch {
    return null;
  }
}

/** A run's answer as it streams, for the card: what it searched for, the words so far (an answer's text,
 *  or the note on options), and options as they come. The JSON so far is read leniently. */
export function draftOf(kind: AgentCard["kind"], searches: string[], partial: unknown, pages: string[] = []): AgentDraft {
  const p = (partial && typeof partial === "object" ? partial : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const text = str(kind === "answer" ? p.answer : p.note).trim();
  const options = (Array.isArray(p.options) ? p.options : [])
    .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>) : {}))
    .map((o) => ({ title: str(o.title).trim(), why: str(o.why).trim() }))
    .filter((o) => o.title);
  return { searches, pages: pages.slice(0, 6), text: text || null, options: kind === "options" ? options : [] };
}
