// What a design review shows of a spec: a summary for the Overview slide, up to four lines for each
// `##` section, and questions Stand suggests. The spec gives the slides and their order; Stand only
// writes the words on them, once per plan version, and the author can rewrite any of it.
//
// The brief is saved with the plan version, so a call opens on it without a wait and a deploy
// doesn't lose it. A new version gets a new brief; what the author wrote carries over.

import { BRIEF_LINES_MAX, BRIEF_LINE_MAX, BRIEF_SUMMARY_MAX, SECTION_SLIDES_MAX, type BriefSuggestion, type PlanBrief } from "../shared/designReview.ts";
import type { PlanVersion } from "../shared/planReview.ts";
import type { DB } from "./db.ts";
import { newId } from "./ids.ts";
import type { Agent } from "./llm.ts";
import { forSpace } from "./usage.ts";
import { planSections } from "./planReview.ts";

const SPEC_MAX = 120_000;
const QUESTION_MAX = 400;
/** A brief still "writing" after this long was cut off by a restart. */
const WRITING_MS = 3 * 60_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const key = (heading: string) => heading.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
const cleanLines = (lines: string[]) =>
  lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, BRIEF_LINES_MAX).map((l) => clip(l, BRIEF_LINE_MAX));

type Draft = NonNullable<Awaited<ReturnType<NonNullable<Agent["taskBrief"]>>>>;

/** The section slides of a spec: the headings on each, in the spec's order. Each section on the call
 *  has a slide of its own until there are more than SECTION_SLIDES_MAX; then the two adjacent slides
 *  with the least text under them join, until the deck fits. Once the author has grouped them
 *  (brief.grouped), a slide is a run of sections that each join the one before. */
export function slideGroups(brief: PlanBrief, spec: string): string[][] {
  if (brief.grouped) {
    const groups: string[][] = [];
    let open = false;
    for (const s of brief.sections) {
      if (!s.join) open = false;
      if (s.off) continue;
      if (open) groups.at(-1)!.push(s.heading);
      else groups.push([s.heading]);
      open = true;
    }
    return groups;
  }
  const size = new Map(planSections(spec).map((s) => [key(s.heading), s.end - s.headingEnd]));
  const groups = brief.sections.filter((s) => !s.off).map((s) => ({ headings: [s.heading], size: size.get(key(s.heading)) ?? 0 }));
  while (groups.length > SECTION_SLIDES_MAX) {
    let at = 0;
    for (let i = 1; i < groups.length - 1; i++) if (groups[i].size + groups[i + 1].size < groups[at].size + groups[at + 1].size) at = i;
    groups.splice(at, 2, { headings: [...groups[at].headings, ...groups[at + 1].headings], size: groups[at].size + groups[at + 1].size });
  }
  return groups.map((g) => g.headings);
}

/** The brief of a version before Stand has written anything: the spec's sections, with what the
 *  author wrote for an earlier version carried over. */
function skeleton(db: DB, noteId: string, versions: PlanVersion[], plan: PlanVersion, status: PlanBrief["status"]): PlanBrief {
  const earlier = versions.slice(0, versions.indexOf(plan)).reverse();
  const from = earlier.find((v) => db.planBrief(noteId, v.id));
  const prev = from ? db.planBrief(noteId, from.id) : null;
  const under = (text: string) => new Map(planSections(text).map((s) => [key(s.heading), text.slice(s.headingEnd, s.end).trim()]));
  const before = from ? under(from.text) : new Map<string, string>();
  const now = under(plan.text);
  const old = new Map((prev?.sections ?? []).map((s) => [key(s.heading), s]));
  const keptSummary = !!prev?.summaryEdited;
  return {
    version: plan.id,
    status,
    summary: keptSummary ? prev!.summary : "",
    summaryEdited: keptSummary,
    ...(keptSummary && (prev!.summaryChanged || from!.text !== plan.text) && { summaryChanged: true }),
    sections: planSections(plan.text).map((s) => {
      const was = old.get(key(s.heading));
      const kept = !!was?.edited;
      const changed = kept && (was!.changed || before.get(key(s.heading)) !== now.get(key(s.heading)));
      return { heading: s.heading, lines: kept ? was!.lines : [], edited: kept, off: !!was?.off, ...(changed && { changed: true }), ...(prev?.grouped && was?.join && { join: true }) };
    }),
    ...(prev?.grouped && { grouped: true }),
    suggestions: [],
    editedBy: prev?.editedBy ?? null,
    at: Date.now(),
  };
}

/** Stand's draft laid over the brief as it is saved now: nothing the author wrote is replaced, a
 *  section the spec doesn't have is dropped, and so is a question whose quote isn't in the spec. */
export function mergeDraft(brief: PlanBrief, draft: Draft, spec: string): PlanBrief {
  const lines = new Map(draft.sections.map((s) => [key(s.heading), cleanLines(s.lines)]));
  const have = new Set(brief.suggestions.map((s) => `${s.quote}\n${s.text}`));
  const fresh: BriefSuggestion[] = [];
  for (const q of draft.questions) {
    const quote = q.quote.trim();
    const text = clip(q.question.replace(/\s+/g, " ").trim(), QUESTION_MAX);
    if (!quote || !text || !spec.includes(quote) || have.has(`${quote}\n${text}`)) continue;
    have.add(`${quote}\n${text}`);
    fresh.push({ id: newId(10), quote, text, state: "open" });
  }
  return {
    ...brief,
    status: "ready",
    summary: brief.summaryEdited ? brief.summary : clip(draft.summary.replace(/\s+/g, " ").trim(), BRIEF_SUMMARY_MAX),
    sections: brief.sections.map((s) => (s.edited ? s : { ...s, lines: lines.get(key(s.heading)) ?? [] })),
    suggestions: [...brief.suggestions, ...fresh],
    at: Date.now(),
  };
}

