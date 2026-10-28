#!/usr/bin/env node
// Drives a Stand instance started by launch.sh the way a person does, in headless
// Chromium, and saves evidence (screenshots, page text, a summary) to <run>/evidence.
//
//   NODE_PATH="$(npm root -g)" node drive.cjs <run dir> <journey> [--headed]
//
// Journeys: signin | space | meeting | mcp   (each one starts from a fresh sign-in;
// meeting and mcp include the space journey, mcp includes the meeting journey).
// Exit code 0 = every check passed; 1 = a check failed (see summary.json).

const fs = require("node:fs");
const path = require("node:path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    'Playwright not found. Run with NODE_PATH="$(npm root -g)", or install it once:\n' +
      "  npm i -g playwright@1.56.1 && npx playwright install chromium",
  );
  process.exit(2);
}

const [runDir, journey = "meeting", ...flags] = process.argv.slice(2);
if (!runDir || !["signin", "space", "meeting", "mcp"].includes(journey)) {
  console.error("usage: drive.cjs <run dir> <signin|space|meeting|mcp> [--headed]");
  process.exit(2);
}
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `${journey}-${stamp}`);
fs.mkdirSync(out, { recursive: true });

const summary = { journey, base, startedAt: new Date().toISOString(), steps: [], checks: [], ok: true };
let page;
let shot = 0;

