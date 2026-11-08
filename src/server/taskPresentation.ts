import { createHash } from "node:crypto";
import type { TaskBrief } from "../shared/protocol.ts";
import type { Agent } from "./llm.ts";

/** Shared across viewers. An edited task/spec gets a new brief; failed runs can be retried. */
export class TaskBriefs {
  private cache = new Map<string, Promise<TaskBrief>>();
  constructor(private agent: Pick<Agent, "taskBrief">) {}

  get(id: string, title: string, spec: string): Promise<TaskBrief> {
    if (!this.agent.taskBrief) return Promise.reject(new Error("AI briefs are unavailable. You can still present the full spec."));
    if (!spec.trim()) return Promise.reject(new Error("Attach a spec to this task to generate a discussion brief."));
    if (spec.length > 120_000) return Promise.reject(new Error("This spec is too long for a discussion brief. Present the full spec instead."));
    const key = createHash("sha256").update(JSON.stringify([id, title, spec])).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const run = Promise.resolve().then(() => this.agent.taskBrief!(JSON.stringify({ task: title, spec }))).then((brief) => {
      if (!brief) throw new Error("Stand couldn't generate the discussion brief. Try again.");
      return brief;
    }).catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, run);
    return run;
  }
}
