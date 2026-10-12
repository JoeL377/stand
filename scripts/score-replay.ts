// Scores a replay (scripts/replay-notes.ts) against a reference list of the meeting's topics:
// how often the board's current topic was the one actually being talked about, how long a new
// topic took to show up, and which topics it never caught, merged or split.
//
//   node --import tsx scripts/score-replay.ts meeting.json gold-topics.json replay/current [more replays...]
import fs from "node:fs";
import path from "node:path";

interface Line {
  ts: number;
  speaker: string;
  text: string;
  itemId: string | null;
}
interface Gold {
  id: string;
  title: string;
  itemId: string | null;
  spans: number[][];
  importance: "major" | "minor";
}
interface Snapshot {
  at: number;
  itemId: string | null;
  topics: Array<{ id: string; topic: string; outcome: string; lines: number[] }>;
}

const [meetingFile, goldFile, ...replays] = process.argv.slice(2);
if (!replays.length) throw new Error("score-replay.ts meeting.json gold-topics.json replayDir [...]");
const lines: Line[] = JSON.parse(fs.readFileSync(meetingFile, "utf8")).lines;
const gold: Gold[] = JSON.parse(fs.readFileSync(goldFile, "utf8")).topics;
const goldOf: Array<string | null> = lines.map((_, i) => gold.find((g) => g.spans.some(([a, b]) => i >= a && i <= b))?.id ?? null);
const goldById = new Map(gold.map((g) => [g.id, g]));
/** A sample every 10 seconds of the meeting. */
const STEP = 10_000;
/** A remark with no reference topic keeps the last topic's label this long. */
const CARRY = 60_000;

function score(dir: string) {
  const snaps: Snapshot[] = JSON.parse(fs.readFileSync(path.join(dir, "snapshots.json"), "utf8"));
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  const majority = (idx: number[]) => {
    const count = new Map<string, number>();
    for (const i of idx) if (goldOf[i]) count.set(goldOf[i]!, (count.get(goldOf[i]!) ?? 0) + 1);
    const best = [...count].sort((a, b) => b[1] - a[1])[0];
    return best ? { id: best[0], share: best[1] / idx.length } : null;
  };

  // What the board showed at each moment, by the board's own rule: the topic holding the latest
  // remark, else the one talked about most recently, from the last notes run that had finished.
  const samples: Array<{ t: number; truth: string | null; shown: string | null; shownTitle: string | null; shownId: string | null }> = [];
  const start = lines[0].ts;
  const end = lines.at(-1)!.ts;
  let li = -1;
  let si = -1;
  let lastLabeled: { id: string; ts: number } | null = null;
  for (let t = start; t <= end; t += STEP) {
    while (li + 1 < lines.length && lines[li + 1].ts <= t) {
      li++;
      if (goldOf[li]) lastLabeled = { id: goldOf[li]!, ts: lines[li].ts };
    }
    while (si + 1 < snaps.length && snaps[si + 1].at <= t) si++;
    const focus = lines[li].itemId;
    const truth = goldOf[li] ?? (lastLabeled && t - lastLabeled.ts < CARRY ? lastLabeled.id : null);
    const snap = [...snaps.slice(0, si + 1)].reverse().find((s) => s.itemId === focus);
    let shown: Snapshot["topics"][number] | null = null;
    if (snap?.topics.length) {
      shown =
        snap.topics.find((d) => d.lines.includes(li)) ??
        [...snap.topics].sort((a, b) => Math.max(-1, ...b.lines.filter((x) => x <= li)) - Math.max(-1, ...a.lines.filter((x) => x <= li)))[0];
    }
    samples.push({ t, truth, shown: shown ? (majority(shown.lines)?.id ?? null) : null, shownTitle: shown?.topic ?? null, shownId: shown?.id ?? null });
  }
  const judged = samples.filter((s) => s.truth);
  const right = judged.filter((s) => s.shown === s.truth).length;

  // How long each stretch of talk on a topic took to show as the current topic, if it ever did.
  const stretches: Array<{ id: string; from: number; to: number }> = [];
  for (const g of gold) for (const [a, b] of g.spans) stretches.push({ id: g.id, from: lines[a].ts, to: lines[b].ts });
  stretches.sort((a, b) => a.from - b.from);
  const lags: Array<{ id: string; at: number; lag: number | null; minutes: number }> = stretches.map((s) => {
    const hit = samples.find((x) => x.t >= s.from && x.t <= s.to + STEP && x.shown === s.id);
    return { id: s.id, at: s.from, lag: hit ? hit.t - s.from : null, minutes: (s.to - s.from) / 60_000 };
  });
  const caught = lags.filter((l) => l.lag !== null).map((l) => l.lag!).sort((a, b) => a - b);

  // Topics as the board ended up with them: which reference topics have one, which were merged or split.
  const finals = new Map<string | null, Snapshot>();
  for (const s of snaps) finals.set(s.itemId, s);
  const finalTopics = [...finals.values()].flatMap((s) => s.topics);
  const everShown = new Set(samples.map((s) => s.shown).filter(Boolean));
  const holders = new Map<string, string[]>();
  const merged: string[] = [];
  for (const d of finalTopics) {
    const m = majority(d.lines);
    if (!m) continue;
    holders.set(m.id, [...(holders.get(m.id) ?? []), d.topic]);
    const others = new Set(d.lines.map((i) => goldOf[i]).filter((g) => g && g !== m.id));
    const big = [...others].filter((g) => d.lines.filter((i) => goldOf[i] === g).length >= Math.max(5, d.lines.length * 0.2));
    if (big.length) merged.push(`"${d.topic}" holds ${[m.id, ...big].join(" + ")}`);
  }
  const switches = samples.filter((s, k) => k && s.shownId !== samples[k - 1].shownId).length;
  const truthSwitches = samples.filter((s, k) => k && s.truth && samples[k - 1].truth && s.truth !== samples[k - 1].truth).length;
  const majors = gold.filter((g) => g.importance === "major");
  return {
    replay: path.basename(dir),
    agent: summary.agent,
    cadence: `${summary.debounceMs / 1000}s/${summary.maxWaitMs / 1000}s`,
    runs: summary.runs,
    costUsd: summary.costUsd,
    costPerHourUsd: summary.costPerHourUsd,
    currentTopicRight: +(right / judged.length).toFixed(3),
    medianLagSeconds: caught.length ? caught[Math.floor(caught.length / 2)] / 1000 : null,
    stretchesNeverShown: lags.filter((l) => l.lag === null && l.minutes >= 1).map((l) => `${l.id} at ${clock(l.at - start)} (${l.minutes.toFixed(1)} min)`),
    majorTopicsNeverShown: majors.filter((g) => !everShown.has(g.id)).map((g) => `${g.id} ${g.title}`),
    majorTopicsMissingAtEnd: majors.filter((g) => !holders.has(g.id)).map((g) => `${g.id} ${g.title}`),
    split: [...holders].filter(([, ts]) => ts.length > 1).map(([id, ts]) => `${id} -> ${ts.map((t) => `"${t}"`).join(", ")}`),
    merged,
    boardSwitchesPerHour: Math.round((switches / samples.length) * 360),
    realSwitchesPerHour: Math.round((truthSwitches / samples.length) * 360),
    finalTopics: finalTopics.length,
    referenceTopics: gold.length,
  };
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
for (const dir of replays) console.log(JSON.stringify(score(dir), null, 1));
void goldById;
