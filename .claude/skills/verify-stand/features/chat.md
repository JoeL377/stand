# Chat

What people in a space write to each other between meetings: a thread with a box at its foot. From 1200px wide it is the dock, a column at the right of the space page beside every tab. On a narrower screen it is the Chat tab. A message shows on everyone's open page at once, with no reload. Your own messages can be changed and deleted. The tab counts what you have not read, and the space's name in the sidebar goes bold.

Under it, a space has a channel, a message is a chat segment, and a stretch of talk is a session: a `meetings` row of kind `chat` that closes after an hour of quiet. A session is not a meeting: the Meetings tab and the feed leave it out.

## Sub-features
- Dock: from 1200px there is no Chat tab. The **Chat** button in the page head (`aria-pressed`) and Command + J (Ctrl + J) open and close the dock; opening puts the cursor in the box. The button carries the unread marks while the dock is closed. Open or closed is kept in `localStorage` as `stand.chatDock` for all spaces, closed by default (its count shows on the Chat button). A saved Chat tab shows Tasks with the dock open. **Open chat** on a mention toast opens the dock. From 1360px the task drawer opens to the left of the dock (`[data-chat-dock]` on `<html>`); below that it covers the dock.
- Send: Enter sends, Shift+Enter makes a new line, `@` lists the space's people. The message shows in the thread at once and the box clears; you can send the next before the first is saved. Sends go out one at a time, in order. A row not saved after 400 ms dims (`.chat-msg.pending`). A failed send stays as `.chat-msg.failed` with "Not sent.", **Retry** and **Delete**, and comes back after a reload (`sessionStorage`, `stand.chatUnsent.<roomId>`). The saved message carries the send's `key`, so the row is not shown twice when the stream brings it before the send answers.
- Live: the page holds the space's event stream open (`GET /api/rooms/<id>/events`, server-sent events) and adds or changes rows as events arrive.
- Change and delete: the tools show on your own message when the pointer is on it. A deleted message keeps its place and says "Message deleted".
- Unread: a filled count on the Chat tab, a dot by the space in the nav, `(N)` in the browser tab's title, and `unread` on the space in `/api/spaces`. Looking at the tab reads everything shown. A "New" line marks where you had read to.
- Read marks: a small face at the right, under the last message each other person has read (`.chat-reads`, with "Read up to here by …" as its `title` and for a screen reader). It moves down as they read on, with no reload (a `read` event on the stream). Nobody's mark shows under their own message, and you never see your own. `reads` in `/api/rooms/<id>/chat` is how far the others have read.
- Mentions: a message that tags you (`@Full Name`, or `@First` when the first name is unique in the space) is marked in amber, with your name in it marked too. While it is unread there is an `@` on the Chat tab, an `@` by the space in the nav, `(@)` in the title, "Mentioned in chat" on the home card, and `chatMentions` on the space in `/api/spaces`. A toast with **Open chat** says so when it comes in while you are on another tab of the page.
- New below: scrolled up while messages come in, a pill over the box says "N new messages" (or "A new message mentions you"). It takes you down to them.
- @Names everywhere: chat, comments, notes, the meeting's side panel and the recap mark the names of people in the space in blue, and yours in amber (`.mention`, `.mention.you`).
- Earlier messages: the thread opens on its newest 100, and **Show earlier messages** loads the page before.
- Capture: Stand reads the chat as it reads a meeting's talk (`src/server/chatCapture.ts`). After a pause it adds to-dos, open questions and decisions to the space, and each shows in the thread as a one-line chip ("To-do", "Decided", "Open", with the owner's face and the full line in its title) under the message it came from. A to-do or question chip opens the task. The × on a chip removes it for everyone, and Stand doesn't add it again from that stretch. When a stretch closes, it is read once more and ends with one line (its first topic and what came of it, `.chat-recap-head`) that opens to the summary and its other topics. `CHAT_CAPTURE=off` stops all of it.
- Agents: `get_chat` on the MCP gives where a space's chat stands, or one stretch with its messages. `whats_new` lists the stretches under `chats`, and `get_meeting_brief` takes a stretch's id.

