// Replays a recorded meeting through live notes the way a real call runs them, to see which
// topics the board shows when, and what the notes runs cost.
//
// The meeting's remarks go into a real room, each at the time it was said. Notes runs fire on the
// room's own rules (a short pause after new talk, never more than a set wait, one run at a time),
// and a run takes as long as the model actually took, so talk that came in meanwhile waits for the
// next run, as it would on a call. Time between runs is skipped, so a 100-minute meeting replays
// in about the time its notes runs take.
//
// Runs on a fresh database of its own and never starts the Conxt delivery, so nothing leaves the
// machine except the model calls.
//
//   node --import tsx scripts/replay-notes.ts meeting.json --out replay/current
//   node --import tsx scripts/replay-notes.ts meeting.json --agent stand-in --gold gold-topics.json
//
// --agent claude     the real notes model (needs ANTHROPIC_API_KEY, or STAND_ANTHROPIC_API_KEY where that
//                    name is reserved, as in Claude Code cloud sessions). The default when a key is set.
// --agent stand-in   no model: a stand-in that groups the talk by a reference topic list and answers
//                    the size a model would, to count runs and tokens for free. Its latency is modeled.
// --gold FILE        reference topics ({topics:[{id,title,spans:[[a,b]]}]}) for the stand-in;
//                    without it, the stand-in uses the topics the meeting ended with.
// --debounce MS, --max-wait MS   the run cadence (the room uses 3000 and 12000).
// --until MIN        stop after this many minutes of talk.
// --merge off        don't place the smaller topics (server/topicMerge.ts); on by default, at most every
//                    2 minutes of the meeting, as the room does. Each call is in merges.json.
// --final-merge      once the talk ends, place them once more on the tidy model, as a meeting's end does.
// REPLAY_DUMP_RUNS=50,300   also save those runs' requests (request-50.json...), to see what a run sends.
// NOTES_LAYOUT=classic, NOTES_LAST_TOPICS=on   the notes prompt experiments in server/config.ts.
// REPLAY_STANDIN_DROP=0.1   the stand-in leaves out that share of the lines it lists, as Haiku does now and then.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { openDb } from "../src/server/db.ts";
import { ClaudeAgent, type CapturedNote, type SettledTopic } from "../src/server/llm.ts";
import { RoomSession } from "../src/server/room.ts";
import { config } from "../src/server/config.ts";
import type { Item, Segment } from "../src/shared/protocol.ts";

interface Line {
  ts: number;
  speaker: string;
  kind: "speech" | "chat";
  text: string;
  itemId: string | null;
  finalTopic: string | null;
}
interface Meeting {
  meeting: { id: string; startedAt: number; endedAt: number; attendees: string[] };
  items: Array<{ id: string | null; title: string }>;
  finalTopics: Array<{ id: string; topic: string; outcome: string; positions: Array<{ speaker: string; position: string }> }>;
  lines: Line[];
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    gold: { type: "string" },
    out: { type: "string" },
    debounce: { type: "string", default: "3000" },
    "max-wait": { type: "string", default: "12000" },
    until: { type: "string" },
    merge: { type: "string", default: "on" },
    "final-merge": { type: "boolean", default: false },
  },
});
const file = positionals[0];
if (!file) throw new Error("Give the meeting file: scripts/replay-notes.ts meeting.json");
const meeting: Meeting = JSON.parse(fs.readFileSync(file, "utf8"));
const apiKey = process.env.STAND_ANTHROPIC_API_KEY?.trim() || config.anthropicKey;
const useModel = (args.agent ?? (apiKey ? "claude" : "stand-in")) === "claude";
if (useModel && !apiKey) throw new Error("--agent claude needs ANTHROPIC_API_KEY or STAND_ANTHROPIC_API_KEY");
const DEBOUNCE = Number(args.debounce);
const MAX_WAIT = Number(args["max-wait"]);
const out = path.resolve(args.out ?? `replay-${useModel ? "claude" : "stand-in"}-${DEBOUNCE}-${MAX_WAIT}`);
fs.mkdirSync(out, { recursive: true });
// --until counts from the first remark, not from when the meeting opened.
const lines = meeting.lines.filter((l) => !args.until || l.ts <= meeting.lines[0].ts + Number(args.until) * 60_000);

// The room logs every run; the replay keeps its own record instead.
const print = console.log;
console.log = (...a: unknown[]) => {
  if (typeof a[0] === "string" && /^\[(agent|room)\]/.test(a[0])) return;
  print(...a);
};

