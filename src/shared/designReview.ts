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
}

/** Whether a to-do's spec is on the next design review, for the plan viewer's button. */
export interface DesignReviewState {
  queued: boolean;
  points: number;
}

/** One change the author makes while preparing a spec. */
export type BriefChange =
  | { summary: string }
  | { section: string; lines?: string[]; off?: boolean }
  | { suggestion: string; accept: boolean }
  | { point: string; off: boolean }
  | { question: string; section?: string | null }
  | { rewrite: true };

/** The points that get a slide: on the deck and with a passage in the plan under review. */
export const pointsOnDeck = (points: DesignPoint[]) => points.filter((p) => !p.off && p.placed);
