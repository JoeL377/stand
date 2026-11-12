# Stand feature map

One file per user-facing feature: how a person reaches it, how `drive.cjs` drives it, and what end state proves it works. Journeys build on each other (`signin` → `space` → `meeting` → `mcp`).

| feature | file | journey | drivable here |
|---|---|---|---|
| Sign in and spaces | [signin-and-spaces.md](signin-and-spaces.md) | `signin`, `space` | yes (stand-in sign-in only) |
| Live meeting and notes | [live-meeting.md](live-meeting.md) | `meeting` | yes, with the scripted demo (no real audio) |
| End meeting, space page and recap | [end-and-recap.md](end-and-recap.md) | `meeting` | yes |
| Agent MCP | [agent-mcp.md](agent-mcp.md) | `mcp` | yes |
| Chat | [chat.md](chat.md) | `chat.cjs`, `chat-capture.cjs`, `mentions.cjs` and `chat-dock.cjs` (their own scripts) | yes; capture with pattern notes, not with a real model |
| Design review | [design-review.md](design-review.md) | `design-review.cjs` (its own script) | yes, without the AI brief (needs a key) |
| Projects | [projects.md](projects.md) | `projects.cjs` (its own script) | yes, with the scripted demo |
| Task owners | [task-owners.md](task-owners.md) | `task-owner.cjs` (its own script) | yes |
| Open questions: answer, drop, sweep | [questions.md](questions.md) | `questions.cjs` (its own script, on the preview's sample data) | yes, without the sweep's model pass (needs a key) |
| Bar notes and snaps | [bar-notes-and-snaps.md](bar-notes-and-snaps.md) | none | no, needs the Mac app |
