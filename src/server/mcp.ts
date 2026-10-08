// The Stand MCP server at /mcp (Streamable HTTP, stateless: a fresh server per
// request, so it runs fine on one instance with no session store). Agents in
// Claude Code, Cursor or Codex authenticate with a personal access token from
// the Connect an agent page and see exactly the spaces their person is in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { AgentError, type AgentApi, type Caller } from "./agents.ts";

const INSTRUCTIONS = `Stand records team meetings and pins what was said to the agenda item it was about: decisions, to-dos with owners, open questions, and the topics they came out of.

References look like stand:action/<id>, stand:decision/<id>, stand:question/<id> and stand:topic/<id>. When the user pastes one (or a Stand /ref/ link), call get with it first and work from the decision and the reasons, not just the title.

"What's mine?" -> list_my_work. Starting on an item -> get_item_context. What happened in a meeting -> get_meeting_brief.
Report back when you finish or get stuck: complete_action for a to-do you finished (add a note and the PR link), post_update for progress, a blocker, or something people need to decide. Reports show up on that item in Stand.`;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (err: unknown) => {
  if (err instanceof AgentError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
  throw err;
};
const run = (fn: () => unknown) => {
  try {
    return ok(fn());
  } catch (err) {
    return fail(err);
  }
};

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export function buildMcpServer(api: AgentApi, caller: Caller, baseUrl: string) {
  const server = new McpServer({ name: "stand", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get",
    {
      title: "Get one Stand to-do, decision, question or topic",
      description:
        "Returns one thing from Stand by its reference (stand:action/<id>, stand:decision/<id>, stand:question/<id>, stand:topic/<id>, or a Stand /ref/ link) with just enough context to act on it: its text, owner and status, the space and item it belongs to, the topic it came from with each person's position, related decisions and open questions on that item, short quotes, and earlier updates.",
      inputSchema: { ref: z.string().describe("A Stand reference like stand:action/k3m9xq2p, or a Stand link to one") },
      annotations: READ,
    },
    ({ ref }) => run(() => api.get(caller, ref, baseUrl)),
  );

  server.registerTool(
    "list_my_work",
    {
      title: "List my Stand to-dos",
      description:
        "To-dos owned by the person this token belongs to, across the Stand spaces they're in, newest meeting first. Each has its ref, item, the decision behind it, and the meeting date.",
      inputSchema: {
        space: z.string().optional().describe("Only this space (id or part of its name)"),
        status: z.enum(["open", "done", "all"]).optional().describe("Default open"),
        include_unassigned: z.boolean().optional().describe("Also include to-dos nobody owns"),
      },
      annotations: READ,
    },
    ({ space, status, include_unassigned }) =>
      run(() => api.listMyWork(caller, { space, status, includeUnassigned: include_unassigned }, baseUrl)),
  );

  server.registerTool(
    "list_spaces",
    {
      title: "List my Stand spaces",
      description:
        "The spaces this person is in, with their purpose, open to-do counts, their items (ids for get_item_context) and latest meeting id.",
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => api.listSpaces(caller)),
  );

  server.registerTool(
    "get_item_context",
    {
      title: "Get the context for a Stand item",
      description:
        "Everything Stand knows about one agenda item (task, ticket or slide), ranked: decisions, open questions, open and recently done to-dos, the topics discussed with each person's position, and updates reported since. Use it before starting work on an item.",
      inputSchema: { item_id: z.string().describe("The item's id, from list_spaces, list_my_work or get") },
      annotations: READ,
    },
    ({ item_id }) => run(() => api.itemContext(caller, item_id, baseUrl)),
  );

  server.registerTool(
    "get_meeting_brief",
    {
      title: "Get a Stand meeting brief",
      description:
        "The follow-up brief for one meeting (schema stand.meeting-brief/v1): summary, to-dos, decisions, open questions and topics per item. Give meeting_id, or space_id for that space's latest meeting.",
      inputSchema: {
        meeting_id: z.string().optional(),
        space_id: z.string().optional().describe("Use the latest meeting in this space"),
        transcript: z.boolean().optional().describe("Include what was said (long). Default false"),
      },
      annotations: READ,
    },
    ({ meeting_id, space_id, transcript }) =>
      run(() => api.meetingBrief(caller, { meetingId: meeting_id, spaceId: space_id, transcript }, baseUrl)),
  );

  server.registerTool(
    "post_update",
    {
      title: "Post an update to Stand",
      description:
        "Reports progress, a blocker, or something people need to decide on an item (or on one to-do, by its ref). It shows on that item in Stand under Since last time, attributed to this person via this agent. Append only.",
      inputSchema: {
        ref: z.string().optional().describe("The to-do, decision, question or topic this is about (stand:action/<id> …)"),
        item_id: z.string().optional().describe("Or the item it's about"),
        text: z.string().describe("What happened, in a sentence or two"),
        status: z.enum(["progress", "blocked", "needs_decision"]).optional().describe("Default progress"),
        links: z.array(z.string()).optional().describe("PRs, docs or other links (up to 5)"),
      },
      annotations: WRITE,
    },
    ({ ref, item_id, text, status, links }) => run(() => api.postUpdate(caller, { ref, itemId: item_id, text, status, links })),
  );

  server.registerTool(
    "complete_action",
    {
      title: "Check off a Stand to-do",
      description:
        "Marks a to-do done in Stand (the same as ticking its box), with an optional closing note and links such as the PR. Shows as done by this person via this agent.",
      inputSchema: {
        ref: z.string().describe("The to-do's reference, stand:action/<id>"),
        note: z.string().optional().describe("What was done"),
        links: z.array(z.string()).optional().describe("PRs, docs or other links (up to 5)"),
      },
      annotations: WRITE,
    },
    ({ ref, note, links }) => run(() => api.completeAction(caller, { ref, note, links })),
  );

  return server;
}

/** Handles one MCP request. Stateless, so GET (server-to-client streams) and DELETE aren't offered. */
export async function handleMcp(req: Request, res: Response, api: AgentApi, caller: Caller, baseUrl: string) {
  if (req.method !== "POST") {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }
  const server = buildMcpServer(api, caller, baseUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
