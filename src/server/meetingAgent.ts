// ✦ Stand, the meeting's own agent: the reference for what an agent can do in a live call. For now
// one thing, on a click: an open question on the board's list ("where do we move off Railway?")
// gets a card of options, each with its tradeoff, and what the space already said about it.
// Anyone can take an option as a decision or a to-do, or dismiss the card. Nothing reaches the
// board's list or the space without that click.
//
// A run reads the question, the last few minutes of talk, and the space's history (decisions,
// open to-dos, open questions, notes from the bar), and may search the web a few times. Each card
// is kept with the meeting and records who asked, when, the model and what it cost, so it doubles
// as the agent's log.
import { z } from "zod";
import type { AgentCard, AgentOption, Segment } from "../shared/protocol.ts";

/** Most runs one meeting may start: a cost cap while it's tried on real calls. */
export const AGENT_MAX_RUNS = 12;
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

/** Keeps one meeting's cards. */
export class AgentKeeper {
  private cards: AgentCard[];
  private n: number;

  constructor(saved?: AgentCard[] | null) {
    this.cards = saved ?? [];
    this.n = Math.max(0, ...this.cards.map((c) => Number(c.id.slice(3)) || 0));
  }

  all(): AgentCard[] {
    return this.cards;
  }

  get(id: string): AgentCard | undefined {
    return this.cards.find((c) => c.id === id);
  }

  /** The card already on a question, unless it was dismissed or failed. */
  onQuestion(about: string): AgentCard | undefined {
    return this.cards.find((c) => c.about === about && !c.dismissed && c.status !== "failed");
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

  /** How a run ended: its answer as a card, or failed. */
  finish(id: string, out: { fields: Pick<AgentCard, "options" | "fromSpace" | "note"> | null; model: string | null; costUsd: number | null }, at = Date.now()) {
    const card = this.get(id);
    if (!card) return null;
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
    if (!card || card.status !== "ready" || card.picked || card.dismissed || !card.options[index]) return null;
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
