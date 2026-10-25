import type { Item, MeetingCost } from "../shared/protocol.ts";

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
export const fmtDuration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** "$4.52", or "$0.04" for small amounts. */
export const fmtCost = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`;

/** What each Claude pass is called on screen (agent methods, server/llm.ts). */
const TASK_NAMES: Record<string, string> = {
  boardCard: "Topic card",
  boardDrift: "Topic check",
  liveList: "Running list",
  notesFor: "Live notes",
  mergeTopics: "Topic merge",
  recapMeeting: "Recap",
  summarizeMeeting: "Summary",
  synthesizeMeeting: "Synthesis",
  describeSnap: "Snaps",
  frameBacks: "Screen notes",
  matchScreen: "Screen reading",
};

/** One line per pass, most expensive first: "Topic card $1.10 (98 calls)". */
export const costLines = (c: MeetingCost) =>
  c.tasks.map((t) => `${TASK_NAMES[t.task] ?? t.task} ${fmtCost(t.usd)} (${t.calls} ${t.calls === 1 ? "call" : "calls"})`);

export const itemLabel = (it: Item | null | undefined) => (it ? it.title : "General discussion");

const palette = ["#5b5bd6", "#0d9488", "#d97706", "#db2777", "#2563eb", "#65a30d", "#9333ea", "#dc2626"];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join("");

/** Short label shown before an item's title: the Linear key, or "Slide 3". */
export function keyOf(item: Pick<Item, "externalId" | "slideNo"> | null | undefined): string | null {
  if (!item) return null;
  return item.externalId ?? (item.slideNo ? `Slide ${item.slideNo}` : null);
}

/** Links read as "PR #12" or the site's name rather than a raw URL. */
export function linkLabel(url: string) {
  try {
    const u = new URL(url);
    const pr = /\/pull\/(\d+)/.exec(u.pathname);
    if (u.hostname === "github.com" && pr) return `PR #${pr[1]}`;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "just now", "4 min ago", "3h ago", "2d ago". */
export function fmtAgo(ts: number) {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
