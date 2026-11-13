#!/usr/bin/env node
// Drives the chat dock and send at once on a Stand instance started by launch.sh, with two people.
// From 1200px wide, chat is a column at the right of the space page, beside every tab, and a message
// shows the moment it is sent. Launch with short capture waits, as chat-capture.cjs needs:
//
//   CHAT_CAPTURE_QUIET_MS=1500 $S/launch.sh
//   NODE_PATH="$(npm root -g)" node chat-dock.cjs <run dir>
//
// STAND_VERIFY_CHANNEL=chrome uses the installed Chrome when Playwright's own Chromium won't start.
// Exit code 0 = every check passed; 1 = a check failed (see summary.json in the evidence folder).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `chat-dock-${stamp}`);
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

const spaceName = `Dock ${stamp.slice(11)}`;
const TODO = "I will send the invite email copy today.";
const FROM_TASKS = "Writing this from the Tasks tab.";
const UNSENT = "This one goes out while the server is away.";

async function signIn(page, name, email) {
  await page.goto(base);
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Work email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New space" }).first().waitFor();
}
const dock = (page) => page.getByRole("complementary", { name: "Chat" });
const box = (page) => dock(page).getByRole("combobox", { name: "Write to the space" });
const say = async (page, text) => {
  await box(page).fill(text);
  await box(page).press("Enter");
};
const thread = (page) => dock(page).locator(".chat-thread");
const caught = (page, text) => dock(page).locator(".chat-caught", { hasText: text });

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_VERIFY_CHANNEL || undefined });
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
    await step("Vera makes a space: chat starts closed, and the Chat button opens it at the right of Tasks", async () => {
      await signIn(vera, "Vera Verify", "vera@verify.test");
      await vera.getByRole("button", { name: "New space" }).first().click();
      await vera.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
      await vera.getByRole("button", { name: "Create and enter" }).click();
      await vera.waitForURL(/\/s\/[a-z0-9]+$/);
      spaceUrl = vera.url();
      await vera.getByRole("button", { name: "Chat", pressed: false }).waitFor();
      check("the dock starts closed", (await dock(vera).count()) === 0);
      await vera.getByRole("button", { name: "Chat", pressed: false }).click();
      await dock(vera).getByText("Nothing here yet.").waitFor();
      await snap("vera-dock-on-tasks", vera);
    });
    const roomId = spaceUrl.split("/s/")[1];
    check("the tab row has no Chat tab", (await vera.getByRole("tab", { name: /^Chat/ }).count()) === 0);
    check("the Chat button in the head says the dock is open", (await vera.getByRole("button", { name: "Chat", pressed: true }).count()) === 1);

    await step("the dock stays while Vera goes through Meetings and Decisions", async () => {
      for (const t of [/^Meetings/, /^Projects/]) {
        await vera.getByRole("tab", { name: t }).click();
        await box(vera).waitFor();
      }
    });

    lastPage = bo;
    await step("Bo opens the space on Tasks and writes from there", async () => {
      await signIn(bo, "Bo Tester", "bo@verify.test");
      await bo.goto(spaceUrl);
      await bo.getByRole("tab", { name: /^Projects/, selected: true }).waitFor();
      // Closed until he opens it, here as in every space.
      await bo.getByRole("button", { name: "Chat", pressed: false }).click();
      await say(bo, FROM_TASKS);
      await thread(bo).getByText(FROM_TASKS).waitFor();
    });

    lastPage = vera;
    await step("Vera sees it in her dock with no reload", async () => {
      await thread(vera).getByText(FROM_TASKS).waitFor({ timeout: 5000 });
      await snap("vera-sees-bo", vera);
    });

    // Send at once: the message shows while its save is held back, and the box is free for the next.
    await step("with the save held back, Vera's message shows at once and the box is empty", async () => {
      let release;
      const held = new Promise((r) => (release = r));
      await vera.route(`**/api/rooms/${roomId}/chat/messages`, async (route) => {
        await held;
        await route.continue();
      });
      await say(vera, "First of three");
      await thread(vera).locator(".chat-msg.pending", { hasText: "First of three" }).waitFor({ timeout: 300 });
      check("the box is empty while the first one is saved", (await box(vera).inputValue()) === "");
      await say(vera, "Second of three");
      await say(vera, "Third of three");
      await vera.waitForTimeout(700);
      await snap("vera-three-pending", vera);
      check("all three show, dimmed, before any is saved", (await thread(vera).locator(".chat-msg.pending").count()) === 3);
      release();
      await vera.waitForFunction(() => document.querySelectorAll(".sh-dock .chat-msg.pending").length === 0, null, { timeout: 5000 });
      await vera.unroute(`**/api/rooms/${roomId}/chat/messages`);
    });
    await step("Bo gets the three in the order they were sent", async () => {
      await thread(bo).getByText("Third of three").waitFor({ timeout: 5000 });
    });
    const order = (await thread(bo).locator(".chat-msg-text").allInnerTexts()).filter((t) => t.includes("of three"));
    check("Bo has them in the order they were sent", order.join("|") === "First of three|Second of three|Third of three", order);
    const mine = (await thread(vera).locator(".chat-msg-text").allInnerTexts()).filter((t) => t.includes("of three"));
    check("Vera has each one once", mine.length === 3, mine);

    await step("a send that fails stays as Not sent, and Retry saves it once", async () => {
      await vera.route(`**/api/rooms/${roomId}/chat/messages`, (route) => route.abort("failed"));
      await say(vera, UNSENT);
      const row = thread(vera).locator(".chat-msg.failed", { hasText: UNSENT });
      await row.getByText("Not sent.").waitFor({ timeout: 5000 });
      await snap("vera-not-sent", vera);
      await vera.unroute(`**/api/rooms/${roomId}/chat/messages`);
      await row.getByRole("button", { name: "Retry" }).click();
      await thread(vera).locator(".chat-msg.failed").waitFor({ state: "detached", timeout: 5000 });
      await thread(bo).getByText(UNSENT).waitFor({ timeout: 5000 });
    });
    const kept = await vera.request.get(`${base}/api/rooms/${roomId}/chat`).then((r) => r.json());
    fs.writeFileSync(path.join(out, "chat.json"), JSON.stringify(kept, null, 2));
    check("the server kept the retried message once", kept.messages.filter((m) => m.text === UNSENT).length === 1);
    check("the server kept the three in order", kept.messages.map((m) => m.text).filter((t) => t.includes("of three")).join("|") === "First of three|Second of three|Third of three");

    await step("a failed send comes back after a reload, to send by hand", async () => {
      await vera.route(`**/api/rooms/${roomId}/chat/messages`, (route) => route.abort("failed"));
      await say(vera, "Lost if the page forgets");
      await thread(vera).locator(".chat-msg.failed", { hasText: "Lost if the page forgets" }).waitFor({ timeout: 5000 });
      await vera.reload();
      await thread(vera).locator(".chat-msg.failed", { hasText: "Lost if the page forgets" }).getByRole("button", { name: "Delete" }).click();
      await vera.unroute(`**/api/rooms/${roomId}/chat/messages`);
      await thread(vera).locator(".chat-msg.failed").waitFor({ state: "detached" });
    });

    lastPage = bo;
    await step("Command + J closes the dock and opens it with the cursor in the box", async () => {
      await bo.getByRole("tab", { name: /^Projects/ }).click();
      await bo.keyboard.press("ControlOrMeta+j");
      await dock(bo).waitFor({ state: "detached" });
      await say(vera, "While Bo has the dock closed");
      await bo.getByRole("button", { name: /^Chat/, pressed: false }).getByText("1").waitFor({ timeout: 5000 });
      await snap("bo-dock-closed-with-unread", bo);
      await bo.keyboard.press("ControlOrMeta+j");
      await box(bo).waitFor();
      check("the cursor is in the chat box", await box(bo).evaluate((el) => el === document.activeElement));
      // Typing in the box keeps the shortcut: it closes the dock again.
      await bo.keyboard.press("ControlOrMeta+j");
      await dock(bo).waitFor({ state: "detached" });
      await bo.getByRole("button", { name: /^Chat/ }).click();
      await box(bo).waitFor();
    });
    await step("the dock stays closed after a reload when it was closed", async () => {
      await bo.getByRole("button", { name: "Close chat" }).click();
      await bo.reload();
      await bo.getByRole("tab", { name: /^Projects/ }).waitFor();
      check("the dock is closed after the reload", (await dock(bo).count()) === 0);
      await bo.getByRole("button", { name: /^Chat/ }).click();
      await box(bo).waitFor();
    });

    lastPage = vera;
    await step("what Stand caught shows in the dock, and opens its task beside the dock on a wide screen", async () => {
      await say(bo, TODO);
      await caught(vera, TODO).waitFor({ timeout: 20000 });
      await vera.setViewportSize({ width: 1440, height: 860 });
      await caught(vera, TODO).getByRole("button", { name: /I will send the invite email copy today/ }).click();
      await vera.waitForURL(/[?&]task=/);
      await vera.getByText("From the chat on").waitFor();
      // The drawer slides in: measure it once it is still.
      await vera.locator(".task-drawer").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await snap("vera-drawer-beside-dock", vera);
    });
    const drawer = await vera.locator(".task-drawer").boundingBox();
    const column = await dock(vera).boundingBox();
    check("the task drawer opens to the left of the dock, not over it", !!drawer && !!column && drawer.x + drawer.width <= column.x + 1, drawer && column && { drawerRight: Math.round(drawer.x + drawer.width), dockLeft: Math.round(column.x) });
    await step("below 1360px the drawer covers the dock", async () => {
      await vera.setViewportSize({ width: 1280, height: 800 });
      await vera.waitForTimeout(200);
      await snap("vera-drawer-over-dock", vera);
      await vera.keyboard.press("Escape");
      await vera.waitForURL((u) => !u.search.includes("task="));
    });

    await step("below 1200px chat is a tab again, and the dock is gone", async () => {
      await vera.setViewportSize({ width: 1100, height: 800 });
      await vera.getByRole("tab", { name: /^Chat/ }).click();
      await vera.getByRole("combobox", { name: "Write to the space" }).waitFor();
      check("no dock on a narrower screen", (await dock(vera).count()) === 0);
      await snap("vera-tab-at-1100", vera);
      // Back on a wide screen, the Chat tab picked here shows as the dock, beside Tasks.
      await vera.setViewportSize({ width: 1280, height: 800 });
      await box(vera).waitFor();
      await vera.getByRole("tab", { name: /^Projects/, selected: true }).waitFor();
    });
  } catch {
    // The failed step is in the summary.
  } finally {
    // Before sign-in the app asks who you are and is told 401; the aborted sends are on purpose.
    const real = errors.filter((e) => !e.includes("401") && !e.includes("ERR_FAILED"));
    summary.consoleErrors = real;
    check("no errors in the browser console", real.length === 0, real.slice(0, 3));
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"}  evidence: ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
