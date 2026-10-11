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

Between meetings people also save notes to a space from the Stand bar on their Mac (typed or dictated), often with snaps of their screen pinned to them.

References look like stand:action/<id>, stand:decision/<id>, stand:question/<id>, stand:topic/<id> and stand:note/<id>. When the user pastes one (or a Stand /ref/ link), call get with it first and work from the decision and the reasons, not just the title.

"What's mine?" -> list_my_work. Everything to do in a space -> list_actions. What people saved to a space lately -> list_notes. What's coming up in the next meeting -> get_suggested_agenda. Starting on an item -> get_item_context. What happened in a meeting -> get_meeting_brief.
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
      title: "Get one Stand to-do, decision, question, topic or note",
      description:
        "Returns one thing from Stand by its reference (stand:action/<id>, stand:decision/<id>, stand:question/<id>, stand:topic/<id>, stand:note/<id>, or a Stand /ref/ link) with just enough context to act on it: its text, owner and status, the space and item it belongs to, the topic it came from with each person's position, related decisions and open questions on that item, short quotes, earlier updates, and snaps of the screen that go with it (fetch image_url with this same token). A note is one saved from the Stand bar, with the snaps pinned to it.",
      inputSchema: { ref: z.string().describe("A Stand reference like stand:action/k3m9xq2p or stand:note/j8f2kq1z, or a Stand link to one") },
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
    "list_actions",
    {
      title: "List a space's to-dos",
      description:
        "Every to-do in one Stand space, whoever owns it, newest meeting first. Each has its ref, owner, status, item, the decision behind it, and the meeting date. Filter by status and owner.",
      inputSchema: {
        space: z.string().describe("The space's id or name (from list_spaces)"),
        status: z.enum(["open", "done", "all"]).optional().describe("Default open"),
        owner: z.string().optional().describe('Only this person\'s (a name, or first name), or "unassigned"'),
      },
      annotations: READ,
    },
    ({ space, status, owner }) => run(() => api.listActions(caller, { space, status, owner }, baseUrl)),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List the notes saved to a Stand space",
      description:
        "Notes people saved to one Stand space from the Stand bar on their Mac (typed or dictated), newest first, each with its ref, who wrote it, when, the item it's filed under (the Stand agent files it until a person confirms), and the snaps of the screen pinned to it with the text read off them (fetch image_url with this same token). Also snaps saved without a note. Use it to catch up on a space between meetings.",
      inputSchema: {
        space: z.string().describe("The space's id or name (from list_spaces)"),
        item_id: z.string().optional().describe("Only notes filed under this item"),
        since: z.string().optional().describe("Only notes saved since this date or time, like 2026-10-11"),
        limit: z.number().int().optional().describe("Default 30, at most 100"),
      },
      annotations: READ,
    },
    ({ space, item_id, since, limit }) => run(() => api.listNotes(caller, { space, itemId: item_id, since, limit }, baseUrl)),
  );

  server.registerTool(
    "get_suggested_agenda",
    {
      title: "Get a Stand space's suggested agenda",
      description:
        "What the Stand agent suggests talking about at the space's next meeting, in order: blockers and decisions people are waiting on, open questions, then open to-dos, each with a one-line reason, its ref and how many meetings it has carried over. Also what's parked and how much got closed since last time. Use it to prepare for a meeting.",
      inputSchema: { space: z.string().describe("The space's id or name (from list_spaces)") },
      annotations: READ,
    },
    ({ space }) => run(() => api.suggestedAgenda(caller, space, baseUrl)),
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
        "Everything Stand knows about one agenda item (task, ticket or slide), ranked: decisions, open questions, open and recently done to-dos, the topics discussed with each person's position, updates reported since, notes people saved about it from the Stand bar (with their snaps), and snaps of the shared screen with what's on them (fetch image_url with this same token). Use it before starting work on an item.",
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
