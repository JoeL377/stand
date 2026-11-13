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
        owner: li.querySelector(".rc-name, .rc-face")?.getAttribute("title") ?? null,
      })),
    );
  const sections = () => rowsIn(".sh-panel .sh-project");
  const forYou = () => rowsIn(".sh-task-group.for-you");
  /** A to-do's parts are folded under it until its parts pill is clicked. */
  const showParts = async (text) => {
    const pill = page.locator(".sh-project .followups li", { hasText: text }).locator(".task-parts").first();
    if ((await pill.getAttribute("aria-expanded")) !== "true") await pill.click();
  };
  /** A parent's row and the indented rows right under it. */
  const family = (rows, text) => {
    const at = rows.findIndex((r) => r.text === text && !r.part);
    const parts = [];
    for (let i = at + 1; at >= 0 && rows[i]?.part; i++) parts.push(rows[i]);
    return { parent: rows[at], parts };
  };
  /** The Projects tab is the projects, and a project's rows are on its own page. */
  let projectIds = {};
  const openTasks = async (project, query = "") => {
    await page.goto(`${base}/s/${roomId}?${project ? `project=${projectIds[project]}` : ""}${query}`);
    if (project) await page.getByRole("region", { name: project }).locator(".followups li").first().waitFor();
    else await page.locator(".sh-project").first().waitFor();
  };
  /** Mine is what is yours across every project, in one list, with what waits on you first. */
  const mine = async () => {
    await page.goto(`${base}/s/${roomId}?mine=1`);
    await page.locator(".sh-task-group .followups li").first().waitFor();
  };
  try {
    await step("open the sample space's projects", async () => {
      const spaces = await page.request.get(`${base}/api/spaces`).then((r) => r.json());
      roomId = spaces.find((s) => s.name === "Acme Checkout")?.id;
      if (!roomId) throw new Error("No Acme Checkout space: this journey runs on the preview's sample data");
      projectIds = Object.fromEntries((await page.request.get(`${base}/api/rooms/${roomId}/projects`).then((r) => r.json())).map((p) => [p.name, p.id]));
      await openTasks();
      await snap("projects");
      check("the first view is a row per project, with no task rows in them", (await page.locator(".pj-grid .sh-project").count()) >= 3 && (await sections()).length === 0);
      await page.getByRole("region", { name: "Payments" }).getByRole("button", { name: "Payments", exact: true }).click();
      await page.waitForURL(/project=/);
      await page.getByRole("region", { name: "Payments" }).locator(".followups li").first().waitFor();
      check("a click on a card opens the project's own page", (await page.locator(".pj-grid").count()) === 0 && (await page.locator(".sh-tab .sh-crumb").count()) === 1);
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
      await showParts(WORKER);
      const indent = await page.evaluate(() => {
        const part = document.querySelector(".sh-project .followups li.part .check");
        const top = document.querySelector(".sh-project .followups li:not(.part) .check");
        return part && top ? part.getBoundingClientRect().left - top.getBoundingClientRect().left : 0;
      });
      check("the part's checkbox starts to the right of its parent's", indent >= 16, indent);
      await openTasks("Guest checkout");
      const checklist = family(await sections(), CHECKLIST);
      check("a part that is ready to ship stays under its parent in the project", checklist.parent?.count === "0/2 parts" && checklist.parts.map((p) => p.text).sort().join() === [LAUNCH_NOTE, TERMS].sort().join(), checklist);
      check("the space has two tabs, Projects and Meetings", ((t) => t.length === 2 && /Projects/.test(t[0]) && /Meetings/.test(t[1]))(await page.getByRole("tablist", { name: "The space" }).getByRole("tab").allInnerTexts()), await page.getByRole("tablist", { name: "The space" }).getByRole("tab").allInnerTexts());
      check("a project's page lists one kind at a time", (await page.getByRole("tablist", { name: "What to show" }).getByRole("tab").allInnerTexts()).map((t) => t.replace(/\s*\d+$/, "").trim()).join() === "Tasks,Questions,Decisions");
      await mine();
      check("Mine is one list with no projects in it", (await page.locator(".sh-project").count()) === 0 && (await rowsIn(".sh-task-group.by-owner")).length >= 1);
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
      // The name waits for the pointer on a wide screen.
      await page.locator(".sh-task-group.for-you .followups li", { hasText: TERMS }).hover();
      await page.locator(".sh-task-group.for-you .task-part-of").click();
      await page.locator(".task-drawer .td-title", { hasText: CHECKLIST }).waitFor();
      check("the drawer shows the parent with its parts", (await page.locator(".task-drawer .td-links li").count()) >= 2);
      await page.waitForTimeout(400);
      await snap("part-of-opens-the-parent");
      await page.keyboard.press("Escape");
    });

    await step("make a to-do a part in the drawer, then tick it off", async () => {
      await openTasks("Guest checkout");
      await page.locator(".sh-project .followups li", { hasText: INVITE }).locator(".fu-open").click();
      await page.locator(".task-drawer .td-title", { hasText: INVITE }).waitFor();
      await page.getByRole("button", { name: "Make it a part of a to-do" }).click();
      await page.getByPlaceholder("Find a to-do").fill("retry worker");
      await page.getByRole("option", { name: WORKER }).click();
      await page.keyboard.press("Escape");
      // The sample to-do has its own project, so it stays there as a row that names its parent.
      const moved = page.locator(".sh-project .followups li", { hasText: INVITE });
      await moved.hover();
      check("a part in another project than its parent names it", (await moved.locator(".task-part-of").innerText()) === `Part of: ${WORKER}`);
      await snap("a-new-part");
      await moved.locator(".check").click();
      await moved.waitFor({ state: "detached" });
      await openTasks("Payments");
      const worker = family(await sections(), WORKER);
      check("the parent counts the new part, ticked", worker.parent?.count === "2/4 parts" && !worker.parts.some((p) => p.text === INVITE), worker);
      await page.locator(".sh-done-toggle", { hasText: "Done" }).click();
      const done = await rowsIn(".sh-done.open");
      await openTasks("Guest checkout");
      await page.locator(".sh-done-toggle", { hasText: "Done" }).click();
      done.push(...(await rowsIn(".sh-done.open")));
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
      await mine();
      const rows = await rowsIn(".sh-task-group.by-owner");
      check("the parent keeps its count while its other part is out of view", family(rows, CHECKLIST).parent?.count === "0/2 parts", rows);
      check("the part that waits on you still names its parent", (await forYou()).some((r) => r.text === TERMS && r.partOf === `Part of: ${CHECKLIST}`));
      await snap("mine");
    });

    await step("on a phone", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      // A phone has rows, and a row opens its project's page.
      await page.goto(`${base}/s/${roomId}`);
      await page.getByRole("region", { name: "Payments" }).getByRole("button", { name: "Payments", exact: true }).click();
      await page.getByRole("region", { name: "Payments" }).locator(".followups li").first().waitFor();
      check("on a phone a row opens its project's page", /project=/.test(page.url()) && (await page.getByRole("tablist", { name: "What to show" }).count()) === 1);
      await openTasks("Payments");
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check("the page doesn't scroll sideways", !wide);
      check("parts are still one step in", (await page.locator(".sh-project .followups li.part").count()) >= 2);
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
