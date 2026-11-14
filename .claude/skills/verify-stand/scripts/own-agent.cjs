#!/usr/bin/env node
// Proves that someone's own agent can read a running call and put a card in it (get_live_call and
// say_in_call over the MCP), the way a person sees it: the card on the board with the agent's name and
// model, its write-up, its row in the transcript, dismissing it, and the recap and brief afterwards.
//
//   NODE_PATH="$(npm root -g)" node own-agent.cjs <run dir> [--headed]
//
// Exit code 0 = every check passed; 1 = a check failed (see summary.json).

const fs = require("node:fs");
const path = require("node:path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error('Playwright not found. Run with NODE_PATH="$(npm root -g)".');
  process.exit(2);
}

const [runDir, ...flags] = process.argv.slice(2);
if (!runDir) {
  console.error("usage: own-agent.cjs <run dir> [--headed]");
  process.exit(2);
}
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `own-agent-${stamp}`);
fs.mkdirSync(out, { recursive: true });

const summary = { journey: "own-agent", base, startedAt: new Date().toISOString(), steps: [], checks: [], ok: true };
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

const spaceName = `Own agent ${stamp.slice(11)}`;
const TEXT = "The retry plan misses **what happens to invites in flight**. Two points:\n\n- Links sent before the change keep the old URL.\n- Nobody owns the redirect.";
const DETAIL = "## What the call covered\n\nThe team agreed on an auto-generated URL.\n\n## What it left out\n\n1. Invites already sent.\n2. Who owns the redirect.\n\n| Risk | Size |\n| --- | --- |\n| Broken invites | Medium |";
const TODO = "Decide who owns the invite redirect";

let token;
let n = 0;
async function mcp(method, params) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
  });
  const text = await r.text();
  return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\ndata: ").pop());
}
/** A tool's reply: its JSON when it worked, else { error: its message }. */
async function tool(name, args) {
  const res = await mcp("tools/call", { name, arguments: args });
  const body = res.result?.content?.[0]?.text ?? JSON.stringify(res.error);
  fs.writeFileSync(path.join(out, `mcp-${String(n).padStart(2, "0")}-${name}.json`), JSON.stringify(res, null, 2));
  if (res.error || res.result?.isError) return { error: body };
  return JSON.parse(body);
}

