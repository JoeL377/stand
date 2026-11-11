#!/usr/bin/env node
// Drives a design review from end to end on a Stand instance started by launch.sh, with two people:
// the host, and a spec's author who is not the host. The author's agent attaches a plan and asks for
// its review over the MCP; the review starts from its page; they walk the slides, call the questions
// and the verdict, and end the meeting. Then it reads what the review wrote back.
//
//   NODE_PATH="$(npm root -g)" node design-review.cjs <run dir>
//
// STAND_VERIFY_CHANNEL=chrome uses the installed Chrome when Playwright's own Chromium won't start.
// Exit code 0 = every check passed; 1 = a check failed (see summary.json in the evidence folder).

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `design-review-${stamp}`);
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

const TASK = "Write the rollout plan for capture";
const PLAN = [
  "# Rollout of server capture",
  "",
  "Browser capture drops words when a tab sleeps.",
  "",
  "## Why",
  "",
  "People lose what was said while the tab slept.",
  "",
  "## Steps",
  "",
  "- Run capture on the server for ten percent of meetings",
  "- Keep the browser fallback for a week",
  "- Remove the flag",
  "",
  "## Risks",
  "",
  "| Risk | Answer |",
  "|---|---|",
  "| Cost | Watch the bill daily |",
].join("\n");