// ---- the clock: the room reads the meeting's time, the model calls run on real time ----
const realNow = Date.now.bind(Date);
let sim = meeting.meeting.startedAt;
const simNow = () => sim;
Date.now = simNow;

// ---- the room ----
const dbFile = path.join(out, "replay.db");
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(dbFile);
const room = db.createRoom("Replay");
const agendaItems = meeting.items.filter((i) => i.id);
const made = db.addItems(
  room.id,
  agendaItems.map((i) => ({ source: "agenda" as const, externalId: null, title: i.title, url: null, description: null })),
);
const itemIdOf = new Map<string | null, string | null>([[null, null], ...agendaItems.map((i, k) => [i.id, made[k].id] as [string, string])]);
const agent = new ClaudeAgent(apiKey ?? "stand-in");
const session = new RoomSession(db, agent, room, () => {});
const meetingId = session.meetingId;
// Private parts of the room the replay drives directly.
const roomInternals = session as unknown as {
  scheduleNotes: (itemId: string | null, delay: number) => void;
  refreshNotes: (itemId: string | null) => Promise<unknown>;
  addSegment: (speakerId: string, speakerName: string, kind: "speech" | "chat", text: string, ts: number) => Segment;
  scheduleMerge: () => void;
  mergeTopics: (final: boolean) => Promise<void>;
  mergedAt: number;
};

// ---- placing the smaller topics, on the meeting's clock (the room's rule: at most every 2 minutes) ----
const MERGE_EVERY_MS = 120_000;
let mergeDue: number | null = null;
roomInternals.scheduleMerge = () => {
  if (args.merge === "off" || mergeDue !== null) return;
  mergeDue = Math.max(sim, roomInternals.mergedAt + MERGE_EVERY_MS);
};

// ---- run cadence, on the meeting's clock (the same rule as the room's scheduleNotes) ----
const pending = new Map<string | null, { since: number; due: number }>();
roomInternals.scheduleNotes = (itemId, delay) => {
  const since = pending.get(itemId)?.since ?? sim;
  const wait = delay === 3_000 ? DEBOUNCE : delay;
  pending.set(itemId, { since, due: sim + Math.max(0, Math.min(wait, since + MAX_WAIT - sim)) });
};

// ---- what each run sent and got back ----
const lineOf = new Map<string, number>(); // segment id -> index into lines
let runWindow: Segment[] = [];
let runNumbers: number[] = [];
let runSettled: SettledTopic[] = [];
let runCaptured: CapturedNote[] = [];
const realNotesFor = agent.notesFor.bind(agent);
agent.notesFor = (item, segments, earlier, captured, context, options) => {
  runWindow = segments;
  runNumbers = !config.notesClassicLayout && options?.lineNumbers?.length === segments.length ? options.lineNumbers : segments.map((_, k) => k + 1);
  runSettled = options?.settled ?? [];
  runCaptured = captured ?? [];
  return realNotesFor(item, segments, earlier, captured, context, options);
};

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}
interface RunRecord {
  n: number;
  itemId: string | null;
  at: number;
  ms: number;
  model: string;
  windowLines: number;
  itemLines: number;
  settled: number;
  folded: number;
  promptChars: number;
  usage: Usage;
  /** For the stand-in: the usage worked out from the prompt and a simulated prompt cache. */
  estimated: boolean;
  topics: number;
  stop: string;
}
const runs: RunRecord[] = [];
let lastCall: { usage: Usage; model: string; ms: number; promptChars: number; estimated: boolean; stop: string } | null = null;

/** What the run that just finished sent and got back (read through a function: the run sets it). */
const callJustMade = () => lastCall;

const messages = (agent as unknown as { client: { beta: { messages: { parse: (p: any, o?: any) => Promise<any> } } } }).client.beta.messages;
const realParse = messages.parse.bind(messages);
messages.parse = async (params: any, opts?: any) => {
  Date.now = realNow;
  const started = performance.now();
  try {
    const blocks = promptBlocks(params);
    if ((process.env.REPLAY_DUMP_RUNS ?? "").split(",").includes(String(runs.length + 1))) {
      fs.writeFileSync(path.join(out, `request-${runs.length + 1}.json`), JSON.stringify({ ...params, output_config: { ...params.output_config, format: "(schema)" } }, null, 1));
    }
    const promptChars = blocks.reduce((n, b) => n + b.text.length, 0);
    if (useModel) {
      const res = await realParse(params, opts);
      lastCall = { usage: res.usage, model: params.model, ms: performance.now() - started, promptChars, estimated: false, stop: res.stop_reason };
      return res;
    }
    // The stand-in places nothing: it only counts what the call would cost.
    const parsed = isMergeCall(params) ? { merges: [] } : standIn();
    const outText = JSON.stringify(parsed);
    const usage = { ...cacheSim(blocks), output_tokens: tokens(outText) };
    // Modeled latency: a second to start, then about 200 tokens a second.
    lastCall = { usage, model: params.model, ms: 1000 + (usage.output_tokens / 200) * 1000, promptChars, estimated: true, stop: "end_turn" };
    return { usage, parsed_output: parsed, stop_reason: "end_turn" };
  } finally {
    Date.now = simNow;
  }
};

