# Bar notes and snaps

The always-on Stand bar in the Mac app: a space switcher, "Write a note…" (Control + Shift + N, typed or dictated), Snap (Control + Shift + S) which pins up to 6 screen pictures to the note, and in a call the meeting controls. Notes land on the space page under Since last time and in the MCP (`list_notes`).

## Sub-features
- Note box unfolding from the bar, Enter saves.
- Snaps pinned to a note; in a meeting a snap shows on everyone's middle screen.
- Web pop-out bar from a meeting (Pop out button), partly drivable in a browser.

## How to get to it (user POV)
Run the Mac app (`npm run try:mac` locally, or the signed .dmg), use the bar from any app.

## Driving it with Playwright
Not drivable in a cloud session: the bar, global shortcuts and screen capture are Electron on macOS. What can be checked here: the server side via the MCP (`list_notes` on a space) after a note is saved by some other means, and the web pop-out bar from the meeting screen.

## Gotchas
- Say "Mac bar unverified" in any report on a change that touches `desktop/` or the bar.
- On joe's Mac, the trial (`~/Projects/stand-try`) needs Screen Recording permission for the terminal to snap.
