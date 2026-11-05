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

References look like stand:action/<id>, stand:decision/<id>, stand:question/<id>, stand:context/<id>, stand:topic/<id> and stand:note/<id>. When the user pastes one (or a Stand /ref/ link), call get with it first and work from the decision and the reasons, not just the title.

"What's new?" or catching up on a space -> whats_new. "What's mine?" -> list_my_work. Everything to do in a space -> list_actions. What people saved to a space lately -> list_notes. What's coming up in the next meeting -> get_suggested_agenda. Starting on an item -> get_item_context. What happened in a meeting -> get_meeting_brief.
Working on a to-do: check it isn't already being worked on (working on the to-do, or being_worked_on in whats_new), then post_update with its ref and status working when you start, so people and other agents see you're on it. If the change shows on screen, attach screenshots before you report: screenshot_upload_url gives a link to curl them to, and they join your next report. When the work is in a PR, put the to-do's ref (stand:action/<id>) in the PR description and post_update with status ready, a short summary of what changed and the PR link: Stand shows it as ready to ship and checks the to-do off by itself when the PR merges, so you don't need to come back. When it's finished with nothing left to ship, complete_action with the summary. post_update for progress, a blocker, or something people need to decide. Reports show up on that to-do in Stand as its log.
A to-do that never came up in a meeting -> create_action, with a summary and a status if there is one. Rewording a to-do, giving it to someone, or moving it to doing, done or dropped -> update_action.
Stand keeps who did what: the person, their agent and its connection. When you write, pass model if you know which one you are, so people can see which agents did the work.
Something true about the project that nobody had to choose, and the next person or agent should know -> add_context, with replaces when it corrects an older line. What the space holds as true -> list_context.`;

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
  /** The caller, with the model it says it is. */
  const as = (model?: string): Caller => (model?.trim() ? { ...caller, model: model.trim().slice(0, 80) } : caller);
  const modelField = z.string().optional().describe("The model doing this work, like claude-opus-5-5, if you know it. Kept with what you did, as you reported it");
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
        "To-dos owned by the person this token belongs to, across the Stand spaces they're in, newest meeting first. Each has its ref, item, the decision behind it, and the meeting date. A to-do an agent is on has status doing and working: who, since when and what it said last; one waiting to ship has ready.",
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
        "Every to-do in one Stand space, whoever owns it, newest meeting first. Each has its ref, owner, status, item, the decision behind it, and the meeting date. A to-do an agent is on has status doing and working: who, since when and what it said last; one waiting to ship has ready. Check before you pick one up. Filter by status and owner.",
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
        "The spaces this person is in, with their purpose, open to-do counts, their items (ids for get_item_context), latest meeting id, and live: the meeting running now with who's in it, or null. Check live before merging to Stand's own repo: a merge redeploys Stand and cuts a call. It only covers this person's spaces.",
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
        "Reports progress, a blocker, or something people need to decide on an item (or on one to-do, by its ref). It shows on that item in Stand under Since last time and in the to-do's log, attributed to this person via this agent. Append only. Status working on a to-do (by its ref) marks it as being worked on, with a loading mark in Stand; it stays that way through progress updates until you complete it, post ready, blocked or needs_decision, or go 30 minutes without an update. Status ready on a to-do: the work is finished and waits to ship; give the PR link and Stand checks the to-do off when it merges.",
      inputSchema: {
        ref: z.string().optional().describe("The to-do, decision, question or topic this is about (stand:action/<id> …)"),
        item_id: z.string().optional().describe("Or the item it's about"),
        text: z.string().optional().describe("What happened, in a sentence or two. Optional for working"),
        status: z
          .enum(["working", "progress", "blocked", "needs_decision", "ready"])
          .optional()
          .describe("Default progress. working: you've started on this to-do. ready: finished, waiting to ship (give the PR link)"),
        links: z.array(z.string()).optional().describe("PRs, docs or other links (up to 5)"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, item_id, text, status, links, model }) => run(() => api.postUpdate(as(model), { ref, itemId: item_id, text, status, links }, baseUrl)),
  );

  server.registerTool(
    "complete_action",
    {
      title: "Check off a Stand to-do",
      description:
        "Marks a to-do done in Stand (the same as ticking its box), with a summary of what changed and links such as the PR. The summary opens first in the to-do's log in Stand, with any screenshots uploaded since your last report (see screenshot_upload_url). Shows as done by this person via this agent.",
      inputSchema: {
        ref: z.string().describe("The to-do's reference, stand:action/<id>"),
        note: z.string().optional().describe("What changed, for the people who asked: a short paragraph, or a few lines starting with - "),
        links: z.array(z.string()).optional().describe("PRs, docs or other links (up to 5)"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, note, links, model }) => run(() => api.completeAction(as(model), { ref, note, links }, baseUrl)),
  );

  const taskFields = {
    owner: z.string().optional().describe('Who does it: a name, "me" (the person this token belongs to) or "unassigned"'),
    status: z
      .enum(["open", "doing", "done", "dropped"])
      .optional()
      .describe("open: not started. doing: someone is on it. done: finished. dropped: not doing it (say why in reason)"),
    summary: z
      .string()
      .optional()
      .describe("More about it for the people who'll read it: the details, or what was done. Goes in the to-do's log in Stand"),
    reason: z.string().optional().describe("Dropped only: why, in a line"),
    links: z.array(z.string()).optional().describe("PRs, docs or other links (up to 5). A merged PR link on done shows the PR closed it"),
  };

  server.registerTool(
    "whats_new",
    {
      title: "See what changed in a Stand space",
      description:
        "Everything that changed in a Stand space since a date, in one call: meetings with their summaries, decisions, open questions, context, what's being worked on right now, to-dos added and closed, and what agents reported. Call it first when catching up. Then use get_meeting_brief for a meeting's detail or transcript.",
      inputSchema: {
        space: z.string().describe("The space's id or name (from list_spaces)"),
        since: z.string().optional().describe("From this date or time, like 2026-10-11. Default: the last 7 days"),
      },
      annotations: READ,
    },
    ({ space, since }) => run(() => api.whatsNew(caller, { space, since }, baseUrl)),
  );

  server.registerTool(
    "list_context",
    {
      title: "List a Stand space's context",
      description:
        "What's true in a Stand space that nobody had to choose, newest first: what the project is, how something works. A line a later one replaced isn't listed.",
      inputSchema: { space: z.string().describe("The space's id or name (from list_spaces)") },
      annotations: READ,
    },
    ({ space }) => run(() => api.listContext(caller, space, baseUrl)),
  );

  server.registerTool(
    "next_check",
    {
      title: "Take a conflict check from Stand",
      description:
        "Hands you the newest decision nobody has checked yet, the earlier decisions it might change, and how to judge them. You do the judging, then call submit_check. Nothing waits on this. It's held for you for ten minutes. waiting: 0 means nothing needs checking.",
      inputSchema: { space: z.string().describe("The space's id or name (from list_spaces)") },
      annotations: WRITE,
    },
    ({ space }) => run(() => api.nextCheck(caller, space)),
  );

  server.registerTool(
    "submit_check",
    {
      title: "Give Stand the result of a conflict check",
      description:
        "Returns what you found from next_check. Findings are proposals: a decision stays kept until a person confirms. Send an empty list if nothing changed, so it isn't checked again.",
      inputSchema: {
        ref: z.string().describe("The decision you checked, stand:decision/<id>"),
        findings: z
          .array(
            z.object({
              ref: z.string().describe("The earlier decision, stand:decision/<id>"),
              relation: z.enum(["replaces", "duplicate"]),
              confidence: z.number().min(0).max(1),
              why: z.string().optional().describe("The reason, in a short line"),
            }),
          )
          .describe("What the new decision changes or repeats. Empty if nothing"),
        version: z.string().optional().describe("The version next_check gave you"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, findings, version, model }) => run(() => api.submitCheck(as(model), { ref, findings, version })),
  );

  server.registerTool(
    "confirm_replaced",
    {
      title: "Confirm a Stand decision was replaced",
      description:
        "Says a later decision replaced an earlier one, or with replaced false that both still stand. A decision stays kept until someone confirms: may_be_replaced_by in get and whats_new is only what Stand suspects. Use it when the person tells you, not on your own judgment.",
      inputSchema: {
        ref: z.string().describe("The earlier decision, stand:decision/<id>"),
        by: z.string().describe("The later decision, stand:decision/<id>"),
        replaced: z.boolean().optional().describe("Default true. false: both stand, so Stand stops suggesting it"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, by, replaced, model }) => run(() => api.confirmReplaced(as(model), { ref, by, replaced: replaced ?? true })),
  );

  server.registerTool(
    "add_context",
    {
      title: "Add context to a Stand space",
      description:
        "Keeps one line of what's true in a Stand space, for the next person or agent. Use it for facts nobody had to choose, like \"Stand runs on one SQLite volume\". It isn't for decisions or to-dos.",
      inputSchema: {
        space: z.string().describe("The space's id or name (from list_spaces)"),
        text: z.string().describe("What's true, in a line"),
        replaces: z.string().optional().describe("The older line this corrects, stand:context/<id>. It stops being listed"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ space, text, replaces, model }) => run(() => api.addContext(as(model), { space, text, replaces }, baseUrl)),
  );

  server.registerTool(
    "create_action",
    {
      title: "Add a to-do to Stand",
      description:
        "Adds a to-do to a Stand space by hand, for work that never came up in a meeting. It shows in the space's Tasks tab like the to-dos meetings catch (marked as added by this person), comes up in the next meeting's check-in while open, and counts toward what got done since the last meeting once closed. Give a status to add one that's already underway, done or dropped, and a summary for the details or what was done. Returns its ref for update_action, post_update and complete_action.",
      inputSchema: {
        space: z.string().describe("The space's id or name (from list_spaces)"),
        text: z.string().describe("What needs doing, in a line, like a meeting's to-do: \"Add a mic picker to the meeting room\""),
        item_id: z.string().optional().describe("The agenda item it belongs to, if any (ids from list_spaces)"),
        ...taskFields,
        owner: taskFields.owner.describe('Who does it: a name, "me" (the default: the person this token belongs to) or "unassigned"'),
        status: taskFields.status.describe(
          "Default open. doing: someone is on it. done: already finished. dropped: not doing it (say why in reason)",
        ),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ space, text, item_id, owner, status, summary, reason, links, model }) =>
      run(() => api.createAction(as(model), { space, text, itemId: item_id, owner, status, summary, reason, links }, baseUrl)),
  );

  server.registerTool(
    "update_action",
    {
      title: "Change a Stand to-do",
      description:
        "Changes one to-do, whether a meeting caught it or someone added it: reword it, give it to someone, or move it to open, doing, done or dropped, and add a summary to its log in Stand. Only what you pass changes. Done here is the same as complete_action; reopening a done or dropped to-do sets status open.",
      inputSchema: {
        ref: z.string().describe("The to-do's reference, stand:action/<id>"),
        text: z.string().optional().describe("New wording, in a line"),
        ...taskFields,
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, text, owner, status, summary, reason, links, model }) =>
      run(() => api.updateAction(as(model), { ref, text, owner, status, summary, reason, links }, baseUrl)),
  );

  server.registerTool(
    "screenshot_upload_url",
    {
      title: "Get a link to attach screenshots to a Stand to-do",
      description:
        "Returns a short-lived link to upload screenshots of your work on a to-do (curl the image file to it; the reply shows the exact command). They join your next post_update or complete_action on that to-do and show in its log in Stand. Use it when the change is something people would want to see, like a UI change.",
      inputSchema: { ref: z.string().describe("The to-do's reference, stand:action/<id>") },
      annotations: WRITE,
    },
    ({ ref }) => run(() => api.screenshotUploadUrl(caller, { ref }, baseUrl)),
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
