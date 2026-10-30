// What the lines that matched no reference item are: real items the reference left out, repeats
// of another shown line, true but too small for the board, or wrong. score.ts counts them all as
// noise; this splits them so a model that shows more real items isn't marked down for it.
//   node --import tsx scripts/live-eval/extras.ts score.json meeting.json out.json
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ask, load, numbered } from "./common.ts";

const [scoreFile, meetingFile, outFile] = process.argv.slice(2);
const score: { rows: Array<{ shownAs: string | null }>; shown: Array<{ id: string; kind: string; text: string }> } = JSON.parse(readFileSync(scoreFile, "utf8"));
const m = load(meetingFile);
const matched = new Set(score.rows.flatMap((r) => (r.shownAs ? [r.shownAs] : [])));
const extra = score.shown.filter((s) => !matched.has(s.text));
if (!extra.length) {
  writeFileSync(outFile, JSON.stringify({ shown: score.shown.length, extra: 0, counts: { real: 0, repeat: 0, minor: 0, wrong: 0 }, lines: [] }, null, 1));
  process.exit(0);
}
const Verdicts = z.object({
  lines: z.array(z.object({ id: z.string(), verdict: z.enum(["real", "repeat", "minor", "wrong"]) })),
});
const { out } = await ask(
  "claude-opus-5-5",
  Verdicts,
  `You check lines a live meeting board showed. For each line give one verdict:
- real: a to-do, decision or open question the meeting really had, worth a line on the board.
- repeat: says the same thing as another line in the full list.
- minor: true, but small talk, logistics or too trivial for the board.
- wrong: misreads the talk (wrong owner, a decision nobody made, a question that was answered right away, a description read aloud taken as a decision).`,
  `People: ${m.meeting.attendees.join(", ")}\n\nTranscript:\n${numbered(m)}`,
  `Full list the board showed:\n${score.shown.map((s) => `- ${s.id} ${s.kind}: ${s.text}`).join("\n")}\n\nGive a verdict for these lines only:\n${extra.map((s) => `- ${s.id}`).join("\n")}`,
  { thinking: true, maxTokens: 16000, effort: "medium" },
);
const counts = { real: 0, repeat: 0, minor: 0, wrong: 0 };
const lines = (out?.lines ?? []).filter((l) => extra.some((e) => e.id === l.id));
for (const l of lines) counts[l.verdict]++;
writeFileSync(outFile, JSON.stringify({ shown: score.shown.length, extra: extra.length, counts, lines }, null, 1));
console.log(JSON.stringify({ shown: score.shown.length, extra: extra.length, ...counts }));