async function snap(name) {
  const file = path.join(out, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  return path.basename(file);
}
async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    summary.steps.push({ name, ms: Date.now() - t, ...(detail ? { detail } : {}) });
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
  console.log(`${pass ? "✓" : "✗"} check: ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
}

const spaceName = `Verify ${stamp.slice(11)}`;

async function signIn() {
  await step("sign in with the stand-in form", async () => {
    await page.goto(base);
    await page.getByPlaceholder("Your name").fill("Vera Verify");
    await page.getByPlaceholder("Work email").fill("vera@verify.test");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "New space" }).first().waitFor();
    await snap("home");
  });
  const me = await page.request.get(`${base}/api/auth/me`).then((r) => r.json());
  check("signed in as Vera", me.email === "vera@verify.test", me.email);
}

async function newSpace() {
  await step("create a space from the New space pop-up", async () => {
    await page.getByRole("button", { name: "New space" }).first().click();
    await page.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
    await page.getByPlaceholder("One line, e.g. Ship one-page checkout by Nov 15").fill("Prove Stand works");
    await page.getByRole("button", { name: "Create and enter" }).click();
    await page.waitForURL(/\/s\/[a-z0-9]+$/);
    await page.getByRole("tab", { name: /^Meetings/ }).waitFor();
    await snap("space-page");
  });
  summary.spaceUrl = page.url();
  const spaces = await page.request.get(`${base}/api/spaces`).then((r) => r.json());
  const list = Array.isArray(spaces) ? spaces : (spaces.spaces ?? []);
  check("space saved on the server", list.some((s) => s.name === spaceName), list.map((s) => s.name));
}

async function meeting() {
  // End meeting asks with the browser's confirm(); Playwright dismisses dialogs unless told.
  page.on("dialog", (d) => d.accept());
  await step("start talking", async () => {
    await page.getByRole("button", { name: "Start talking" }).click();
    await page.getByRole("button", { name: "End meeting" }).waitFor();
    // The agenda starts folded to its numbered strip; open it to read the rows.
    const show = page.getByRole("button", { name: "Show the agenda" });
    if (await show.count()) await show.click();
    await snap("meeting-start");
  });
  await step("play the scripted 4-person demo", async () => {
    await page.getByRole("button", { name: "Play demo" }).click();
    // The demo walks all four agenda items; the last one is DEMO-104. Notes trail the talk.
    await page.getByText(/DEMO-104 · \d+ remarks?/).waitFor({ timeout: 120_000 });
    await snap("meeting-demo-midway");
  });
  await step("wait for live notes on the last item", async () => {
    await page.getByText(/DEMO-104 · \d+ remarks? · \d+ to-dos?/).waitFor({ timeout: 90_000 });
    await snap("meeting-live-notes");
  });
  const agenda = await page.locator("body").innerText();
  fs.writeFileSync(path.join(out, "meeting-page.txt"), agenda);
  // Only the agenda row in focus shows its counts, so this reads DEMO-104's row.
  const row = (agenda.match(/DEMO-104 · [^\n]+/) ?? [""])[0];
  check("talk is pinned to the item in focus and live notes made to-dos", /remarks?/.test(row) && /to-dos?/.test(row), row);

  await step("end the meeting and wait for the write-up", async () => {
    await page.getByRole("button", { name: "End meeting" }).click();
    await page.getByRole("button", { name: "End meeting" }).waitFor({ state: "detached", timeout: 180_000 });
    await page.waitForLoadState("networkidle");
    await snap("after-end");
  });
  summary.afterEndUrl = page.url();

  // The write-up (Sonnet tidy per item, then the recap) runs after End meeting returns,
  // so the meeting shows up on the space page a little later. Reload until it does.
  await step("meeting shows on the space page under Meetings", async () => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      await page.goto(summary.spaceUrl);
      await page.getByRole("tab", { name: /^Meetings/ }).click();
      await page.waitForLoadState("networkidle");
      if (await page.locator('a[href^="/meetings/"]').count()) break;
      if (Date.now() > deadline) throw new Error("no meeting on the space page after 3 minutes");
      await page.waitForTimeout(5_000);
    }
    await snap("space-after-meeting");
    await page.getByRole("tab", { name: /^Tasks/ }).click();
    await snap("space-tasks-tab");
  });
  const spaceText = await page.locator("body").innerText();
  fs.writeFileSync(path.join(out, "space-after-meeting.txt"), spaceText);
  check("space page lists open tasks", !/Nothing open\./.test(spaceText));

  const recap = page.locator('a[href^="/meetings/"]').first();
  if (await recap.count()) {
    await step("open the meeting recap", async () => {
      await recap.click();
      await page.waitForURL(/\/meetings\//, { timeout: 10_000 });
      await page.waitForLoadState("networkidle");
      await snap("recap");
    });
    const recapText = await page.locator("body").innerText();
    fs.writeFileSync(path.join(out, "recap.txt"), recapText);
    summary.recapUrl = page.url();
    check("recap leads with To do", /to do/i.test(recapText));
  } else {
    check("space page links to the meeting recap", false);
  }
}

async function mcp() {
  // The token is made through the same call the Connect an agent page uses; the rest is
  // exactly what Claude Code does with it.
  const { token } = await page.request
    .post(`${base}/api/tokens`, { data: { label: "verify", scope: "read" } })
    .then((r) => r.json());
  check("agent token made", typeof token === "string" && token.length > 10);
  const call = async (id, method, params) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await r.text();
    const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\ndata: ").pop());
    return json;
  };
  await step("agent lists spaces and work over MCP", async () => {
    await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
    const tools = await call(2, "tools/list", {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    check("MCP lists its tools", names.includes("list_spaces") && names.includes("get_meeting_brief"), names);
    const spaces = await call(3, "tools/call", { name: "list_spaces", arguments: {} });
    const text = JSON.stringify(spaces.result ?? spaces.error);
    fs.writeFileSync(path.join(out, "mcp-list_spaces.json"), JSON.stringify(spaces, null, 2));
    check("list_spaces includes the new space", text.includes(spaceName));
    const work = await call(4, "tools/call", { name: "list_actions", arguments: { space: summary.spaceUrl.split("/s/")[1] } });
    fs.writeFileSync(path.join(out, "mcp-list_actions.json"), JSON.stringify(work, null, 2));
    check("list_actions returns the meeting's to-dos", !work.error && !work.result?.isError && /Jordan|Priya|Sam|Alex/.test(JSON.stringify(work.result)));
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: !flags.includes("--headed"),
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  try {
    await signIn();
    if (journey !== "signin") await newSpace();
    if (journey === "meeting" || journey === "mcp") await meeting();
    if (journey === "mcp") await mcp();
  } catch {
    // step() already recorded it
  } finally {
    summary.consoleErrors = consoleErrors.slice(0, 20);
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"} · evidence in ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
