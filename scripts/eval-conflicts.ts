// Tests whether Stand can tell that two decisions disagree when nobody said so, before any of it
// goes in the product (docs/engine-brief.md, step 2). Scores shared words, spaceSettle's one call,
// and one line against all, against a key marked by hand. Keep the lines and the key out of git: this repo is public. data/ is ignored.
//
//   node --import tsx scripts/eval-conflicts.ts --lines data/eval/lines.json --key data/eval/key.json
//
// That is free: it runs the word-overlap baseline, prints what a paid run would cost, and scores
// anything already cached. Add --run to call the model, one call at a time. Every answer is cached
// by its exact request, so a rerun costs nothing.
//
//   lines.json  { "space": "...", "vocabulary": "...", "decisions": [{ "id", "on", "text" }], "questions": [...] }
//   key.json    { "reversals": [{ "a", "b" }], "duplicates": [...], "traps": [...] }   ids from lines.json

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { createAgent, type SettleRow } from "../src/server/llm.ts";

export interface Line {
  id: string;
  on: string;
  text: string;
}
export interface Pair {
  a: string;
  b: string;
}
export interface Key {
  reversals: Pair[];
  duplicates: Pair[];
  traps: Pair[];
}
export interface Finding extends Pair {
  relation: "replaces" | "duplicate";
  confidence?: number;
  why?: string;
}

/** Kept only at this confidence or higher: a false alarm costs more than a miss. */
export const MIN_CONFIDENCE = 0.7;

const pairId = (p: Pair) => [p.a, p.b].sort().join("|");

export function score(findings: Finding[], key: Key) {
  const found = new Map(findings.map((f) => [pairId(f), f]));
  const labeled = new Set([...key.reversals, ...key.duplicates, ...key.traps].map(pairId));
  const hit = (p: Pair) => found.get(pairId(p));
  return {
    reversals: { found: key.reversals.filter((p) => hit(p)?.relation === "replaces"), missed: key.reversals.filter((p) => hit(p)?.relation !== "replaces") },
    duplicates: {
      merged: key.duplicates.filter((p) => hit(p)?.relation === "duplicate"),
      /** Called a conflict: the worst way to get one of these wrong. */
      conflicts: key.duplicates.filter((p) => hit(p)?.relation === "replaces"),
      missed: key.duplicates.filter((p) => !hit(p)),
    },
    traps: { clean: key.traps.filter((p) => !hit(p)), tripped: key.traps.filter((p) => hit(p)) },
    /** Everything flagged that the key says nothing about. These need reading by hand: they are neither right nor wrong yet. */
    unlabeled: findings.filter((f) => !labeled.has(pairId(f))),
  };
}

const STOP = new Set("a an and are as at be but by do for from in is it its not of on one or our the their them they this to we with".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => !STOP.has(w)) ?? []);

/** What Conxt's live callouts did: only compare lines that share two or more words. Free, and shows what that filter can reach. */
export function wordOverlap(lines: Line[]): Finding[] {
  const sets = lines.map((l) => words(l.text));
  const out: Finding[] = [];
  lines.forEach((later, i) => {
    for (let j = 0; j < i; j++) {
      if ([...sets[i]].filter((w) => sets[j].has(w)).length >= 2) out.push({ a: lines[j].id, b: later.id, relation: "replaces" });
    }
  });
  return out;
}

const EachSchema = z.object({
  related: z.array(
    z.object({
      key: z.string(),
      relation: z.enum(["replaces", "duplicate"]),
      confidence: z.number(),
      why: z.string(),
    }),
  ),
});

const EACH_SYSTEM = `You keep track of what a team currently believes. The team just made a new decision. Below it are their earlier decisions, oldest first. Find the earlier decisions the new one changes or repeats, and leave out every other line.

- replaces: the team can't follow both. The new decision changes course from the earlier one, even if it shares no words with it and never says so.
- duplicate: the same choice in other words. Nothing would change if only one were kept.

Neither applies when the new decision adds detail, narrows the earlier one, agrees with it, reaches the same end by another route, or is about the same area without disagreeing.

Lines were caught from speech, so they're short and the same thing can be named differently.

A false alarm costs more than a miss, because people stop reading flags they've learned to ignore. List a line only when someone reading both would agree. Give your confidence from 0 to 1 and the reason in one short line.`;

