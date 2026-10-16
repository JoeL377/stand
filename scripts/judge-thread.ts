// Grades a replay-thread run against the hand-checked topics: at each sampled moment, would
// someone glancing at the card know what the group is talking about?
//
//   STAND_ANTHROPIC_API_KEY=… npx tsx scripts/judge-thread.ts <meeting.json> <gold.json> <run dir> [--every 2]
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const [meetingPath, goldPath, dir] = process.argv.slice(2);
const every = Number(process.argv[process.argv.indexOf("--every") + 1] || 2) || 2;
const m = JSON.parse(readFileSync(meetingPath, "utf8"));
const gold = JSON.parse(readFileSync(goldPath, "utf8"));
const ticks = JSON.parse(readFileSync(`${dir}/ticks.json`, "utf8"));
const lines: { ts: number }[] = m.lines;
const topicOfLine = new Map<number, any>();
for (const t of gold.topics) for (const [a, b] of t.spans) for (let i = a; i <= b; i++) topicOfLine.set(i, t);
/** The reference topic of the latest line at or before ts that has one. */
const goldAt = (ts: number) => {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].ts <= ts && topicOfLine.has(i)) return topicOfLine.get(i);
  return null;
};
const Grade = z.object({ title: z.boolean(), content: z.boolean() });
const client = new Anthropic({ apiKey: process.env.STAND_ANTHROPIC_API_KEY?.trim() });
const SYSTEM = `You grade a live meeting screen. Someone glances at it at one moment. You get what the group is actually talking about at that moment (from a hand-checked reference) and what the screen shows.
- title: true when the screen's title names that topic, or a larger debate the topic is plainly part of. False when it names a different problem.
- content: true when the summary or the "Now" line would tell the person what is being discussed right now.`;
const out: any[] = [];
for (let i = 0; i < ticks.length; i += every) {
  const t = ticks[i];
  const g = goldAt(t.ts);
  if (!g || !t.card) continue;
  const res = await client.beta.messages.parse({
    model: "claude-sonnet-5-5",
    max_tokens: 200,
    system: SYSTEM,
    messages: [{ role: "user", content: `Reference topic: ${g.title}\nGist: ${g.gist}\n\nScreen title: ${t.title}\nSummary: ${t.card.summary}\nNow: ${t.card.now}` }],
    output_config: { effort: "low", format: betaZodOutputFormat(Grade) },
    thinking: { type: "between_tools" },
  } as any);
  const grade = res.parsed_output as any;
  out.push({ at: t.at, gold: g.id, title: t.title, ...grade });
  console.log(`${t.at} ${g.id} title=${grade.title} content=${grade.content} | ${t.title}`);
}
const pct = (k: string) => Math.round((out.filter((o) => o[k]).length / out.length) * 1000) / 10;
const result = { samples: out.length, titleRight: pct("title"), contentRight: pct("content"), eitherRight: Math.round((out.filter((o) => o.title || o.content).length / out.length) * 1000) / 10 };
writeFileSync(`${dir}/judge.json`, JSON.stringify({ result, out }, null, 1));
console.log(JSON.stringify(result));
