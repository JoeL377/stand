export type PlanVersion = { id: string; text: string; by: string; ts: number };
export type Passage = { start: number; end: number };
export type PlanAnchor = Passage & { version: string; quote: string };
/** `slide`: Stand wrote it when a design review called the point; the review's slide it was. */
export type ReviewMessage = { id: string; by: string; text: string; ts: number; slide?: string };
export type PlanThread = {
  id: string;
  original: PlanAnchor;
  placements: PlanAnchor[];
  resolved: boolean;
  messages: ReviewMessage[];
  /** The author took it off the design review; it stays open on the plan. */
  offDeck?: boolean;
  /** Where a thread made for a design review came from: the author's question, or one Stand suggested. */
  origin?: { review: string | null; source: "author" | "stand" };
};
export type PlanReview = {
  plan: PlanVersion;
  latest: string;
  threads: (PlanThread & { placement: Passage | null })[];
};

export function anchorPassage(plan: PlanVersion, range: Passage): PlanAnchor | null {
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start ||
      end > plan.text.length || end - start > 12_000) return null;
  const quote = plan.text.slice(start, end);
  return quote.trim() ? { version: plan.id, start, end, quote } : null;
}

export function carryPassage(anchor: PlanAnchor, source: string, target: string): Passage | null {
  if (source === target) return { start: anchor.start, end: anchor.end };
  const { quote } = anchor;
  const before = source.slice(0, anchor.start).trimEnd().split("\n").at(-1)?.trim();
  const after = source.slice(anchor.end).trimStart().split("\n")[0]?.trim();
  const matches: { range: Passage; context: number }[] = [];
  for (let start = target.indexOf(quote); start >= 0; start = target.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    // A fragment inside a rewritten line isn't evidence that the original block survived.
    if (target.slice(target.lastIndexOf("\n", start - 1) + 1, start).trim() !==
        source.slice(source.lastIndexOf("\n", anchor.start - 1) + 1, anchor.start).trim()) continue;
    if (target.slice(end).split("\n", 1)[0].trim() !== source.slice(anchor.end).split("\n", 1)[0].trim()) continue;
    const context = Number(!!before && target.slice(0, start).trimEnd().endsWith(before)) +
      Number(!!after && target.slice(end).trimStart().startsWith(after));
    matches.push({ range: { start, end }, context });
  }
  if (matches.length === 1 && (quote.trim().length >= 24 || matches[0].context)) return matches[0].range;
  const ranked = matches.filter((match) => match.context === 2);
  return ranked.length === 1 ? ranked[0].range : null;
}