function eachRequest(space: string, vocabulary: string, later: Line, earlier: Line[]) {
  return {
    system: EACH_SYSTEM,
    user: `Space: ${space}${vocabulary ? `\nVocabulary: ${vocabulary}` : ""}

New decision (${later.on}): ${later.text}

Earlier decisions:
${earlier.map((l, i) => `- E${i + 1} · ${l.on}: ${l.text}`).join("\n")}`,
  };
}

/** Dollars per million tokens. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const tokensOf = (text: string) => Math.ceil(text.length / 3.5);
/** Output is mostly thinking, which can't be known before a run. These are guesses per call. */
const OUTPUT_GUESS = { low: 300, high: 2500 };

class Cache {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private file(request: unknown) {
    return path.join(this.dir, `${createHash("sha256").update(JSON.stringify(request)).digest("hex")}.json`);
  }
  get<T>(request: unknown): T | null {
    const f = this.file(request);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as T) : null;
  }
  put(request: unknown, answer: unknown) {
    fs.writeFileSync(this.file(request), JSON.stringify({ request, answer }, null, 2));
  }
}

async function ask(client: Anthropic, model: string, req: { system: string; user: string }, spent: { input: number; output: number }) {
  const res = await client.beta.messages.parse({
    model,
    max_tokens: 8000,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    output_config: { effort: "medium", format: betaZodOutputFormat(EachSchema) },
    ...(model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[], fallbacks: "default" as const }),
  });
  spent.input += res.usage.input_tokens;
  spent.output += res.usage.output_tokens;
  if (res.stop_reason === "refusal") throw new Error("The model declined a line, so this run can't be scored.");
  if (!res.parsed_output) throw new Error(`No answer: stop reason ${res.stop_reason}`);
  return res.parsed_output;
}

/** spaceSettle's approach: the production prompt, one call over every decision and open question. */
function settleInput(lines: Line[], questions: Line[]) {
  const all = [...lines.map((l) => ({ ...l, kind: "decision" as const })), ...questions.map((q) => ({ ...q, kind: "question" as const }))].sort((x, y) => x.on.localeCompare(y.on));
  return all.map((n, i) => ({ id: n.id, key: `${n.kind === "decision" ? "D" : "Q"}${i + 1}`, kind: n.kind, text: n.text, meeting: Date.parse(n.on) }));
}

function settleFindings(notes: ReturnType<typeof settleInput>, rows: SettleRow[]): Finding[] {
  const order = new Map(notes.map((n, i) => [n.key, i]));
  return rows.flatMap((r) => {
    const a = notes[order.get(r.key) ?? -1];
    const b = notes[order.get(r.by) ?? -1];
    return r.how === "replaced" && a?.kind === "decision" && b?.kind === "decision" && order.get(r.by)! > order.get(r.key)! ? [{ a: a.id, b: b.id, relation: "replaces" as const }] : [];
  });
}

