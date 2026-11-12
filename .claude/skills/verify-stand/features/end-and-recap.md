# End meeting, space page and recap

The host ends the meeting for everyone; the server runs the Sonnet tidy pass per item and writes the recap (`/meetings/<id>`): a summary paragraph, `N to do · N decided · N open · N topics` pills, then To do with owners and item keys, Decided, Open. The meeting then shows on the space page under the Meetings tab, and its to-dos fill the space's Tasks tab.

## Sub-features
- Leave is the only way out: the last person leaving ends the meeting; the host with others present gets a menu (Leave / End for everyone). No confirm.
- "Writing notes…" state on the button while the write-up runs.
- Space page after the meeting: meeting row `1 min · N to-dos · N decided · N open`, item links, Tasks / Decisions tabs.
- Recap page.

## How to get to it (user POV)
In a meeting, **Leave** (then **End for everyone** if others are in the call). Go back to the space page; click the meeting row to open the recap.

## Driving it with Playwright
Part of `drive.cjs <run> meeting`: registers `page.on("dialog", d => d.accept())`, clicks `Leave`, waits for the button to go away, then reloads the space page every 5 s (up to 3 min) until a link `a[href^="/meetings/"]` appears. Opens the Tasks tab, checks it isn't "Nothing open.", opens the recap, checks it has To do. Evidence: `space-after-meeting`, `recap` screenshots and `.txt` dumps.

## Gotchas
- Leave only asks (native `confirm()`) when changes have not reached Stand yet; Playwright dismisses that by default.
- The write-up finishes after the meeting screen goes away (several Sonnet calls), so the space page is empty for a few seconds. Poll; don't read it once.
