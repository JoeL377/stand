#!/usr/bin/env node
// Drives the space's chat on a Stand instance started by launch.sh, with two people in two
// browsers: one writes, the other sees it arrive without a reload, answers, and the first one
// changes and deletes a message. Then it reads what the server kept.
//
//   NODE_PATH="$(npm root -g)" node chat.cjs <run dir>
//
// STAND_VERIFY_CHANNEL=chrome uses the installed Chrome when Playwright's own Chromium won't start.
// It runs at 1100px wide, where chat is a tab. From 1200px chat is the dock: chat-dock.cjs drives that.
// Exit code 0 = every check passed; 1 = a check failed (see summary.json in the evidence folder).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `chat-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { base, steps: [], checks: [], ok: true };
let shot = 0;
const snap = async (name, p) => p.screenshot({ path: path.join(out, `${String(++shot).padStart(2, "0")}-${name}.png`) });
let lastPage;
async function step(name, fn) {
  try {
    await fn();
    summary.steps.push({ name });
    console.log(`✓ ${name}`);
  } catch (e) {
    summary.steps.push({ name, error: String(e.message ?? e).split("\n")[0] });
    summary.ok = false;
    console.log(`✗ ${name}: ${String(e.message ?? e).split("\n")[0]}`);
    if (lastPage) await snap(`FAILED-${name.replace(/\W+/g, "-")}`, lastPage).catch(() => {});
    throw e;
  }
}
function check(name, pass, detail) {
  summary.checks.push({ name, pass: !!pass, detail });
  if (!pass) summary.ok = false;
  console.log(`${pass ? "✓" : "✗"} check: ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
}

const spaceName = `Chat ${stamp.slice(11)}`;
const FIRST = "Can we ship the invite flow on Friday?";
const ANSWER = "Yes, if the email copy is done by Thursday.";
const SECOND = "I will send the copy tonight.\nThe draft is at https://example.test/copy";
const CHANGED = "I will send the copy tomorrow morning.";

async function signIn(page, name, email) {
  await page.goto(base);
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Work email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New space" }).first().waitFor();
}
const box = (page) => page.getByRole("combobox", { name: "Write to the space" });
const say = async (page, text) => {
  await box(page).fill(text);
  await box(page).press("Enter");
};
const thread = (page) => page.locator(".chat-thread");

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_VERIFY_CHANNEL || undefined });
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("dialog", (d) => d.accept());
    return page;
  };
  const vera = await open();
  const bo = await open();
  try {
    lastPage = vera;
    let spaceUrl;
    await step("Vera signs in, makes a space and opens its Chat tab", async () => {
      await signIn(vera, "Vera Verify", "vera@verify.test");
      await vera.getByRole("button", { name: "New space" }).first().click();
      await vera.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
      await vera.getByRole("button", { name: "Create and enter" }).click();
      await vera.waitForURL(/\/s\/[a-z0-9]+$/);
      spaceUrl = vera.url();
      await vera.getByRole("tab", { name: /^Chat/ }).click();
      await vera.getByText("Nothing here yet.").waitFor();
      await snap("vera-empty-chat", vera);
    });
    const roomId = spaceUrl.split("/s/")[1];

    await step("Vera writes the first message", async () => {
      await say(vera, FIRST);
      await thread(vera).getByText(FIRST).waitFor();
      await snap("vera-first-message", vera);
    });
    check("the box is empty after the send", (await box(vera).inputValue()) === "");

    lastPage = bo;
    await step("Bo opens the space from its link and sees one unread on the Chat tab", async () => {
      await signIn(bo, "Bo Tester", "bo@verify.test");
      await bo.goto(spaceUrl);
      await bo.getByRole("tab", { name: /^Chat\s*1$/ }).waitFor();
      await snap("bo-unread-on-tab", bo);
    });
    const before = await bo.request.get(`${base}/api/spaces`).then((r) => r.json());
    check("the space's summary counts Bo's unread message", before.find((s) => s.id === roomId)?.unread === 1, before.find((s) => s.id === roomId)?.unread);

    await step("Bo opens Chat, reads it and answers", async () => {
      await bo.getByRole("tab", { name: /^Chat/ }).click();
      await thread(bo).getByText(FIRST).waitFor();
      // Read now: the count goes off the tab.
      await bo.getByRole("tab", { name: /^Chat$/ }).waitFor();
      await say(bo, ANSWER);
      await thread(bo).getByText(ANSWER).waitFor();
      await snap("bo-answered", bo);
    });

    lastPage = vera;
    await step("Vera sees the answer arrive with no reload", async () => {
      await thread(vera).getByText(ANSWER).waitFor({ timeout: 5000 });
      await snap("vera-sees-answer", vera);
    });
    check("each person's name is on their message", (await thread(vera).innerText()).includes("Vera Verify") && (await thread(vera).innerText()).includes("Bo Tester"));

    await step("Vera writes two lines with a link; Shift+Enter makes the new line", async () => {
      const [one, two] = SECOND.split("\n");
      await box(vera).fill(one);
      await box(vera).press("Shift+Enter");
      await box(vera).pressSequentially(two);
      await box(vera).press("Enter");
      await thread(vera).getByRole("link", { name: "example.test/copy" }).waitFor();
      await thread(bo).getByRole("link", { name: "example.test/copy" }).waitFor({ timeout: 5000 });
    });

    await step("Vera changes her message, and Bo sees the change", async () => {
      const row = vera.locator(".chat-msg", { hasText: "I will send the copy tonight." });
      await row.hover();
      await row.getByRole("button", { name: "Change your message" }).click();
      await vera.getByRole("textbox", { name: "Change your message" }).fill(CHANGED);
      await vera.getByRole("button", { name: "Save" }).click();
      await thread(vera).getByText(CHANGED).waitFor();
      await thread(bo).getByText(CHANGED).waitFor({ timeout: 5000 });
      await thread(bo).getByText("(edited)").waitFor();
      await snap("bo-sees-edit", bo);
    });
    check("Bo has no tools on Vera's message", (await bo.locator(".chat-msg", { hasText: CHANGED }).getByRole("button").count()) === 0);

    await step("Vera deletes her first message, and Bo sees it gone", async () => {
      const row = vera.locator(".chat-msg", { hasText: FIRST });
      await row.hover();
      await row.getByRole("button", { name: "Delete your message" }).click();
      await thread(bo).getByText("Message deleted").waitFor({ timeout: 5000 });
      await snap("vera-after-delete", vera);
      await snap("bo-after-delete", bo);
    });
    check("the deleted words are off both screens", !(await thread(vera).innerText()).includes(FIRST) && !(await thread(bo).innerText()).includes(FIRST));

    await step("Bo reloads: the thread is as it was left", async () => {
      await bo.reload();
      await thread(bo).getByText(CHANGED).waitFor();
      await thread(bo).getByText("Message deleted").waitFor();
    });

    lastPage = bo;
    await step("Bo looks at Tasks; a new message from Vera shows as unread on the Chat tab", async () => {
      await bo.getByRole("tab", { name: /^Tasks/ }).click();
      await say(vera, "One more thing: the footer link is broken.");
      await bo.getByRole("tab", { name: /^Chat\s*1$/ }).waitFor({ timeout: 5000 });
      await snap("bo-unread-while-on-tasks", bo);
      await bo.getByRole("tab", { name: /^Chat/ }).click();
      await bo.locator(".chat-day.new").waitFor();
      await snap("bo-new-line", bo);
    });

    // What the server kept.
    const kept = await vera.request.get(`${base}/api/rooms/${roomId}/chat`).then((r) => r.json());
    fs.writeFileSync(path.join(out, "chat.json"), JSON.stringify(kept, null, 2));
    check("the server kept four messages in one session", kept.messages.length === 4 && kept.sessions.length === 1, { messages: kept.messages.length, sessions: kept.sessions.length });
    check("the deleted message has no text left", kept.messages[0].text === "" && kept.messages[0].deletedAt > 0);
    check("the changed message has its new words", kept.messages[2].text === `${CHANGED}\nThe draft is at https://example.test/copy` || kept.messages[2].text === CHANGED, kept.messages[2].text);
    const room = await vera.request.get(`${base}/api/rooms/${roomId}`).then((r) => r.json());
    check("the chat is not listed as a meeting of the space", room.meetings.length === 0, room.meetings.length);
    const feed = await vera.request.get(`${base}/api/rooms/${roomId}/feed`).then((r) => r.json());
    check("the chat is not in the space's feed of meetings", feed.meetings.length === 0, feed.meetings.length);
    // An agent reads the chat over the MCP, with a token made the way the Connect an agent page makes one.
    const { token } = await vera.request.post(`${base}/api/tokens`, { data: { label: "verify", scope: "read" } }).then((r) => r.json());
    const mcp = async (id, method, params) => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const text = await r.text();
      return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\ndata: ").pop());
    };
    const tool = async (id, name, args) => {
      const res = await mcp(id, "tools/call", { name, arguments: args });
      fs.writeFileSync(path.join(out, `mcp-${name}-${id}.json`), JSON.stringify(res, null, 2));
      return res.result?.isError || res.error ? null : JSON.parse(res.result.content[0].text);
    };
    await step("an agent reads the chat over the MCP", async () => {
      await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
      const names = ((await mcp(2, "tools/list", {})).result?.tools ?? []).map((t) => t.name);
      check("the MCP lists get_chat", names.includes("get_chat"));
      const status = await tool(3, "get_chat", { space: roomId });
      check("get_chat shows the stretch going on now, with both people", status?.live?.length === 1 && status.live[0].messages === 4 && status.live[0].people.length === 2, status?.live);
      const one = await tool(4, "get_chat", { chat_id: status.live[0].chat_id, transcript: true });
      const said = (one?.transcript ?? []).map((m) => m.text);
      check("its transcript has what was written, without the deleted message", said.length === 3 && said.includes(ANSWER) && said.includes(CHANGED) && !said.includes(FIRST), said);
      const news = await tool(5, "whats_new", { space: roomId });
      check("whats_new lists the chat apart from meetings", news?.chats?.length === 1 && news.meetings.length === 0, { chats: news?.chats?.length, meetings: news?.meetings?.length });
      const brief = await tool(6, "get_meeting_brief", { meeting_id: status.live[0].chat_id, transcript: true });
      check("the brief of the stretch says it is chat", brief?.meeting?.kind === "chat" && brief.meeting.channel === "Chat", brief?.meeting);
      const spaces = await tool(7, "list_spaces", {});
      check("list_spaces says when the space's chat last had a message", !!spaces?.find((s) => s.id === roomId)?.chat?.last_message_at);
    });

    await step("a long thread opens on its newest messages, and earlier ones load when asked for", async () => {
      for (let i = 1; i <= 120; i++) await vera.request.post(`${base}/api/rooms/${roomId}/chat/messages`, { data: { text: `Line ${i}` } });
      await bo.reload();
      await thread(bo).getByText("Line 120", { exact: true }).waitFor();
      await snap("bo-long-thread", bo);
    });
    const newest = await thread(bo).getByText("Line 120", { exact: true }).boundingBox();
    const frame = await thread(bo).boundingBox();
    check("the newest message is in view when the thread opens", !!newest && !!frame && newest.y >= frame.y && newest.y + newest.height <= frame.y + frame.height + 1, newest && frame && { message: Math.round(newest.y + newest.height), thread: Math.round(frame.y + frame.height) });
    check("the oldest page is not loaded yet", (await thread(bo).getByText("Line 1", { exact: true }).count()) === 0);
    await step("Show earlier messages brings the start of the thread", async () => {
      await bo.getByRole("button", { name: "Show earlier messages" }).click();
      await thread(bo).getByText("Line 1", { exact: true }).waitFor();
      await thread(bo).getByText("Message deleted").waitFor();
    });
    check("nothing older is left to load", (await bo.getByRole("button", { name: "Show earlier messages" }).count()) === 0);

    await step("the same chat on a phone", async () => {
      await bo.setViewportSize({ width: 390, height: 844 });
      await bo.reload();
      await thread(bo).getByText("Line 120", { exact: true }).waitFor();
      await snap("bo-phone", bo);
      const write = await box(bo).boundingBox();
      check("on a phone the box to write in is on the screen", !!write && write.y + write.height <= 844, write && Math.round(write.y));
      const end = await thread(bo).getByText("Line 120", { exact: true }).boundingBox();
      check("on a phone the newest message is on the screen, above the box", !!end && !!write && end.y > 0 && end.y + end.height <= write.y, end && Math.round(end.y));
      await bo.setViewportSize({ width: 1100, height: 800 });
    });

  } catch {
    // The failed step is in the summary.
  } finally {
    // Before sign-in the app asks who you are and is told 401: that one is expected.
    const real = errors.filter((e) => !e.includes("401"));
    summary.consoleErrors = real;
    check("no errors in the browser console", real.length === 0, real.slice(0, 3));
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"}  evidence: ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
