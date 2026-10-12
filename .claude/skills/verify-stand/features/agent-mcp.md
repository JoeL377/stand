# Agent MCP

`/mcp` lets Claude Code, Cursor or Codex read and report into Stand with a personal token made on **Connect an agent** (`/agents`). Tools: get, list_my_work, list_actions, list_notes, get_suggested_agenda, list_spaces, get_item_context, get_meeting_brief, post_update, complete_action.

## Sub-features
- Token creation (read or write scope) and revoking on `/agents`.
- Read tools (spaces, to-dos, notes, briefs, refs) and write tools (post_update, complete_action), whose reports show on the item in Stand.
- OAuth sign-in for the Claude connector (not driven here).

## How to get to it (user POV)
Sidebar **Connect an agent**, pick a client, make a token, paste the snippet into the agent's config, then ask the agent "what's mine?".

## Driving it with Playwright
`drive.cjs <run> mcp` runs the meeting journey, then makes a read token with the same `POST /api/tokens` call the page uses and speaks JSON-RPC to `/mcp` with `Authorization: Bearer <token>`: `initialize`, `tools/list`, `list_spaces`, `list_actions {space: <id>}`. Proof: `list_spaces` names the new space and `list_actions` returns the demo's to-dos with owners (`mcp-*.json`).

## Gotchas
- `list_actions` requires `space` (id or name). Without it the tool answers with a validation error inside `result.isError`, not a JSON-RPC error.
- Responses may come back as an SSE `data:` line; `drive.cjs` handles both forms.
- To prove a write tool, call `post_update` and then check the item page (`/items/<id>`) shows the report.
