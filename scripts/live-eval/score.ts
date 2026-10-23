// Grades what a live pipeline showed against the reference list (gold.ts): how many reference
// items it caught, how long after they were said they showed, how many of its lines are noise,
// and how much its lines moved (rewordings, lines that vanished while still true).
//   node --import tsx scripts/live-eval/score.ts gold.json meeting.json --delta run.json | --notes DIR | --board DIR
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ask, load } from "./common.ts";

const [goldFile, meetingFile, how, src, outFile] = process.argv.slice(2);
const gold: Array<{ id: string; kind: string; who: string | null; text: string; ts: number; weight: string }> = JSON.parse(readFileSync(goldFile, "utf8")).items;
const m = load(meetingFile);
const t0 = m.meeting.startedAt;
const end = m.lines.at(-1)!.ts;

interface Shown { id: string; kind: string; text: string; firstAt: number; rewordings: number; vanished: number; closed: string | null }
const shown: Shown[] = [];
const norm = (k: string) => ({ action: "todo", decision: "decided", question: "open" })[k] ?? k;

if (how === "--delta") {
  for (const i of JSON.parse(readFileSync(src, "utf8")).items) shown.push({ id: i.id, kind: i.kind, text: i.text, firstAt: i.shownAt, rewordings: i.edits.length, vanished: i.closed?.how === "wrong" ? 1 : 0, closed: i.closed?.how ?? null });
} else {
  // Snapshots over time, each the set of lines on screen: {at, lines:[{id,kind,text}]}
  let snaps: Array<{ at: number; lines: Array<{ id: string; kind: string; text: string }>; thread?: string | null }>;
  if (how === "--notes") {
    snaps = JSON.parse(readFileSync(`${src}/snapshots.json`, "utf8"))
      .filter((s: { notes?: unknown }) => s.notes)
      .map((s: { at: number; notes: Array<{ id: string; kind: string; text: string }> }) => ({ at: s.at, lines: s.notes.map((n) => ({ ...n, kind: norm(n.kind) })) }));
  } else {
    snaps = JSON.parse(readFileSync(`${src}/ticks.json`, "utf8")).map((t: { ts: number; ms: number; threadId: string | null; card: { details: Array<{ id: string; kind: string; text: string }> } | null }) => ({
      at: t.ts + t.ms,
      thread: t.threadId,
      lines: (t.card?.details ?? []).filter((d) => d.kind !== "position"),
    }));
  }
  const by = new Map<string, Shown>();
  let prev = new Map<string, string>();
  let prevThread: string | null | undefined;
  for (const s of snaps) {
    const now = new Map(s.lines.map((l) => [l.id, l.text]));
    for (const l of s.lines) {
      const had = by.get(l.id);
      if (!had) by.set(l.id, { id: l.id, kind: l.kind, text: l.text, firstAt: s.at, rewordings: 0, vanished: 0, closed: null });
      else if (prev.has(l.id) && prev.get(l.id) !== l.text) had.rewordings++;
    }
    // A line that leaves the screen. On the board a thread change takes every line with it.
    for (const id of prev.keys()) if (!now.has(id)) by.get(id)!.vanished++;
    prev = now;
    prevThread = s.thread;
  }
  void prevThread;
  shown.push(...by.values());
}

const Match = z.object({
  matches: z.array(z.object({ gold: z.string(), shown: z.array(z.string()).describe("Ids of shown lines that say the same thing (same task, decision or question), any wording") })),
});
const { out } = await ask(
  "claude-sonnet-5-5",
  Match,
  "You grade live meeting notes against a reference list. For each reference item, list the ids of the shown lines that say the same thing: the same task, decision or question, in any wording, even if the kind differs (a to-do shown as a decision still counts). A line that is only loosely related doesn't count. Give every reference item, with an empty list when nothing matches.",
  `Reference items:\n${gold.map((g) => `- ${g.id} ${g.kind}${g.who ? ` (${g.who})` : ""}: ${g.text}`).join("\n")}`,
  `Shown lines:\n${shown.map((s) => `- ${s.id} ${s.kind}: ${s.text}`).join("\n")}`,
  { thinking: true, maxTokens: 16000, effort: "medium" },
);
const hit = new Map((out?.matches ?? []).map((x) => [x.gold, x.shown.filter((id) => shown.some((s) => s.id === id))]));
const used = new Set([...hit.values()].flat());
const rows = gold.map((g) => {
  const ids = hit.get(g.id) ?? [];
  const first = ids.map((id) => shown.find((s) => s.id === id)!).sort((a, b) => a.firstAt - b.firstAt)[0];
  return { ...g, shownAs: first?.text ?? null, lagS: first ? Math.round((first.firstAt - g.ts) / 1000) : null };
});
const pct = (x: number, n: number) => (n ? Math.round((100 * x) / n) : 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);
const core = rows.filter((r) => r.weight === "core");
const lags = rows.flatMap((r) => (r.lagS === null ? [] : [Math.max(0, r.lagS)]));
const summary = {
  pipeline: `${how.slice(2)} ${src}`,
  gold: gold.length,
  caught: pct(rows.filter((r) => r.lagS !== null).length, rows.length),
  coreCaught: pct(core.filter((r) => r.lagS !== null).length, core.length),
  medianLagS: median(lags),
  p90LagS: lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(lags.length * 0.9)] : null,
  shownLines: shown.length,
  noisePct: pct(shown.filter((s) => !used.has(s.id)).length, shown.length),
  rewordingsPerLine: +(shown.reduce((s, x) => s + x.rewordings, 0) / Math.max(1, shown.length)).toFixed(2),
  vanishedPct: pct(shown.filter((s) => s.vanished > 0).length, shown.length),
  minutes: Math.round((end - t0) / 60_000),
};
writeFileSync(outFile, JSON.stringify({ summary, rows, shown }, null, 1));
console.log(JSON.stringify(summary));
