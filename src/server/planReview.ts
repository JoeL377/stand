import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Actor } from "../shared/actors.ts";
import { anchorPassage, carryPassage, type Passage, type PlanReview, type PlanThread, type PlanVersion } from "../shared/planReview.ts";
import { TASK_COMMENT_MAX, type Note } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import { newId } from "./ids.ts";

type MdNode = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MdNode[] };

/** The passages of a plan that can carry a comment: each top-level block and each list item, the
 *  same ones the plan viewer marks (web/Markdown.tsx). */
export function planBlocks(text: string): Passage[] {
  const blocks: Passage[] = [];
  const walk = (node: MdNode, top: boolean) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((top || node.type === "listItem") && start !== undefined && end !== undefined) blocks.push({ start, end });
    node.children?.forEach((child) => walk(child, false));
  };
  (unified().use(remarkParse).use(remarkGfm).parse(text) as MdNode).children?.forEach((node) => walk(node, true));
  return blocks;
}

/** Where a quote from the plan sits, widened to whole passages as a selection in the plan viewer is.
 *  "missing": the plan doesn't say that; "ambiguous": it says it more than once. */
export function quotePassage(text: string, quote: string): Passage | "missing" | "ambiguous" {
  const q = quote.trim();
  const at = q ? text.indexOf(q) : -1;
  if (at < 0) return "missing";
  if (text.indexOf(q, at + 1) >= 0) return "ambiguous";
  const blocks = planBlocks(text);
  const around = (pos: number) =>
    blocks.filter((b) => b.start <= pos && pos < b.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  const first = around(at);
  const last = around(at + q.length - 1);
  return first && last ? { start: first.start, end: last.end } : "missing";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A change to a thread goes on the to-do's log as a comment, so it shows wherever the to-do's work does. */
export function logThreadChange(
  db: DB, note: Note & { roomId: string }, thread: PlanThread, action: unknown,
  by: { userId: string; userName: string; client: string | null; actor?: Actor | null },
) {
  const passage = clip(thread.original.quote.trim().split("\n")[0].replace(/^[#>*\-\s|]+/, ""), 80);
  const first = clip(thread.messages[0]?.text ?? "", 120);
  const last = clip(thread.messages.at(-1)?.text ?? "", 400);
  const text =
    action === "create" ? `Commented on the plan, at "${passage}": ${last}`
    : action === "reply" ? `Replied on the plan, at "${passage}": ${last}`
    : action === "resolve" ? `Resolved a comment on the plan: "${first}"`
    : action === "reopen" ? `Reopened a comment on the plan: "${first}"`
    : null;
  if (!text) return;
  db.addUpdate({ roomId: note.roomId, itemId: note.itemId, noteId: note.id, noteText: note.text, ...by, status: "comment", text, links: [] });
}

export function reviewFor(db: DB, task: string, version?: string): PlanReview | null {
  const versions = db.planVersions(task);
  const latest = versions.at(-1);
  const index = version ? versions.findIndex((plan) => plan.id === version) : versions.length - 1;
  const plan = versions[index];
  if (!latest || !plan) return null;
  const byId = new Map(versions.map((entry, i) => [entry.id, i]));
  return {
    plan,
    latest: latest.id,
    threads: db.planThreads(task).map((thread) => {
      const candidates = [thread.original, ...thread.placements];
      const anchor = candidates.reduce<typeof thread.original | null>((best, candidate) => {
        const at = byId.get(candidate.version) ?? Infinity;
        return at <= index && (!best || at >= byId.get(best.version)!) ? candidate : best;
      }, null);
      return {
        ...thread,
        placement: anchor && carryPassage(anchor, versions[byId.get(anchor.version)!].text, plan.text),
      };
    }),
  };
}

export function changeReview(
  db: DB, task: string, by: string,
  input: { version?: unknown; thread?: unknown; action?: unknown; start?: unknown; end?: unknown; text?: unknown },
): PlanThread | null {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const message = () => ({ id: newId(12), by, text, ts: Date.now() });
  const validMessage = text.length > 0 && text.length <= TASK_COMMENT_MAX;
  const thread = db.planThreads(task).find((entry) => entry.id === input.thread);
  const plan = (): PlanVersion | undefined => db.planVersions(task).find((entry) => entry.id === input.version);
  const anchor = () => {
    const version = plan();
    return version && typeof input.start === "number" && typeof input.end === "number"
      ? anchorPassage(version, { start: input.start, end: input.end }) : null;
  };
  if (input.action === "create") {
    const original = anchor();
    if (!original || !validMessage) return null;
    const created = { id: newId(12), original, placements: [], resolved: false, messages: [message()] };
    db.savePlanThread(task, created);
    return created;
  }
  if (!thread) return null;
  switch (input.action) {
    case "reply":
      if (!validMessage) return null;
      thread.messages.push(message());
      break;
    case "resolve":
    case "reopen":
      thread.resolved = input.action === "resolve";
      break;
    case "reattach": {
      const placement = anchor();
      if (!placement) return null;
      thread.placements = [...thread.placements.filter((entry) => entry.version !== placement.version), placement];
      break;
    }
    default: return null;
  }
  db.savePlanThread(task, thread);
  return thread;
}
