#!/usr/bin/env node
// Drives the read marks in a space's chat on a Stand instance started by launch.sh, with three
// people in three browsers: one writes, and sees a small face under the last message each of the
// others has read, moving as they read on, with no reload. Then it reads what the server kept.
//
//   NODE_PATH="$(npm root -g)" node chat-reads.cjs <run dir>
//
// STAND_VERIFY_CHANNEL=chrome uses the installed Chrome when Playwright's own Chromium won't start.
// It runs at 1100px wide, where chat is a tab, so a person reads only when they open that tab.
// Exit code 0 = every check passed; 1 = a check failed (see summary.json in the evidence folder).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `chat-reads-${stamp}`);
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

const spaceName = `Reads ${stamp.slice(11)}`;
const FIRST = "The deploy is out.";
const SECOND = "All checks are green.";
const THIRD = "The footer link is broken, though.";
const ANSWER = "Thanks, looking at the footer now.";

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
/** The marks on a page, as [the message each sits under, what it says]. */
const marks = (page) =>
  page.locator(".chat-reads").evaluateAll((els) =>
    els.map((el) => {
      let at = el.previousElementSibling;
      while (at && !at.classList.contains("chat-msg")) at = at.previousElementSibling;
      return [at?.querySelector(".chat-msg-text")?.textContent ?? null, el.getAttribute("title")];
    }),
  );
