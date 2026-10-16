// Replays a meeting export through the middle board (src/server/board.ts) on a simulated clock,
// with the real board model, and records what the board showed every 30 seconds.
//
//   STAND_ANTHROPIC_API_KEY=… node --import tsx scripts/replay-thread.ts <meeting.json> --out DIR [--until MIN]
//
// BOARD_MODEL picks the model (default claude-sonnet-5-5). Writes DIR/ticks.json and
// DIR/summary.json. scripts/judge-thread.ts grades a run against hand-checked topics.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BOARD_EVERY_MS, BoardKeeper } from "../src/server/board.ts";
import { config } from "../src/server/config.ts";
import { ClaudeAgent } from "../src/server/llm.ts";
import type { Item, Segment } from "../src/shared/protocol.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const out = flag("out");
if (!args[0] || !out) throw new Error("usage: replay-thread.ts <meeting.json> --out DIR [--until MIN]");
const untilMin = flag("until") ? Number(flag("until")) : Infinity;
const apiKey = process.env.STAND_ANTHROPIC_API_KEY?.trim() || config.anthropicKey;
if (!apiKey) throw new Error("needs STAND_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY");

const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.2, write: 2.5 },
};
const usage = { in: 0, out: 0, read: 0, write: 0, calls: 0 };
// The agent logs every call's usage; count it from there.
const log = console.log;
console.log = (...a: unknown[]) => {
  const m = typeof a[0] === "string" && /^\[agent\] \S+ in=(\d+) cached=(\d+) wrote=(\d+) out=(\d+)/.exec(a[0]);
  if (!m) return log(...a);
  usage.in += +m[1];
  usage.read += +m[2];
  usage.write += +m[3];
  usage.out += +m[4];
  usage.calls++;
};

const m = JSON.parse(readFileSync(args[0], "utf8"));
const items: Item[] = m.items.filter((i: { id: string | null }) => i.id).map((i: { id: string; title: string }) => ({ id: i.id, title: i.title }) as Item);
const lines: Array<{ ts: number; speaker: string; text: string; itemId: string | null }> = m.lines;
const t0 = lines[0].ts;
const segments: Segment[] = lines.map((l, i) => ({ id: `s${i}`, meetingId: "replay", itemId: l.itemId, speakerId: l.speaker, speakerName: l.speaker, kind: "speech", text: l.text, ts: l.ts }) as Segment);
const fmt = (ts: number) => {
  const s = Math.floor((ts - t0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const agent = new ClaudeAgent(apiKey);
const keeper = new BoardKeeper(agent, t0);
const end = Math.min(lines.at(-1)!.ts, t0 + untilMin * 60_000);
const ticks: unknown[] = [];
let focus: string | null = lines[0].itemId;
let switches = 0;
let lastCurrent: string | null = null;
for (let now = t0 + BOARD_EVERY_MS; now <= end + BOARD_EVERY_MS; now += BOARD_EVERY_MS) {
  const said = segments.filter((s) => s.ts <= now);
  const at = said.at(-1)?.itemId ?? null;
  if (at !== focus) {
    focus = at;
    keeper.focused(at, said.find((s, i) => s.itemId === at && (i === 0 || said[i - 1].itemId !== at))?.ts ?? now);
  }
  if (!keeper.due(said)) continue;
  const started = Date.now();
  await keeper.run(said, items, m.meeting.attendees, focus, now);
  const ms = Date.now() - started;
  const b = keeper.board();
  const cur = b.threads.find((t) => t.id === b.currentId) ?? null;
  const switched = b.currentId !== lastCurrent ? (cur?.title ?? null) : null;
  if (switched) switches++;
  lastCurrent = b.currentId;
  ticks.push({ at: fmt(now), ts: now, ms, threadId: cur?.id ?? null, title: cur?.title ?? null, card: cur?.card ?? null, switched });
  log(`[${fmt(now)}] ${(ms / 1000).toFixed(1)}s ${switched ? `SWITCH → ${switched}` : (cur?.title ?? "-")}\n    now: ${cur?.card.now ?? ""}`);
}
mkdirSync(out, { recursive: true });
const p = PRICES[config.boardModel];
const cost = p ? (usage.in * p.in + usage.out * p.out + usage.read * p.read + usage.write * p.write) / 1e6 : null;
const hours = (end - t0) / 3_600_000;
const times = ticks.map((t) => (t as { ms: number }).ms).sort((a, b) => a - b);
const summary = {
  model: config.boardModel,
  threads: keeper.board().threads.map((t) => ({ id: t.id, title: t.title, start: fmt(t.spans[0][0]) })),
  switches,
  switchesPerHour: switches / hours,
  usage,
  costUsd: cost,
  costPerHourUsd: cost && cost / hours,
  medianMs: times[Math.floor(times.length / 2)],
};
writeFileSync(`${out}/ticks.json`, JSON.stringify(ticks, null, 1));
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1));
log(JSON.stringify(summary, null, 1));
