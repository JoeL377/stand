# Working in Stand

This team's to-dos, decisions and meetings live in Stand, in the space **Conxt 1.0**. The repo's `.mcp.json` offers Stand's MCP. If its tools aren't available, ask the person to sign in through `/mcp` before you start, and don't work around it.

In every session:

1. **Catch up first.** Call `whats_new` with `space: "Conxt 1.0"` before anything else, and work from what it says. It covers the last 7 days unless you pass `since`.
2. **Mark the to-do as working before you start.** Call `post_update` with its ref and `status: "working"`. If the work has no to-do yet, add one with `create_action`.
3. **Close it through the PR.** Put `stand:action/<id>` in the PR description, then call `post_update` with the ref, `status: "ready"`, a short summary and the PR link. Stand checks the to-do off when the PR merges.

Do both parts of step 3. Stand finds merges by watching PRs reported ready. The ref on its own only closes a to-do through the Stand GitHub App, which is off in production.

Before building, read `docs/mvp-plan.md`. For anything about decisions, conflicts or search, read `docs/engine-brief.md` too.

Merging redeploys Stand, which can cut a live call. Check that no meeting is live before you merge.
