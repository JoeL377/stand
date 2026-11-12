# Task owners

A to-do has one owner: a name, as said in the meeting or chosen by hand (`notes.owner`, free text, `null` for unassigned). Open questions have no owner to give; they show "Anyone".

## Reach it

- Space page → Tasks → the face at the end of a to-do's row (`Change owner: …`). On phones the row hides the face; use the drawer.
- The task drawer: the owner's name in the line under the title.
- The picker lists the person looking first (`(you)`), then the space's people, then the current owner if nobody here has that name. Type to filter, or type a new name and pick `Give it to "…"`. `Unassigned` clears it.
- API: `PATCH /api/rooms/:id/tasks/:noteId/owner` with `{ owner: "Name" | null }`. It goes through the same path as the MCP's `update_action` with `owner`.

## Drive it

`NODE_PATH="$(npm root -g)" node scripts/task-owner.cjs "$RUN"`. An agent adds a to-do with no owner. The script picks yourself from the row's face, gives it to a typed name from the drawer, then sets it back to Unassigned, and reads the owner back over the MCP after each change. About 10 seconds.

## Gotchas

- The list groups by first name, so after a change the row moves to its new owner's group.
- "me", "none", "nobody" and "unassigned" typed as a name mean what they mean for agents: you, or no owner.