const isMergeCall = (params: any) => typeof params.system === "string" && params.system.startsWith("You tidy the topic list");

/** The request as the text blocks the model reads, in order: system and the output format first. */
function promptBlocks(params: any): Array<{ text: string; cache: boolean }> {
  const system = typeof params.system === "string" ? params.system : JSON.stringify(params.system);
  const format = JSON.stringify(params.output_config?.format ?? "");
  const content = typeof params.messages[0].content === "string" ? [{ type: "text", text: params.messages[0].content }] : params.messages[0].content;
  return [
    { text: `${format}\n${system}`, cache: false },
    ...content.map((b: any) => ({ text: b.type === "text" ? b.text : "", cache: !!b.cache_control })),
  ];
}

/** About how many tokens the notes model counts for some text (its tokenizer runs ~30% above 4 characters a token). */
const tokens = (text: string) => Math.ceil(text.length / 3.1);

/** A 5-minute prompt cache: a request reads the longest earlier-cached prefix it shares (looking back
 *  up to 20 blocks from its breakpoint) and writes up to its breakpoint. Prefixes under 512 tokens don't cache. */
const cache = new Map<string, number>();
function cacheSim(blocks: Array<{ text: string; cache: boolean }>): Omit<Usage, "output_tokens"> {
  const total = blocks.reduce((n, b) => n + tokens(b.text), 0);
  const bp = blocks.findLastIndex((b) => b.cache);
  if (bp < 0) return { input_tokens: total, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const hashes: string[] = [];
  const upTo: number[] = [];
  let h = createHash("sha256");
  let n = 0;
  for (let i = 0; i <= bp; i++) {
    h.update(blocks[i].text);
    hashes.push(h.copy().digest("hex"));
    n += tokens(blocks[i].text);
    upTo.push(n);
  }
  const now = sim;
  const fresh = (k: string) => (cache.get(k) ?? -Infinity) > now - 5 * 60_000;
  let hit = -1;
  for (let i = bp; i >= Math.max(0, bp - 20); i--) if (fresh(hashes[i])) { hit = i; break; }
  if (upTo[bp] < 512) return { input_tokens: total, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const read = hit >= 0 ? upTo[hit] : 0;
  const write = upTo[bp] - read;
  if (hit >= 0) cache.set(hashes[hit], now);
  cache.set(hashes[bp], now);
  return { input_tokens: total - read - write, cache_read_input_tokens: read, cache_creation_input_tokens: write };
}

// ---- the stand-in: groups the window by the reference topics, at the size a model would answer ----
const gold: Array<{ id: string; title: string; spans: number[][] }> | null = args.gold ? JSON.parse(fs.readFileSync(args.gold, "utf8")).topics : null;
const labelOf: Array<string | null> = lines.map((l, i) => {
  if (!gold) return l.finalTopic;
  return gold.find((g) => g.spans.some(([a, b]) => i >= a && i <= b))?.id ?? null;
});
const titleOf = new Map<string, string>(gold ? gold.map((g) => [g.id, g.title]) : meeting.finalTopics.map((t) => [t.id, t.topic]));
const DROP = Number(process.env.REPLAY_STANDIN_DROP ?? 0);
let seed = 1;
/** Seeded, so a replay with drops gives the same answer twice. */
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
function standIn() {
  const groups = new Map<string, number[]>();
  runWindow.forEach((s, k) => {
    const label = labelOf[lineOf.get(s.id) ?? -1];
    if (!label) return;
    groups.set(label, [...(groups.get(label) ?? []), k]);
  });
  const discussions = [...groups].map(([label, at]) => {
    const title = titleOf.get(label) ?? label;
    const turns = at.filter((_, j) => j === 0 || !(DROP && rand() < DROP)).map((k) => runNumbers[k]);
    const speakers = [...new Set(at.map((k) => runWindow[k].speakerName))];
    const captured = runCaptured.filter((c) => c.text.startsWith(`${title}:`));
    return {
      topic: title,
      turns: config.notesTurnsAsRanges ? asRanges(turns) : turns,
      // A model's answer runs about this long per person and per note.
      positions: speakers.map((speaker) => ({ speaker, position: `Their stance on ${title}, in one short line of about this length.`.slice(0, 80) })),
      outcome: "open" as const,
      continues: null,
      picks_up: runSettled.find((t) => t.topic === title)?.key ?? null,
      decisions: [],
      action_items: [
        ...captured.map((c) => ({ text: c.text, owner: c.owner, same_as: c.key })),
        ...(captured.length ? [] : [{ text: `${title}: follow up on what was agreed here`, owner: speakers[0] ?? null, same_as: null }]),
      ],
      open_questions: turns.length > 20 ? [`What's still open about ${title}?`] : [],
    };
  });
  return { summary: "Where this item stands, in a sentence or two, as the model writes it each run.", discussions };
}

/** 3, 4, 5, 9 -> "3-5, 9", the way a model lists them with NOTES_TURNS=ranges. */
function asRanges(nums: number[]) {
  const out: string[] = [];
  for (let k = 0; k < nums.length; k++) {
    let j = k;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > k ? `${nums[k]}-${nums[j]}` : `${nums[k]}`);
    k = j;
  }
  return out.join(", ");
}

// ---- the replay ----
const speakerIds = new Map<string, string>();
function say(i: number) {
  const l = lines[i];
  const want = itemIdOf.get(l.itemId) ?? null;
  if (session.state().focusItemId !== want) session.setFocus(want, "Replay", "manual");
  const id = speakerIds.get(l.speaker) ?? `p${speakerIds.size + 1}`;
  speakerIds.set(l.speaker, id);
  const seg = roomInternals.addSegment(id, l.speaker, l.kind, l.text, l.ts);
  lineOf.set(seg.id, i);
}

interface Snapshot {
  /** When the board showed it: when the run finished. */
  at: number;
  itemId: string | null;
  topics: Array<{ id: string; topic: string; outcome: string; lines: number[]; mergedInto: string | null; group: string | null }>;
}
const snapshots: Snapshot[] = [];
const snapTopics = (discussions: ReturnType<typeof db.meetingDiscussions>) =>
  discussions.map((d) => ({
    id: d.id,
    topic: d.topic,
    outcome: d.outcome,
    lines: d.segmentIds.flatMap((id) => lineOf.get(id) ?? []),
    mergedInto: d.mergedInto ?? null,
    group: d.group ?? null,
  }));
const originalItem = (itemId: string | null) => [...itemIdOf].find(([, mine]) => mine === itemId)?.[0] ?? null;
interface MergeRecord {
  at: number;
  ms: number;
  model: string;
  usage: Usage;
  final: boolean;
  main: number;
  placed: number;
  topics: number;
}
const merges: MergeRecord[] = [];
/** Places the smaller topics now, as the room would, and records what the board shows once it answers. */
async function placeTopics(final: boolean) {
  lastCall = null;
  const before = JSON.stringify(db.meetingDiscussions(meetingId).map((d) => [d.id, d.mergedInto, d.group]));
  await roomInternals.mergeTopics(final);
  const call = callJustMade();
  const discussions = db.meetingDiscussions(meetingId);
  if (call)
    merges.push({
      at: sim,
      ms: Math.round(call.ms),
      model: call.model,
      usage: {
        input_tokens: call.usage.input_tokens,
        output_tokens: call.usage.output_tokens,
        cache_read_input_tokens: call.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: call.usage.cache_creation_input_tokens ?? 0,
      },
      final,
      main: discussions.filter((d) => !d.mergedInto && !d.group).length,
      placed: discussions.filter((d) => d.mergedInto || d.group).length,
      topics: discussions.length,
    });
  // It runs beside the notes runs: the board changes when it answers, and the talk doesn't wait.
  if (JSON.stringify(discussions.map((d) => [d.id, d.mergedInto, d.group])) === before) return;
  const at = sim + (call?.ms ?? 0);
  for (const itemId of new Set(discussions.map((d) => d.itemId)))
    snapshots.push({ at, itemId: originalItem(itemId), topics: snapTopics(discussions.filter((d) => d.itemId === itemId)) });
}
const started = performance.now();
if (session.state().focusItemId !== (itemIdOf.get(lines[0]?.itemId ?? null) ?? null)) session.setFocus(itemIdOf.get(lines[0].itemId) ?? null, "Replay", "manual");

let i = 0;
let n = 0;
while (i < lines.length || pending.size || mergeDue !== null) {
  const next = [...pending].sort((a, b) => a[1].due - b[1].due)[0];
  const nextAt = Math.min(next?.[1].due ?? Infinity, mergeDue ?? Infinity);
  if (i < lines.length && lines[i].ts <= nextAt) {
    sim = Math.max(sim, lines[i].ts);
    say(i++);
    continue;
  }
  if (mergeDue !== null && mergeDue <= (next?.[1].due ?? Infinity)) {
    sim = Math.max(sim, mergeDue);
    mergeDue = null;
    await placeTopics(false);
    continue;
  }
  const [itemId, { due }] = next;
  pending.delete(itemId);
  sim = Math.max(sim, due);
  const at = sim;
  const itemLines = db.itemSegments(meetingId, itemId).length;
  lastCall = null;
  await roomInternals.refreshNotes(itemId);
  const call = callJustMade();
  const ms = call?.ms ?? 0;
  const discussions = db.meetingDiscussions(meetingId).filter((d) => d.itemId === itemId);
  if (call) {
    runs.push({
      n: ++n,
      itemId,
      at,
      ms: Math.round(ms),
      model: call.model,
      windowLines: runWindow.length,
      itemLines,
      settled: runSettled.filter((t) => !t.going).length,
      folded: runSettled.filter((t) => t.going).length,
      promptChars: call.promptChars,
      usage: {
        input_tokens: call.usage.input_tokens,
        output_tokens: call.usage.output_tokens,
        cache_read_input_tokens: call.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: call.usage.cache_creation_input_tokens ?? 0,
      },
      estimated: call.estimated,
      topics: discussions.length,
      stop: call.stop,
    });
  }
  // Talk said while the run was going: it waits for the next run, as on a call.
  const end = at + ms;
  while (i < lines.length && lines[i].ts <= end) {
    sim = Math.max(sim, lines[i].ts);
    say(i++);
  }
  sim = Math.max(sim, end);
  snapshots.push({ at: sim, itemId: originalItem(itemId), topics: snapTopics(discussions) });
  if (n % 25 === 0 && call) {
    const mins = ((at - meeting.meeting.startedAt) / 60_000).toFixed(1);
    console.log(`[replay] run ${n} at ${mins} min: ${runWindow.length}/${itemLines} lines, ${discussions.length} topics, ${Math.round(ms)} ms`);
  }
}
if (args["final-merge"]) await placeTopics(true);
Date.now = realNow;
// The placing runs beside the notes runs, so its snapshots can land between theirs.
snapshots.sort((a, b) => a.at - b.at);

// ---- what it cost ----
const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.2, write: 2.5 },
};
const price = (r: { model: string; usage: Usage }) => {
  const p = PRICES[r.model];
  if (!p) return NaN;
  const u = r.usage;
  return (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_read_input_tokens * p.read + u.cache_creation_input_tokens * p.write) / 1e6;
};
const sum = (f: (r: RunRecord) => number) => runs.reduce((s, r) => s + f(r), 0);
const minutes = (Math.max(...lines.map((l) => l.ts)) - meeting.meeting.startedAt) / 60_000;
const summary = {
  agent: useModel ? "claude" : "stand-in",
  model: runs[0]?.model ?? config.notesModel,
  turns: config.notesTurnsAsRanges ? "ranges" : "every number",
  thinking: config.notesThinking,
  debounceMs: DEBOUNCE,
  maxWaitMs: MAX_WAIT,
  meetingMinutes: Math.round(minutes),
  lines: lines.length,
  runs: runs.length,
  runsPerMinute: +(runs.length / minutes).toFixed(2),
  medianRunMs: runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 0,
  tokens: {
    input: sum((r) => r.usage.input_tokens),
    cacheRead: sum((r) => r.usage.cache_read_input_tokens),
    cacheWrite: sum((r) => r.usage.cache_creation_input_tokens),
    output: sum((r) => r.usage.output_tokens),
  },
  costUsd: +sum(price).toFixed(4),
  costPerHourUsd: +((sum(price) / minutes) * 60).toFixed(4),
  merge: {
    calls: merges.length,
    medianMs: merges.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(merges.length / 2)] ?? 0,
    costUsd: +merges.reduce((c, r) => c + price(r), 0).toFixed(4),
    finalCostUsd: +merges.filter((r) => r.final).reduce((c, r) => c + price(r), 0).toFixed(4),
  },
  estimated: !useModel,
  wallSeconds: Math.round((performance.now() - started) / 1000),
};
fs.writeFileSync(path.join(out, "runs.json"), JSON.stringify(runs, null, 1));
fs.writeFileSync(path.join(out, "snapshots.json"), JSON.stringify(snapshots));
fs.writeFileSync(path.join(out, "merges.json"), JSON.stringify(merges, null, 1));
fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
