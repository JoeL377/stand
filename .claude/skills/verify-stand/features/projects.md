# Projects

A project is a named group of a space's to-dos, open questions and decisions (`src/shared/projects.ts`). The Tasks tab shows one section per project, then Unassigned, each grouped by who has the task.

## Reach it

- Space page → Tasks → `+ Project`, or the project pill on any task row (`Change project: …`).
- In a call: the agenda line's `Project for …` menu → `Make project`, `Link to project`, `Remove project link`.
- The filter at the end of the tab row (`Filter by project`), `?project=<id>` or `?project=none`, and `Mine` (`?mine=1`).
- MCP: `list_spaces` (projects), `list_actions` (project filter), `get` with `stand:project/<id>`, `create_project`, `order_projects`, `project` on `create_action` and `update_action`.
- Order: the `Project order` switch at the right of the `Mine` / `+ Project` row. `Active first` (the default) puts projects with a to-do in progress first, then the ones with the newest open to-dos; a header says `N in progress`. `Team order` is the space's one saved order, most important first: drag a project by the handle at the left of its header, or use `Move up` / `Move down` in its `⋯` menu. A new project goes last. `list_spaces` and the project filter use the team's order; `list_spaces` adds `in_progress` and `latest_activity` to each project.

## Drive it

`NODE_PATH="$(npm root -g)" node scripts/projects.cjs "$RUN"`. It makes a project on the Tasks tab, makes one from the demo's DEMO-104 line in a call, runs the demo, ends it, checks the line's to-dos sit in that project grouped by owner, moves one with the picker, filters, and reads all of it over the MCP. Then it adds a to-do over the MCP whose words name Onboarding, waits for Stand's pass to show the dashed `Onboarding?` pill, confirms it, and makes the to-do a part of another in the task drawer (`Part of`, then `Parts` on the parent). About 4 minutes. It launches the installed Google Chrome (`STAND_BROWSER` picks another channel).

`NODE_PATH="$(npm root -g)" node scripts/project-order.cjs "$RUN"` proves the order: it makes three projects, switches to Team order, drags one to the top and one to the bottom, moves one with the menu, reloads, sets the order with `order_projects` and checks the Tasks tab follows. Then an agent adds to-dos and starts on one, and it checks Active first on the Tasks tab while the saved order stays. About 20 seconds.

## Gotchas

- Wait for `.sh-panel`, not `networkidle`: the space page keeps a connection open.
- A to-do is in a project by the rules on each read, so linking a line mid-call is enough; nothing is copied onto the to-do.
- The order can't change in Active first, while a project filter is on or when only one project shows: there is no handle and no `Move up` / `Move down`. With a filter on or one project in view there is no `Project order` switch either.
- The switch is kept per space in the browser (`stand.projectSort.<room>`), so a fresh browser context starts on Active first. On touch screens the handle is hidden, and the menu items still work.
- Stand's suggestions (`src/server/projectSuggest.ts`) run when a meeting or chat stretch ends, 10 minutes after a to-do changes between meetings, and a minute after a project is made or renamed. The script makes a project to start that minute. The local instance has no model: its heuristic agent suggests a project only when a to-do's text names exactly one project, whole words. `PROJECT_SUGGEST=off` stops the pass.
