// What each Claude call cost, kept per meeting so the recap (and the call itself) can show what a
// meeting spent. A room wraps its agent in metered(): every call made through it runs inside that
// meeting's scope, and llm.ts reports each response's token usage here, which lands in llm_usage.
// Calls made outside a meeting (Done since, the space settle pass) are kept with no meeting.
import { AsyncLocalStorage } from "node:async_hooks";

export interface UsageRow {
  meetingId: string | null;
  /** The agent method that made the call, like boardCard or recapMeeting. */
  task: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  at: number;
}

/** First-party prices in dollars per million tokens. Cache writes (5 minute) are 1.25x input. */
const PRICES: Array<{ prefix: string; input: number; cacheRead: number; output: number }> = [
  { prefix: "claude-opus-5-5", input: 4, cacheRead: 0.2, output: 20 },
  { prefix: "claude-opus", input: 5, cacheRead: 0.5, output: 25 },
  { prefix: "claude-sonnet-5", input: 2, cacheRead: 0.2, output: 10 },
  { prefix: "claude-sonnet", input: 3, cacheRead: 0.3, output: 15 },
  { prefix: "claude-haiku-5-5", input: 0.1, cacheRead: 0.01, output: 0.5 },
  { prefix: "claude-haiku", input: 1, cacheRead: 0.1, output: 5 },
];

/** A call's cost in dollars. An unknown model is priced as Opus, so it's never under-counted. */
export function costOf(r: Pick<UsageRow, "model" | "input" | "cacheRead" | "cacheWrite" | "output">): number {
  const p = PRICES.find((x) => r.model.startsWith(x.prefix)) ?? PRICES[1];
  return (r.input * p.input + r.cacheWrite * p.input * 1.25 + r.cacheRead * p.cacheRead + r.output * p.output) / 1_000_000;
}

const scope = new AsyncLocalStorage<{ meetingId: string; task: string; spent?: () => void }>();
let sink: ((row: UsageRow) => void) | null = null;

/** Where usage rows go (the database), set once at startup. */
export function setUsageSink(fn: (row: UsageRow) => void) {
  sink = fn;
}

/** llm.ts calls this with every response's usage. */
export function recordUsage(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const s = scope.getStore();
  try {
    sink?.({
      meetingId: s?.meetingId ?? null,
      task: s?.task ?? "other",
      model,
      input: u.input_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens,
      at: Date.now(),
    });
    s?.spent?.();
  } catch (err) {
    console.error("[agent] could not record usage:", err);
  }
}

/** The agent, with every method call counted against this meeting. `spent` runs after each recorded call. */
export function metered<T extends object>(agent: T, meetingId: string, spent?: () => void): T {
  return new Proxy(agent, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => scope.run({ meetingId, task: String(key), spent }, () => v.apply(target, args));
    },
  });
}