/** Waits until the page's marks are these, then says what they are. */
async function marksAre(page, want) {
  const same = (got) => JSON.stringify(got) === JSON.stringify(want);
  for (let i = 0; i < 50 && !same(await marks(page)); i++) await page.waitForTimeout(100);
  return marks(page);
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_VERIFY_CHANNEL || undefined });
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    return page;
  };
  const vera = await open();
  const bo = await open();
  const cy = await open();
  try {
    lastPage = vera;
    let spaceUrl;
    await step("Vera signs in, makes a space and writes two messages in its chat", async () => {
      await signIn(vera, "Vera Verify", "vera@verify.test");
      await vera.getByRole("button", { name: "New space" }).first().click();
      await vera.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
      await vera.getByRole("button", { name: "Create and enter" }).click();
      await vera.waitForURL(/\/s\/[a-z0-9]+$/);
      spaceUrl = vera.url();
      await vera.getByRole("tab", { name: /^Chat/ }).click();
      await say(vera, FIRST);
      await thread(vera).getByText(FIRST).waitFor();
      await say(vera, SECOND);
      await thread(vera).getByText(SECOND).waitFor();
    });
    const roomId = spaceUrl.split("/s/")[1];
    check("nobody else has read it: no mark", (await marks(vera)).length === 0, await marks(vera));

    lastPage = bo;
    await step("Bo opens the space, on its Tasks tab", async () => {
      await signIn(bo, "Bo Tester", "bo@verify.test");
      await bo.goto(spaceUrl);
      await bo.getByRole("tab", { name: /^Chat\s*2$/ }).waitFor();
    });
    check("Bo has the space open but not the chat: still no mark", (await marks(vera)).length === 0, await marks(vera));

    await step("Bo opens Chat", async () => {
      await bo.getByRole("tab", { name: /^Chat/ }).click();
      await thread(bo).getByText(SECOND).waitFor();
    });
    lastPage = vera;
    let got = await marksAre(vera, [[SECOND, "Read up to here by Bo Tester"]]);
    check("Vera sees Bo's mark under her newest message, with no reload", got.length === 1 && got[0][0] === SECOND && got[0][1] === "Read up to here by Bo Tester", got);
    await snap("vera-bo-has-read", vera);
    check("the mark says who for a screen reader", (await vera.locator(".chat-reads .sr-only").first().textContent()) === "Read up to here by Bo Tester");
    check("Bo sees no mark: the messages are Vera's own", (await marks(bo)).length === 0, await marks(bo));

    await step("Bo goes to Tasks, and Vera writes a third message", async () => {
      await bo.getByRole("tab", { name: /^Tasks/ }).click();
      await say(vera, THIRD);
      await thread(vera).getByText(THIRD).waitFor();
      await bo.getByRole("tab", { name: /^Chat\s*1$/ }).waitFor({ timeout: 5000 });
    });
    got = await marksAre(vera, [[SECOND, "Read up to here by Bo Tester"]]);
    check("Bo's mark stays under the second message while the third is unread", got.length === 1 && got[0][0] === SECOND, got);
    await snap("vera-bo-is-behind", vera);

    await step("Bo comes back to Chat", async () => {
      await bo.getByRole("tab", { name: /^Chat/ }).click();
      await thread(bo).getByText(THIRD).waitFor();
    });
    got = await marksAre(vera, [[THIRD, "Read up to here by Bo Tester"]]);
    check("Bo's mark moves down to the third message", got.length === 1 && got[0][0] === THIRD, got);
    await snap("vera-bo-caught-up", vera);

    lastPage = cy;
    await step("Cy joins the space and opens Chat", async () => {
      await signIn(cy, "Cy Third", "cy@verify.test");
      await cy.goto(spaceUrl);
      await cy.getByRole("tab", { name: /^Chat/ }).click();
      await thread(cy).getByText(THIRD).waitFor();
    });
    lastPage = vera;
    // Cy joined after Vera's page loaded: the mark brings his name with it.
    got = await marksAre(vera, [[THIRD, "Read up to here by Bo Tester and Cy Third"]]);
    check("two people at the same message share one row of marks, with no reload", got.length === 1 && got[0][1] === "Read up to here by Bo Tester and Cy Third", got);
    check("with one face each", (await vera.locator(".chat-reads .avatar").count()) === 2);
    await snap("vera-two-have-read", vera);
    const mark = await vera.locator(".chat-reads").boundingBox();
    const message = await vera.locator(".chat-msg", { hasText: THIRD }).boundingBox();
    const write = await box(vera).boundingBox();
    check("the marks sit under the message, above the box, at the right", !!mark && !!message && !!write && mark.y >= message.y + message.height - 1 && mark.y + mark.height <= write.y, mark && message && { mark: Math.round(mark.y), message: Math.round(message.y + message.height) });

    await step("Bo answers", async () => {
      await say(bo, ANSWER);
      await thread(vera).getByText(ANSWER).waitFor({ timeout: 5000 });
    });
    // Vera's page is on Chat, so she reads the answer as it arrives; Cy's too.
    got = await marksAre(vera, [[ANSWER, "Read up to here by Cy Third"]]);
    check("Vera sees Cy's mark under Bo's answer, and none for Bo under his own message", got.length === 1 && got[0][1] === "Read up to here by Cy Third", got);
    got = await marksAre(bo, [[ANSWER, "Read up to here by Cy Third and Vera Verify"]]);
    check("Bo sees that Cy and Vera have read his answer", got.length === 1 && got[0][0] === ANSWER && got[0][1] === "Read up to here by Cy Third and Vera Verify", got);
    await snap("bo-answer-read-by-both", bo);

    // What the server kept, for each of them.
    const kept = await vera.request.get(`${base}/api/rooms/${roomId}/chat`).then((r) => r.json());
    fs.writeFileSync(path.join(out, "chat.json"), JSON.stringify(kept, null, 2));
    const last = kept.messages.at(-1).seq;
    check("the server tells Vera how far Bo and Cy have read, and leaves her out", JSON.stringify(kept.reads.map((r) => [r.name, r.upTo])) === JSON.stringify([["Bo Tester", last], ["Cy Third", last]]), kept.reads);

    await step("Vera reloads: the marks are as they were", async () => {
      await say(vera, "On it too.");
      await thread(vera).getByText("On it too.").waitFor();
      await marksAre(vera, [["On it too.", "Read up to here by Bo Tester and Cy Third"]]);
      await vera.reload();
      await vera.getByRole("tab", { name: /^Chat/ }).click();
      await thread(vera).getByText("On it too.").waitFor();
    });
    got = await marksAre(vera, [["On it too.", "Read up to here by Bo Tester and Cy Third"]]);
    check("after a reload Vera's newest message has both marks", got.length === 1 && got[0][0] === "On it too.", got);
    got = await marksAre(bo, [["On it too.", "Read up to here by Cy Third"]]);
    check("Bo sees Cy's mark there, and not Vera's under her own message", got.length === 1 && got[0][1] === "Read up to here by Cy Third", got);

    await step("the dock, on a wide screen", async () => {
      await bo.setViewportSize({ width: 1280, height: 800 });
      await bo.reload();
      await bo.getByRole("complementary", { name: "Chat" }).getByText(ANSWER).waitFor();
      await marksAre(bo, [["On it too.", "Read up to here by Cy Third"]]);
      await snap("bo-dock", bo);
    });
    await step("the same chat on a phone", async () => {
      await bo.setViewportSize({ width: 390, height: 844 });
      await bo.reload();
      await bo.getByRole("tab", { name: /^Chat/ }).click();
      await thread(bo).getByText(ANSWER).waitFor();
      await marksAre(bo, [["On it too.", "Read up to here by Cy Third"]]);
      await snap("bo-phone", bo);
      const m = await bo.locator(".chat-reads").boundingBox();
      const w = await box(bo).boundingBox();
      check("on a phone the marks are on the screen, above the box", !!m && !!w && m.x >= 0 && m.x + m.width <= 390 && m.y + m.height <= w.y, m && { x: Math.round(m.x), y: Math.round(m.y) });
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
