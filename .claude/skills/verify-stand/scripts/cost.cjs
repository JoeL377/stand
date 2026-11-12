#!/usr/bin/env node
// What Stand spent (CostPanel.tsx on Manage spaces), the way an admin reads it. The local instance
// makes no Claude calls, so after a real call and a real chat stretch the journey writes usage rows
// straight into the run's database: in a call, in chat and between meetings, on three models, over
// several days, plus one row of another person's space and one with no space, which must not show.
// Then it reads the panel at 30 days and at 7, the empty state of a second space, and checks that a
// member who doesn't manage the space gets no panel and a refusal from the route.
//
//   NODE_PATH="$(npm root -g)" node cost.cjs <run dir> [--headed]

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { chromium } = require("playwright");

const [runDir, ...flags] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `cost-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { journey: "cost", base, steps: [], checks: [], ok: true };
let page;
let shot = 0;
const snap = async (name, target = page, full = true) => {
  const file = path.join(out, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await (target === page ? page.screenshot({ path: file, fullPage: full }) : target.screenshot({ path: file }));
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

async function signIn(p, name, email) {
  await p.goto(base);
  await p.getByPlaceholder("Your name").fill(name);
  await p.getByPlaceholder("Work email").fill(email);
  await p.getByRole("button", { name: "Continue" }).click();
  await p.getByRole("button", { name: "New space" }).first().waitFor();
}
async function newSpace(p, name) {
  await p.goto(base);
  await p.getByRole("button", { name: "New space" }).first().click();
  await p.getByPlaceholder("e.g. Checkout v2").fill(name);
  await p.getByRole("button", { name: "Create and enter" }).click();
  await p.waitForURL(/\/s\/[a-z0-9]+$/);
  return p.url().split("/s/")[1];
}

const DAY = 86_400_000;
const M = 1_000_000;
/** Usage rows, at list prices: Opus 5.5 $4 in / $20 out, Sonnet 5.5 $2 in, Haiku 5.5 $0.10 in / $0.50 out a million. */
function writeUsage(rooms) {
  // The server has the database open in WAL mode with no busy timeout. One short IMMEDIATE
  // transaction keeps the write lock for a moment only; this side waits if the server is writing.
  const db = new DatabaseSync(path.join(runDir, "data", "standup.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const meeting = (kind) => db.prepare(`SELECT id FROM meetings WHERE room_id = ? AND kind ${kind} ORDER BY started_at DESC LIMIT 1`).get(rooms.cost)?.id;
    const call = meeting("IS NULL");
    const chat = meeting("= 'chat'");
    if (!call || !chat) throw new Error(`no call (${call}) or chat stretch (${chat}) in the space`);
    const now = Date.now();
    const rows = [
      [call, rooms.cost, "recapMeeting", "claude-opus-5-5", M, 0, now - 60_000], // $4.00 today
      [call, rooms.cost, "boardCard", "claude-haiku-5-5", 0, M, now - 2 * DAY], // $0.50
      [chat, rooms.cost, "notesFor", "claude-haiku-5-5", M, 0, now - DAY], // $0.10
      [null, rooms.cost, "suggestProjects", "claude-opus-5-5", 0, M, now - 3 * DAY], // $20.00
      [null, rooms.cost, "polishAgenda", "claude-sonnet-5-5", M, 0, now - 10 * DAY], // $2.00, 30 days only
      [null, rooms.cost, "doneDeck", "claude-haiku-5-5", 30_000, 0, now - 120_000], // $0.003, under a cent
      [null, rooms.other, "doneDeck", "claude-opus-5-5", M, 0, now - 60_000], // another space's
      [null, null, "doneDeck", "claude-opus-5-5", M, 0, now - 60_000], // no space known
    ];
    const insert = db.prepare("INSERT INTO llm_usage (meeting_id, room_id, task, model, input, cache_read, cache_write, output, at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)");
    db.exec("BEGIN IMMEDIATE");
    for (const r of rows) insert.run(...r);
    db.exec("COMMIT");
    return { call, chat };
  } finally {
    db.close();
  }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_BROWSER ?? "chrome", headless: !flags.includes("--headed"), args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const open = async (viewport = { width: 1440, height: 900 }) => {
    const ctx = await browser.newContext({ viewport, permissions: ["microphone"] });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => consoleErrors.push(String(e)));
    p.on("dialog", (d) => d.accept());
    return p;
  };
  const consoleErrors = [];
  page = await open();
  const bo = await open();
  const rooms = {};
  const panel = (roomId, p = page) => p.locator("form.sp-manage-row", { has: p.locator(`a[href="/s/${roomId}"]`) }).locator(".cost-panel");
  try {
    await step("Vera signs in and makes two spaces", async () => {
      await signIn(page, "Vera Verify", "vera@verify.test");
      rooms.quiet = await newSpace(page, `Quiet ${stamp.slice(11)}`);
      rooms.cost = await newSpace(page, `Cost ${stamp.slice(11)}`);
    });

    await step("a call: start talking, then end it", async () => {
      await page.getByRole("button", { name: "Start talking" }).click();
      await page.getByRole("button", { name: "Leave", exact: true }).waitFor();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page.getByRole("menuitem", { name: "End for everyone" }).click({ timeout: 1500 }).catch(() => {});
      await page.locator("footer.controls").waitFor({ state: "detached", timeout: 60_000 });
    });

    await step("a chat stretch: write to the space", async () => {
      await page.goto(`${base}/s/${rooms.cost}`);
      // On a wide screen chat is the dock beside every tab; narrower, it is a tab.
      const tab = page.getByRole("tab", { name: /^Chat/ });
      if (await tab.count()) await tab.click();
      const box = page.getByRole("combobox", { name: "Write to the space" });
      await box.fill("What did the cost panel say this week?");
      await box.press("Enter");
      await page.locator(".chat-thread").getByText("What did the cost panel say this week?").waitFor();
    });

    await step("Bo signs in, makes his own space and opens Vera's from its link", async () => {
      await signIn(bo, "Bo Tester", "bo@verify.test");
      rooms.other = await newSpace(bo, `Bo's ${stamp.slice(11)}`);
      await bo.goto(`${base}/s/${rooms.cost}`);
      await bo.locator(".sh-panel").waitFor();
    });

    await step("write usage rows into the run's database", async () => {
      Object.assign(rooms, writeUsage(rooms));
    });

    const api = (p, url) => p.request.get(`${base}${url}`).then(async (r) => ({ status: r.status(), body: await r.json() }));
    const month = await api(page, `/api/rooms/${rooms.cost}/cost?days=30&tz=0`);
    check("the route sums this space only: $26.603 over 6 calls", month.status === 200 && Math.abs(month.body.usd - 26.603) < 1e-9 && month.body.calls === 6, [month.status, month.body.usd, month.body.calls]);
    check("groups, most expensive first", month.body.groups?.map((g) => g.where).join() === "between,calls,chat", month.body.groups?.map((g) => [g.where, g.usd]));
    check("30 day entries", month.body.days?.length === 30, month.body.days?.length);
    const refused = await api(bo, `/api/rooms/${rooms.cost}/cost`);
    check("a member who doesn't manage the space is refused", refused.status === 403 && /^Only an admin/.test(refused.body.error), refused);

    await step("Manage spaces: the panel at 30 days", async () => {
      await page.goto(`${base}/spaces/manage`);
      await panel(rooms.cost).locator(".cost-total").waitFor();
      await panel(rooms.cost).scrollIntoViewIfNeeded();
      await snap("panel-30-days", panel(rooms.cost));
    });
    const text = await panel(rooms.cost).innerText();
    check("the total and the calls", text.includes("$26.60 · 6 calls"), text.split("\n").slice(0, 4));
    for (const words of ["In calls", "In chat", "Between meetings", "What Stand does for the space, not for one meeting.", "Recap", "Topic card", "Live notes", "Project suggestions", "Agenda tidy", "Done since"])
      check(`shows "${words}"`, text.includes(words));
    check("a cost under a cent reads under $0.01", /Done since\s+under \$0\.01/.test(text), text.match(/Done since.*\n?.*/)?.[0]);
    check("no other space's row and no row without a space", !text.includes("$30.6") && !text.includes("$34.6"));
    check("30 bars", (await panel(rooms.cost).locator(".cost-day").count()) === 30, await panel(rooms.cost).locator(".cost-day").count());
    const label = await panel(rooms.cost).locator(".cost-days").getAttribute("aria-label");
    check("the bars say what they show to a screen reader", /^Cost by day for the last 30 days: most on .+, \$20\.00$/.test(label ?? ""), label);
    check("the day with the most is the tallest bar", (await panel(rooms.cost).locator(".cost-bar[style*='height: 100%']").count()) === 1);

    await step("switch to 7 days", async () => {
      await panel(rooms.cost).getByRole("combobox", { name: "Cost range" }).selectOption("7");
      await panel(rooms.cost).locator(".cost-day").nth(7).waitFor({ state: "detached" });
      await snap("panel-7-days", panel(rooms.cost));
    });
    const week = await panel(rooms.cost).innerText();
    check("7 bars", (await panel(rooms.cost).locator(".cost-day").count()) === 7, await panel(rooms.cost).locator(".cost-day").count());
    check("the 7 day total leaves out the agenda tidy of 10 days ago", week.includes("$24.60 · 5 calls") && !week.includes("Agenda tidy"), week.split("\n").slice(0, 4));

    await step("the empty state on the second space", async () => {
      await panel(rooms.quiet).getByText("Nothing in this range yet.").waitFor();
      await snap("panel-empty", panel(rooms.quiet));
    });
    check("the empty space has no groups and no bars", (await panel(rooms.quiet).locator(".cost-group, .cost-day").count()) === 0);

    await step("the whole page, in dark, and on a phone", async () => {
      await snap("manage-page");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await panel(rooms.cost).locator(".cost-total").waitFor();
      await snap("panel-30-days-dark", panel(rooms.cost));
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await panel(rooms.cost).locator(".cost-total").waitFor();
      await snap("panel-30-days-phone", panel(rooms.cost));
    });
    const box = await panel(rooms.cost).locator(".cost-days").boundingBox();
    const last = await panel(rooms.cost).locator(".cost-day").last().boundingBox();
    check("on a phone the 30 bars fit in the row", !!box && !!last && last.x + last.width <= box.x + box.width + 0.5, [box?.width, last && last.x + last.width - (box?.x ?? 0)]);

    await step("Bo's Manage spaces has his own space's panel and not Vera's", async () => {
      await bo.goto(`${base}/spaces/manage`);
      await panel(rooms.other, bo).locator(".cost-total").waitFor();
      check("no panel for the space Bo doesn't manage", (await panel(rooms.cost, bo).count()) === 0);
      check("Bo's own space shows its row", (await panel(rooms.other, bo).innerText()).includes("$4.00 · 1 call"));
    });
  } catch {
    // step() recorded it
  } finally {
    summary.consoleErrors = consoleErrors.slice(0, 20);
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"} · evidence in ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
