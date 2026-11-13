// The space's Activity tab: what agents did in a space, newest first. Nothing here is stored as an
// activity: each event is read from the record the action already left (a report on a to-do, a note
// a call caught, a slide, an answer), so the tab also shows what happened before it existed.
// It starts with agents: people's own agents over the MCP, Stand's own agent, and GitHub merges.
// People's changes can join later as one more kind of who.

/** Who did it, as the tab's filter pills list them. */
export interface ActivityWho {
  /** What the filter matches on: one per person's agent, plus "stand" and "github". */
  key: string;
  kind: "agent" | "stand" | "github";
  /** How a row names it: "Joe's Claude", "Stand", "GitHub". */
  name: string;
  /** The pill's label: the agent's own name. */
  short: string;
  /** Whose agent it is. */
  person: string | null;
  personId: string | null;
  picture: string | null;
}

/** What an event is about, and where clicking it goes. */
export interface ActivityTarget {
  text: string;
  /** A page in Stand. */
  href?: string;
  /** A to-do or open question: it opens in the space page's drawer. */
  taskId?: string;
  /** What it is, for the mark beside it in a folded list. */
  kind?: "action" | "decision" | "question" | "context" | "meeting";
}

export type ActivityKind =
  | "working" | "progress" | "blocked" | "needs_decision" | "ready" | "done" | "shipped" | "added" | "note" | "plan" | "linked"
  | "comment" | "review_asked" | "dropped" | "answered_question" | "slide" | "design" | "idea_review" | "project" | "renamed" | "caught"
  | "answer" | "options" | "sweep" | "settled";

export interface ActivityEvent {
  id: string;
  ts: number;
  /** An ActivityWho's key. */
  who: string;
  kind: ActivityKind;
  /** What it did, to follow the name: "started on", "caught 12 items in". */
  verb: string;
  target: ActivityTarget | null;
  /** Something waits on a person: the row's one colored word. */
  flag?: "Blocked" | "Needs a decision" | "Ready to ship" | "To confirm";
  /** What the agent wrote, shown when the row is opened. */
  detail?: string;
  links?: string[];
  /** What the row folds: the items a call caught, the meetings a rename named. */
  items?: ActivityTarget[];
  /** The model the agent said it was. */
  model?: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  /** Everyone the space's filter can show, the busiest first. */
  agents: ActivityWho[];
  /** Pass as `before` for the next page; null when there is nothing older. */
  next: number | null;
}

/** A row of the timeline: one event, or a burst of the same kind by the same agent folded into one. */
export interface ActivityRow {
  id: string;
  ts: number;
  who: string;
  /** The event, or the newest of the burst. */
  event: ActivityEvent;
  /** A burst: every event in it, newest first. */
  burst?: ActivityEvent[];
  /** A burst's line: "added 8 to-dos". */
  verb: string;
}

/** Events this close together, of one kind by one agent, are one burst. */
export const BURST_GAP_MS = 10 * 60_000;
/** A burst folds from this many events. */
export const BURST_MIN = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a burst of each kind reads as. A kind left out never folds: each one matters on its own. */
const BURSTS: Partial<Record<ActivityKind, (n: number, sameTarget: boolean) => string>> = {
  added: (n) => `added ${plural(n, "item")}`,
  note: (n, same) => (same ? `updated ${n} times:` : `updated ${plural(n, "to-do")}`),
  progress: (n, same) => (same ? `posted ${plural(n, "update")} on` : `posted progress on ${plural(n, "to-do")}`),
  working: (n) => `started on ${plural(n, "to-do")}`,
  linked: (n) => `linked ${plural(n, "to-do")}`,
  plan: (n, same) => (same ? `attached ${plural(n, "plan version")} to` : `attached plans to ${plural(n, "to-do")}`),
  comment: (n, same) => (same ? `left ${plural(n, "comment")} on` : `commented on ${plural(n, "to-do")}`),
  done: (n) => `completed ${plural(n, "to-do")}`,
  dropped: (n) => `dropped ${plural(n, "item")}`,
  shipped: (n) => `${plural(n, "merged PR")} closed ${plural(n, "to-do")}`,
  slide: (n) => `added ${plural(n, "slide")} to the product review`,
  answered_question: (n) => `answered ${plural(n, "open question")}`,
  answer: (n) => `answered ${plural(n, "question")}`,
};

/** Folds bursts: three or more events of one kind by one agent, each within ten minutes of the last,
 *  become one row where the newest of them sat. Events come and go newest first. */
export function groupActivity(events: ActivityEvent[]): ActivityRow[] {
  const groups: ActivityEvent[][] = [];
  const open = new Map<string, ActivityEvent[]>();
  const groupOf = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    if (!BURSTS[e.kind]) continue;
    const key = `${e.who}|${e.kind}`;
    const g = open.get(key);
    if (g && g[g.length - 1].ts - e.ts <= BURST_GAP_MS) g.push(e);
    else {
      const fresh = [e];
      groups.push(fresh);
      open.set(key, fresh);
    }
    groupOf.set(e.id, open.get(key)!);
  }
  const rows: ActivityRow[] = [];
  for (const e of events) {
    const g = groupOf.get(e.id);
    if (!g || g.length < BURST_MIN) {
      rows.push({ id: e.id, ts: e.ts, who: e.who, event: e, verb: e.verb });
      continue;
    }
    if (g[0] !== e) continue;
    const first = g[0].target;
    const same = !!first && g.every((x) => x.target?.text === first.text && x.target?.taskId === first.taskId);
    rows.push({ id: `burst:${e.id}`, ts: e.ts, who: e.who, event: e, burst: g, verb: BURSTS[e.kind]!(g.length, same) });
  }
  return rows;
}

/** A burst about one thing keeps its link; one about many has none of its own. */
export const burstTarget = (row: ActivityRow): ActivityTarget | null => {
  if (!row.burst) return row.event.target;
  const first = row.burst[0].target;
  return first && row.burst.every((x) => x.target?.text === first.text && x.target?.taskId === first.taskId) ? first : null;
};

/** The start of the day a time falls in, in the viewer's own time zone. */
export const dayStart = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
