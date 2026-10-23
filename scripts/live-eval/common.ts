// Shared bits for the live-synthesis evaluation (scripts/live-eval): loading a meeting export,
// numbering its lines, and one structured model call that reports what it cost and how long it took.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readFileSync } from "node:fs";
import type { z } from "zod";

export interface Line { ts: number; speaker: string; kind: "speech" | "chat"; text: string }
export interface Meeting { meeting: { id: string; startedAt: number; attendees: string[] }; lines: Line[] }

export const load = (file: string): Meeting => JSON.parse(readFileSync(file, "utf8"));
export const clock = (ms: number, t0: number) => {
  const s = Math.max(0, Math.floor((ms - t0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const numbered = (m: Meeting, from = 0, to = m.lines.length, newAfter = Infinity) =>
  m.lines
    .slice(from, to)
    .map((l, k) => `${from + k >= newAfter ? "NEW " : ""}[${from + k + 1}] [${clock(l.ts, m.meeting.startedAt)}] ${l.speaker}${l.kind === "chat" ? " (chat)" : ""}: ${l.text}`)
    .join("\n");

const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.2, write: 2.5 },
  "claude-opus-5-5": { in: 5, out: 25, read: 0.5, write: 6.25 },
};
const client = new Anthropic({ apiKey: process.env.STAND_ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY });

export async function ask<S extends z.ZodTypeAny>(
  model: string,
  schema: S,
  system: string,
  /** The part that stays the same from call to call goes first, so it is cached. */
  stable: string,
  live: string,
  { thinking = false, maxTokens = 4000, effort = "low" as "low" | "medium" | "high" } = {},
): Promise<{ out: z.infer<S> | null; ms: number; usd: number }> {
  const started = performance.now();
  const res = await client.beta.messages.parse({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text" as const, text: stable, cache_control: { type: "ephemeral" as const } }, ...(live ? [{ type: "text" as const, text: live }] : [])] }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
    ...(thinking ? {} : { thinking: model.startsWith("claude-haiku") ? { type: "disabled" as const } : ({ type: "between_tools" } as unknown as { type: "disabled" }) }),
  });
  const u = res.usage;
  const p = PRICES[model];
  const usd = p ? (u.input_tokens * p.in + u.output_tokens * p.out + (u.cache_read_input_tokens ?? 0) * p.read + (u.cache_creation_input_tokens ?? 0) * p.write) / 1e6 : 0;
  return { out: (res.parsed_output as z.infer<S> | null) ?? null, ms: performance.now() - started, usd };
}
