# Live meeting and notes

The meeting screen (`/s/<id>` after Start talking): agenda on the left (rows show the title; the row in focus also shows `N remarks · N to-dos`), "Now discussing" with the topic card in the middle (server/board.ts: a fixed title, a ✦ paragraph Sonnet rewrites every 30 s, details, and the point being made now; a share or deck shrinks it to one line over the screen) and a chapter bar of topics under it, the right panel with Chat / Transcript (Transcript opens first; chat is one conversation for the meeting with a message box), and the bottom controls (Mute, Share screen, Pop out, Play demo, Leave, End meeting). Live notes run on Claude Haiku a few seconds after each pause.

## Sub-features
- Host-driven focus: clicking an agenda item pins talk to it.
- Live notes: to-dos with owners, decisions, open questions, grouped into topics (these feed the recap, not the middle card).
- Topic card: needs a key; without one the middle shows the talk so far. The demo moves through items faster than the 30 s cadence, so expect cards for only some of its items.
- Transcript tab, Move a remark to another item.
- Play demo: a scripted standup (Priya, Sam, Alex, Jordan) over four seeded items DEMO-101..104, shown only when LiveKit or Claude is missing.

## How to get to it (user POV)
On a space page click **Start talking**. With no LiveKit (mock mode) the host sees **Play demo** in the bottom bar.

## Driving it with Playwright
`drive.cjs <run> meeting` clicks `Start talking`, waits for `End meeting`, clicks `Play demo`, then waits for the agenda text `DEMO-104 · N remarks` (the demo reached the last item) and `DEMO-104 · N remarks · N to-dos` (live notes landed). Screenshots `meeting-demo-midway` and `meeting-live-notes`; page text in `meeting-page.txt`. The server log should show `[agent] claude-haiku-5-5 … notes for <item>` lines.

## Gotchas
- Mock mode has no shared audio; "Mute" and the mic are inert. Talk only enters through the demo (or browser speech recognition, which headless Chromium doesn't have).
- Only the focused agenda row shows counts, so checks read DEMO-104's row.
- Without an Anthropic key the notes are heuristic, so a pass then says nothing about note quality.
- For note quality on real long meetings use `npm run replay`; for the topic card use `node --import tsx scripts/replay-thread.ts <meeting.json> --out DIR` and `scripts/judge-thread.ts`, not this journey.
