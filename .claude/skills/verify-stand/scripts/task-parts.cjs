#!/usr/bin/env node
// A to-do's parts on the Tasks tab: a part sits under its parent, one step in, whoever owns it; the
// parent says how many of its parts are done; a part whose parent isn't the row above it (under For
// you, in Done, with Mine on) names its parent instead, and the name opens the parent. Then a person
// makes a to-do a part in the task drawer and ticks it off, and the list follows.
//
// It needs to-dos with parts in each of those places, so it runs on the preview's sample data
// (features/task-parts.md says how):
//   NODE_PATH="$(npm root -g)" node task-parts.cjs <run dir> [--headed]

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir, ...flags] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `task-parts-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { journey: "task-parts", base, steps: [], checks: [], ok: true };
let page;
let shot = 0;
const snap = async (name) => {
  const file = path.join(out, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
};
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    summary.steps.push({ name, ms: Date.now() - t });
    console.log(`✓ ${name}`);
  } catch (e) {
    summary.steps.push({ name, ms: Date.now() - t, error: String(e.message ?? e).split("\n")[0] });
    summary.ok = false;
    console.log(`✗ ${name}: ${String(e.message ?? e).split("\n")[0]}`);
    await snap(`FAILED-${name.replace(/\W+/g, "-")}`).catch(() => {});
    throw e;
  }
}
function check(name, pass, detail) {
  summary.checks.push({ name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) });
  if (!pass) summary.ok = false;
  console.log(`${pass ? "✓" : "✗"} check: ${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 300)})` : ""}`);
}

