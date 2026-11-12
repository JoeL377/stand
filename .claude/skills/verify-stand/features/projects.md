# Projects

A project is a named group of a space's to-dos, open questions and decisions (`src/shared/projects.ts`). The Tasks tab shows one section per project, then Unassigned, each grouped by who has the task.

## Reach it

- Space page → Tasks → `+ Project`, or the project pill on any task row (`Change project: …`).
- In a call: the agenda line's `Project for …` menu → `Make project`, `Link to project`, `Remove project link`.
- The filter at the end of the tab row (`Filter by project`), `?project=<id>` or `?project=none`, and `Mine` (`?mine=1`).
- MCP: `list_spaces` (projects), `list_actions` (project filter), `get` with `stand:project/<id>`, `create_project`, `project` on `create_action` and `update_action`.

## Drive it

`NODE_PATH="$(npm root -g)" node scripts/projects.cjs "$RUN"`. It makes a project on the Tasks tab, makes one from the demo's DEMO-104 line in a call, runs the demo, ends it, checks the line's to-dos sit in that project grouped by owner, moves one with the picker, filters, and reads all of it over the MCP. About 2 minutes. It launches the installed Google Chrome (`STAND_BROWSER` picks another channel).

## Gotchas

- Wait for `.sh-panel`, not `networkidle`: the space page keeps a connection open.
- A to-do is in a project by the rules on each read, so linking a line mid-call is enough; nothing is copied onto the to-do.
