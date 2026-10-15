# Sign in and spaces

Home (`/`) is find-and-enter: a left sidebar (New space, All spaces, Manage spaces, Connect an agent, Your spaces) and the space cards. A space (`/s/<id>`) is invite-only and holds the team's context: one page of tabs: Meetings (meetings, bar notes, snaps, agent reports), To do, Questions, Decisions, Up next, synthesis instructions, Invite and Start talking (Join when someone is in a meeting).

## Sub-features
- Stand-in sign-in (name + email), only while Google isn't configured.
- New space pop-up: name + "What is it for?" line, Create and enter.
- Space page: the Meetings, To do, Questions, Decisions and Up next tabs, Add synthesis instructions, Invite (copies the link).
- Manage spaces (`/spaces/manage`), not yet in a journey.

## How to get to it (user POV)
Open the app, type a name and work email, Continue. Click **New space** in the sidebar, fill the name, **Create and enter**. You land on the space page.

## Driving it with Playwright
`drive.cjs <run> space`. Handles: placeholders `Your name`, `Work email`, `e.g. Checkout v2`, `One line, e.g. Ship one-page checkout by Nov 15`; buttons `Continue`, `New space` (first match is the sidebar one), `Create and enter`; URL `/s/[a-z0-9]+`; tabs `Meetings`, `To do`. Proof: screenshot `space-page`, and `/api/spaces` lists the new name.

## Gotchas
- With Google or an allowlist configured the stand-in form disappears and `/api/auth/dev` refuses. `launch.sh` unsets both on purpose.
- A brand-new space shows "Demo mode · 2 services not connected" (LiveKit and Linear). That is expected here.
- Space names must be unique per run for the checks; `drive.cjs` stamps the time into the name.
