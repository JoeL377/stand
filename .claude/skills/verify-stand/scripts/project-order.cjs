#!/usr/bin/env node
// The order of a space's projects, the way a person and an agent change it: make three projects on the
// Tasks tab, drag one by its handle to the top, move it down from its menu, reload to see the order
// kept, then set the order over the MCP and see the Tasks tab follow.
//
//   NODE_PATH="$(npm root -g)" node project-order.cjs <run dir> [--headed]

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir, ...flags] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `project-order-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { journey: "project-order", base, steps: [], checks: [], ok: true };
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
const api = (p) => page.request.get(`${base}${p}`).then((r) => r.json());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_BROWSER ?? "chrome", headless: !flags.includes("--headed") });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  let roomId;
  const onScreen = () => page.locator("section.sh-project:not(.unassigned)").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const onServer = async () => (await api(`/api/rooms/${roomId}/projects`)).map((p) => p.name);
  const settled = async (want) => {
    await page.waitForFunction(
      (w) => JSON.stringify([...document.querySelectorAll("section.sh-project:not(.unassigned)")].map((e) => e.getAttribute("aria-label"))) === JSON.stringify(w),
      want,
      { timeout: 5000 },
    ).catch(() => {});
    await page.waitForTimeout(400);
  };
  try {
    await step("sign in and make a space", async () => {
      await page.goto(base);
      await page.getByPlaceholder("Your name").fill("Vera Verify");
      await page.getByPlaceholder("Work email").fill("vera@verify.test");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "New space" }).first().click();
      await page.getByPlaceholder("e.g. Checkout v2").fill(`Order ${stamp.slice(11)}`);
      await page.getByRole("button", { name: "Create and enter" }).click();
      await page.waitForURL(/\/s\/[a-z0-9]+$/);
      roomId = page.url().split("/s/")[1];
    });

    await step("make three projects with + Project", async () => {
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      for (const [name, goal] of [["Alpha", "First made"], ["Beta", "Second made"], ["Gamma", "Third made"]]) {
        await page.getByRole("button", { name: "+ Project" }).click();
        await page.getByLabel("Project name").fill(name);
        await page.getByLabel("Goal").fill(goal);
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.getByRole("region", { name }).waitFor();
      }
      await snap("three-projects");
    });
    check("new projects go last, in the order made", same(await onScreen(), ["Alpha", "Beta", "Gamma"]), await onScreen());
    check("each project head has a drag handle", (await page.locator(".sh-project-grip").count()) === 3);

    await step("drag Gamma by its handle to the top", async () => {
      const grip = page.getByRole("region", { name: "Gamma" }).locator(".sh-project-grip");
      await page.getByRole("region", { name: "Gamma" }).locator(".sh-project-head").hover();
      await snap("grip-on-hover");
      await grip.dragTo(page.getByRole("region", { name: "Alpha" }), { targetPosition: { x: 40, y: 4 } });
      await settled(["Gamma", "Alpha", "Beta"]);
      await snap("after-drag");
    });
    check("the screen shows the dragged order", same(await onScreen(), ["Gamma", "Alpha", "Beta"]), await onScreen());
    check("the server keeps the dragged order", same(await onServer(), ["Gamma", "Alpha", "Beta"]), await onServer());

    await step("Move down from Gamma's menu", async () => {
      await page.getByRole("button", { name: "Gamma: more" }).click();
      await snap("menu-move-items");
      const up = page.getByRole("menuitem", { name: "Move up" });
      check("Move up is off for the first project", await up.isDisabled());
      await page.getByRole("menuitem", { name: "Move down" }).click();
      await settled(["Alpha", "Gamma", "Beta"]);
    });
    check("the server keeps the menu's move", same(await onServer(), ["Alpha", "Gamma", "Beta"]), await onServer());

    await step("reload: the order stays", async () => {
      await page.reload();
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.getByRole("region", { name: "Beta" }).waitFor();
      await snap("after-reload");
    });
    check("after a reload the screen shows the kept order", same(await onScreen(), ["Alpha", "Gamma", "Beta"]), await onScreen());

    await step("drag Alpha to the bottom", async () => {
      const grip = page.getByRole("region", { name: "Alpha" }).locator(".sh-project-grip");
      const beta = page.getByRole("region", { name: "Beta" });
      const box = await beta.boundingBox();
      await grip.dragTo(beta, { targetPosition: { x: 40, y: box.height - 4 } });
      await settled(["Gamma", "Beta", "Alpha"]);
    });
    check("a drag onto the lower half puts it after", same(await onServer(), ["Gamma", "Beta", "Alpha"]), await onServer());

    await step("an agent sets the order over MCP", async () => {
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
      const tool = async (id, name, args) => JSON.parse((await call(id, "tools/call", { name, arguments: args })).result.content[0].text);
      await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
      const tools = (await call(2, "tools/list", {})).result.tools;
      check("MCP offers order_projects", tools.some((t) => t.name === "order_projects"));
      const ordered = await tool(3, "order_projects", { space: roomId, projects: ["alpha"], model: "claude-opus-5-5" });
      fs.writeFileSync(path.join(out, "mcp-order_projects.json"), JSON.stringify(ordered, null, 2));
      check("order_projects puts the named one first, the rest keep their order", same(ordered.ordered.map((p) => p.name), ["Alpha", "Gamma", "Beta"]), ordered.ordered);
      const spaces = await tool(4, "list_spaces", {});
      const mine = spaces.find((s) => s.id === roomId);
      fs.writeFileSync(path.join(out, "mcp-list_spaces.json"), JSON.stringify(mine, null, 2));
      check("list_spaces lists projects in the order", same((mine.projects ?? []).map((p) => p.name), ["Alpha", "Gamma", "Beta"]), mine.projects);
      const bad = await call(5, "tools/call", { name: "order_projects", arguments: { space: roomId, projects: ["Nope"] } });
      check("an unknown name is refused with the space's projects", bad.result.isError && /Nope.*Alpha/.test(bad.result.content[0].text), bad.result.content[0].text);
      await settled(["Alpha", "Gamma", "Beta"]);
      await page.reload();
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.getByRole("region", { name: "Beta" }).waitFor();
      await snap("after-mcp-order");
    });
    check("the Tasks tab shows the agent's order", same(await onScreen(), ["Alpha", "Gamma", "Beta"]), await onScreen());

    await step("with a project filter on, there is no handle", async () => {
      const id = (await api(`/api/rooms/${roomId}/projects`)).find((p) => p.name === "Gamma").id;
      await page.goto(`${base}/s/${roomId}?project=${id}`);
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.getByRole("region", { name: "Gamma" }).waitFor();
    });
    check("a filtered list has no drag handle", (await page.locator(".sh-project-grip").count()) === 0);
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
