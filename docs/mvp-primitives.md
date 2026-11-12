# Primitives: context, decision, task

Draft, Nov 4, 2026 · Huy Ngo · building on this now; comments are signals, not a gate

This was the one design call blocking the build. Janesh spent hours on the port and stopped here: "we need to figure out what our primitives are," then said "context, decision and the tasks. I'm good with that." This turns that into three kinds, one link table and no migration of what's already in Stand.

## The rule

| Kind | What it is | Test |
| --- | --- | --- |
| **Task** | Work: something to do, answer or decide | Can it be finished? |
| **Decision** | What someone chose, and why | Did someone choose, and does it hold until replaced? |
| **Context** | What's true, that nobody chose | Is it just true, until it stops being? |

Janesh and Huy were both right, about different things. Janesh's "What is Stand?" is context, and forcing it into a task adds nothing. Huy's point holds for how knowledge gets made: an open question is a task, and finishing it leaves a decision or context behind. So tasks are how work moves, and decisions and context are what it leaves.

This replaces the Oct 20 line "Everything, including decisions, asks and choices, is a task", and should be recorded as replacing it.

## In practice

| What people say | Kind | Ends as |
| --- | --- | --- |
| "Joe ports the board by Monday" | Task, do | Done, with the PR as evidence |
| "Where do we host?" | Task, answer | A decision, linked back to it |
| "We're not moving to Railway, because of the cost" | Decision | Holds until replaced. No task needed (Andy, Oct 28) |
| "Stand is TypeScript" | Context | Holds until it stops being true |
| A conflict the check finds | Task, decide | The decision that holds, which replaces the other |
| "Meet Saturday at 9" | Not kept | Stays in the transcript |

## Fields

Stand's `notes` table holds all three, so this adds to it and moves nothing.

**All kinds:** text · quote · said by (a person, not a name string) · space · when.

**Every write keeps its actor** (`src/shared/actors.ts`): kind (person, agent, stand or github), whose it is, the agent's name, its connection and the model it reported. Work happens in Stand and in people's own harnesses, so this is how to tell them apart. It says who made the write, not who did the work: in the back test, Joe's agent closed the to-do for Huy's PR #63, and 6 of 22 hand closes were someone else's to-do. For the work, follow `closed_by` to the PR. Rows from before Nov 5 read theirs from the "Joe via Claude" strings, so they have no connection or model.

| Kind | Stand today | Add |
| --- | --- | --- |
| Task | `action` and `question` notes; verb, state (open, doing, done, dropped), owner, `done_when`, `parent_id`, `closed_by`, `drop_reason`, `said_done_json` | Nothing new; ask for a done-when when it's empty |
| Decision | `decision` notes; during a meeting, a heard decision waits on the running list until someone confirms | `why`; who proposed, agreed and was away; state (heard, kept, replaced) |
| Context | Not stored | New `context` kind; state (heard, kept, replaced) |

**One new table, `links`:** from · to · relation · who · when.

**One level above tasks: projects** (`src/shared/projects.ts`, table `projects`). A project is a named group of tasks, questions and decisions in one space: a feature or a workstream. A task is in zero or one project, and a project can't hold a project. Context has no project. A note's own `project_id` is only what someone set by hand (`project_set_by`); otherwise Stand works it out on each read: from the agenda item (the to-do it shows, its project link, or the link of its deck's item), then from the parent task, else Unassigned. People and agents (`create_project`) make projects. A space has one order of projects, most important first: people drag them on the Tasks tab, agents set it with `order_projects`, and `list_spaces` lists them in it. This replaces the free-text topic label, whose labels became projects once. The GitHub repo a space links, which the code called its project, is now a **source** (`space_sources`, `src/server/sources.ts`).

| Relation | Meaning |
| --- | --- |
| `leaves` | This task left this decision or context |
| `replaces` | This decision or context replaces that one. Anyone in the space can confirm it |
| `serves` | This task carries out that decision |
| `conflicts` | The check thinks these disagree. A decide task stays open for the owner; nothing waits on it |
| `objects` | This person disagrees, and why. It shows on the decision and blocks nothing |
| `depends_on` | This task waits on that one. Whoever picks up either can see it, and it blocks nothing |

The strategy doc's rule is why person, space and links go in now: every write carries a person, every rule a scope, and knowledge a lineage edge. They're cheap on day one, and can't be backfilled later.

## Janesh's questions

| Question (Oct 28) | Answer |
| --- | --- |
| Are the primitives context, decisions and tasks? | Yes |
| Do they link to each other? | Yes, through `links` |
| Do tasks have children? | One level, through `parent_id`. A spec is a task with children |
| Do we support epics? | Yes, as projects: one level above tasks, one per task, no nesting (decided Nov 11 and 12) |
| Tight or loose? | Loose: a task needs only text. Owner and done-when are asked for, not required |
| How does the review queue work now it's multiplayer? | It's not a primitive (Oct 20). It's everything heard but not kept, plus open decide tasks. Anyone in the space can act on it, and nothing waits on it |

## What it rules out for now

More verbs, per-team custom states, priorities, tags, approvals or holds of any kind, and scopes finer than a space other than a project. All can be added later without changing the three kinds.