function report(name: string, findings: Finding[], key: Key, lines: Line[]) {
  const text = (id: string) => lines.find((l) => l.id === id)?.text ?? id;
  const show = (p: Pair) => `    ${text(p.a)}\n      vs ${text(p.b)}`;
  const s = score(findings, key);
  console.log(`\n${name}: ${findings.length} flagged`);
  console.log(`  Reversals found: ${s.reversals.found.length} of ${key.reversals.length}`);
  s.reversals.missed.forEach((p) => console.log(`  MISSED\n${show(p)}`));
  console.log(`  Duplicates merged: ${s.duplicates.merged.length} of ${key.duplicates.length}, called conflicts: ${s.duplicates.conflicts.length}, missed: ${s.duplicates.missed.length}`);
  console.log(`  Traps left alone: ${s.traps.clean.length} of ${key.traps.length}`);
  s.traps.tripped.forEach((p) => console.log(`  FALSE ALARM\n${show(p)}`));
  console.log(`  Flagged, not in the key (read these by hand): ${s.unlabeled.length}`);
  s.unlabeled.forEach((f) => console.log(`    [${f.relation}${f.confidence !== undefined ? ` ${f.confidence}` : ""}] ${text(f.a)}\n      -> ${text(f.b)}${f.why ? `\n      ${f.why}` : ""}`));
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const data = JSON.parse(fs.readFileSync(flag("lines", "data/eval/lines.json"), "utf8")) as { space: string; vocabulary?: string; decisions: Line[]; questions?: Line[] };
  const key = JSON.parse(fs.readFileSync(flag("key", "data/eval/key.json"), "utf8")) as Key;
  const model = flag("model", process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5");
  const run = args.includes("--run");
  const cache = new Cache(flag("cache", "data/eval/cache"));
  const lines = [...data.decisions].sort((x, y) => x.on.localeCompare(y.on));
  const known = new Set(lines.map((l) => l.id));
  for (const p of [...key.reversals, ...key.duplicates, ...key.traps]) {
    for (const id of [p.a, p.b]) if (!known.has(id)) throw new Error(`The key names ${id}, which isn't in the lines.`);
  }

  report("Shared words (free baseline)", wordOverlap(lines), key, lines);

  const requests = lines.slice(1).map((later, i) => ({ later, earlier: lines.slice(0, i + 1), req: eachRequest(data.space, data.vocabulary ?? "", later, lines.slice(0, i + 1)) }));
  const wire = (req: { system: string; user: string }) => ({ model, effort: "medium", ...req });
  const missing = requests.filter((r) => !cache.get(wire(r.req)));
  const [inPrice, outPrice] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const input = missing.reduce((n, r) => n + tokensOf(r.req.system + r.req.user), 0);
  const cost = (out: number) => (input * inPrice + missing.length * out * outPrice) / 1e6;
  console.log(`\nOne line against all, ${model}: ${requests.length} calls, ${missing.length} not cached, about ${input} input tokens.`);
  console.log(`Estimated cost: $${cost(OUTPUT_GUESS.low).toFixed(2)} to $${cost(OUTPUT_GUESS.high).toFixed(2)}. Output is a guess of ${OUTPUT_GUESS.low} to ${OUTPUT_GUESS.high} tokens per call.`);

  if (run && missing.length) {
    const client = new Anthropic();
    const spent = { input: 0, output: 0 };
    for (const r of missing) {
      cache.put(wire(r.req), await ask(client, model, r.req, spent));
      process.stdout.write(".");
    }
    console.log(`\nSpent $${((spent.input * inPrice + spent.output * outPrice) / 1e6).toFixed(2)}: ${spent.input} in, ${spent.output} out.`);
  }

  const notes = settleInput(lines, data.questions ?? []);
  const settleWire = { approach: "spaceSettle", model, notes: notes.map(({ key, kind, text, meeting }) => ({ key, kind, text, meeting })) };
  let settled = cache.get<{ answer: SettleRow[] }>(settleWire)?.answer ?? null;
  if (!settled) console.log(`spaceSettle, ${model}: 1 call over ${notes.length} lines, about ${tokensOf(JSON.stringify(notes)) + 500} input tokens, under $0.25.`);
  if (run && !settled) {
    settled = await createAgent().settleSpace({ name: data.space, purpose: "" }, settleWire.notes);
    if (!settled) throw new Error("spaceSettle gave no answer.");
    cache.put(settleWire, settled);
  }
  if (settled) report("spaceSettle's approach", settleFindings(notes, settled), key, lines);

  const findings: Finding[] = [];
  let answered = 0;
  for (const r of requests) {
    const hit = cache.get<{ answer: z.infer<typeof EachSchema> }>(wire(r.req));
    if (!hit) continue;
    answered++;
    for (const f of hit.answer.related) {
      const earlier = r.earlier[Number(f.key.replace(/^E/, "")) - 1];
      if (earlier && f.confidence >= MIN_CONFIDENCE) findings.push({ a: earlier.id, b: r.later.id, relation: f.relation, confidence: f.confidence, why: f.why });
    }
  }
  if (answered) report(`One line against all (${answered} of ${requests.length} answered)`, findings, key, lines);
  else console.log("Nothing cached yet, so no model score. Add --run to call the model.");
}

if (process.argv[1]?.endsWith("eval-conflicts.ts")) await main();
