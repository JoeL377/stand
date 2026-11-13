#!/usr/bin/env node
// Giving a to-do to someone by hand: an agent adds a to-do with no owner, then on the Tasks tab a person
// clicks its face, picks themselves, gives it to a typed name from the task drawer, and sets it back
// to Unassigned. Each change is read back from the server and over the MCP.
//
//   NODE_PATH="$(npm root -g)" node task-owner.cjs <run dir> [--headed]

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir, ...flags] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `task-owner-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { journey: "task-owner", base, steps: [], checks: [], ok: true };
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

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_BROWSER ?? "chrome", headless: !flags.includes("--headed") });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  let roomId;
  let tool;
  let ref;
  const owner = async () => (await tool(Date.now() % 100000, "get", { ref }))?.owner ?? null;
  const row = () => page.locator(".followups li", { hasText: "Write the launch post" });
  try {
    await step("sign in and make a space", async () => {
      await page.goto(base);
      await page.getByPlaceholder("Your name").fill("Vera Verify");
      await page.getByPlaceholder("Work email").fill("vera@verify.test");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "New space" }).first().click();
      await page.getByPlaceholder("e.g. Checkout v2").fill(`Owners ${stamp.slice(11)}`);
      await page.getByRole("button", { name: "Create and enter" }).click();
      await page.waitForURL(/\/s\/[a-z0-9]+$/);
      roomId = page.url().split("/s/")[1];
    });

    await step("an agent adds a to-do with no owner", async () => {
      const { token } = await page.request.post(`${base}/api/tokens`, { data: { label: "verify", scope: "write" } }).then((r) => r.json());
      const call = async (id, method, params) => {
        const r = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        const text = await r.text();
        return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\ndata: ").pop());
      };
      tool = async (id, name, args) => JSON.parse((await call(id, "tools/call", { name, arguments: args })).result.content[0].text);
      await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
      ref = (await tool(2, "create_action", { space: roomId, text: "Write the launch post", owner: "unassigned" })).created.ref;
      fs.writeFileSync(path.join(out, "mcp-get-before.json"), JSON.stringify(await tool(3, "get", { ref }), null, 2));
      await page.reload();
      await page.getByRole("tab", { name: /^Projects/ }).click();
      await row().waitFor();
      await snap("unassigned");
    });
    check("the to-do starts unassigned", (await owner()) === null);

    await step("click its face and pick yourself", async () => {
      await row().getByRole("button", { name: "Change owner: Unassigned" }).click();
      await page.getByRole("dialog", { name: "Change owner" }).waitFor();
      await snap("picker-open");
      await page.getByRole("option", { name: "Vera Verify (you)" }).click();
      await row().getByRole("button", { name: "Change owner: Vera Verify" }).waitFor();
      await snap("given-to-me");
    });
    check("the face click did not open the task drawer", (await page.locator(".task-drawer").count()) === 0);
    check("the server keeps the new owner", (await owner()) === "Vera Verify", await owner());
    check("the to-do moved under You", (await page.locator(".sh-task-group, .sh-group", { hasText: "You" }).count()) > 0);

    await step("in the drawer, give it to a typed name", async () => {
      await row().getByText("Write the launch post").click();
      const drawer = page.locator(".task-drawer");
      await drawer.getByRole("button", { name: "Change owner: Vera Verify" }).click();
      await drawer.getByPlaceholder("Find a person or type a name").fill("Sam Lee");
      await snap("drawer-typed-name");
      await drawer.getByRole("button", { name: "Give it to “Sam Lee”" }).click();
      await drawer.getByRole("button", { name: "Change owner: Sam Lee" }).waitFor();
      await row().getByRole("button", { name: "Change owner: Sam Lee" }).waitFor();
      await snap("drawer-given-to-sam");
    });
    check("the server keeps the typed name", (await owner()) === "Sam Lee", await owner());

    await step("set it back to Unassigned", async () => {
      const drawer = page.locator(".task-drawer");
      await drawer.getByRole("button", { name: "Change owner: Sam Lee" }).click();
      await drawer.getByRole("dialog", { name: "Change owner" }).getByRole("button", { name: "Unassigned" }).click();
      await drawer.getByRole("button", { name: "Change owner: Unassigned" }).waitFor();
      await snap("back-to-unassigned");
    });
    check("the server has no owner again", (await owner()) === null, await owner());
    fs.writeFileSync(path.join(out, "mcp-get-after.json"), JSON.stringify(await tool(9, "get", { ref }), null, 2));
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
