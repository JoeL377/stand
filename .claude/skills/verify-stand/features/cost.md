# What Stand spent

What Stand's Claude calls for a space cost, at list prices (`PRICES` in `src/server/usage.ts`): each call is kept in `llm_usage` with its meeting and its space. The panel on Manage spaces (`src/web/CostPanel.tsx`) shows the total, a line per pass in each group (In calls, In chat, Between meetings) and a bar per day. An estimate, not the invoice.

## Reach it

- Manage spaces (`/spaces/manage`) → each space you manage → `What Stand spent`, after Sources. The `Cost range` switch at its right: `30 days` (the default) or `7 days`.
- `GET /api/rooms/:id/cost?days=30&tz=<minutes east of UTC>`: only the space's creator and admins; another member gets 403, someone outside 404. `days` is clamped to 1-90, `tz` to ±840.
- One meeting's cost stays where it was: the pill in the call and the cost on its recap.

## Drive it

`NODE_PATH="$(npm root -g)" node scripts/cost.cjs "$RUN"`. Vera makes two spaces, starts and ends a call in one and writes in its chat; Bo makes his own space and opens Vera's from its link. The local instance makes no Claude calls, so the script then writes usage rows straight into `$RUN/data/standup.db`: in the call, in the chat stretch and between meetings, on three models, over 10 days, plus a row of Bo's space and one with no space. It checks the route's sums and Bo's 403, then reads the panel: the total, the three groups with their pass names, `under $0.01`, 30 bars, the label a screen reader hears, 7 bars and the smaller total after the switch, the empty state of the second space, dark and a phone width, and that Bo's Manage spaces has only his own space's panel. Under a minute.

## Gotchas

- The rows are written while the server runs. It opens the database in WAL mode with no busy timeout; the script waits up to 5 s for the lock and writes all rows in one short `BEGIN IMMEDIATE` transaction, so a write of the server's can only fail if it lands in that moment.
- Days are the browser's: the page sends `-getTimezoneOffset()`. A row written a few minutes before the browser's midnight shows on yesterday's bar.
- Nobody speaks in the journey's call. That is enough: the call's rows only need its meeting.
- Rows from before the space was kept, between meetings, have no space and show nowhere. Rows in a meeting got their space from the meeting when the column was added.
- With a model key, the real call and chat in the journey can add rows of their own, and the totals checks then fail. Run it without a key.
