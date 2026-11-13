#!/usr/bin/env node
// Drives what Stand catches from the space's chat, on a Stand instance started by launch.sh with
// short waits, with two people in two browsers: they write a decision and a to-do, both see the
// caught lines arrive without a reload, one opens the to-do, the other removes the decision, and
// when the talk goes quiet the stretch closes with what it was about. Then it reads what the
// server and an agent see.
//
//   CHAT_CAPTURE_QUIET_MS=1500 CHAT_QUIET_MS=30000 launch.sh
//   NODE_PATH="$(npm root -g)" node chat-capture.cjs <run dir>
//
// Without a model key the notes come from patterns ("We decided…", "I will…"), which is what this
// journey writes. STAND_VERIFY_CHANNEL=chrome uses the installed Chrome.
// Exit code 0 = every check passed; 1 = a check failed (see summary.json in the evidence folder).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `chat-capture-${stamp}`);
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

const spaceName = `Capture ${stamp.slice(11)}`;
const DECISION = "We decided to ship the invite flow on Friday.";
const TODO = "I will send the invite email copy today.";
const SMALL_TALK = "Sounds good to me, thanks a lot Bo.";

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
const caught = (page, text) => page.locator(".chat-caught", { hasText: text });

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
    await step("Vera makes a space, opens Chat and writes a decision", async () => {
      await signIn(vera, "Vera Verify", "vera@verify.test");
      await vera.getByRole("button", { name: "New space" }).first().click();
      await vera.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
      await vera.getByRole("button", { name: "Create and enter" }).click();
      await vera.waitForURL(/\/s\/[a-z0-9]+$/);
      spaceUrl = vera.url();
      await vera.getByRole("tab", { name: /^Chat/ }).click();
      await say(vera, DECISION);
      await thread(vera).getByText(DECISION).first().waitFor();
    });
    const roomId = spaceUrl.split("/s/")[1];

    lastPage = bo;
    await step("Bo joins the space and writes that he will do something", async () => {
      await signIn(bo, "Bo Tester", "bo@verify.test");
      await bo.goto(spaceUrl);
      await bo.getByRole("tab", { name: /^Chat/ }).click();
      await say(bo, TODO);
      await thread(bo).locator(".chat-msg", { hasText: TODO }).waitFor();
    });

    await step("both see what Stand caught, with no reload", async () => {
      for (const page of [bo, vera]) {
        await caught(page, DECISION).waitFor({ timeout: 15000 });
        await caught(page, TODO).waitFor({ timeout: 5000 });
      }
      await snap("bo-caught-lines", bo);
      await snap("vera-caught-lines", vera);
    });
    check("the decision's chip says Decided", (await caught(vera, DECISION).innerText()).includes("Decided"));
    check("the to-do's chip says To-do, with who took it", /To-do/.test(await caught(vera, TODO).innerText()) && /Bo Tester/.test((await caught(vera, TODO).getAttribute("title")) || ""), await caught(vera, TODO).getAttribute("title"));
    check("each line shows once", (await caught(vera, DECISION).count()) === 1 && (await caught(vera, TODO).count()) === 1);
    const order = await thread(vera).evaluate((el) => [...el.querySelectorAll(".chat-msg, .chat-caught")].map((n) => (n.classList.contains("chat-caught") ? "caught" : "msg")));
    // The decision is caught after Vera's message when Stand read it before Bo wrote, and after Bo's otherwise.
    check("the caught lines sit in the thread after the messages they came after", ["msg msg caught caught", "msg caught msg caught"].includes(order.join(" ")), order);

    lastPage = vera;
    await step("Vera opens the to-do from the thread: it is a task of the space", async () => {
      await caught(vera, TODO).getByRole("button", { name: /I will send the invite email copy today/ }).click();
      await vera.waitForURL(/[?&]task=/);
      await vera.getByText("From the chat on").waitFor();
      await vera.getByRole("button", { name: "Copy for agent" }).waitFor();
      await snap("vera-task-drawer", vera);
      await vera.keyboard.press("Escape");
      await vera.waitForURL((u) => !u.search.includes("task="));
    });

    lastPage = bo;
    await step("the Tasks and Decisions tabs have them", async () => {
      await bo.getByRole("tab", { name: /^Tasks/ }).click();
      await bo.getByText(TODO).filter({ visible: true }).first().waitFor({ timeout: 25000 });
      await snap("bo-tasks-tab", bo);
      await bo.getByRole("tab", { name: /^Decisions/ }).click();
      await bo.locator(".sh-panel.decisions li", { hasText: DECISION }).waitFor({ timeout: 25000 });
      await snap("bo-decisions-tab", bo);
      await bo.getByRole("tab", { name: /^Chat/ }).click();
    });

    await step("Bo removes the decision: it isn't one. It goes from Vera's thread too", async () => {
      const row = caught(bo, DECISION);
      await row.hover();
      await row.getByRole("button", { name: "Remove this decision" }).click();
      await row.waitFor({ state: "detached", timeout: 5000 });
      await caught(vera, DECISION).waitFor({ state: "detached", timeout: 5000 });
      await snap("vera-decision-removed", vera);
    });
    check("the message itself stays", (await thread(vera).locator(".chat-msg", { hasText: DECISION }).count()) === 1);

    await step("more talk is read, and the removed decision does not come back", async () => {
      await say(vera, SMALL_TALK);
      await thread(bo).getByText(SMALL_TALK).waitFor({ timeout: 5000 });
      // Long enough for the next run to have happened and been shown.
      await vera.waitForTimeout(5000);
    });
    check("the decision is still gone after the next run", (await caught(vera, DECISION).count()) === 0 && (await caught(bo, DECISION).count()) === 0);
    check("the to-do is still there, once", (await caught(vera, TODO).count()) === 1);

    await step("the talk goes quiet: the stretch closes with what it was about, on both screens", async () => {
      for (const page of [vera, bo]) await page.locator(".chat-recap").waitFor({ timeout: 90000 });
      await snap("vera-recap", vera);
      await snap("bo-recap", bo);
    });
    await vera.locator(".chat-recap-head").click();
    check("the recap has a summary", ((await vera.locator(".chat-recap-summary").innerText()) || "").trim().length > 0, await vera.locator(".chat-recap").innerText());

    // What the server kept.
    const kept = await vera.request.get(`${base}/api/rooms/${roomId}/chat`).then((r) => r.json());
    fs.writeFileSync(path.join(out, "chat.json"), JSON.stringify(kept, null, 2));
    const lines = (kept.caught[0]?.lines ?? []).map((l) => `${l.kind}: ${l.text}`);
    check("the server has one session with the to-do and no decision", kept.caught.length === 1 && lines.length === 1 && lines[0] === `action: ${TODO}`, lines);
    check("the closed session has its summary", !!kept.caught[0]?.summary && kept.channel.openSessionId === null, { summary: kept.caught[0]?.summary, open: kept.channel.openSessionId });

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
    await step("an agent reads what the chat left", async () => {
      await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
      const status = await tool(2, "get_chat", { space: roomId });
      const recent = status?.recent?.[0];
      check("get_chat lists the closed stretch with one to-do, no decision, and its summary", !!recent && recent.to_dos === 1 && recent.decided === 0 && !!recent.summary, recent);
      const one = await tool(3, "get_chat", { chat_id: recent.chat_id });
      check("the stretch gives the to-do with its owner", one?.to_dos?.length === 1 && one.to_dos[0].text === TODO && one.to_dos[0].owner === "Bo Tester", one?.to_dos);
      const actions = await tool(4, "list_actions", { space: roomId });
      const all = JSON.stringify(actions);
      check("list_actions has the to-do from chat", all.includes(TODO));
      const news = await tool(5, "whats_new", { space: roomId });
      check("whats_new has no decision from the chat, since it was removed", !(news?.decided ?? []).some((d) => d.text === DECISION), (news?.decided ?? []).map((d) => d.text));
    });

    lastPage = bo;
    await step("the same thread on a phone", async () => {
      await bo.setViewportSize({ width: 390, height: 844 });
      await bo.reload();
      await caught(bo, TODO).waitFor();
      await bo.locator(".chat-recap").waitFor();
      await snap("bo-phone", bo);
      const row = await caught(bo, TODO).boundingBox();
      check("on a phone the caught line fits the screen", !!row && row.x >= 0 && row.x + row.width <= 390, row && { x: Math.round(row.x), width: Math.round(row.width) });
      await bo.setViewportSize({ width: 1100, height: 800 });
    });
  } catch {
    // The failed step is in the summary.
  } finally {
    const real = errors.filter((e) => !e.includes("401"));
    summary.consoleErrors = real;
    check("no errors in the browser console", real.length === 0, real.slice(0, 3));
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"}  evidence: ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
