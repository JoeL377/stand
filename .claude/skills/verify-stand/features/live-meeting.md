# Live meeting and notes

The meeting screen (`/s/<id>` after Start talking): agenda on the left (rows show the title; the row in focus also shows `N remarks · N to-dos`), "Now discussing" with the current topic in the middle and a chapter bar under it (topic board on the `topics` branch), the right panel with Notes & topics / Transcript, and the bottom controls (Mute, Share screen, Pop out, Play demo, Leave, End meeting). Live notes run on Claude Haiku a few seconds after each pause.

## Sub-features
- Host-driven focus: clicking an agenda item pins talk to it.
- Live notes: to-dos with owners, decisions, open questions, grouped into topics.
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
- For note quality on real long meetings use `npm run replay` on the `topics` branch, not this journey.