const WORKER = "Build the payment retry worker";
const BROWSER = "Remove the browser retry path";
const RUNBOOK = "Write the retry runbook for support";
const KEY = "Add an idempotency key to every charge";
const CHECKLIST = "Draft the Dec 1 launch checklist";
const LAUNCH_NOTE = "Write the guest checkout launch note";
const TERMS = "Update the terms link at checkout";
const INVITE = "Invite support to the next review";

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_BROWSER ?? "chrome", headless: !flags.includes("--headed") });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  let roomId;
  const room = () => page.request.get(`${base}/api/rooms/${roomId}`).then((r) => r.json());
  /** The rows of a list as the page shows them. */
  const rowsIn = (scope) =>
    page.$$eval(`${scope} .followups li`, (lis) =>
      lis.map((li) => ({
        text: li.querySelector(".fu-open")?.textContent ?? "",
        part: li.classList.contains("part"),
        count: li.querySelector(".task-parts")?.textContent ?? null,
        partOf: li.querySelector(".task-part-of")?.textContent ?? null,
        owner: li.querySelector(".rc-face")?.getAttribute("title") ?? null,
      })),
    );
  const sections = () => rowsIn(".sh-panel .sh-project");
  const forYou = () => rowsIn(".sh-task-group.for-you");
  /** A parent's row and the indented rows right under it. */
  const family = (rows, text) => {
    const at = rows.findIndex((r) => r.text === text && !r.part);
    const parts = [];
    for (let i = at + 1; at >= 0 && rows[i]?.part; i++) parts.push(rows[i]);
    return { parent: rows[at], parts };
  };
  const openTasks = async () => {
    await page.goto(`${base}/s/${roomId}`);
    // The rows that wait on someone move to For you once their work has loaded.
    await page.locator(".sh-task-group.for-you .followups li").first().waitFor();
  };
  try {
    await step("open the sample space's Tasks tab", async () => {
      const spaces = await page.request.get(`${base}/api/spaces`).then((r) => r.json());
      roomId = spaces.find((s) => s.name === "Acme Checkout")?.id;
      if (!roomId) throw new Error("No Acme Checkout space: this journey runs on the preview's sample data");
      await openTasks();
      await snap("tasks-with-parts");
      const worker = family(await sections(), WORKER);
      check("the parent says how many of its parts are done", worker.parent?.count === "1/3 parts", worker.parent);
      check(
        "its open parts are the rows under it, one step in",
        worker.parts.map((p) => p.text).join("|") === [BROWSER, RUNBOOK].join("|"),
        worker.parts,
      );
      check("a part someone else owns stays under its parent", /Priya/.test(worker.parent?.owner ?? "") && /Maya/.test(worker.parts[1]?.owner ?? ""), [worker.parent?.owner, worker.parts[1]?.owner]);
      check("a part under its parent doesn't name it", worker.parts.every((p) => !p.partOf), worker.parts);
      const indent = await page.evaluate(() => {
        const part = document.querySelector(".sh-project .followups li.part .check");
        const top = document.querySelector(".sh-project .followups li:not(.part) .check");
        return part && top ? part.getBoundingClientRect().left - top.getBoundingClientRect().left : 0;
      });
      check("the part's checkbox starts to the right of its parent's", indent >= 16, indent);
      const checklist = family(await sections(), CHECKLIST);
      check("a parent with a part under For you counts it too", checklist.parent?.count === "0/2 parts" && checklist.parts.map((p) => p.text).join() === LAUNCH_NOTE, checklist);
      const terms = (await forYou()).find((r) => r.text === TERMS);
      check("a part under For you is a row of its own that names its parent", terms && !terms.part && terms.partOf === `Part of: ${CHECKLIST}`, terms);
      const saved = await room();
      const todo = (text) => [...saved.followUps, ...saved.doneFollowUps].find((f) => f.text === text && (text !== BROWSER || f.parentId));
      check(
        "the server has the same parents",
        [BROWSER, RUNBOOK, KEY].every((t) => todo(t)?.parentId === todo(WORKER)?.id) && [LAUNCH_NOTE, TERMS].every((t) => todo(t)?.parentId === todo(CHECKLIST)?.id),
      );
    });

    await step("the name of the parent opens it", async () => {
      await page.locator(".sh-task-group.for-you .task-part-of").click();
      await page.locator(".task-drawer .td-title", { hasText: CHECKLIST }).waitFor();
      check("the drawer shows the parent with its parts", (await page.locator(".task-drawer .td-links li").count()) >= 2);
      await page.waitForTimeout(400);
      await snap("part-of-opens-the-parent");
      await page.keyboard.press("Escape");
    });

    await step("make a to-do a part in the drawer, then tick it off", async () => {
      await page.locator(".sh-project .followups li", { hasText: INVITE }).locator(".fu-open").click();
      await page.locator(".task-drawer .td-title", { hasText: INVITE }).waitFor();
      await page.getByRole("button", { name: "Make it a part of a to-do" }).click();
      await page.getByPlaceholder("Find a to-do").fill("retry worker");
      await page.getByRole("option", { name: WORKER }).click();
      await page.locator(".sh-project .followups li.part", { hasText: INVITE }).waitFor();
      await page.keyboard.press("Escape");
      let worker = family(await sections(), WORKER);
      check("the new part moved under its parent, and the count grew", worker.parts.some((p) => p.text === INVITE) && worker.parent?.count === "1/4 parts", worker);
      await snap("a-new-part");
      await page.locator(".sh-project .followups li.part", { hasText: INVITE }).locator(".check").click();
      await page.locator(".sh-project .followups li", { hasText: INVITE }).waitFor({ state: "detached" });
      worker = family(await sections(), WORKER);
      check("ticking a part counts it on the parent", worker.parent?.count === "2/4 parts" && !worker.parts.some((p) => p.text === INVITE), worker);
      await page.locator(".sh-done-toggle", { hasText: "Done" }).click();
      const done = await rowsIn(".sh-done.open");
      check(
        "done parts name their parent under Done",
        [KEY, INVITE].every((t) => done.find((r) => r.text === t)?.partOf === `Part of: ${WORKER}`),
        done.map((r) => [r.text, r.partOf]),
      );
      await snap("done-parts");
      const saved = await room();
      const invite = saved.doneFollowUps.find((f) => f.text === INVITE);
      check("the server kept the parent and the tick", !!invite?.doneAt && invite.parentId === saved.followUps.find((f) => f.text === WORKER)?.id, invite && { doneAt: invite.doneAt, parentId: invite.parentId });
    });

    await step("Mine: a part whose parent is someone else's names it", async () => {
      await page.goto(`${base}/s/${roomId}?mine=1`);
      await page.locator(".sh-task-group.for-you .followups li").first().waitFor();
      const rows = await sections();
      check("the parent keeps its count while its other part is out of view", family(rows, CHECKLIST).parent?.count === "0/2 parts" && rows.every((r) => !r.part), rows);
      check("the part that waits on you still names its parent", (await forYou()).some((r) => r.text === TERMS && r.partOf === `Part of: ${CHECKLIST}`));
      await snap("mine");
    });

    await step("on a phone", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openTasks();
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check("the page doesn't scroll sideways", !wide);
      check("parts are still one step in", (await page.locator(".sh-project .followups li.part").count()) >= 3);
      await snap("phone");
    });

    check("no page errors", consoleErrors.length === 0, consoleErrors);
  } catch {
    // The failed step is in the summary.
  } finally {
    summary.consoleErrors = consoleErrors;
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`\n${summary.ok ? "PASS" : "FAIL"}: ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
