// The sweep of a space's open questions: Stand reads them against what the space has decided and
// holds as true, and proposes which a decision answers and which nobody needs answered any more.
// It runs when someone asks for it on the Tasks tab, and changes nothing: the person ticks what
// they agree with and closes those in one step (agents.ts closeQuestion), because Stand never
// decides on its own.

import { createHash } from "node:crypto";
import type { SweepProposal } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import type { Agent } from "./llm.ts";
import { openQuestions, settledView } from "./spaceSettle.ts";

/** How many questions one sweep reads, oldest first. */
export const SWEEP_MAX = 120;
/** How many decisions and lines of context it reads them against, newest first. */
const AGAINST = 200;

/** The last sweep of each space, so opening the list again doesn't read everything again. */
const last = new Map<string, { basis: string; proposals: SweepProposal[] }>();

/** Sweeps running now: a second ask for the same space waits on the first. */
const running = new Map<string, Promise<SweepProposal[] | null>>();

/** Stand's proposals for a space's open questions, oldest first. Null when the model can't be asked. */
export function sweepQuestions(db: DB, agent: Agent, roomId: string, now = Date.now()): Promise<SweepProposal[] | null> {
  const going = running.get(roomId);
  if (going) return going;
  const run = sweep(db, agent, roomId, now).finally(() => running.delete(roomId));
  running.set(roomId, run);
  return run;
}

async function sweep(db: DB, agent: Agent, roomId: string, now: number): Promise<SweepProposal[] | null> {
  const room = db.getRoom(roomId);
  if (!room || !agent.sweepQuestions) return null;
  const questions = openQuestions(db, roomId).slice(0, SWEEP_MAX);
  if (!questions.length) return [];
  const decisions = settledView(db, roomId)
    .decided.filter((d) => d.decisionState === "kept")
    .reverse();
  const context = db.spaceContext(roomId, AGAINST).map((c) => c.text);
  const basis = createHash("sha1")
    .update([...questions, ...decisions].map((n) => `${n.id}:${n.text}`).join("\n") + context.join("\n"))
    .digest("hex");
  const before = last.get(roomId);
  if (before?.basis === basis) return before.proposals;
  const asked = questions.map((n, i) => ({ n, key: `Q${i + 1}` }));
  const decided = decisions.map((n, i) => ({ n, key: `D${i + 1}` }));
  const rows = await agent.sweepQuestions(
    { name: room.name, purpose: room.purpose },
    {
      today: now,
      questions: asked.map(({ n, key }) => ({ key, text: n.text, asked: n.meetingStartedAt })),
      decisions: decided.map(({ n, key }) => ({ key, text: n.text, on: n.meetingStartedAt })),
      context,
    },
  );
  if (!rows) return null;
  const proposals: SweepProposal[] = [];
  for (const { n, key } of asked) {
    const r = rows.find((x) => x.key === key);
    if (!r) continue;
    const by = r.how === "answered" ? decided.find((d) => d.key === r.by)?.n : undefined;
    // An answer names a decision the space has; one that doesn't is no proposal.
    if (r.how === "answered" && !by) continue;
    proposals.push({
      id: n.id,
      text: n.text,
      askedAt: n.meetingStartedAt,
      how: r.how,
      decision: by ? { id: by.id, text: by.text } : undefined,
      why: r.why.replace(/\s+/g, " ").trim().slice(0, 200),
    });
  }
  last.set(roomId, { basis, proposals });
  return proposals;
}
