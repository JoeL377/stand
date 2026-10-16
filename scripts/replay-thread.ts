// Prototype for the redesigned middle board: one "thread" card (fixed title, a paragraph that
// keeps up with the talk, a few details, and a "now" line), built straight from the transcript
// and not from the live notes' topics. Replays a meeting export on a simulated clock.
//
//   STAND_ANTHROPIC_API_KEY=… npx tsx scripts/replay-thread.ts <meeting.json> --out DIR [--model claude-haiku-5-5] [--tick 30] [--until MIN]
//
// Writes DIR/ticks.json (every model answer and what the board showed) and DIR/summary.json.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const meetingPath = args[0];
const out = flag("out")!;
const model = flag("model", "claude-sonnet-5-5")!;
const tickMs = Number(flag("tick", "30")) * 1000;
const untilMin = flag("until") ? Number(flag("until")) : Infinity;
/** How much recent talk the model reads each time. */
const WINDOW_MS = 4 * 60_000;
/** A move to a new thread shows only after it holds for this many answers in a row. */
const CONFIRM = 2;

const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.2, write: 2.5 },
};

interface Line { ts: number; speaker: string; text: string; itemId: string | null }
const m = JSON.parse(readFileSync(meetingPath, "utf8"));
const lines: Line[] = m.lines;
const items: Record<string, string> = Object.fromEntries(m.items.filter((i: any) => i.id).map((i: any) => [i.id, i.title]));
const t0 = lines[0].ts;
const people = (m.meeting.attendees as string[]).join(", ");

const Detail = z.object({
  kind: z.enum(["position", "decided", "todo", "open", "ref"]),
  who: z.string().nullable().describe("First name for a position or a to-do owner; null otherwise"),
  text: z.string(),
});
const Card = z.object({
  summary: z.string(),
  now: z.string(),
  details: z.array(Detail),
});
const Answer = z.object({
  current: Card.describe("The thread on screen, brought up to date"),
  retitle: z.string().nullable().describe("Only while the thread on screen is under 3 minutes old and its title doesn't name the problem being worked out: a better title. Otherwise null"),
  shift: z
    .object({
      kind: z.enum(["new", "return"]),
      returnTo: z.string().nullable().describe("For return: the id of the earlier thread"),
      title: z.string(),
      card: Card,
    })
    .nullable()
    .describe("Only when the newest talk has clearly moved off the thread on screen"),
});
type Card = z.infer<typeof Card>;

const SYSTEM = `You keep the middle screen of a live team meeting. It shows ONE card: the thread of discussion the group is on.

A thread is ONE question or problem the group is working through, named the way a person would name it afterwards: "First-join audio bug", "Should participants edit to-dos?", "Should we merge Connect and Stand?". Never a container like "Testing the app" or "Product feedback": in a meeting that reviews a product, each bug, feature, or design question is its own thread. A long debate about one decision that moves through sub-questions is still one thread: follow the sub-questions in the summary and the "now" line.

Typical threads last 2 to 15 minutes; a big debate can last much longer.

Each time you get: the thread on screen (title, summary, details), earlier threads, and the last few minutes of transcript with the lines since your last look marked NEW. Transcription is rough: guess through misheard words and names.

Return:
- current: the on-screen thread brought up to date.
  - summary: one paragraph, 2-4 sentences, at most 70 words, present tense: what is being worked out, the main views by first name, and where it stands. Keep the previous wording where it is still right; change only what the new talk changes. Don't narrate ("they discuss"); say the substance. The summary is about this thread only: if you would need to write "now they..." about a different problem, that is a shift, not a summary edit.
  - now: at most 14 words, the point being made in the NEW lines, with the first name of who is making it ("Andy: building ingestion in Stand means merging in practice"). If the NEW lines are off this thread, say what they are about anyway.
  - details: at most 6, the most useful first: position (who + their view, one per person), decided, todo (who = owner), open (an unanswered question), ref (a name, link, number or thing mentioned that people may want to look up). Keep earlier details unless the talk replaced them.
- retitle: usually null. While the thread on screen is under 3 minutes old, if its title names the first remark rather than the problem being worked out, give a better title once.
- shift: null while the NEW lines still belong to the thread on screen. Ask: would the title on screen still be the right name for what the NEW lines are about? A tangent of a line or two, a joke, or the next sub-question of the same debate keeps the thread. A different problem, bug, feature, or decision is a new thread, even when it is about the same product (a bug report, then a question about how notes should look, are two threads). A mic check or small talk at the start is not a thread: move off it as soon as real work starts. Then give kind "new" with a short title (at most 8 words, the question or problem being worked out in plain words, not the first remark) and its own card from the lines that belong to it, or kind "return" with returnTo when talk went back to an earlier thread. When a move is already pending, say it again if it still holds, with the same title.`;

