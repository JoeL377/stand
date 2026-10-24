// Prototype: a running list of to-dos, decisions and open questions that only ever grows or
// changes by id. After each pause in the talk (like live notes: 3 s quiet, at most MAX_WAIT after
// the first unread line), the model gets the list so far and the last WINDOW of talk with the
// unread lines marked NEW, and returns only what those lines add or change. One call at a time,
// on a simulated clock: talk said while a call runs waits for the next one, as on a call.
//   node --import tsx scripts/live-eval/delta.ts meeting.json out.json [--model claude-haiku-5-5]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { similar } from "../../src/server/notesMerge.ts";
import { ask, clock, load, numbered } from "./common.ts";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string", default: "claude-haiku-5-5" }, prompt: { type: "string", default: "v1" }, thinking: { type: "boolean", default: false }, debounce: { type: "string", default: "3000" }, "max-wait": { type: "string", default: "8000" }, window: { type: "string", default: "120000" } },
});
const [file, outFile] = positionals;
const m = load(file);
const DEBOUNCE = +a.debounce!, MAX_WAIT = +a["max-wait"]!, WINDOW = +a.window!;
const t0 = m.meeting.startedAt;

const Kind = z.enum(["todo", "decided", "open"]);
const Answer = z.object({
  add: z
    .array(
      z.object({
        kind: Kind,
        who: z.string().nullable().describe("A to-do's owner (first name); null if nobody took it or not a to-do"),
        text: z.string().describe("At most 10 words, plain"),
        line: z.number().int().describe("The NEW line it comes from"),
      }),
    )
    .describe("Only things the NEW lines add that the list doesn't already have"),
  change: z.array(z.object({ id: z.string(), text: z.string() })).describe("A line whose meaning the NEW talk changed (new owner, narrowed scope). Never to polish wording. Usually empty"),
  close: z
    .array(z.object({ id: z.string(), how: z.enum(["answered", "done", "dropped", "wrong"]) }))
    .describe("answered: an open question got settled (add the decision too). done/dropped: a to-do. wrong: you misheard it earlier. Usually empty"),
});
const SYSTEM = `You keep the running list on the middle screen of a live team meeting: to-dos (with owner), decisions, and open questions. People glance at it while they talk, so speed and stability matter more than polish.

Each time you get the list so far (with ids) and the last couple of minutes of transcript. Lines marked NEW are the ones you haven't seen yet. Return only what the NEW lines add or change; everything you don't name stays exactly as it is.

- todo: someone says they or another person will do something ("I'll make the PR", "can you send me the link"). who = the owner's first name.
- decided: the group settles something ("let's go with tasks as the primitive", "okay, we'll try the async route"). Agreement by the people talking is enough; it needn't be formal.
- open: a real question about the work that is raised and not answered yet. Not rhetorical questions, not "can you hear me".
Add an item as soon as it is clearly said; don't wait for the discussion to end. Skip small talk, mic checks and jokes. Don't add something already on the list in other words. When an open question gets answered, close it as answered and add the decision.
Transcription is rough: read through misheard words, and match misheard names to the people in the meeting.`;

const SYSTEM_V2 = `You keep the running list on the middle screen of a live team meeting: to-dos (with owner), decisions, and open questions. Four people glance at it while they talk. A line that shows up within seconds of being said is worth a lot; a wrong or repeated line costs more, because everyone reads it.

Each time you get the list so far (with ids, including lines closed earlier) and the last couple of minutes of transcript. Lines marked NEW are the ones you haven't seen yet. Return only what the NEW lines add or change; everything you don't name stays as it is. Most of the time the answer is empty: a busy meeting adds about one line every two or three minutes.

Add a line only when the NEW talk itself does one of these:
- todo: someone commits to doing something, or asks a named person to and they don't refuse ("I'll make the PR", "can you send me the link", "Joe, you take the redesign"). who = the owner's first name. Not ideas, wishes or "we should think about".
- decided: the people talking settle something between them (one proposes, others agree, nobody objects; or "okay, let's do X"). Not one person's opinion, not a proposal still being argued, and not someone reading out or describing a document, spec or another agent's output: that is information, not a decision.
- open: a question about the work that the group explicitly raises as something to figure out and leaves unanswered. Not rhetorical questions, not small talk, not questions answered in the next lines.

Before adding, check the list: if a line there (open or closed) already says the same thing in other words, don't add it; at most use change on that line if the owner or scope changed. One line per thing.
When an open question gets answered, close it as answered and add the decision. Never return commentary about the transcript as a line.
Transcription is rough: read through misheard words, and match misheard names to the people in the meeting.`;