// A spec of twelve sections, some long and some short: more than the eight section slides a spec gets.
const BIG_TASK = "Design the billing export";
const BIG_SIZES = [10, 500, 20, 30, 400, 15, 600, 25, 35, 700, 12, 18];
const BIG_PLAN = ["# Billing export", "", "One CSV a month.", "", ...BIG_SIZES.flatMap((n, i) => [`## Part ${i + 1}`, "", `Body ${i + 1}: ${"x".repeat(n)}`, ""])].join("\n");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.STAND_VERIFY_CHANNEL || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const errors = [];
  const person = async (name, email) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
    page.on("dialog", (d) => d.accept());
    await page.goto(base);
    await page.getByPlaceholder("Your name").fill(name);
    await page.getByPlaceholder("Work email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForLoadState("networkidle");
    return page;
  };
  try {
    let vera, rae, spaceUrl, space;
    await step("the host signs in and makes a space, and the author joins it", async () => {
      rae = lastPage = await person("Rae Reviewer", "rae@verify.test");
      await rae.getByRole("button", { name: "New space" }).first().click();
      await rae.getByPlaceholder("e.g. Checkout v2").fill(`Call ${stamp.slice(11)}`);
      await rae.getByPlaceholder("One line, e.g. Ship one-page checkout by Nov 15").fill("Prove the design review call");
      await rae.getByRole("button", { name: "Create and enter" }).click();
      await rae.waitForURL(/\/s\/[a-z0-9]+$/);
      spaceUrl = rae.url();
      space = spaceUrl.split("/s/")[1];
      vera = lastPage = await person("Vera Verify", "vera@verify.test");
      await vera.goto(spaceUrl);
      await vera.waitForLoadState("networkidle");
    });

    const { token } = await vera.request.post(`${base}/api/tokens`, { data: { label: "verify", scope: "write" } }).then((r) => r.json());
    let rpc = 0;
    const call = async (method, params) => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
      });
      const text = await r.text();
      return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\ndata: ").pop());
    };
    const tool = async (name, args) => {
      const res = await call("tools/call", { name, arguments: args });
      const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error);
      fs.writeFileSync(path.join(out, `mcp-${rpc}-${name}.json`), text);
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { text, json, isError: !!res.result?.isError || !!res.error };
    };
    let taskId = "";
    await step("the author's agent attaches a plan and asks for its review with a question", async () => {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
      const made = await tool("create_action", { space, text: TASK, owner: "me" });
      const ref = (made.text.match(/stand:action\/[a-z0-9]+/) ?? [""])[0];
      taskId = ref.split("/")[1];
      await tool("attach_plan", { ref, plan: PLAN });
      const asked = await tool("request_design_review", { ref, questions: [{ quote: "fallback for a week", question: "Is a week enough for the mobile clients?" }] });
      if (asked.isError) throw new Error(asked.text.slice(0, 200));
      const edit = await vera.request.patch(`${base}/api/tasks/${taskId}/design-review`, { data: { section: "Why", lines: ["A sleeping tab drops words", "The server never sleeps"] } });
      if (!edit.ok()) throw new Error(`prepare: ${edit.status()}`);
    });

    await step("a spec of twelve sections is on eight section slides, and its author regroups them", async () => {
      lastPage = vera;
      const made = await tool("create_action", { space, text: BIG_TASK, owner: "me" });
      const ref = (made.text.match(/stand:action\/[a-z0-9]+/) ?? [""])[0];
      await tool("attach_plan", { ref, plan: BIG_PLAN });
      const asked = await tool("request_design_review", { ref, questions: [{ quote: "Body 4:", question: "Is part four right?" }] });
      if (asked.isError) throw new Error(asked.text.slice(0, 200));
      await vera.goto(`${base}/s/${space}/design-review?spec=${ref.split("/")[1]}`);
      await vera.getByRole("heading", { name: BIG_TASK }).waitFor();
      await vera.getByText("Stand put the 12 sections on 8 slides").waitFor();
      await snap("twelve-sections-on-eight-slides", vera);
    });
    const slideCards = () => vera.locator(".dr-slides > .dr-slide:not(.off)").count();
    check("the review page shows ten slides: the Overview, eight section slides and the Verdict", (await slideCards()) === 10 && (await vera.locator(".rp-title").innerText()).includes("10 slides"), await vera.locator(".rp-title").innerText());
    const shared = vera.locator(".dr-slide", { has: vera.getByRole("heading", { name: "Part 3", exact: true }) });
    check("short sections that follow each other share a slide, with the question under its section",
      (await shared.getByRole("heading", { name: "Part 4", exact: true }).count()) === 1 && (await shared.locator(".dr-part", { hasText: "Part 4" }).locator(".dr-point").innerText()).includes("Is part four right?"));
    await step("the author gives a section its own slide, then lets Stand group them again", async () => {
      await vera.getByRole("region", { name: "Part 4", exact: true }).getByRole("button", { name: "Give it its own slide" }).click();
      await vera.getByText("You chose which sections share a slide.").waitFor();
      if ((await slideCards()) !== 11) throw new Error(`expected 11 slides, saw ${await slideCards()}`);
      await vera.getByRole("button", { name: "Let Stand group them" }).click();
      await vera.getByText("Stand put the 12 sections on 8 slides").waitFor();
      await vera.getByRole("button", { name: "Take off the review" }).click();
      await vera.getByRole("heading", { name: TASK }).waitFor();
    });

    await step("the host starts the meeting; the host is not the author", async () => {
      lastPage = rae;
      await rae.goto(spaceUrl);
      await rae.getByRole("button", { name: "Start talking" }).click();
      await rae.getByRole("button", { name: "End meeting" }).waitFor();
    });

    await step("the author starts the design review from its page and lands in the call", async () => {
      lastPage = vera;
      await vera.goto(`${base}/s/${space}/design-review`);
      await vera.getByRole("button", { name: "Start design review" }).click();
      await vera.locator(".design-stage").waitFor({ timeout: 30_000 });
      await snap("author-overview", vera);
    });
    const stageText = async (p) => (await p.locator(".design-stage").innerText()).replace(/\s+/g, " ");
    const veraOverview = await stageText(vera);
    check("the call opens on the Overview: the spec's title and its slides", veraOverview.includes(TASK) && /Slides.*Why.*Steps.*Risks/.test(veraOverview) && veraOverview.includes("1 question"), veraOverview.slice(0, 200));
    check("the deck has five slides: a question is not a slide", veraOverview.includes("Slide 1 of 5"), veraOverview.match(/Slide \d+ of \d+/)?.[0]);
    await rae.locator(".design-stage").waitFor({ timeout: 15_000 });
    check("the host's screen went to the review too", (await stageText(rae)).includes(TASK));

    await step("the author, who is not the host, moves to the next slide for everyone", async () => {
      await vera.getByRole("button", { name: "Next slide" }).click();
      await vera.locator(".design-stage h1", { hasText: "Why" }).waitFor();
      await rae.locator(".design-stage h1", { hasText: "Why" }).waitFor();
      await snap("section-why-host", rae);
    });
    check("the section slide shows the author's lines", (await stageText(rae)).includes("The server never sleeps"));

    await step("the host goes on to the Steps slide, which lists its question", async () => {
      lastPage = rae;
      await rae.getByRole("button", { name: "Next slide" }).click();
      await rae.locator(".design-stage h1", { hasText: "Steps" }).waitFor();
      await rae.locator(".ds-q", { hasText: "Is a week enough for the mobile clients?" }).waitFor();
      await snap("section-with-question", rae);
    });
    check("the question is closed on the slide of its section", (await rae.locator(".ds-q.open").count()) === 0 && (await stageText(rae)).includes("Slide 3 of 5"), (await stageText(rae)).match(/Slide [^←→]*/)?.[0]);
    await step("the author opens the question for everyone, and the slide stays up", async () => {
      lastPage = vera;
      await vera.locator("button.ds-q", { hasText: "Is a week enough for the mobile clients?" }).click();
      await vera.locator(".ds-q.open .ds-question").waitFor();
      await rae.locator(".ds-q.open .ds-question").waitFor();
      await snap("question-open-author", vera);
    });
    const point = await stageText(vera);
    check("the open question shows its passage, on the slide of its section", point.includes("Keep the browser fallback for a week") && point.includes("Is a week enough for the mobile clients?") && (await vera.locator(".design-stage h1", { hasText: "Steps" }).count()) === 1, point.slice(0, 220));
    check("the bar says which slide and which question", point.includes("Slide 3 of 5 · Question 1 of 1"), point.match(/Slide [^←→]*/)?.[0]);

    await step("someone says something while the question is up", async () => {
      const open = rae.getByRole("button", { name: "Show chat and transcript" });
      if (await open.count()) await open.click();
      const chat = rae.getByRole("tab", { name: /^Chat/ });
      if (await chat.count()) await chat.first().click();
      await rae.getByLabel("Message everyone").fill("Two weeks is safer for the mobile clients");
      await rae.getByLabel("Message everyone").press("Enter");
      await rae.waitForTimeout(1500);
    });

    await step("the host adds a to-do and a decision Stand missed on the question", async () => {
      lastPage = rae;
      const add = rae.locator(".ds-caught .rv-wrap-add");
      await add.getByPlaceholder("Add a to-do").fill("Change the plan to two weeks");
      await add.getByPlaceholder("Add a to-do").press("Enter");
      await add.getByRole("button", { name: "Decided" }).click();
      await add.getByPlaceholder("Add a decision").fill("Keep the fallback for two weeks");
      await add.getByPlaceholder("Add a decision").press("Enter");
      await vera.locator(".ds-caught", { hasText: "Keep the fallback for two weeks" }).waitFor();
      await vera.locator(".ds-caught", { hasText: "Change the plan to two weeks" }).waitFor();
      await snap("point-with-caught", vera);
    });

    await step("the author calls the question Settled", async () => {
      lastPage = vera;
      await vera.getByRole("button", { name: "Settled" }).click();
      await rae.getByRole("button", { name: "Settled", pressed: true }).waitFor();
    });

    await step("the host opens the full spec for everyone, at the question's passage", async () => {
      lastPage = rae;
      await rae.getByRole("button", { name: "Full spec" }).click();
      await rae.getByRole("dialog", { name: "Full spec" }).waitFor();
      await vera.getByRole("dialog", { name: "Full spec" }).waitFor({ timeout: 10_000 });
      await vera.getByRole("dialog", { name: "Full spec" }).getByText("Is a week enough for the mobile clients?").first().waitFor();
      await snap("full-spec-for-all", vera);
    });
    check("the spec opens on the question's thread", (await vera.locator("[data-plan-highlight]").count()) > 0, await vera.locator("[data-plan-highlight]").allInnerTexts());

    await step("a comment made in the call becomes a question on the slide of its section", async () => {
      const review = await rae.request.get(`${base}/api/tasks/${taskId}/plan-review`).then((r) => r.json());
      const q = "| Cost | Watch the bill daily |";
      const tableStart = review.plan.text.indexOf("| Risk | Answer |");
      const made = await rae.request.post(`${base}/api/tasks/${taskId}/plan-review`, {
        data: { action: "create", version: review.plan.id, text: "Who watches the bill?", start: tableStart, end: review.plan.text.indexOf(q) + q.length },
      });
      if (!made.ok()) throw new Error(`comment: ${made.status()} ${await made.text()}`);
      await rae.getByRole("button", { name: "Back to the slide" }).click();
      await rae.getByRole("button", { name: "Next slide" }).click();
      await rae.locator(".design-stage h1", { hasText: "Risks" }).waitFor();
      await rae.locator(".ds-q", { hasText: "Who watches the bill?" }).waitFor();
      await rae.getByRole("button", { name: "Next slide" }).click();
      await rae.locator(".ds-q.open .ds-question", { hasText: "Who watches the bill?" }).waitFor();
      await snap("question-added-in-call", rae);
    });
    check("the new question is a step on the Risks slide, and the deck still has five slides", (await stageText(rae)).includes("Slide 4 of 5 · Question 1 of 1"), (await stageText(rae)).match(/Slide [^←→]*/)?.[0]);

    await step("the team reaches the Verdict and calls it", async () => {
      await rae.getByRole("button", { name: "Still open" }).click();
      await rae.getByRole("button", { name: "Next slide" }).click();
      await rae.locator(".ds-results").waitFor();
      await vera.locator(".ds-results").waitFor();
      await vera.getByRole("button", { name: "Approve with changes" }).click();
      await rae.getByRole("button", { name: "Approve with changes", pressed: true }).waitFor();
      await snap("verdict", rae);
    });
    const verdict = await stageText(rae);
    check("the Verdict lists each question with how it ended", /Is a week enough for the mobile clients\? Settled/.test(verdict) && /Who watches the bill\? Still open/.test(verdict), verdict.slice(0, 260));
    const agenda = (await rae.locator("body").innerText());
    fs.writeFileSync(path.join(out, "host-page.txt"), agenda);

    await step("the host ends the meeting", async () => {
      await rae.getByRole("button", { name: "End meeting" }).click();
      await rae.getByRole("button", { name: "End meeting" }).waitFor({ state: "detached", timeout: 180_000 });
      await rae.waitForLoadState("networkidle");
    });
    const state = await vera.request.get(`${base}/api/tasks/${taskId}/design-review`).then((r) => r.json());
    check("after the meeting the review is over, and the plan knows its verdict", state.queued === false && state.last?.verdict === "changes" && state.last?.changed === false, state);
    const threads = (await vera.request.get(`${base}/api/tasks/${taskId}/plan-review`).then((r) => r.json())).threads;
    const settled = threads.find((t) => t.messages[0].text === "Is a week enough for the mobile clients?");
    const open = threads.find((t) => t.messages[0].text === "Who watches the bill?");
    fs.writeFileSync(path.join(out, "threads-after.json"), JSON.stringify(threads, null, 2));
    check("Settled resolved the thread, with what was decided on its slide", settled?.resolved === true && /Settled in the design review[\s\S]*Decided:\n- Keep the fallback for two weeks\nTo do:\n- Change the plan to two weeks/.test(settled.messages.at(-1).text), settled?.messages.at(-1).text);
    check("Still open left the thread open, with Stand's line on it", open?.resolved === false && /^Still open after the design review/.test(open.messages.at(-1).text), open?.messages.at(-1).text);
    const detail = await vera.request.get(`${base}/api/tasks/${taskId}`).then((r) => r.json());
    fs.writeFileSync(path.join(out, "task-after.json"), JSON.stringify(detail, null, 2));
    const verdictLine = JSON.stringify(detail).match(/Design review, [^"]*/)?.[0];
    check("the to-do's log has the verdict in one line", /Approve with changes\. 1 question settled, 1 open\. 1 to-do came out of it/.test(verdictLine ?? ""), verdictLine);
    check("the spec's to-do waits on the to-do from the review", detail.waitsOn.some((l) => l.text === "Change the plan to two weeks"), detail.waitsOn.map((l) => l.text));
    const review = await tool("get_review", { space });
    const last = review.json?.design_review?.last;
    check("get_review gives agents the verdict and how each question ended", last?.specs?.[0]?.verdict === "Approve with changes" && JSON.stringify(last.specs[0].questions.map((p) => p.outcome)) === JSON.stringify(["Settled", "Still open"]), last?.specs?.[0]);

    await step("the Tasks tab keeps the review that ran, and its page", async () => {
      lastPage = vera;
      await vera.goto(spaceUrl);
      await vera.getByRole("link", { name: /Design review/ }).waitFor();
      await snap("tasks-tab-after", vera);
      await vera.getByRole("link", { name: /Design review/ }).click();
      await vera.waitForURL(/\/design-review\/[a-z0-9]+$/);
      await vera.getByRole("heading", { name: TASK }).waitFor();
      await snap("review-record", vera);
    });
    const record = (await vera.locator(".dr-spec").innerText()).replace(/\s+/g, " ");
    check("the record shows the verdict, each question's result and what was raised", record.includes("Approve with changes") && /Is a week enough for the mobile clients\? Settled/.test(record) && record.includes("Keep the fallback for two weeks") && /Who watches the bill\? Still open/.test(record), record.slice(0, 400));

    await step("the recap links to the review, and the plan viewer shows it was reviewed", async () => {
      await vera.getByRole("link", { name: "Recap" }).click();
      await vera.getByRole("link", { name: /Design review · 1 spec/ }).waitFor();
      await snap("recap", vera);
      await vera.goto(`${spaceUrl}?task=${taskId}&view=plan`);
      await vera.getByRole("link", { name: /Reviewed/ }).waitFor();
      await vera.getByRole("button", { name: "Request review again" }).waitFor();
      await snap("plan-viewer-reviewed", vera);
    });
    check("the plan viewer says how the last review ended", (await vera.getByRole("link", { name: /Reviewed/ }).innerText()).includes("Approve with changes"));
  } catch {
    // recorded by step()
  } finally {
    summary.consoleErrors = errors.slice(0, 20);
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"} · evidence in ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
