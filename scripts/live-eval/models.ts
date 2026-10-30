// The shipped running list (src/server/liveList.ts) on a recorded meeting with any model, effort
// and thinking setting, so models can be compared on the same talk. Same pause rules and
// simulated clock as list.ts, same 15 s give-up as the room; writes list.ts's format plus what
// each call took and cost.
//   STAND_ANTHROPIC_API_KEY=… MODEL=claude-haiku-5-5 EFFORT=low THINK=off \
//     node --import tsx scripts/live-eval/models.ts meeting.json out.json
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { writeFileSync } from "node:fs";
import { LIST_DEBOUNCE_MS, LIST_MAX_WAIT_MS, LIST_SYSTEM, type ListAnswer, ListAnswerSchema, ListKeeper } from "../../src/server/liveList.ts";
import type { Segment } from "../../src/shared/protocol.ts";
import { load } from "./common.ts";

const [file, outFile] = process.argv.slice(2);
const model = process.env.MODEL ?? "claude-sonnet-5-5";
const effort = (process.env.EFFORT ?? "low") as "low" | "medium" | "high";
const think = process.env.THINK === "on";
const TIMEOUT_MS = 15_000;
// EAGER=on adds one paragraph that tells the model to add lines readily: today's prompt is
// tuned on Sonnet with thinking off, and stronger or thinking models read it as "add little".
const EAGER = `\n\nLean towards adding. Each to-do, decision or open question the team would want on the board should appear the first time it is said clearly enough to write down, even if it is small or might change: people can drop a line with one click, but a missing line is never seen. Staying silent is right only when the new talk holds nothing of the kind.`;
const system = LIST_SYSTEM + (process.env.EAGER === "on" ? EAGER : "");

// $/MTok: input, output, cache read, cache write (5 min).
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
};
// Haiku turns thinking off with "disabled", Sonnet 5.5 with "between_tools"; Opus 5.5 and Fable
// 5.1 always think, so for them THINK=off only means low effort.
const thinking = think
  ? {}
  : model.startsWith("claude-haiku")
    ? { thinking: { type: "disabled" as const } }
    : model.startsWith("claude-sonnet")
      ? { thinking: { type: "between_tools" } as unknown as { type: "disabled" } }
      : {};

const client = new Anthropic({ apiKey: process.env.STAND_ANTHROPIC_API_KEY!.trim(), maxRetries: 0 });
let usd = 0;
let timeouts = 0;
let failures = 0;
const outTokens: number[] = [];
async function liveList(context: string, talk: string): Promise<ListAnswer | null> {
  try {
    const res = await client.beta.messages.parse(
      {
        model,
        max_tokens: think ? 8000 : 2000,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: context, cache_control: { type: "ephemeral" } }, { type: "text", text: talk }] }],
        output_config: { effort, format: betaZodOutputFormat(ListAnswerSchema) },
        ...thinking,
      },
      { timeout: TIMEOUT_MS },
    );
    const u = res.usage;
    const p = PRICES[model] ?? [0, 0, 0, 0];
    usd += (u.input_tokens * p[0] + u.output_tokens * p[1] + (u.cache_read_input_tokens ?? 0) * p[2] + (u.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
    outTokens.push(u.output_tokens);
    return (res.parsed_output as ListAnswer | null) ?? null;
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) timeouts++;
    else {
      failures++;
      console.error(String(e).slice(0, 300));
    }
    return null;
  }
}

const m = load(file);
const t0 = m.meeting.startedAt;
const segments = m.lines.map((l, i) => ({ id: `s${i}`, meetingId: "replay", itemId: null, speakerId: l.speaker, speakerName: l.speaker, kind: l.kind, text: l.text, ts: l.ts }) as Segment);
const keeper = new ListKeeper({ liveList }, t0);
const shownAt = new Map<string, number>();
const edits = new Map<string, number>();
const texts = new Map<string, string>();
const ms: number[] = [];
let read = 0;
let sim = t0;
while (read < segments.length) {
  const first = segments[read].ts;
  let due = Math.max(sim, first + LIST_DEBOUNCE_MS);
  for (let k = read; k < segments.length && segments[k].ts <= due; k++) due = Math.max(sim, Math.min(segments[k].ts + LIST_DEBOUNCE_MS, first + LIST_MAX_WAIT_MS));
  const said = segments.filter((s) => s.ts <= due);
  const started = performance.now();
  await keeper.run(said, m.meeting.attendees, () => null, due);
  const took = performance.now() - started;
  ms.push(took);
  sim = due + took;
  read = said.length;
  for (const n of keeper.notes("replay")) {
    if (!shownAt.has(n.id)) shownAt.set(n.id, sim);
    else if (texts.get(n.id) !== n.text) edits.set(n.id, (edits.get(n.id) ?? 0) + 1);
    texts.set(n.id, n.text);
  }
}
const items = keeper.saved().map((i) => ({ id: i.id, kind: i.kind, who: i.who, text: i.text, shownAt: shownAt.get(i.id) ?? sim, closed: i.closed, edits: Array(edits.get(i.id) ?? 0).fill({}) }));
ms.sort((a, b) => a - b);
const hours = (m.lines.at(-1)!.ts - t0) / 3_600_000;
const run = {
  model,
  effort,
  think,
  eager: process.env.EAGER === "on",
  calls: ms.length,
  medianMs: Math.round(ms[ms.length >> 1]),
  p90Ms: Math.round(ms[Math.floor(ms.length * 0.9)]),
  timeouts,
  failures,
  usd: +usd.toFixed(3),
  usdPerHour: +(usd / hours).toFixed(2),
  medianOutTokens: [...outTokens].sort((a, b) => a - b)[outTokens.length >> 1] ?? 0,
};
writeFileSync(outFile, JSON.stringify({ ...run, items }, null, 1));
console.log(JSON.stringify({ ...run, items: items.length }));
