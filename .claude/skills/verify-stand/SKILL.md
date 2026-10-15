---
name: verify-stand
description: Prove a Stand change works by driving the real web app like a person - sign in, make a space, run a meeting with the scripted 4-person demo, end it, read the recap and check the agent MCP - in headless Chromium against an isolated local instance, with screenshots as evidence. Use before calling any Stand web or server change done, when asked to "verify", "prove it works" or "show me", or when a test passing isn't proof of what a user sees.
---

# Verify Stand

Stand is a voice meeting app: spaces hold a team's context, meetings pin talk to agenda items, live notes (Claude) turn talk into to-dos, decisions and open questions, the recap writes it up, and agents read it all over `/mcp`. A passing `npm test` proves the server's units, not what a person sees. This skill runs the real app and drives it through the browser.

Everything below runs from the repo root. Scripts live in `.claude/skills/verify-stand/scripts/` (call it `$S`).

## Launch

```bash
S=.claude/skills/verify-stand/scripts
RUN=$($S/launch.sh | tail -1)      # optional: $S/launch.sh 3912 for a second instance
```

`launch.sh` installs deps if needed, runs `npm run build`, and starts the production server (`node --import tsx src/server/index.ts`, `NODE_ENV=production`) on port 3911 with its own data dir under `$RUN/data` (an empty SQLite DB, so every run starts clean). Ready = the log line `standup server on http://localhost:<port>`; the script waits for it and prints the run dir last.

It deliberately ignores `.env`: LiveKit, Google sign-in and email allowlists are unset so that audio runs in **mock mode** (no LiveKit, no mic) and sign-in is the **stand-in form** (name + email, unverified). Live notes and the recap use real Claude when `ANTHROPIC_API_KEY` (or `STAND_ANTHROPIC_API_KEY` in cloud sessions) is set; without a key they fall back to heuristic notes, so proofs about note quality need the key.

Each instance has its own port and data dir, so two can run side by side. Never point the scripts at the live Railway app or at a developer's `npm run dev` on 3001/5173.

## Doctor

```bash
$S/doctor.sh "$RUN"     # read-only; ends with DOCTOR OK or DOCTOR FAILED
```

Checks: our pid is alive, `/api/health` answers `{"ok":true}`, the port belongs to our pid, which commit it was built from vs. the checkout now (rebuild by relaunching if they differ), the modes line (`audio: off (mock mode) · transcription: browser · notes: claude-haiku-5-5 …`), and that the stand-in sign-in is available. Run it first whenever anything looks off.

## Drive

```bash
NODE_PATH="$(npm root -g)" node $S/drive.cjs "$RUN" <journey> [--headed]
```

Playwright with Chromium (preinstalled in cloud sessions; elsewhere `npm i -g playwright@1.56.1 && npx playwright install chromium`). Journeys build on each other:

| journey | what it does | about |
|---|---|---|
| `signin` | stand-in sign-in, lands on home | 5 s |
| `space` | + New space pop-up, Create and enter, space page | 10 s |
| `meeting` | + Start talking, Play demo, wait for live notes, End meeting, wait for the write-up, space page, recap | 2-3 min |
| `mcp` | + agent token, MCP `tools/list`, `list_spaces`, `list_actions` | +5 s |

Handles it uses (stable, from the UI's own text and roles): placeholders `Your name`, `Work email`, `e.g. Checkout v2`; buttons `Continue`, `New space`, `Create and enter`, `Start talking`, `Play demo`, `End meeting`; tabs `Meetings`, `To do`; links `a[href^="/meetings/"]`; agenda row text `DEMO-104 · N remarks · N to-dos`.

For a change the journeys don't cover, copy the pattern in `drive.cjs` (`step()` + `snap()` + `check()`) into a scratch script, and read the feature file for that area first. Add the new journey to `drive.cjs` and the feature map if it will be needed again.

## Evidence

Every run writes `$RUN/evidence/<journey>-<time>/`: numbered screenshots of each step (`FAILED-*.png` at the step that broke), page text dumps (`meeting-page.txt`, `space-after-meeting.txt`, `recap.txt`), MCP responses, and `summary.json` (steps with timings, checks with pass/fail and what was seen, browser console errors). The server log is `$RUN/server.log`; it shows every Claude call (`[agent] claude-haiku-5-5 in=… out=…`) and the write-up.

Proof standards:
- Drive the real user path: the buttons a person clicks. Don't call internal setters or post WebSocket messages directly. The only shortcut is making the MCP token through the same `/api/tokens` call the Connect an agent page makes.
- Capture the action *and* the resulting state: the meeting screen while notes land, then the space page and recap afterward.
- Check side effects, not just pixels: `drive.cjs` reads `/api/spaces` and the MCP to confirm the server stored what the screen shows.
- Look at the screenshots yourself before calling it done. A green `summary.json` with a broken layout is not a pass.
- When reporting, attach the screenshots that show the change (in a Project, copy them under `/mnt/project-files/<task>/` first).

## Cleanup

```bash
$S/cleanup.sh "$RUN"
```

Kills only the pid this run started (never by process name), deletes `$RUN/data`, keeps `$RUN/evidence` and `$RUN/server.log`. Run it after every attempt, failed ones too.

## What this can't prove

- Real audio, LiveKit rooms and Deepgram transcription: mock mode replaces them. Joining with two real people, mic levels and speaker names need joe's Mac or the live app.
- Google sign-in and the email allowlist.
- The Mac app (Electron bar, snaps with Control + Shift + S, bar notes, dictation): it needs macOS. On joe's Mac, `npm run try:mac` runs it against a local server.
- Note quality on long meetings: use the notes replay harness (`npm run replay` / `npm run replay:score`, recorded meetings in `/mnt/project-files/topic-replay/`).

Say which of these your change touches and that it is unverified, instead of implying the run covered it.

## Feature map

`features/README.md` indexes the user-facing features with how to reach, drive and prove each one. Read the file for the area you changed before driving. Keep it honest: when a journey needs a precondition the app doesn't seed, the journey fails and the reason goes in that feature's Gotchas; never weaken a check to make it pass.