export class PlanBriefs {
  private running = new Map<string, Promise<PlanBrief>>();
  constructor(private db: DB, private agent: Pick<Agent, "taskBrief">) {}

  /** The brief of the to-do's latest plan as it is saved; null when there is no plan or no brief yet. */
  current(noteId: string): PlanBrief | null {
    const plan = this.db.planVersions(noteId).at(-1);
    const brief = plan && this.db.planBrief(noteId, plan.id);
    if (!brief) return null;
    const cutOff = brief.status === "writing" && !this.running.has(`${noteId}:${plan.id}`) && Date.now() - brief.at > WRITING_MS;
    return cutOff ? { ...brief, status: "failed" } : brief;
  }

  /** Writes the brief of the latest plan if it has none, and resolves when it is written. `again`:
   *  Stand writes its part again (after a failed run, or when the author asks). The brief is saved
   *  before the model is asked, so a reader sees the spec's sections straight away. */
  ensure(note: { id: string; text: string }, again = false): Promise<PlanBrief | null> {
    const versions = this.db.planVersions(note.id);
    const plan = versions.at(-1);
    if (!plan) return Promise.resolve(null);
    const id = `${note.id}:${plan.id}`;
    const going = this.running.get(id);
    if (going) return going;
    const saved = this.db.planBrief(note.id, plan.id);
    if (saved && saved.status !== "writing" && !again) return Promise.resolve(saved);
    const can = !!this.agent.taskBrief && plan.text.length <= SPEC_MAX;
    const status = can ? "writing" : "none";
    const base: PlanBrief = saved
      ? { ...saved, status, suggestions: saved.suggestions.filter((s) => s.state !== "open"), at: Date.now() }
      : skeleton(this.db, note.id, versions, plan, status);
    this.db.savePlanBrief(note.id, base);
    if (!can) return Promise.resolve(base);
    const run = (async () => {
      let draft: Draft | null = null;
      try {
        draft = (await forSpace(this.agent, this.db.getNote(note.id)?.roomId ?? null).taskBrief!(JSON.stringify({ task: note.text, sections: base.sections.map((s) => s.heading), spec: plan.text }))) ?? null;
      } catch (err) {
        console.error("[agent] plan brief failed:", err);
      }
      // The author may have edited it while Stand wrote.
      const now = this.db.planBrief(note.id, plan.id) ?? base;
      const next: PlanBrief = draft ? mergeDraft(now, draft, plan.text) : { ...now, status: "failed", at: Date.now() };
      this.db.savePlanBrief(note.id, next);
      return next;
    })().finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  /** The brief to change: the saved one, started now if there is none. */
  private open(note: { id: string; text: string }): PlanBrief | null {
    const brief = this.current(note.id);
    if (brief) return brief;
    void this.ensure(note).catch(() => {});
    return this.current(note.id);
  }

  /** The author's words for the Overview. */
  setSummary(note: { id: string; text: string }, summary: string, by: string): PlanBrief | null {
    const brief = this.open(note);
    if (!brief) return null;
    const { summaryChanged: _c, ...rest } = brief;
    const next: PlanBrief = { ...rest, summary: clip(summary.trim(), BRIEF_SUMMARY_MAX), summaryEdited: true, editedBy: by };
    this.db.savePlanBrief(note.id, next);
    return next;
  }

  /** The author's lines for a section, the section taken off the call (or put back), or the section
   *  joined to the slide before it (or given its own). Null when the plan has no such section. */
  setSection(note: { id: string; text: string }, heading: string, change: { lines?: string[]; off?: boolean; join?: boolean }, by: string): PlanBrief | null {
    let brief = this.open(note);
    if (!brief?.sections.some((s) => key(s.heading) === key(heading))) return null;
    // The first time the author groups, the slides Stand made become theirs to change.
    if (change.join !== undefined && !brief.grouped) {
      const leads = new Set(slideGroups(brief, this.db.planVersions(note.id).at(-1)?.text ?? "").map((g) => g[0]));
      brief = { ...brief, grouped: true, sections: brief.sections.map((s, i) => ({ ...s, join: i > 0 && !leads.has(s.heading) })) };
    }
    const next: PlanBrief = {
      ...brief,
      editedBy: by,
      sections: brief.sections.map((s, i) => {
        if (key(s.heading) !== key(heading)) return s;
        const { changed: _c, ...rest } = s;
        return {
          ...(change.lines ? { ...rest, lines: cleanLines(change.lines), edited: true } : s),
          ...(change.off !== undefined && { off: change.off }),
          ...(change.join !== undefined && { join: change.join && i > 0 }),
        };
      }),
    };
    this.db.savePlanBrief(note.id, next);
    return next;
  }

  /** Hands the grouping of sections into slides back to Stand. */
  regroup(note: { id: string; text: string }, by: string): PlanBrief | null {
    const brief = this.open(note);
    if (!brief) return null;
    const { grouped: _g, ...rest } = brief;
    const next: PlanBrief = { ...rest, editedBy: by, sections: brief.sections.map(({ join: _j, ...s }) => s) };
    this.db.savePlanBrief(note.id, next);
    return next;
  }

  /** Marks a suggestion accepted or dismissed, and returns it as it was. Null when it isn't open. */
  closeSuggestion(note: { id: string; text: string }, id: string, state: "accepted" | "dismissed"): BriefSuggestion | null {
    const brief = this.current(note.id);
    const suggestion = brief?.suggestions.find((s) => s.id === id && s.state === "open");
    if (!brief || !suggestion) return null;
    this.db.savePlanBrief(note.id, { ...brief, suggestions: brief.suggestions.map((s) => (s.id === id ? { ...s, state } : s)) });
    return suggestion;
  }
}