## Driving it with Playwright
`scripts/chat.cjs <run>` is its own journey with two browser contexts (Vera and Bo). Handles: tab `Chat`; the box is `getByRole("combobox", { name: "Write to the space" })`; the thread is `.chat-thread`, a message `.chat-msg`; buttons `Change your message`, `Delete your message`, `Save`, `Show earlier messages`. It also reads the chat over `/mcp` with a token (`get_chat`, `whats_new`, `get_meeting_brief`, `list_spaces`). Proof is in what the other person's page shows without a reload, and in what it reads afterwards: `/api/rooms/<id>/chat` (the kept messages and their one session), and `/api/rooms/<id>` and its feed (no meeting).

`scripts/chat-capture.cjs <run>` proves capture, with the same two people. Launch with short waits, or the journey waits a minute for a run and an hour for the close: `CHAT_CAPTURE_QUIET_MS=1500 CHAT_QUIET_MS=30000 $S/launch.sh`. Handles: a caught line is `.chat-caught` (button `Remove this decision` / `Remove this to-do` / `Remove this open question`), the end of a closed stretch is `.chat-recap`. It checks the other person's thread without a reload, the Tasks and Decisions tabs, the task drawer ("From the chat on"), `/api/rooms/<id>/chat` (`caught`), and `get_chat`, `list_actions` and `whats_new` over `/mcp`.

`chat.cjs`, `chat-capture.cjs` and `mentions.cjs` run at 1100px wide, where chat is a tab.

`scripts/chat-dock.cjs <run>` drives the dock and send at once with two people at 1280px (launch with `CHAT_CAPTURE_QUIET_MS=1500`). Handles: the dock is `getByRole("complementary", { name: "Chat" })`, the head button `getByRole("button", { name: /^Chat/ })`, `Close chat`, `Retry`, `Delete`. It holds and fails sends with `page.route` on `/api/rooms/<id>/chat/messages`, checks the order on the other person's page and in `/api/rooms/<id>/chat`, and measures the task drawer beside the dock at 1440px.

`scripts/mentions.cjs <run>` drives the mention and new-message marks with two people: the toast, the tab and nav marks, `chatMentions` in `/api/spaces`, the marked message for each person, the pill on a wide screen and on a phone, and the home card.

`scripts/chat-reads.cjs <run>` drives the read marks with three people at 1100px, where a person reads only when they open the Chat tab. It checks which message each mark sits under on the writer's page as the others open the tab, fall behind and catch up, that someone who joined after the page loaded gets a mark, `reads` in `/api/rooms/<id>/chat`, and the marks after a reload, in the dock and on a phone.

## Gotchas
- `mentions.cjs` counts the unread dots in the whole sidebar. Run it on a clean instance, or before the other chat journeys: their spaces leave unread messages for the same people.
- The task drawer slides in. Wait for its animations to finish before measuring it.
- Buttons fade their color over 0.12 s, so a screenshot just after the pill turns from blue to amber can catch it grey. That is the fade, not the look.
- Delete asks with the browser's `confirm()`; accept dialogs, as the journey does.
- The first 401 in the console is the app asking who you are before sign-in. The journey leaves it out of its console check.
- Without a model key the notes come from patterns: "We decided…" is a decision, "I will…" a to-do. `chat-capture.cjs` writes those. What a real model catches from real talk needs the key, and a replay to judge it.
- Removing a caught line asks with the browser's `confirm()`.
- Where a caught line sits: after the last message written when Stand caught it, until the stretch closes and the run then finds the message it came from (only a real model gives that).
- A session closes after an hour of quiet; `CHAT_QUIET_MS` shortens that for a run. The unit tests in `src/server/chat.test.ts` and `src/server/chatCapture.test.ts` cover the session and capture rules with their own clock.
- From 1200px the dock is open by default, so a person with the space page in front reads the chat without opening anything, and their mark moves. `chat-reads.cjs` runs narrower so that reading is a step of its own.
