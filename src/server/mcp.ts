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

At the start of a session, call whats_new for the space you're working in and work from what it says. It covers the last 7 days and what's being worked on right now, so nobody has to re-explain.
Before starting on a to-do, call start_work with its ref: one call marks it as yours and returns why it exists, its plan, what it depends on and what else is in progress. Tell your person about any heads_up before going on; nothing stops you.

"What's new?" or catching up on a space -> whats_new. "What's mine?" -> list_my_work. Everything to do in a space -> list_actions. What people saved to a space lately -> list_notes. What's coming up in the next meeting -> get_suggested_agenda. Starting on an item -> get_item_context. What happened in a meeting -> get_meeting_brief.
If the change shows on screen, attach screenshots before you report: screenshot_upload_url gives a link to curl them to, and they join your next report. When the work is in a PR, put the to-do's ref (stand:action/<id>) in the PR description and post_update with status ready, a short summary of what changed and the PR link: Stand shows it as ready to ship and checks the to-do off by itself when the PR merges, so you don't need to come back. When it's finished with nothing left to ship, complete_action with the summary. If you write a plan or spec for it, attach_plan keeps it on the to-do instead of in the repo. When your person asks for a review of that plan, or it has a question the team must decide, request_design_review puts it on the space's next design review with your questions; don't ask for one otherwise. If it needs another to-do done first, link_todos says so; that's a signal and blocks nothing. post_update for progress, a blocker, or something people need to decide. Reports show up on that to-do in Stand as its log.
A to-do that never came up in a meeting -> create_action, with a summary and a status if there is one. Rewording a to-do, giving it to someone, or moving it to doing, done or dropped -> update_action.
Stand keeps who did what: the person, their agent and its connection. When you write, pass model if you know which one you are, so people can see which agents did the work.
When you finish something people should see, add_review_slide puts it on the space's next product review with its pictures; get_review shows what's on the next review and what the team said about each slide in the last one, and the same for design reviews: the verdict on each spec and how its questions ended.
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
        carried_over: z.boolean().optional().describe("Include every open to-do from earlier meetings (long; list_actions has them too). Default false"),
      },
      annotations: READ,
    },
    ({ meeting_id, space_id, transcript, carried_over }) =>
      run(() => api.meetingBrief(caller, { meetingId: meeting_id, spaceId: space_id, transcript, carriedOver: carried_over }, baseUrl)),
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
          .enum(["working", "progress", "blocked", "needs_decision", "ready", "comment"])
          .optional()
          .describe("Default progress. working: you've started on this to-do. ready: finished, waiting to ship (give the PR link). comment: add to a to-do or question’s discussion"),
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
    "start_work",
    {
      title: "Start on a Stand to-do",
      description:
        "Call this when you start on a to-do. In one call it marks the to-do as being worked on, so people and other agents can see, and returns everything get does: the topic and decisions behind it, each person's position, quotes, its plan, what it waits on and what waits on it, plus what else in the space is being worked on right now. heads_up lists anything to weigh first, like someone else already being on it. Nothing stops you starting.",
      inputSchema: {
        ref: z.string().describe("The to-do's reference, stand:action/<id>"),
        note: z.string().optional().describe("What you're about to do, in a sentence. Shows in Stand"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, note, model }) => run(() => api.startWork(as(model), { ref, note }, baseUrl)),
  );

  server.registerTool(
    "get_plan_review",
    {
      description: "Read a to-do’s plan version and passage comment threads. Omit version for the latest plan.",
      inputSchema: { ref: z.string(), version: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ ref, version }) => run(() => api.planReview(as(), { ref, version })),
  );

  server.registerTool(
    "update_plan_review",
    {
      description: "Comment on a passage of a to-do’s plan, or reply to, resolve, or reopen an existing comment thread. To comment (action create), give quote: the passage copied exactly from the plan as get_plan_review returns it, and text. The other actions need thread.",
      inputSchema: {
        ref: z.string(),
        thread: z.string().optional().describe("The thread's id. Needed for reply, resolve and reopen"),
        action: z.enum(["create", "reply", "resolve", "reopen"]),
        text: z.string().optional().describe("The comment or the reply"),
        quote: z.string().optional().describe("create only: the passage the comment is about, copied exactly from the latest plan"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ model, ...input }) => run(() => api.updatePlanReview(as(model), input)),
  );

  server.registerTool(
    "attach_plan",
    {
      title: "Attach a plan or spec to a Stand to-do",
      description:
        "Keeps the plan or spec for a to-do on the to-do, as markdown, so nobody needs it in the repo and anyone can see how it's being done. Attaching again adds a new version. It doesn't have to stay perfectly current: attach when you have a plan and again when it changes a lot. get returns the latest. A ```mermaid code block shows as its diagram, in the plan and on that section's slide in a design review: put one under the heading where a flow, a sequence or a data model is easier to see than to read.",
      inputSchema: {
        ref: z.string().describe("The to-do's reference, stand:action/<id>"),
        plan: z.string().describe("The plan or spec, as markdown, up to 100,000 characters"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, plan, model }) => run(() => api.attachPlan(as(model), { ref, plan }, baseUrl)),
  );

  server.registerTool(
    "request_design_review",
    {
      title: "Ask the team to review a to-do's plan",
      description:
        "Puts a to-do's plan on the space's next design review: a call where the team goes through the spec on a few slides (its sections, with each open comment thread as a question on the slide of its section) and ends with a verdict. Call it after attach_plan, and only when your person asks for a review or the plan has a question the team must decide. Give those questions: each one becomes a comment thread on the passage it quotes, and a question the team settles in the call. Calling it again for the same to-do adds questions and changes nothing else.",
      inputSchema: {
        ref: z.string().describe("The to-do's reference, stand:action/<id>"),
        questions: z
          .array(
            z.object({
              question: z.string().describe("What the team has to decide, in a sentence or two"),
              quote: z.string().optional().describe("The passage it is about, copied exactly from the latest plan. Left out, the question is about the whole plan"),
            }),
          )
          .max(12)
          .optional()
          .describe("The choices in the plan you are not sure of. Leave out what the plan already settles"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, questions, model }) => run(() => api.requestDesignReview(as(model), { ref, questions }, baseUrl)),
  );

  server.registerTool(
    "link_todos",
    {
      title: "Say one Stand to-do depends on another",
      description:
        "Records that a to-do waits on another in the same space, so whoever picks up either one can see it. It's a signal and blocks nothing: anyone can still start either to-do. get shows waits_on and waiting_on_this with who's on each; list rows give waits_on for what's still open. Pass remove to take a link back.",
      inputSchema: {
        ref: z.string().describe("The to-do that waits, stand:action/<id>"),
        depends_on: z.string().describe("The to-do it waits on, stand:action/<id>"),
        remove: z.boolean().optional().describe("Take this link back"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ ref, depends_on, remove, model }) => run(() => api.linkTodos(as(model), { ref, dependsOn: depends_on, remove }, baseUrl)),
  );

  server.registerTool(
    "whats_new",
    {
      title: "See what changed in a Stand space",
      description:
        "Everything that changed in a Stand space since a date, in one call: meetings with their summaries, decisions, open questions, context, what's being worked on right now, to-dos added and closed with their summaries, and the latest word on everything else. Call it first when catching up. Then use get_meeting_brief for a meeting's detail or transcript.",
      inputSchema: {
        space: z.string().describe("The space's id or name (from list_spaces)"),
        since: z.string().optional().describe("From this date or time, like 2026-10-11. Default: the last 7 days"),
        all_updates: z.boolean().optional().describe("Every report, up to the newest 50, instead of the latest word on each to-do"),
      },
      annotations: READ,
    },
    ({ space, since, all_updates }) => run(() => api.whatsNew(caller, { space, since, allUpdates: all_updates }, baseUrl)),
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
    "add_review_slide",
    {
      title: "Add a slide to the next product review",
      description:
        "Puts a feature on the space's next product review: a call where the team goes through what was built, one slide per feature, with the slide on screen while they talk about it. Call it when you finish something people should see. Give the to-do it shows and the slide takes that to-do's screenshots and PR; the reply has a link to upload more pictures straight to the slide. Give it a short name too: that is what the slide is called everywhere. Adding again for the same to-do rewrites its slide. Everyone adds to the same review, so the deck is ready when the team starts. After the call, Stand files each to-do, decision and open question under the slide it was about.",
      inputSchema: {
        title: z.string().describe("The feature, in a line, as a person would say it"),
        name: z.string().optional().describe("What people will call this slide, in two or three words, like \"Task drawer\". Shown in place of \"Slide 3\" on the agenda, in the transcript and on everything caught under it. Left out, the first words of the title are used"),
        summary: z.string().optional().describe("What changed and what to look at, in two or three short lines. Write statements, not questions: a question on the slide reads as one the team asked"),
        ref: z.string().optional().describe("The to-do this shows, stand:action/<id>. Its screenshots and PR come along"),
        space: z.string().optional().describe("A space id, or part of its name. Needed when there is no ref"),
        pr: z.string().optional().describe("The PR link, if the to-do doesn't already carry it"),
        model: modelField,
      },
      annotations: WRITE,
    },
    ({ title, name, summary, ref, space, pr, model }) => run(() => api.addReviewSlide(as(model), { title, name, summary, ref, space, pr }, baseUrl)),
  );

  server.registerTool(
    "get_review",
    {
      title: "Read a space's product review and design review",
      description:
        "The space's next product review (its slides so far, plus finished work that will join when it starts) and how the last one went: each slide's outcome (Ship, Ship with fixes, Not yet) and the to-dos, decisions and open questions the team raised while that slide was on screen. Under design_review: the specs waiting on the next design review with their questions, and the last one that ran, with each spec's verdict (Approve, Approve with changes, Not yet), how each question ended (Settled, Still open) and the to-dos that came out of it.",
      inputSchema: { space: z.string().describe("A space id, or part of its name") },
      annotations: READ,
    },
    ({ space }) => run(() => api.getReview(caller, { space }, baseUrl)),
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
