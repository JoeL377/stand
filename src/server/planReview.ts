import { anchorPassage, carryPassage, type PlanReview, type PlanThread, type PlanVersion } from "../shared/planReview.ts";
import { TASK_COMMENT_MAX } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import { newId } from "./ids.ts";

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