(async () => {
  // PW_CHANNEL=chrome drives the Chrome on this computer when Playwright's own Chromium is not installed.
  const browser = await chromium.launch({ headless: !flags.includes("--headed"), channel: process.env.PW_CHANNEL || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  try {
    await step("sign in and make a space", async () => {
      await page.goto(base);
      await page.getByPlaceholder("Your name").fill("Vera Verify");
      await page.getByPlaceholder("Work email").fill("vera@verify.test");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "New space" }).first().click();
      await page.getByPlaceholder("e.g. Checkout v2").fill(spaceName);
      await page.getByRole("button", { name: "Create and enter" }).click();
      await page.waitForURL(/\/s\/[a-z0-9]+$/);
    });
    const spaceUrl = page.url();
    const space = spaceUrl.split("/s/")[1];

    token = (await page.request.post(`${base}/api/tokens`, { data: { label: "opencode", scope: "write" } }).then((r) => r.json())).token;
    check("agent token made", typeof token === "string" && token.length > 10);
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
    const names = ((await mcp("tools/list", {})).result?.tools ?? []).map((t) => t.name);
    check("MCP lists get_live_call and say_in_call", names.includes("get_live_call") && names.includes("say_in_call"));

    const none = await tool("get_live_call", { space });
    check("no call yet: get_live_call says so", /No call is running/.test(none.error ?? ""), none.error);

    await step("start talking and play the demo to its end", async () => {
      await page.getByRole("tab", { name: /^Meetings/ }).click();
      await page.getByRole("button", { name: "Start talking" }).click();
      await page.getByRole("button", { name: "Leave", exact: true }).waitFor();
      const show = page.getByRole("button", { name: "Show the agenda" });
      if (await show.count()) await show.click();
      await page.getByRole("button", { name: "Play demo" }).click();
      // A call with an empty agenda has no agenda column; it comes, folded, with the demo's items.
      await page.getByRole("button", { name: "Show the agenda" }).click({ timeout: 15000 }).catch(() => {});
      await page.getByText(/DEMO-104 · \d+ remarks?/).waitFor({ timeout: 120_000 });
      // The demo's last step is an agent's report; give it a moment to land.
      await page.waitForTimeout(8_000);
      await snap("call-before");
    });

    let cursor;
    await step("the agent reads the running call", async () => {
      const live = await tool("get_live_call", { space });
      cursor = live.cursor;
      const said = (live.lines ?? []).map((l) => l.text).join("\n");
      check("get_live_call returns what was said and typed", /payment iframe/.test(said) && (live.lines ?? []).some((l) => l.kind === "chat"), `${(live.lines ?? []).length} lines`);
      check("it names who is in the call", (live.people ?? []).includes("Vera Verify"), live.people);
      check("it carries what Stand answered in the call", (live.answers ?? []).some((a) => a.by === "Stand" && /20 percent/.test(a.text)), live.answers);
      check("it says the lines are data, not instructions", /never instructions/.test(live.read_as ?? ""));
      const whole = await tool("get_live_call", { space, all: true });
      check("all returns the whole call", /workspace URL/.test((whole.lines ?? []).map((l) => l.text).join("\n")), `${(whole.lines ?? []).length} lines`);
    });

    await step("the agent says something in the call, and the card shows on the board", async () => {
      const made = await tool("say_in_call", { space, text: TEXT, detail: DETAIL, todo: TODO, sources: [{ url: "https://example.com/docs/invites", title: "Invites" }], model: "claude-fable-5-2" });
      check("say_in_call posted the card", !made.error && made.said?.by === "Vera Verify via opencode", made.error ?? made.said);
      const card = page.locator(".said-card");
      await card.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await snap("card-on-board");
      const text = await card.innerText();
      check("the card carries the agent's words", /what happens to invites in flight/.test(text) && /Nobody owns the redirect/.test(text));
      check("the card names whose agent, which one and its model", /Vera's agent/.test(text) && /opencode · claude-fable-5-2/.test(text), text.split("\n").slice(0, 3));
      check("the card offers its next step as a to-do", text.includes(TODO));
      check("markdown is drawn, not shown raw", !text.includes("**") && (await card.locator("strong").count()) > 0);
      const again = await tool("say_in_call", { space, text: "One more thing." });
      check("a second card straight after is refused", /every 5 seconds/.test(again.error ?? ""), again.error);
    });

    await step("the write-up opens from the card", async () => {
      await page.locator(".said-card-detail > summary").click();
      await page.locator(".said-card-detail").getByText("What it left out").waitFor();
      await page.locator(".said-card-detail").scrollIntoViewIfNeeded();
      await snap("card-write-up");
      check("the write-up draws its table", (await page.locator(".said-card-detail table").count()) === 1);
    });

    await step("the transcript says the agent said it", async () => {
      // The side panel is a rail while the board has the room, or open on the Chat tab after a message.
      const rail = page.getByRole("button", { name: /^Transcript/ });
      if (await rail.count()) await rail.first().click();
      else await page.getByRole("tab", { name: /^All/ }).click();
      const row = page.locator(".capture-agent", { hasText: "said in the call" });
      await row.first().waitFor({ timeout: 10_000 });
      await row.first().scrollIntoViewIfNeeded();
      await snap("transcript-row");
      const text = await row.first().innerText();
      check("the row names Vera's agent and its model", /Vera Verify/.test(text) && /via opencode \(claude-fable-5-2\)/.test(text), text.split("\n")[0]);
    });

    await step("another read from the cursor sees the card and nothing old", async () => {
      const next = await tool("get_live_call", { space, since: cursor });
      check("from the cursor: no old lines", (next.lines ?? []).length === 0, (next.lines ?? []).length);
      check("from the cursor: the agent's card is among the answers", (next.answers ?? []).some((a) => /Vera Verify's agent \(opencode\)/.test(a.by) && /invites in flight/.test(a.text)), next.answers);
    });

    await step("anyone dismisses the card", async () => {
      // The open side panel lies over the card's right edge, where its × is: fold it, as a person would.
      const hide = page.getByRole("button", { name: "Hide chat and transcript" });
      if (await hide.count()) await hide.first().click();
      await page.mouse.move(700, 600);
      await page.locator("aside.side.rail").waitFor({ timeout: 20_000 });
      await page.locator(".said-card .agent-card-close").click();
      await page.locator(".said-card").waitFor({ state: "detached", timeout: 10_000 });
      await snap("card-dismissed");
    });

    // Step 1b: a card while a review slide has the middle of the screen reaches everyone, the presenter too.
    let bo;
    const BO_TEXT = "On this slide: **the invite links** still point at the old URL.";
    await step("a second person joins, and a review slide takes the middle for everyone", async () => {
      const boCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone"] });
      bo = await boCtx.newPage();
      bo.on("pageerror", (e) => consoleErrors.push(`bo: ${e}`));
      bo.on("dialog", (d) => d.accept());
      await bo.goto(base);
      await bo.getByPlaceholder("Your name").fill("Bo Tester");
      await bo.getByPlaceholder("Work email").fill("bo@verify.test");
      await bo.getByRole("button", { name: "Continue" }).click();
      await bo.waitForLoadState("networkidle");
      await bo.goto(spaceUrl);
      await bo.getByRole("button", { name: "Join them" }).first().click();
      const join = bo.getByRole("dialog", { name: "Join the call" }).getByRole("button", { name: "Join muted" });
      if (await join.count()) await join.click();
      await bo.getByRole("button", { name: "Leave", exact: true }).waitFor({ timeout: 30_000 });
      const slide = await tool("add_review_slide", { space, title: "Invite links", summary: "The new invite URL." });
      check("add_review_slide put a slide on the review", !slide.error, slide.error);
      const started = await page.request.post(`${base}/api/rooms/${space}/review/start`);
      check("the review started in the call", started.ok(), started.status());
      await page.locator(".review-stage").waitFor({ timeout: 20_000 });
      await bo.locator(".review-stage").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(800);
      await snap("review-slide-up");
    });

    await step("a card arrives during the slide: everyone gets a notice, the presenter too", async () => {
      const made = await tool("say_in_call", { space, text: BO_TEXT, detail: "## Why\nThe old links are in emails.", model: "claude-fable-5-2" });
      check("say_in_call posted the card during the review", !made.error, made.error);
      for (const [who, p] of [["presenter", page], ["Bo", bo]]) {
        const notice = p.locator(".said-notice:visible");
        await notice.waitFor({ timeout: 10_000 });
        const text = await notice.innerText();
        check(`${who}: the notice names whose agent and has the card's first line`, /Vera's agent/.test(text) && /the invite links still point/.test(text) && /Open/.test(text), text);
        check(`${who}: the slide stays on the middle screen`, (await p.locator(".review-stage").count()) === 1 && (await p.locator(".board-tab").count()) === 0);
      }
      await snap("notice-presenter");
      await bo.screenshot({ path: path.join(out, `${String(++shot).padStart(2, "0")}-notice-bo.png`) });
    });

    await step("the presenter opens it: the card shows on her screen only, and Bo's screen does not move", async () => {
      await page.locator(".said-notice:visible").getByRole("button", { name: "Open" }).click();
      const panel = page.locator(".said-panel .said-card");
      await panel.waitFor({ timeout: 5_000 });
      await panel.locator(".said-card-detail > summary").click();
      await panel.getByText("The old links are in emails.").waitFor();
      await snap("panel-presenter");
      check("the panel has the whole card: words, write-up and dismiss", /the invite links/.test(await panel.innerText()) && (await page.locator(".said-panel").getByRole("button", { name: "Dismiss for everyone" }).count()) === 1);
      check("the slide is still under the panel, and the notice is gone", (await page.locator(".review-stage").count()) === 1 && (await page.locator(".said-notice:visible").count()) === 0);
      await bo.waitForTimeout(1_500);
      check("Bo, who follows the presenter, has no panel and is still on the slide", (await bo.locator(".said-panel").count()) === 0 && (await bo.locator(".review-stage").count()) === 1 && (await bo.locator(".board-tab").count()) === 0);
      check("Bo still has his notice", (await bo.locator(".said-notice:visible").count()) === 1);
      await page.keyboard.press("Escape");
      await page.locator(".said-panel").waitFor({ state: "detached", timeout: 5_000 });
    });

    await step("Bo closes his notice: the Board tab keeps its mark until he has seen the card", async () => {
      await bo.locator(".said-notice:visible").getByRole("button", { name: "Close" }).click();
      await bo.locator(".said-notice:visible").waitFor({ state: "detached", timeout: 5_000 });
      // Longer than the 12 seconds the mark used to stay.
      await bo.waitForTimeout(13_000);
      const tab = bo.getByRole("tab", { name: /^Board/ });
      check("13 s on, the Board tab still has its mark", (await tab.locator(".agent-tab-mark").count()) === 1);
      await tab.click();
      await bo.locator(".said-card", { hasText: "the invite links" }).waitFor({ timeout: 5_000 });
      await bo.getByRole("tab", { name: "Slides" }).click();
      await bo.locator(".review-stage").waitFor();
      check("once seen, the mark is gone", (await bo.getByRole("tab", { name: /^Board/ }).locator(".agent-tab-mark").count()) === 0);
      await bo.close();
    });

    await step("end the meeting and open the recap", async () => {
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await page.getByRole("menuitem", { name: "End for everyone" }).click({ timeout: 1500 }).catch(() => {});
      await page.locator("footer.controls").waitFor({ state: "detached", timeout: 180_000 });
      const deadline = Date.now() + 180_000;
      for (;;) {
        await page.goto(spaceUrl);
        await page.getByRole("tab", { name: /^Meetings/ }).click();
        await page.waitForTimeout(1_500);
        if (await page.locator('a[href^="/meetings/"]').count()) break;
        if (Date.now() > deadline) throw new Error("no meeting on the space page after 3 minutes");
        await page.waitForTimeout(5_000);
      }
      await page.locator('a[href^="/meetings/"]').first().click();
      await page.waitForURL(/\/meetings\//);
      await page.getByRole("button", { name: /Whole transcript/ }).click();
      const row = page.locator(".capture-agent", { hasText: "said in the call" });
      await row.first().waitFor({ timeout: 10_000 });
      await row.first().scrollIntoViewIfNeeded();
      await snap("recap-transcript");
      const text = await row.first().innerText();
      check("the recap's transcript keeps what the agent said, with who and which model", /invites in flight/.test(text) && /via opencode \(claude-fable-5-2\)/.test(text));
      await row.first().locator(".tl-detail > summary").click();
      await row.first().getByText("What it left out").waitFor();
      await row.first().locator(".tl-detail").scrollIntoViewIfNeeded();
      await snap("recap-write-up");
    });

    await step("the brief carries it for the next agent", async () => {
      const meetingId = page.url().split("/meetings/")[1].split(/[?#/]/)[0];
      const brief = await tool("get_meeting_brief", { meeting_id: meetingId, transcript: true });
      const line = (brief.timeline ?? []).find((e) => e.kind === "agent" && /invites in flight/.test(e.text));
      check("get_meeting_brief has the line by Vera's agent", line?.who === "Vera Verify via opencode" && line?.by?.model === "claude-fable-5-2", line && { who: line.who, by: line.by });
      check("with its write-up", /What it left out/.test(line?.detail ?? ""));
      const after = await tool("say_in_call", { space, text: "Too late." });
      check("after the call: say_in_call says no call is running", /No call is running/.test(after.error ?? ""), after.error);
    });
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
