// The shipped running list (src/server/liveList.ts) on a recorded meeting, with the room's pause
// rules on a simulated clock, written in delta.ts's format so score.ts grades it the same way.
//   STAND_ANTHROPIC_API_KEY=… node --import tsx scripts/live-eval/list.ts meeting.json out.json
import { writeFileSync } from "node:fs";
import { ClaudeAgent } from "../../src/server/llm.ts";
import { LIST_DEBOUNCE_MS, LIST_MAX_WAIT_MS, ListKeeper } from "../../src/server/liveList.ts";
import type { Segment } from "../../src/shared/protocol.ts";
import { load } from "./common.ts";

const [file, outFile] = process.argv.slice(2);
const m = load(file);
const t0 = m.meeting.startedAt;
const segments = m.lines.map((l, i) => ({ id: `s${i}`, meetingId: "replay", itemId: null, speakerId: l.speaker, speakerName: l.speaker, kind: l.kind, text: l.text, ts: l.ts }) as Segment);
const agent = new ClaudeAgent(process.env.STAND_ANTHROPIC_API_KEY!.trim());
const keeper = new ListKeeper({ liveList: agent.liveList.bind(agent) }, t0);
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
const kind = { action: "todo", decision: "decided", question: "open" } as const;
const items = keeper.saved().map((i) => ({ id: i.id, kind: i.kind, who: i.who, text: i.text, shownAt: shownAt.get(i.id) ?? sim, closed: i.closed, edits: Array(edits.get(i.id) ?? 0).fill({}) }));
void kind;
ms.sort((a, b) => a - b);
writeFileSync(outFile, JSON.stringify({ calls: ms.length, medianMs: Math.round(ms[ms.length >> 1]), items }, null, 1));
console.log(`${ms.length} calls, ${items.length} items, median ${Math.round(ms[ms.length >> 1])} ms`);
