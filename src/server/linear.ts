// Loads Linear issues to use as a room's agenda. Accepts a project, cycle,
// custom view or issue URL, or a list of issue keys like "ENG-1, ENG-2".

import type { Item } from "../shared/protocol.ts";
import { config } from "./config.ts";

export type ImportedItem = Pick<Item, "source" | "externalId" | "title" | "url" | "description">;

const ISSUE_FIELDS = `identifier title url description priority state { name type } assignee { name }`;

type LinearIssue = {
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
};

export type LinearTarget =
  | { kind: "project"; id: string }
  | { kind: "cycle"; teamKey: string; number: number | "active" }
  | { kind: "view"; id: string }
  | { kind: "issues"; keys: string[] };

export function parseLinearInput(input: string): LinearTarget | null {
  const s = input.trim();
  const keys = s.match(/\b[A-Z][A-Z0-9]{0,9}-\d+\b/g);
  let url: URL | null = null;
  try {
    url = new URL(s);
  } catch {
    // not a URL
  }
  if (!url) return keys?.length ? { kind: "issues", keys: [...new Set(keys)] } : null;
  if (!/(^|\.)linear\.app$/.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean); // [workspace, kind, ...]
  const [, kind, a, b, c] = parts;
  const slugId = (slug: string) => slug.split("-").pop()!;
  if (kind === "issue" && a) return { kind: "issues", keys: [a.toUpperCase()] };
  if (kind === "project" && a) return { kind: "project", id: slugId(a) };
  if (kind === "view" && a) return { kind: "view", id: slugId(a) };
  if (kind === "team" && a) {
    if (b === "cycle" && c) return { kind: "cycle", teamKey: a.toUpperCase(), number: c === "active" ? "active" : Number(c) };
    if (b === "active" || b === "current") return { kind: "cycle", teamKey: a.toUpperCase(), number: "active" };
  }
  return null;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: config.linearKey! },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || body.errors?.length) throw new Error(body.errors?.[0]?.message ?? `Linear returned ${res.status}`);
  return body.data!;
}

const OPEN = (i: LinearIssue) => i.state?.type !== "canceled";

function toItem(i: LinearIssue): ImportedItem {
  const meta = [i.state?.name, i.assignee?.name].filter(Boolean).join(" · ");
  return {
    source: "linear",
    externalId: i.identifier,
    title: i.title,
    url: i.url,
    description: [meta, i.description?.slice(0, 2000)].filter(Boolean).join("\n\n") || null,
  };
}

export async function importFromLinear(input: string): Promise<ImportedItem[]> {
  if (!config.linearKey) throw new Error("Linear isn't connected yet. Add LINEAR_API_KEY to the server's .env.");
  const target = parseLinearInput(input);
  if (!target) throw new Error("Paste a Linear project, cycle, view or issue link, or issue keys like ENG-12.");

  let issues: LinearIssue[] = [];
  switch (target.kind) {
    case "project": {
      const d = await gql<{ project: { issues: { nodes: LinearIssue[] } } }>(
        `query($id: String!) { project(id: $id) { issues(first: 100) { nodes { ${ISSUE_FIELDS} } } } }`,
        { id: target.id },
      );
      issues = d.project.issues.nodes;
      break;
    }
    case "view": {
      const d = await gql<{ customView: { issues: { nodes: LinearIssue[] } } }>(
        `query($id: String!) { customView(id: $id) { issues(first: 100) { nodes { ${ISSUE_FIELDS} } } } }`,
        { id: target.id },
      );
      issues = d.customView.issues.nodes;
      break;
    }
    case "cycle": {
      type Cycle = { issues: { nodes: LinearIssue[] } } | null;
      const d = await gql<{ teams: { nodes: Array<{ activeCycle: Cycle; cycles: { nodes: Cycle[] } }> } }>(
        `query($key: String!, $n: Float) { teams(filter: { key: { eq: $key } }) { nodes {
           activeCycle { issues(first: 100) { nodes { ${ISSUE_FIELDS} } } }
           cycles(filter: { number: { eq: $n } }) { nodes { issues(first: 100) { nodes { ${ISSUE_FIELDS} } } } }
         } } }`,
        { key: target.teamKey, n: target.number === "active" ? -1 : target.number },
      );
      const team = d.teams.nodes[0];
      if (!team) throw new Error(`No Linear team with key ${target.teamKey}.`);
      const cycle = target.number === "active" ? team.activeCycle : team.cycles.nodes[0];
      if (!cycle) throw new Error("That cycle wasn't found (or the team has no active cycle).");
      issues = cycle.issues.nodes;
      break;
    }
    case "issues": {
      for (const key of target.keys.slice(0, 50)) {
        const d = await gql<{ issue: LinearIssue }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: key });
        if (d.issue) issues.push(d.issue);
      }
      break;
    }
  }
  return issues.filter(OPEN).map(toItem);
}

/** A believable sprint for trying the app without Linear. */
export function sampleSprint(): ImportedItem[] {
  const rows: Array<[string, string, string]> = [
    ["DEMO-101", "Onboarding checklist drops users on step 3", "In Progress · Priya"],
    ["DEMO-102", "Pricing page: annual plan toggle", "In Review · Sam"],
    ["DEMO-103", "Webhooks retry with exponential backoff", "Todo · Alex"],
    ["DEMO-104", "Flaky checkout e2e test on CI", "In Progress · Jordan"],
  ];
  return rows.map(([key, title, meta]) => ({ source: "linear", externalId: key, title, url: null, description: meta }));
}
