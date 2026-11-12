#!/usr/bin/env node
// Drives mentions and new-message marks in a space's chat on a Stand instance started by launch.sh,
// with two people in two browsers. Vera tags Bo while Bo is on Tasks: Bo gets a toast, an @ on the
// Chat tab and in the nav, and the message is marked for him. Then Bo reads older messages while
// more come in, and the pill under the thread takes him down to them.
//
//   NODE_PATH="$(npm root -g)" node mentions.cjs <run dir>
//
// Exit code 0 = every check passed; 1 = a check failed (see summary.json in the evidence folder).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `mentions-${stamp}`);
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

const spaceName = `Mentions ${stamp.slice(11)}`;
const TAG = "@Bo Tester can you check the invite email?";

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
  // The @ list opens on a name: close it so Enter sends.
  await box(page).press("Escape");
  await box(page).press("Enter");
};
const thread = (page) => page.locator(".chat-thread");

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_VERIFY_CHANNEL || undefined });
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    return page;
  };
  const vera = await open();
  const bo = await open();
  try {
    lastPage = vera;
    let spaceUrl;
    await step("Vera makes a space; Bo joins it from its link and stays on Tasks", async () => {
      await signIn(vera, "Vera Verify", "vera@verify.test");
      await vera.getByRole("button", { name: "New space" }).first().click();
      await vera.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
      await vera.getByRole("button", { name: "Create and enter" }).click();
      await vera.waitForURL(/\/s\/[a-z0-9]+$/);
      spaceUrl = vera.url();
      await signIn(bo, "Bo Tester", "bo@verify.test");
      await bo.goto(spaceUrl);
      await bo.getByRole("tab", { name: /^Tasks/ }).click();
      // Vera's page learns Bo is in the space when it loads again.
      await vera.reload();
      await vera.getByRole("tab", { name: /^Chat/ }).click();
    });
    const roomId = spaceUrl.split("/s/")[1];

    await step("Vera writes a plain message: Bo's Chat tab shows one new", async () => {
      await say(vera, "Morning! Invite flow is up on staging.");
      await bo.getByRole("tab", { name: /^Chat\s*1$/ }).waitFor({ timeout: 5000 });
      await snap("bo-one-new", bo);
    });
    check("the count on the Chat tab is a filled badge", (await bo.locator(".sh-tab.chat .count.fresh").count()) === 1);
    check("the nav shows a dot for new chat in the space", (await bo.locator(".sp-chat-mark:not(.mention)").count()) === 1);

    lastPage = bo;
    await step("Vera tags Bo: a toast, an @ on the Chat tab and an @ in the nav", async () => {
      await say(vera, TAG);
      await bo.locator(".toast", { hasText: "Vera mentioned you in chat" }).waitFor({ timeout: 5000 });
      await bo.getByRole("tab", { name: /^Chat\s*2\s*\(1 mentions you\)$/ }).waitFor();
      await snap("bo-mentioned-toast-and-marks", bo);
    });
    check("the Chat tab has an @ badge", (await bo.locator(".sh-tab.chat .count.mention").count()) === 1);
    check("the nav has an @ mark for the space", (await bo.locator(".sp-chat-mark.mention").count()) === 1);
    check("the browser tab says a mention waits", (await bo.title()).startsWith("(@)"), await bo.title());
    const spaces = await bo.request.get(`${base}/api/spaces`).then((r) => r.json());
    const mine = spaces.find((s) => s.id === roomId);
    check("the space's summary counts the unread mention", mine?.unread === 2 && mine?.chatMentions === 1, { unread: mine?.unread, chatMentions: mine?.chatMentions });

    await step("Bo opens the chat from the toast; the message that tags him is marked", async () => {
      await bo.locator(".toast", { hasText: "Vera mentioned you in chat" }).getByRole("button", { name: "Open chat" }).click();
      await thread(bo).getByText("can you check the invite email?").waitFor();
      await bo.getByRole("tab", { name: /^Chat$/ }).waitFor();
      await snap("bo-chat-mention-marked", bo);
    });
    const row = bo.locator(".chat-msg", { hasText: "can you check the invite email?" });
    check("Bo sees the message marked as one that tags him", (await row.evaluate((el) => el.classList.contains("mentions-you"))) === true);
    check("Bo sees his name marked as a mention of him", (await row.locator(".mention.you").innerText()) === "@Bo Tester");
    check("the marks go once Bo has read it", (await bo.locator(".sp-chat-mark").count()) === 0 && !(await bo.title()).startsWith("("));
    const veraRow = vera.locator(".chat-msg", { hasText: "can you check the invite email?" });
    check("Vera sees the name marked as a mention of someone else", (await veraRow.locator(".mention:not(.you)").innerText()) === "@Bo Tester");
    check("Vera's own message is not marked as tagging her", (await veraRow.evaluate((el) => el.classList.contains("mentions-you"))) === false);
    await snap("vera-sees-mention", vera);

    await step("Bo reads older messages while new ones come in; a pill takes him down", async () => {
      for (let i = 1; i <= 40; i++) await vera.request.post(`${base}/api/rooms/${roomId}/chat/messages`, { data: { text: `Line ${i}` } });
      await thread(bo).getByText("Line 40", { exact: true }).waitFor({ timeout: 5000 });
      await thread(bo).evaluate((el) => el.scrollTo(0, 0));
      await bo.waitForTimeout(300);
      await say(vera, "One more: the footer link is broken.");
      await bo.locator(".chat-jump", { hasText: "1 new message" }).waitFor({ timeout: 5000 });
      await say(vera, "@Bo can you take that?");
      await bo.locator(".chat-jump.mention", { hasText: "A new message mentions you" }).waitFor({ timeout: 5000 });
      await snap("bo-jump-pill", bo);
      await bo.locator(".chat-jump").click();
      await bo.locator(".chat-jump").waitFor({ state: "detached" });
      await bo.waitForTimeout(600);
      await snap("bo-after-jump", bo);
    });
    const last = await thread(bo).getByText("can you take that?").boundingBox();
    const frame = await thread(bo).boundingBox();
    check("after the pill the newest message is in view", !!last && !!frame && last.y + last.height <= frame.y + frame.height + 1, last && frame && { message: Math.round(last.y + last.height), thread: Math.round(frame.y + frame.height) });

    await step("on a phone, the pill sits over the box to write in", async () => {
      await bo.setViewportSize({ width: 390, height: 844 });
      await bo.reload();
      await thread(bo).getByText("can you take that?").waitFor();
      await bo.evaluate(() => window.scrollTo(0, 0));
      await bo.waitForTimeout(300);
      await say(vera, "Last one for today.");
      await bo.locator(".chat-jump", { hasText: "1 new message" }).waitFor({ timeout: 5000 });
      await snap("bo-phone-jump-pill", bo);
      const pill = await bo.locator(".chat-jump").boundingBox();
      const write = await box(bo).boundingBox();
      check("on a phone the pill is on the screen, above the box", !!pill && !!write && pill.y > 0 && pill.y + pill.height <= write.y, pill && write && { pill: Math.round(pill.y + pill.height), box: Math.round(write.y) });
      await bo.setViewportSize({ width: 1280, height: 800 });
    });

    await step("Bo goes home; Vera tags him again, and the space's card says so", async () => {
      await bo.goto(`${base}/`);
      await bo.getByText(spaceName).first().waitFor();
      await say(vera, "@Bo Tester and the pricing page too");
      await bo.reload();
      await bo.locator(".sp-state.chat-mention", { hasText: "Mentioned in chat" }).waitFor({ timeout: 5000 });
      await snap("bo-home-mentioned", bo);
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