const client = new Anthropic({ apiKey: process.env.STAND_ANTHROPIC_API_KEY?.trim() });

interface Thread { id: string; title: string; card: Card; start: number; itemId: string | null }
const threads: Thread[] = [];
let current: Thread | null = null;
let pending: { kind: "new" | "return"; returnTo: string | null; title: string; card: Card; count: number; since: number } | null = null;
const usage = { in: 0, out: 0, read: 0, write: 0, calls: 0 };
const ticks: any[] = [];
const fmt = (ts: number) => {
  const s = Math.floor((ts - t0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const cardText = (c: Card) =>
  `Summary: ${c.summary}\nNow: ${c.now}\nDetails:\n${c.details.map((d) => `- ${d.kind}${d.who ? ` (${d.who})` : ""}: ${d.text}`).join("\n") || "(none)"}`;

const Drift = z.object({
  verdict: z.enum(["same", "moved"]),
  title: z.string().nullable().describe("For moved: the thread the talk is on now, at most 8 words"),
});
const DRIFT_SYSTEM = `You check one thing about a live meeting screen. Its title names the thread of discussion the group is on. Read the last few minutes of transcript and answer: would a person who just walked in, reading only this talk, still name it with this title?
- same: yes, or the talk is a sub-question of the same debate, or a short tangent.
- moved: the talk has turned to a different question or problem (it may have drifted there gradually). Give the title it is on now: at most 8 words, the question or problem being worked out.
Transcription is rough: guess through misheard words and names.`;

async function call<T>(system: string, stable: string, live: string, schema: z.ZodType<T>, now: number): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.beta.messages.parse({
        model,
        max_tokens: 3000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: stable, cache_control: { type: "ephemeral" } }, { type: "text", text: live }] }],
        output_config: { effort: "low", format: betaZodOutputFormat(schema) },
        thinking: { type: model.startsWith("claude-haiku") ? "disabled" : "between_tools" },
      } as any);
      const u = res.usage;
      usage.in += u.input_tokens;
      usage.out += u.output_tokens;
      usage.read += u.cache_read_input_tokens ?? 0;
      usage.write += u.cache_creation_input_tokens ?? 0;
      usage.calls++;
      return (res.parsed_output as any) ?? null;
    } catch (e) {
      console.error(`[${fmt(now)}] attempt ${attempt + 1} failed: ${(e as Error).message}`);
      if ((e as any).status === 400) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return null;
}

/** Is the title still right? Asked without the summary in view, so a slow drift can't hide in it. */
async function drift(now: number): Promise<z.infer<typeof Drift> | null> {
  const recent = lines.filter((l) => l.ts <= now && l.ts > now - 3 * 60_000);
  return call(DRIFT_SYSTEM, `People: ${people}`, `Title on screen: "${current!.title}"\n\nTranscript, last 3 minutes:\n${recent.map((l) => `[${fmt(l.ts)}] ${l.speaker}: ${l.text}`).join("\n")}`, Drift, now);
}

