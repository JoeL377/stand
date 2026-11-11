// Replays a saved transcript through a brainstorm's map pass (src/server/brainstorm.ts), at the
// pace the room runs it, and prints what each pass put on the map.
//   STAND_ANTHROPIC_API_KEY=… npx tsx scripts/replay-map.ts <transcript.md> "<the sentence>" [fromMin] [toMin] [out.json]
// The transcript is the Markdown a meeting exports: "**Name** [m:ss]: words" lines.
import { readFileSync, writeFileSync } from "node:fs";
import type { Segment } from "../src/shared/protocol.ts";
import { MAP_MAX_WAIT_MS, MapKeeper } from "../src/server/brainstorm.ts";
import { ClaudeAgent } from "../src/server/llm.ts";

const [file, prompt, fromMin = "0", toMin = "999", out] = process.argv.slice(2);
const key = process.env.STAND_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
if (!file || !prompt || !key) {
  console.error('usage: replay-map.ts <transcript.md> "<the sentence>" [fromMin] [toMin] [out.json], with a model key in the environment');
  process.exit(1);
}
const T0 = Date.UTC(2026, 0, 1);
const segments: Segment[] = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  const m = /^\*\*(.+?)\*\* \[(\d+):(\d\d)\](?: \(chat\))?: (.*)$/.exec(line);
  if (!m) continue;
  const ts = T0 + (Number(m[2]) * 60 + Number(m[3])) * 1000 + segments.length;
  if (ts < T0 + Number(fromMin) * 60_000 || ts > T0 + Number(toMin) * 60_000) continue;
  segments.push({ id: `s${segments.length}`, meetingId: "replay", itemId: null, speakerId: m[1], speakerName: m[1], kind: "speech", text: m[4], ts });
}
const people = [...new Set(segments.map((s) => s.speakerName))];
const agent = new ClaudeAgent(key);
const map = new MapKeeper({ brainstormMap: agent.brainstormMap.bind(agent) }, prompt, segments[0].ts - 1);
const clock = (ts: number) => {
  const s = Math.floor((ts - T0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
let passes = 0;
const started = Date.now();
for (let now = segments[0].ts + MAP_MAX_WAIT_MS; now <= segments.at(-1)!.ts + MAP_MAX_WAIT_MS; now += MAP_MAX_WAIT_MS) {
  if (map.unreadSince(segments.filter((s) => s.ts <= now)) === null) continue;
  const before = JSON.stringify(map.all());
  passes++;
  await map.run(segments, people, [], T0, now);
  const was: Array<{ id: string; points: unknown[] }> = JSON.parse(before);
  for (const n of map.all()) {
    const old = was.find((o) => o.id === n.id);
    if (!old) console.log(`${clock(now)}  + ${n.parent ? `  ${n.parent} › ` : ""}[${n.id}] ${n.label} (${n.by ?? "?"}): ${n.detail}`);
    else for (const p of n.points.slice(old.points.length)) console.log(`${clock(now)}  ~ [${n.id}] ${n.label} += ${p.text} (${p.by ?? "?"})`);
  }
}
const nodes = map.all();
console.log(`\n${passes} passes in ${Math.round((Date.now() - started) / 1000)} s · ${nodes.filter((n) => !n.parent).length} directions, ${nodes.filter((n) => n.parent).length} ideas`);
for (const d of nodes.filter((n) => !n.parent)) {
  console.log(`\n${d.label}`);
  for (const i of nodes.filter((n) => n.parent === d.id)) console.log(`  - ${i.label}${i.points.length ? ` (+${i.points.length})` : ""}`);
}
if (out) writeFileSync(out, JSON.stringify(nodes, null, 2));
