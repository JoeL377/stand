# Your own agent in a call

A person's own agent (Claude Code, opencode, Cursor), connected through the MCP, can read a call while it runs and put a card on its board for everyone in it. Stand runs no model for these cards. Two tools:

- `get_live_call` (read): who is in the call, `lines` (said and typed), `showing` (what the main view shows), `caught` (to-dos, decisions, open questions as refs) and `answers` (what Stand or someone's agent answered). Without `since` it returns the last 10 minutes; `since: <cursor>` returns only what came after; `all` returns the whole call. A line comes again under the same id when its speaker went on.
- `say_in_call` (write): `text` (markdown, 1,200 characters at most), `detail` (a write-up folded under the card, 20,000 at most), `todo`, `sources`, `model`. One agent may put 30 cards in a call, 5 seconds apart at the least.

## Reach it

- In a call, the card is in the board's stack (**Card** tab): head "From an agent", then "<First name>'s agent" in the person's color with the agent's name and model, the words, the links, the next step with **To do**, and **The full write-up** folded under them. The × takes it off the board for everyone. A new card is the live card for 3 minutes, as an Ask Stand answer is.
- While the board is out of view on a screen (a share, a deck, a review slide, a presented to-do, the Map, Words or Diagram view, a snap's tab, a hidden browser tab, a phone with a sheet up), a new card comes up as a notice to that person: "<First name>'s agent", the card's first line, **Open** and ×, at the foot of the middle screen (on a review slide, in the slide's dock; on a phone with a sheet, one line over the sheet). It stays 60 seconds, with "+N" for more unseen cards. **Open** shows the whole card in a panel on that screen only (**Close** or Escape; **Dismiss for everyone**); the slide or share goes on under it and nobody who follows the presenter moves. The on the Board tab stays until that person has seen the card. What was seen is kept in the browser only (`src/web/agentNotice.ts`).
- The transcript (side panel) has a row "<Name> via <agent> (<model>) said in the call" with **Show on the board**.
- After the call: the recap's **Whole transcript** has the same row with its write-up, and `get_meeting_brief` with `transcript` has it as a `kind: "agent"` line with `detail`.
- Code: `src/server/agents.ts` (`liveCall`, `sayInCall`), `src/server/room.ts` (`tail`, `agentSay`), `src/server/meetingAgent.ts` (`AgentKeeper.say`), `src/web/room/AgentCard.tsx` (`SaidCard`), `src/shared/timeline.ts`.

## Drive it

```bash
S=.claude/skills/verify-stand/scripts
RUN=$($S/launch.sh | tail -1)
NODE_PATH="$(npm root -g)" node $S/own-agent.cjs "$RUN"
$S/cleanup.sh "$RUN"
```

`own-agent.cjs` signs in, makes a space, starts a call and plays the demo to its end. It makes a write token with the same `POST /api/tokens` call the Connect an agent page uses, then speaks to `/mcp` as the agent: `get_live_call` (lines, people, Stand's answer, `all`), `say_in_call`, a second `say_in_call` at once (refused), and `get_live_call` from the cursor. In the browser it checks the card (name, agent, model, drawn markdown, the next step), opens the write-up, reads the transcript row and dismisses the card. Then a second person (Bo) joins, the agent puts a review slide up with `add_review_slide` and the review starts: a card said during the slide must bring the notice to both screens with the slide still in the middle; the presenter opens it in the panel and Bo's screen must not move; Bo closes his notice and the Board tab must keep its mark past 12 seconds, until he opens the board. Last it ends the call, and reads the recap's transcript. Last, `get_meeting_brief` must carry the line and its write-up, and `say_in_call` must say that no call is running. About two minutes.

## Gotchas

- `PW_CHANNEL=chrome` drives the Chrome on the computer when Playwright's own Chromium is not installed.
- The open side panel lies over the right edge of the card, where its × is. The journey folds the panel before it dismisses the card.
- Without an Anthropic key the call has no running list, so a click on **To do** on the card does nothing here. `room.test.ts` covers it ("someone's own agent reads a running call…").
- The dock is drawn twice on a review slide (the screen's, hidden by CSS, and the slide's), so the journey finds the notice with `.said-notice:visible`.
- Not driven: the notice on a phone with a sheet up, and in the Map view.
- The space page keeps an event stream open, so `networkidle` never comes there. The journey waits a fixed moment.