type Item = { id: string; kind: string; who: string | null; text: string; line: number; shownAt: number; closed: { how: string; at: number } | null; edits: Array<{ at: number; text: string }> };
const items: Item[] = [];
const calls: Array<{ at: number; ms: number; usd: number; newLines: number; added: number; changed: number; closed: number }> = [];
const listText = () =>
  a.prompt === "v1"
    ? items.filter((i) => !i.closed).map((i) => `- [${i.id}] ${i.kind}${i.who ? ` (${i.who})` : ""}: ${i.text}`).join("\n") || "(empty)"
    : items.map((i) => `- [${i.id}] ${i.kind}${i.who ? ` (${i.who})` : ""}: ${i.text}${i.closed ? ` (closed: ${i.closed.how})` : ""}`).join("\n") || "(empty)";

let read = 0; // lines the model has seen
let sim = t0;
let nextId = 0;
while (read < m.lines.length) {
  // The next call is due DEBOUNCE after the latest unread line, or MAX_WAIT after the first, whichever is sooner.
  const first = m.lines[read].ts;
  let due = Math.max(sim, first + DEBOUNCE);
  for (let k = read; k < m.lines.length && m.lines[k].ts <= due; k++) due = Math.max(sim, Math.min(m.lines[k].ts + DEBOUNCE, first + MAX_WAIT));
  const upTo = m.lines.findIndex((l) => l.ts > due);
  const end = upTo === -1 ? m.lines.length : upTo;
  const from = Math.max(0, m.lines.findIndex((l) => l.ts > due - WINDOW));
  const start = Math.min(from, read);
  const live = `Running list:\n${listText()}\n\nTranscript, meeting time (${clock(due, t0)} now):\n${numbered(m, start, end, read)}`;
  const { out, ms, usd } = await ask(a.model!, Answer, a.prompt === "v1" ? SYSTEM : SYSTEM_V2, `People: ${m.meeting.attendees.join(", ")}`, live, { maxTokens: a.thinking ? 6000 : 2000, thinking: a.thinking });
  const at = due + ms;
  let added = 0, changed = 0, closed = 0;
  for (const x of out?.add ?? []) {
    if (!x.text.trim() || items.some((i) => (a.prompt === "v1" ? !i.closed && i.kind === x.kind && i.text.toLowerCase() === x.text.trim().toLowerCase() : similar(i.text, x.text)))) continue;
    items.push({ id: `L${++nextId}`, kind: x.kind, who: x.who, text: x.text.trim(), line: x.line, shownAt: at, closed: null, edits: [] });
    added++;
  }
  for (const c of out?.change ?? []) {
    const it = items.find((i) => i.id === c.id && !i.closed);
    if (it && c.text.trim() && c.text.trim() !== it.text) (it.edits.push({ at, text: c.text.trim() }), (it.text = c.text.trim()), changed++);
  }
  for (const c of out?.close ?? []) {
    const it = items.find((i) => i.id === c.id && !i.closed);
    if (it) (it.closed = { how: c.how, at }), closed++;
  }
  calls.push({ at, ms: Math.round(ms), usd, newLines: end - read, added, changed, closed });
  read = end;
  sim = at;
  if (calls.length % 25 === 0) console.log(`[delta] ${calls.length} calls, ${clock(at, t0)}, ${items.length} items`);
}
const minutes = (m.lines.at(-1)!.ts - t0) / 60_000;
const usd = calls.reduce((s, c) => s + c.usd, 0);
const ms = calls.map((c) => c.ms).sort((x, y) => x - y);
writeFileSync(outFile, JSON.stringify({ model: a.model, prompt: a.prompt, thinking: a.thinking, debounce: DEBOUNCE, maxWait: MAX_WAIT, window: WINDOW, calls: calls.length, medianMs: ms[ms.length >> 1], p90Ms: ms[Math.floor(ms.length * 0.9)], usd, usdPerHour: (usd / minutes) * 60, items, callLog: calls }, null, 1));
console.log(`${calls.length} calls, ${items.length} items, median ${ms[ms.length >> 1]} ms, $${((usd / minutes) * 60).toFixed(2)}/h`);
