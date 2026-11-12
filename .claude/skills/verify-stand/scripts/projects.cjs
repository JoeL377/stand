#!/usr/bin/env node
// Projects (shared/projects.ts), the way a person uses them: make one on the Tasks tab, make one from an
// agenda line in a call, run the scripted demo on that line, then read the Tasks tab, where the call's
// to-dos sit in that project grouped by who has them. Then move one with the picker, filter by
// project, and read the same through the MCP. Last, Stand's suggestion: a to-do that names a project
// gets the dashed "<name>?" pill after the pass, Confirm makes it a normal pill, and a part set in the
// task drawer shows under "Part of" and "Parts".
//
//   NODE_PATH="$(npm root -g)" node projects.cjs <run dir> [--headed]

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir, ...flags] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `projects-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { journey: "projects", base, steps: [], checks: [], ok: true };
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

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_BROWSER ?? "chrome", headless: !flags.includes("--headed"), args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  let roomId;
  let namedId;
  try {
    await step("sign in and make a space", async () => {
      await page.goto(base);
      await page.getByPlaceholder("Your name").fill("Vera Verify");
      await page.getByPlaceholder("Work email").fill("vera@verify.test");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "New space" }).first().click();
      await page.getByPlaceholder("e.g. Checkout v2").fill(`Projects ${stamp.slice(11)}`);
      await page.getByRole("button", { name: "Create and enter" }).click();
      await page.waitForURL(/\/s\/[a-z0-9]+$/);
      roomId = page.url().split("/s/")[1];
    });

    await step("make a project with + Project on the Tasks tab", async () => {
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.getByRole("button", { name: "+ Project" }).click();
      await page.getByLabel("Project name").fill("Onboarding");
      await page.getByLabel("Goal").fill("New teams get going in one call");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("region", { name: "Onboarding" }).waitFor();
      await snap("tasks-new-project");
    });
    const made = (await api(`/api/rooms/${roomId}/projects`)).map((p) => p.name);
    check("the server keeps the project", made.includes("Onboarding"), made);

    let item;
    await step("start talking, play the demo, and make a project from its last agenda line", async () => {
      await page.getByRole("button", { name: "Start talking" }).click();
      await page.getByRole("button", { name: "Leave", exact: true }).waitFor();
      const show = page.getByRole("button", { name: "Show the agenda" });
      if (await show.count()) await show.click();
      await page.getByRole("button", { name: "Play demo" }).click();
      // The demo adds its agenda; the last line is DEMO-104.
      const row = page.locator("li.item", { hasText: "DEMO-104" });
      await row.waitFor({ timeout: 60_000 });
      item = (await row.innerText()).split("\n")[0];
      await row.hover();
      await row.getByRole("button", { name: /^Project for / }).click();
      await snap("agenda-project-menu");
      await page.getByRole("menuitem", { name: "Make project" }).click();
      await row.locator(".item-project").waitFor();
      await snap("agenda-linked");
    });
    const linked = (await api(`/api/rooms/${roomId}/projects`)).find((p) => p.name !== "Onboarding");
    check("Make project made a project named for the line and linked it", !!linked, linked?.name);

    await step("the demo runs on that line and its notes land", async () => {
      await page.getByText(/DEMO-104 · \d+ remarks? · \d+ to-dos?/).waitFor({ timeout: 210_000 });
      await snap("meeting-notes");
    });

    await step("end the meeting and open the Tasks tab", async () => {
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page.getByRole("menuitem", { name: "End for everyone" }).click({ timeout: 1500 }).catch(() => {});
      await page.locator("footer.controls").waitFor({ state: "detached", timeout: 180_000 });
      const deadline = Date.now() + 180_000;
      for (;;) {
        await page.goto(`${base}/s/${roomId}`);
        await page.getByRole("tab", { name: /^Tasks/ }).click();
        await page.locator(".sh-panel").waitFor(); await page.waitForTimeout(1500);
        if (await page.getByRole("region", { name: linked.name }).locator(".followups li").count()) break;
        if (Date.now() > deadline) throw new Error("no tasks in the project after 3 minutes");
        await page.waitForTimeout(5_000);
      }
      await snap("tasks-by-project");
    });
    const section = page.getByRole("region", { name: linked.name });
    const sectionText = await section.innerText();
    fs.writeFileSync(path.join(out, "tasks-tab.txt"), await page.locator("body").innerText());
    const room = await api(`/api/rooms/${roomId}`);
    const onItem = room.followUps.filter((f) => room.items.some((i) => i.id === f.itemId && i.title === item.replace(/^DEMO-104\s*/, "")) || f.project === linked.id);
    check("the call's to-dos on the linked line are in its project", onItem.length > 0 && onItem.every((f) => f.project === linked.id), onItem.map((f) => [f.text, f.project]));
    check("the project's section groups them by who has them", /· \d+/.test(sectionText) && (sectionText.match(/\n(You|No owner|[A-Z][a-z]+) · \d+/g) ?? []).length >= 1, sectionText.slice(0, 400));
    check("Onboarding stays with nothing open in it", /Nothing open in this project/.test(await page.getByRole("region", { name: "Onboarding" }).innerText()));

    await step("move a to-do to Onboarding with the picker", async () => {
      const first = section.locator(".followups li").first();
      await first.getByRole("button", { name: /^Change project/ }).click();
      await snap("picker-open");
      await page.getByRole("dialog", { name: "Change project" }).getByRole("option", { name: "Onboarding" }).click();
      await page.getByRole("region", { name: "Onboarding" }).locator(".followups li").first().waitFor();
      await snap("tasks-moved");
    });

    await step("filter the tab to one project", async () => {
      const onboarding = (await api(`/api/rooms/${roomId}/projects`)).find((p) => p.name === "Onboarding");
      await page.getByLabel("Filter by project").selectOption(onboarding.id);
      await page.waitForURL(/project=/);
      await snap("tasks-filtered");
      const text = await page.locator(".sh-panel").innerText();
      check("only Onboarding shows", text.includes("Onboarding") && !text.includes(linked.name), text.slice(0, 200));
    });

    await step("an agent reads projects and files a to-do in one over MCP", async () => {
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
      const tools = (await call(2, "tools/list", {})).result.tools.map((t) => t.name);
      check("MCP offers create_project", tools.includes("create_project"));
      const spaces = await tool(3, "list_spaces", {});
      const mine = spaces.find((s) => s.id === roomId);
      fs.writeFileSync(path.join(out, "mcp-list_spaces.json"), JSON.stringify(mine, null, 2));
      check("list_spaces lists the projects", (mine.projects ?? []).map((p) => p.name).includes("Onboarding"), mine.projects);
      const made = await tool(4, "create_project", { space: roomId, name: "Agent work", goal: "Made by an agent", model: "claude-opus-5-5" });
      const added = await tool(5, "create_action", { space: roomId, text: "Write the onboarding guide", project: made.created.ref, owner: "unassigned" });
      check("create_action files the to-do in the agent's project", added.created.project?.name === "Agent work", added.created.project);
      const listed = await tool(6, "list_actions", { space: roomId, project: "Agent work" });
      fs.writeFileSync(path.join(out, "mcp-list_actions.json"), JSON.stringify(listed, null, 2));
      check("list_actions filters by project", listed.count === 1 && listed.actions[0].text === "Write the onboarding guide", listed.count);
      const read = await tool(7, "get", { ref: (mine.projects.find((p) => p.name === linked.name) ?? {}).ref });
      fs.writeFileSync(path.join(out, "mcp-get-project.json"), JSON.stringify(read, null, 2));
      check("get reads a project with its agenda line and what is open in it", read.kind === "project" && read.agenda_items.length === 1 && read.open_questions.length > 0, read.counts);
      const onboarding = await tool(8, "get", { ref: mine.projects.find((p) => p.name === "Onboarding").ref });
      check("get lists the to-do the picker moved in", onboarding.open_todos.length === 1 && onboarding.counts.open_todos === 1, onboarding.counts);
      // No project given, and its words name one: what Stand's pass should file.
      namedId = (await tool(9, "create_action", { space: roomId, text: "Record the onboarding video", owner: "unassigned" })).created.ref.split("/").pop();
      await page.goto(`${base}/s/${roomId}`);
      await page.getByRole("tab", { name: /^Tasks/ }).click();
      await page.getByRole("region", { name: "Agent work" }).waitFor();
      await snap("tasks-agent-project");
    });

    const pill = () => page.getByRole("region", { name: "Onboarding" }).locator(".followups li", { hasText: "Record the onboarding video" }).locator(".project-pill");
    await step("Stand suggests Onboarding for a to-do that names it", async () => {
      // A new project has the pass run a minute later; the local instance's heuristic agent files a
      // to-do whose words name exactly one project.
      await page.request.post(`${base}/api/rooms/${roomId}/projects`, { data: { name: "Pricing" } });
      const deadline = Date.now() + 150_000;
      for (;;) {
        await page.goto(`${base}/s/${roomId}`);
        await page.getByRole("tab", { name: /^Tasks/ }).click();
        await page.locator(".sh-panel").waitFor(); await page.waitForTimeout(1000);
        if (await pill().count()) break;
        if (Date.now() > deadline) throw new Error("no suggestion after 150 s");
        await page.waitForTimeout(10_000);
      }
      await snap("tasks-suggested");
    });
    check("the suggested pill reads Onboarding? with a dashed outline", (await pill().innerText()) === "Onboarding?" && (await pill().getAttribute("class")).includes("suggested"), await pill().innerText());
    const shown = (await api(`/api/rooms/${roomId}`)).followUps.find((f) => f.id === namedId);
    check("the server says it is only a suggestion", shown?.projectSuggested === true && shown?.projectSetBy == null, shown && [shown.project, shown.projectSuggested]);

    await step("Confirm makes it a normal pill", async () => {
      await pill().click();
      const pop = page.getByRole("dialog", { name: "Change project" });
      await pop.getByText("Stand suggests Onboarding").waitFor();
      await snap("picker-suggestion");
      await pop.getByRole("button", { name: "Confirm" }).click();
      await page.waitForFunction(() => !document.querySelector(".project-pill.suggested"));
      await snap("tasks-confirmed");
    });
    check("the pill reads Onboarding, set by hand", (await pill().innerText()) === "Onboarding" && !(await pill().getAttribute("class")).includes("suggested"), await pill().innerText());

    await step("make it a part of another to-do in the task drawer", async () => {
      await page.goto(`${base}/s/${roomId}?task=${namedId}`);
      const drawer = page.getByRole("complementary", { name: "Task" });
      await drawer.getByRole("button", { name: "Make it a part of a to-do" }).click();
      await page.getByRole("dialog", { name: "Part of" }).getByRole("option", { name: "Write the onboarding guide" }).click();
      await drawer.locator(".td-links", { hasText: "Write the onboarding guide" }).waitFor();
      await snap("drawer-part-of");
      await drawer.locator(".td-links button", { hasText: "Write the onboarding guide" }).click();
      await drawer.getByRole("heading", { name: /^Parts/ }).waitFor();
      check("the parent lists it under Parts", (await drawer.innerText()).includes("Record the onboarding video"));
      await snap("drawer-parts");
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
