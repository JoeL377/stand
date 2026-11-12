# Chat

What people in a space write to each other between meetings. The space page has a Chat tab: a thread with a box at its foot. A message shows on everyone's open page at once, with no reload. Your own messages can be changed and deleted. The tab counts what you have not read, and the space's name in the sidebar goes bold.

Under it, a space has a channel, a message is a chat segment, and a stretch of talk is a session: a `meetings` row of kind `chat` that closes after an hour of quiet. A session is not a meeting: the Meetings tab, the feed and Conxt leave it out.

## Sub-features
- Send: Enter sends, Shift+Enter makes a new line, `@` lists the space's people. What you typed stays in the box when a send fails.
- Live: the page holds the space's event stream open (`GET /api/rooms/<id>/events`, server-sent events) and adds or changes rows as events arrive.
- Change and delete: the tools show on your own message when the pointer is on it. A deleted message keeps its place and says "Message deleted".
- Unread: a filled count on the Chat tab, a dot by the space in the nav, `(N)` in the browser tab's title, and `unread` on the space in `/api/spaces`. Looking at the tab reads everything shown. A "New" line marks where you had read to.
- Mentions: a message that tags you (`@Full Name`, or `@First` when the first name is unique in the space) is marked in amber, with your name in it marked too. While it is unread there is an `@` on the Chat tab, an `@` by the space in the nav, `(@)` in the title, "Mentioned in chat" on the home card, and `chatMentions` on the space in `/api/spaces`. A toast with **Open chat** says so when it comes in while you are on another tab of the page.
- New below: scrolled up while messages come in, a pill over the box says "N new messages" (or "A new message mentions you"). It takes you down to them.
- @Names everywhere: chat, comments, notes, the meeting's side panel and the recap mark the names of people in the space in blue, and yours in amber (`.mention`, `.mention.you`).
- Earlier messages: the thread opens on its newest 100, and **Show earlier messages** loads the page before.
- Agents: `get_chat` on the MCP gives where a space's chat stands, or one stretch with its messages. `whats_new` lists the stretches under `chats`, and `get_meeting_brief` takes a stretch's id.

## Driving it with Playwright
`scripts/chat.cjs <run>` is its own journey with two browser contexts (Vera and Bo). Handles: tab `Chat`; the box is `getByRole("combobox", { name: "Write to the space" })`; the thread is `.chat-thread`, a message `.chat-msg`; buttons `Change your message`, `Delete your message`, `Save`, `Show earlier messages`. It also reads the chat over `/mcp` with a token (`get_chat`, `whats_new`, `get_meeting_brief`, `list_spaces`). Proof is in what the other person's page shows without a reload, and in what it reads afterwards: `/api/rooms/<id>/chat` (the kept messages and their one session), and `/api/rooms/<id>` and its feed (no meeting).

`scripts/mentions.cjs <run>` drives the mention and new-message marks with two people: the toast, the tab and nav marks, `chatMentions` in `/api/spaces`, the marked message for each person, the pill on a wide screen and on a phone, and the home card.

## Gotchas
- Buttons fade their color over 0.12 s, so a screenshot just after the pill turns from blue to amber can catch it grey. That is the fade, not the look.
- Delete asks with the browser's `confirm()`; accept dialogs, as the journey does.
- The first 401 in the console is the app asking who you are before sign-in. The journey leaves it out of its console check.
- What Stand catches from chat (to-dos, decisions, open questions) is not built yet, so nothing here proves it.
- A session closes after an hour of quiet; a journey can't wait for that. The unit tests in `src/server/chat.test.ts` cover the session rules with their own clock.