async function ask(now: number, lastLook: number, drifted: string | null): Promise<z.infer<typeof Answer> | null> {
  const recent = lines.filter((l) => l.ts <= now && l.ts > now - WINDOW_MS);
  const focus = [...lines].reverse().find((l) => l.ts <= now)?.itemId ?? null;
  const stable = [
    `People: ${people}`,
    `Agenda item in focus: ${focus ? items[focus] : "none (general talk)"}`,
    `Earlier threads:\n${threads.filter((t) => t !== current).map((t) => `- ${t.id} "${t.title}": ${t.card.summary}`).join("\n") || "(none)"}`,
  ].join("\n\n");
  const live = [
    current ? `Thread on screen: "${current.title}" (since ${fmt(current.start)}, now ${fmt(now)})\n${cardText(current.card)}` : "Thread on screen: none yet. If the talk has a subject, return it as shift kind new.",
    pending ? `Pending move (${pending.kind}): "${pending.title}"` : "",
    drifted ? `A check of the last 3 minutes says the talk has moved off the title on screen, to: "${drifted}". Unless that is plainly wrong, return shift kind new (or return, if it is an earlier thread).` : "",
    `Transcript, last ${WINDOW_MS / 60000} minutes (meeting time):\n${recent.map((l) => `${l.ts > lastLook ? "NEW " : ""}[${fmt(l.ts)}] ${l.speaker}: ${l.text}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  return call(SYSTEM, stable, live, Answer, now);
}

const end = Math.min(lines.at(-1)!.ts, t0 + untilMin * 60_000);
let lastLook = t0 - 1;
let switches = 0;
let sinceDrift = 0;
const DRIFT_EVERY = 4;
for (let now = t0 + tickMs; now <= end + tickMs; now += tickMs) {
  const fresh = lines.filter((l) => l.ts > lastLook && l.ts <= now);
  if (fresh.length < 2 && current) continue;
  if (!fresh.length) continue;
  const started = Date.now();
  // Every 2 minutes on a thread, or while a move the check found waits to be confirmed.
  let drifted: string | null = null;
  if (current && !pending && ++sinceDrift >= DRIFT_EVERY) {
    sinceDrift = 0;
    const d = await drift(now);
    if (d?.verdict === "moved" && d.title) drifted = d.title;
    if (drifted) console.log(`[${fmt(now)}] drift check: moved → ${drifted}`);
  }
  const a = await ask(now, lastLook, drifted);
  const ms = Date.now() - started;
  lastLook = now;
  if (!a) continue;
  let switched: string | null = null;
  if (current) current.card = a.current;
  let retitled: string | null = null;
  if (current && a.retitle && !(current as any).retitled && now - current.start < 3 * 60_000 && a.retitle !== current.title && !a.shift) {
    retitled = current.title = a.retitle;
    (current as any).retitled = true;
  }
  if (a.shift) {
    const sameAsPending = pending && pending.kind === a.shift.kind && (a.shift.kind === "return" ? pending.returnTo === a.shift.returnTo : true);
    pending = sameAsPending
      ? { ...pending!, title: pending!.title, card: a.shift.card, count: pending!.count + 1 }
      : { kind: a.shift.kind, returnTo: a.shift.returnTo, title: a.shift.title, card: a.shift.card, count: 1, since: now };
    const back = pending.kind === "return" ? threads.find((t) => t.id === pending!.returnTo) : undefined;
    if (!current || pending.count >= CONFIRM) {
      if (back) {
        back.card = pending.card;
        current = back;
      } else {
        current = { id: `T${threads.length + 1}`, title: pending.title, card: pending.card, start: pending.since - tickMs, itemId: fresh.at(-1)!.itemId };
        threads.push(current);
      }
      switched = current.title;
      sinceDrift = 0;
      switches++;
      pending = null;
    }
  } else pending = null;
  const tick = { at: fmt(now), ts: now, ms, threadId: current?.id ?? null, title: current?.title ?? null, card: current?.card ?? null, pending: pending && { title: pending.title, count: pending.count }, switched, retitled };
  ticks.push(tick);
  console.log(`[${tick.at}] ${(ms / 1000).toFixed(1)}s ${switched ? `SWITCH → ${switched}` : current?.title}${pending ? ` (pending: ${pending.title})` : ""}\n    now: ${current?.card.now}`);
}
mkdirSync(out, { recursive: true });
const p = PRICES[model];
const cost = p ? (usage.in * p.in + usage.out * p.out + usage.read * p.read + usage.write * p.write) / 1e6 : null;
const hours = (end - t0) / 3_600_000;
const summary = { model, tickSeconds: tickMs / 1000, threads: threads.map((t) => ({ id: t.id, title: t.title, start: fmt(t.start) })), switches, switchesPerHour: switches / hours, usage, costUsd: cost, costPerHourUsd: cost && cost / hours, medianMs: ticks.map((t) => t.ms).sort((a, b) => a - b)[Math.floor(ticks.length / 2)] };
writeFileSync(`${out}/ticks.json`, JSON.stringify(ticks, null, 1));
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
