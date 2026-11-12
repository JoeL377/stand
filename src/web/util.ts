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
  refileReview: "Review filing",
  brainstormMap: "Brainstorm map",
  designDiagram: "Design diagram",
  designSeed: "Design diagram start",
  recapMeeting: "Recap",
  summarizeMeeting: "Summary",
  synthesizeMeeting: "Synthesis",
  describeSnap: "Snaps",
  frameBacks: "Screen notes",
  matchScreen: "Screen reading",
  findOptions: "Find options",
  answer: "Ask Stand",
  draftDeck: "Deck draft",
  describeCapture: "Capture reading",
  pickItem: "Note filing",
  polishAgenda: "Agenda tidy",
  settleSpace: "Decisions check",
  doneDeck: "Done since",
  suggestProjects: "Project suggestions",
  sweepQuestions: "Question sweep",
  taskBrief: "Plan brief",
};

/** A pass's name on screen; an unnamed one shows its method name. */
export const taskName = (task: string) => TASK_NAMES[task] ?? task;

/** One line per pass, most expensive first: "Topic card $1.10 (98 calls)". */
export const costLines = (c: MeetingCost) =>
  c.tasks.map((t) => `${taskName(t.task)} ${fmtCost(t.usd)} (${t.calls} ${t.calls === 1 ? "call" : "calls"})`);

export const itemLabel = (it: Item | null | undefined) => (it ? it.title : "General discussion");

const palette = ["#5b5bd6", "#0d9488", "#d97706", "#db2777", "#2563eb", "#65a30d", "#9333ea", "#dc2626"];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}
/** A view owns one allocator: collisions take the next unused palette color.
 * Assignments stay put as people join; extra people receive additional hues. */
export function createPersonColors() {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  return (id: string) => {
    const existing = assigned.get(id);
    if (existing) return existing;
    const start = palette.indexOf(colorFor(id));
    let color: string | undefined;
    for (let offset = 0; offset < palette.length; offset++) {
      const candidate = palette[(start + offset) % palette.length];
      if (!used.has(candidate)) { color = candidate; break; }
    }
    if (!color) {
      // The golden angle spreads additional colors around the color wheel.
      let extra = assigned.size - palette.length;
      do {
        color = `hsl(${((extra++ * 137.508) % 360).toFixed(3)} 65% 42%)`;
      } while (used.has(color));
    }
    assigned.set(id, color);
    used.add(color);
    return color;
  };
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join("");

/** Short label shown before an item's title: the Linear key, or "Slide 3". */
export function keyOf(item: (Pick<Item, "externalId" | "slideNo"> & { slide?: Item["slide"] }) | null | undefined): string | null {
  if (!item) return null;
  return item.externalId ?? item.slide?.review?.name ?? item.slide?.design?.name ?? (item.slideNo ? `Slide ${item.slideNo}` : null);
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
