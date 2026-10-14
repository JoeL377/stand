// Scores a replay (scripts/replay-notes.ts) against a reference list of the meeting's topics:
// how often the board's current topic was the one actually being talked about, how long a new
// topic took to show up, and which topics it never caught, merged or split.
//
//   node --import tsx scripts/score-replay.ts meeting.json gold-topics.json replay/current [more replays...]
import fs from "node:fs";
import path from "node:path";
import { type ChapterTopic, chapterOf, stretches as barStretches } from "../src/shared/chapters.ts";
import { type Focus, pickFocus } from "../src/shared/boardFocus.ts";

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
  topics: Array<{ id: string; topic: string; outcome: string; lines: number[]; mergedInto?: string | null; group?: string | null }>;
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
  const samples: Array<{
    t: number;
    truth: string | null;
    shown: string | null;
    shownTitle: string | null;
    shownId: string | null;
    /** The same with the board waiting before it switches (shared/boardFocus.ts). */
    held: string | null;
    heldId: string | null;
    bar: number;
    barBefore: number;
  }> = [];
  let held: Focus | null = null;
  // The chapter bar at a moment: every item's topics as their last run left them.
  const shape = (d: Snapshot["topics"][number], itemId: string | null, placed: boolean): ChapterTopic => ({
    id: d.id,
    itemId,
    mergedInto: placed ? d.mergedInto : null,
    group: placed ? d.group : null,
    times: d.lines.map((i) => lines[i].ts),
  });
  const latestByItem = new Map<string | null, Snapshot>();
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
    while (si + 1 < snaps.length && snaps[si + 1].at <= t) latestByItem.set(snaps[++si].itemId, snaps[si]);
    const focus = lines[li].itemId;
    const truth = goldOf[li] ?? (lastLabeled && t - lastLabeled.ts < CARRY ? lastLabeled.id : null);
    const snap = [...snaps.slice(0, si + 1)].reverse().find((s) => s.itemId === focus);
    let shown: Snapshot["topics"][number] | null = null;
    if (snap?.topics.length) {
      shown =
        snap.topics.find((d) => d.lines.includes(li)) ??
        [...snap.topics].sort((a, b) => Math.max(-1, ...b.lines.filter((x) => x <= li)) - Math.max(-1, ...a.lines.filter((x) => x <= li)))[0];
    }
    if (snap) {
      held = pickFocus(
        held,
        shown?.id ?? null,
        snap.topics.map((d) => ({ id: d.id, lines: d.lines.map((i) => ({ id: String(i), ts: lines[i].ts })) })),
        lines[li].ts,
      );
    }
    const heldTopic = snap?.topics.find((d) => d.id === held?.id) ?? null;
    const all = [...latestByItem].flatMap(([itemId, s]) => s.topics.map((d) => ({ d, itemId })));
    const lastSaid = shown ? Math.max(-Infinity, ...shown.lines.map((i) => lines[i].ts)) : -Infinity;
    const live = shown && t - lastSaid < 120_000 ? shown.id : null;
    const bar = (placed: boolean, fold: boolean) => {
      const shapes = all.map(({ d, itemId }) => shape(d, itemId, placed));
      const byId = new Map(shapes.map((x) => [x.id, x]));
      const liveShape = live ? byId.get(live) : undefined;
      return barStretches(shapes, liveShape ? chapterOf(liveShape, byId) : null, t, { fold }).length;
    };
    samples.push({
      t,
      truth,
      shown: shown ? (majority(shown.lines)?.id ?? null) : null,
      shownTitle: shown?.topic ?? null,
      shownId: shown?.id ?? null,
      held: heldTopic ? (majority(heldTopic.lines)?.id ?? null) : null,
      heldId: heldTopic?.id ?? null,
      bar: bar(true, true),
      barBefore: bar(false, false),
    });
  }
  const judged = samples.filter((s) => s.truth);
  const right = judged.filter((s) => s.shown === s.truth).length;
  const heldRight = judged.filter((s) => s.held === s.truth).length;

  // How long each stretch of talk on a topic took to show as the current topic, if it ever did.
  const stretches: Array<{ id: string; from: number; to: number }> = [];
  for (const g of gold) for (const [a, b] of g.spans) stretches.push({ id: g.id, from: lines[a].ts, to: lines[b].ts });
  stretches.sort((a, b) => a.from - b.from);
  const lags: Array<{ id: string; at: number; lag: number | null; minutes: number }> = stretches.map((s) => {
    const hit = samples.find((x) => x.t >= s.from && x.t <= s.to + STEP && x.shown === s.id);
    return { id: s.id, at: s.from, lag: hit ? hit.t - s.from : null, minutes: (s.to - s.from) / 60_000 };
  });
  const caught = lags.filter((l) => l.lag !== null).map((l) => l.lag!).sort((a, b) => a - b);
  const heldLags = stretches
    .map((st) => {
      const hit = samples.find((x) => x.t >= st.from && x.t <= st.to + STEP && x.held === st.id);
      return hit ? hit.t - st.from : null;
    })
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);

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
  // For reading: each stretch of talk, and what the board showed during it.
  const rows = stretches.map((st, k) => {
    const during = samples.filter((x) => x.t >= st.from && x.t <= st.to);
    const shown = new Map<string, number>();
    for (const x of during) shown.set(x.shownTitle ?? "(nothing)", (shown.get(x.shownTitle ?? "(nothing)") ?? 0) + 1);
    const titles = [...shown].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} (${Math.round((c / during.length) * 100)}%)`);
    const lag = lags[k].lag === null ? "never" : `${Math.round(lags[k].lag! / 1000)}s`;
    return `| ${clock(st.from - start)} | ${st.id} ${goldById.get(st.id)!.title} | ${lag} | ${titles.join("; ") || "(under 10 s)"} |`;
  });
  fs.writeFileSync(
    path.join(dir, "timeline.md"),
    `# What the board showed: ${path.basename(dir)}\n\n| at | topic being talked about | shown after | what the board's current topic said |\n|---|---|---|---|\n${rows.join("\n")}\n`,
  );
  // Placings: which reference topic each placed topic and its chapter hold, to read for wrong ones.
  const finalById = new Map(finalTopics.map((d) => [d.id, d]));
  const placings = finalTopics
    .filter((d) => d.mergedInto || d.group)
    .map((d) => {
      const into = d.mergedInto ? finalById.get(d.mergedInto) : null;
      const mine = majority(d.lines)?.id ?? "-";
      const theirs = into ? (majority(into.lines)?.id ?? "-") : null;
      return { text: `"${d.topic}" (${mine}) -> ${into ? `"${into.topic}" (${theirs})` : `group "${d.group}"`}`, across: into ? mine !== theirs : false };
    });
  const finalShapes = [...finals].flatMap(([itemId, s]) => s.topics.map((d) => shape(d, itemId, true)));
  const shapeById = new Map(finalShapes.map((x) => [x.id, x]));
  const chaptersAtEnd = new Set(finalShapes.map((x) => chapterOf(x, shapeById)));
  // A major reference topic has a chapter of its own when the head of some chapter is mostly it.
  const heads = new Set(finalTopics.filter((d) => !d.mergedInto && !d.group).flatMap((d) => majority(d.lines)?.id ?? []));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
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
    heldBoard: {
      currentTopicRight: +(heldRight / judged.length).toFixed(3),
      medianLagSeconds: heldLags.length ? heldLags[Math.floor(heldLags.length / 2)] / 1000 : null,
      stretchesCaught: `${heldLags.length} of ${stretches.length}`,
      switchesPerHour: Math.round((samples.filter((s, k) => k && s.heldId !== samples[k - 1].heldId).length / samples.length) * 360),
    },
    realSwitchesPerHour: Math.round((truthSwitches / samples.length) * 360),
    finalTopics: finalTopics.length,
    referenceTopics: gold.length,
    chapters: {
      atEnd: chaptersAtEnd.size,
      barStretchesAtEnd: samples.at(-1)?.bar ?? 0,
      barStretchesAtEndBefore: samples.at(-1)?.barBefore ?? 0,
      medianBarStretches: median(samples.map((s) => s.bar)),
      medianBarStretchesBefore: median(samples.map((s) => s.barBefore)),
      majorTopicsWithOwnChapter: `${majors.filter((g) => heads.has(g.id)).length} of ${majors.length}`,
      placed: placings.length,
      placedAcrossReferenceTopics: placings.filter((p) => p.across).length,
      placings: placings.map((p) => p.text),
    },
  };
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
for (const dir of replays) console.log(JSON.stringify(score(dir), null, 1));
