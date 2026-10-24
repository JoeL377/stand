// Hand-checkable reference list for a meeting: every to-do, decision and open question, with
// the line where it was first said. Opus reads the whole transcript once.
//   node --import tsx scripts/live-eval/gold.ts meeting.json out.json
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ask, load, numbered } from "./common.ts";

const [file, outFile] = process.argv.slice(2);
const m = load(file);
const Gold = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["todo", "decided", "open"]),
      who: z.string().nullable().describe("A to-do's owner, first name; null otherwise"),
      text: z.string().describe("At most 12 words"),
      line: z.number().int().describe("The line where it was first said clearly enough that a note-taker would write it down"),
      weight: z.enum(["core", "minor"]).describe("core: the team would want it on the meeting board; minor: small talk, logistics, jokes"),
    }),
  ),
});
const { out, usd } = await ask(
  "claude-opus-5-5",
  Gold,
  `You make the reference list for grading live meeting notes. Read the whole transcript and list every to-do (someone will do something), decision (the group settled something) and open question (asked and left unanswered, or raised as something to figure out) that a careful note-taker would write down. Give each the line where it was first said clearly enough to write down. Transcription is rough; read through misheard words ("Duke" is usually Huy). Don't list the same thing twice; don't invent.`,
  `People: ${m.meeting.attendees.join(", ")}\n\nTranscript:\n${numbered(m)}`,
  "",
  { thinking: true, maxTokens: 16000, effort: "high" },
);
if (!out) throw new Error("no answer");
const items = out.items.map((g, i) => ({ id: `g${i + 1}`, ...g, ts: m.lines[Math.min(m.lines.length, Math.max(1, g.line)) - 1].ts }));
writeFileSync(outFile, JSON.stringify({ items, usd }, null, 1));
console.log(`${items.length} items (${items.filter((g) => g.weight === "core").length} core), $${usd.toFixed(2)}`);
