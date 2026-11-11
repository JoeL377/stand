// A design review: a call where the team goes through a spec, one slide per section and one per
// open comment thread (a point). These are the shapes the queue and the review page share.

export const BRIEF_SUMMARY_MAX = 600;
export const BRIEF_LINES_MAX = 4;
export const BRIEF_LINE_MAX = 200;
export const DESIGN_QUESTIONS_MAX = 12;

/** One `##` section of the spec as its slide shows it. The heading and the order come from the spec. */
export interface BriefSection {
  heading: string;
  /** What the section decides, in up to four lines. */
  lines: string[];
  /** The author wrote the lines; until then they are Stand's (✦). */
  edited: boolean;
  /** The author took the section off the call. */
  off: boolean;
  /** The spec's text under this heading changed after the author wrote the lines. */
  changed?: boolean;
}

/** A question Stand suggests about a passage. It is a point only after the author accepts it. */
export interface BriefSuggestion {
  id: string;
  quote: string;
  text: string;
  state: "open" | "accepted" | "dismissed";
}

/** What Stand wrote for one version of a plan, with the author's edits. */
export interface PlanBrief {
  /** The plan version it was written for. */
  version: string;
  /** "none": there is no model to write it, so it holds the spec's headings only. */
  status: "writing" | "ready" | "failed" | "none";
  summary: string;
  summaryEdited: boolean;
  /** The spec changed after the author wrote the summary. */
  summaryChanged?: boolean;
  sections: BriefSection[];
  suggestions: BriefSuggestion[];
  editedBy: string | null;
  at: number;
}

/** An open comment thread on the spec, as the review lists it. */
export interface DesignPoint {
  threadId: string;
  quote: string;
  text: string;
  by: string;
  /** The heading of the section its passage is in; null before the first one. */
  section: string | null;
  /** The author took it off the call; the thread stays open on the spec. */
  off: boolean;
  /** False when a newer version of the plan removed its passage: it has no slide. */
  placed: boolean;
}

export interface DesignSpec {
  taskId: string;
  title: string;
  owner: string | null;
  requestedBy: string | null;
  requestedAt: number;
  planVersion: string;
  planBy: string;
  /** The person looking wrote the spec or owns its to-do: they prepare it. */
  mine: boolean;
  brief: PlanBrief;
  points: DesignPoint[];
}

export interface DesignReviewView {
  id: string;
  status: "draft" | "live" | "done";
  specs: DesignSpec[];
}

/** The next design review as the Tasks tab's row shows it. */
export interface DesignReviewSummary {
  specs: number;
  points: number;
  titles: string[];
  /** It is in a call now. */
  live?: boolean;
}

/** Whether a to-do's spec is on the next design review, for the plan viewer's button. */
export interface DesignReviewState {
  queued: boolean;
  points: number;
  /** The review it is on is in a call now. */
  live?: boolean;
}

/** One change the author makes while preparing a spec. */
export type BriefChange =
  | { summary: string }
  | { section: string; lines?: string[]; off?: boolean }
  | { suggestion: string; accept: boolean }
  | { point: string; off: boolean }
  | { question: string; section?: string | null }
  | { rewrite: true };

/** How a point ended in the call, and the team's call on the spec. Anyone's one click. */
export type PointOutcome = "settled" | "open";
export type Verdict = "approve" | "changes" | "not_yet";
export type DesignOutcome = PointOutcome | Verdict;
export const POINT_OUTCOMES: Array<{ id: PointOutcome; label: string }> = [
  { id: "settled", label: "Settled" },
  { id: "open", label: "Still open" },
];
export const VERDICTS: Array<{ id: Verdict; label: string }> = [
  { id: "approve", label: "Approve" },
  { id: "changes", label: "Approve with changes" },
  { id: "not_yet", label: "Not yet" },
];
export const designOutcomeLabel = (o: DesignOutcome) => [...POINT_OUTCOMES, ...VERDICTS].find((x) => x.id === o)?.label ?? o;

export type DesignRole = "overview" | "section" | "point" | "verdict";

/** What a design review's slide carries besides its title and body (server/designReviews.ts). The
 *  body is the summary on an overview, the lines on a section, and the question on a point. */
export interface DesignSlideInfo {
  role: DesignRole;
  /** What the slide is called where a deck slide says "Slide 3". */
  name: string;
  /** The to-do whose spec this is, and the spec's title, on every slide of it. */
  taskId: string;
  spec: string;
  owner: string | null;
  /** Who wrote the plan, to tell its author from everyone else (specAuthor). */
  planBy: string;
  planById: string | null;
  /** Stand wrote the body and the author hasn't rewritten it. */
  stand?: boolean;
  /** A section's heading in the spec, also on the points under it. */
  section?: string | null;
  /** Where the slide's part of the spec is, for Full spec to open on. */
  passage?: { start: number; end: number } | null;
  /** Overview: the sections the call goes through. */
  sections?: string[];
  /** Overview: questions Stand suggests; the author can put one in front of the team. */
  suggestions?: BriefSuggestion[];
  /** Point: the thread, its passage as the spec has it, and who asked. */
  threadId?: string;
  quote?: string;
  by?: string;
  /** Verdict: open comments whose passage this version of the spec no longer has. */
  lost?: Array<{ quote: string; text: string; by: string }>;
  outcome: DesignOutcome | null;
  outcomeBy: string | null;
}

/** Whether this person prepares and walks through the spec: they own its to-do, or wrote its plan. */
export function specAuthor(spec: { owner: string | null; planBy: string; planById?: string | null }, user: { id: string; name: string }): boolean {
  const name = user.name.trim().toLowerCase();
  const owner = spec.owner?.trim().toLowerCase();
  if (owner && (owner === name || owner === name.split(/\s+/)[0])) return true;
  return (!!spec.planById && spec.planById === user.id) || spec.planBy === user.name || spec.planBy.startsWith(`${user.name} via `);
}

/** The points that get a slide: on the deck and with a passage in the plan under review. */
export const pointsOnDeck = (points: DesignPoint[]) => points.filter((p) => !p.off && p.placed);
