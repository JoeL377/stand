// Who made a change in Stand. Work happens in Stand and in people's own harnesses, so a person,
// their agent, Stand itself and GitHub all act on the same to-dos. The "Joe via Claude" strings
// stay for display; this is what to count and filter on.
//
// It says who made the write, not who did the work: someone can tick a to-do another person's
// agent finished. For who did the work, follow closed_by to the PR.

export interface Actor {
  /** person: by hand. agent: someone's own agent over the MCP. stand: Stand itself. github: a merge. */
  kind: "person" | "agent" | "stand" | "github";
  /** Whose it is: the person, or the person the agent works for. Null for Stand. */
  person: string | null;
  personId?: string;
  /** The agent's name as its connection gave it, e.g. "Claude Code". */
  agent?: string;
  /** Which connection it came through: the id of the agent's token. */
  connection?: string;
  /** The model, as the agent reported it. Nobody checks this. */
  model?: string;
}

/** Reads an actor from a "who" string, for rows saved before actors were kept. */
export function parseActor(by: string | null | undefined): Actor | null {
  if (!by) return null;
  if (by.startsWith("carry-over")) return { kind: "stand", person: null };
  const via = by.match(/^(.+?) via (.+)$/);
  if (!via) return { kind: "person", person: by };
  return via[2] === "GitHub" ? { kind: "github", person: via[1] } : { kind: "agent", person: via[1], agent: via[2] };
}
