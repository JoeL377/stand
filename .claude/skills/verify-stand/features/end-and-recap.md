# End meeting, space page and recap

The host ends the meeting for everyone; the server runs the Sonnet tidy pass per item and writes the recap (`/meetings/<id>`): a summary paragraph, `N to do · N decided · N open · N topics` pills, then To do with owners and item keys, Decided, Open. The meeting then shows on the space page under the Meetings tab, and its to-dos fill the space's To do tab.

## Sub-features
- End meeting confirm ("End the meeting for everyone and write up the notes?").
- "Writing notes…" state on the button while the write-up runs.
- Space page after the meeting: meeting row `1 min · N to-dos · N decided · N open`, item links, To do / Questions / Decisions tabs.
- Recap page and the Conxt share section.

## How to get to it (user POV)
In a meeting, **End meeting**, OK on the confirm. Go back to the space page; click the meeting row to open the recap.

## Driving it with Playwright
Part of `drive.cjs <run> meeting`: registers `page.on("dialog", d => d.accept())`, clicks `End meeting`, waits for the button to go away, then reloads the space page every 5 s (up to 3 min) until a link `a[href^="/meetings/"]` appears. Opens the To do tab, checks it isn't "No open to-dos", opens the recap, checks it has To do. Evidence: `space-after-meeting`, `recap` screenshots and `.txt` dumps.

## Gotchas
- End meeting uses the browser's native `confirm()`. Playwright dismisses it by default, which silently cancels the end.
- The write-up finishes after the meeting screen goes away (several Sonnet calls), so the space page is empty for a few seconds. Poll; don't read it once.
