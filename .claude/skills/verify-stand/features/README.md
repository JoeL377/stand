# Stand feature map

One file per user-facing feature: how a person reaches it, how `drive.cjs` drives it, and what end state proves it works. Journeys build on each other (`signin` → `space` → `meeting` → `mcp`).

| feature | file | journey | drivable here |
|---|---|---|---|
| Sign in and spaces | [signin-and-spaces.md](signin-and-spaces.md) | `signin`, `space` | yes (stand-in sign-in only) |
| Live meeting and notes | [live-meeting.md](live-meeting.md) | `meeting` | yes, with the scripted demo (no real audio) |
| End meeting, space page and recap | [end-and-recap.md](end-and-recap.md) | `meeting` | yes |
| Agent MCP | [agent-mcp.md](agent-mcp.md) | `mcp` | yes |
| Bar notes and snaps | [bar-notes-and-snaps.md](bar-notes-and-snaps.md) | none | no, needs the Mac app |
