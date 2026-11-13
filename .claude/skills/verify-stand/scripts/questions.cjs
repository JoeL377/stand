#!/usr/bin/env node
// Closing open questions: on the Tasks tab a person writes an answer under a question (kept as a
// decision the question points to) and takes it back with Undo, answers one from the task drawer,
// closes a swept list in one step, and an agent lists and drops one over the MCP. Each change is
// read back from the space's feed.
//
// It needs a space that already has open questions and decisions, and nothing in the app adds a
// question by hand, so it runs on the preview's sample data (features/questions.md says how):
//   NODE_PATH="$(npm root -g)" node questions.cjs <run dir> [--headed]
//
// Stand sweeps the questions by itself and keeps what it proposes; the page only shows that. With
// no model here, the sample data carries a kept sweep (scripts/seed-preview.ts), and the close that
// follows is the real one.

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const [runDir, ...flags] = process.argv.slice(2);
const port = fs.readFileSync(path.join(runDir, "port"), "utf8").trim();
const base = `http://localhost:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(runDir, "evidence", `questions-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const summary = { journey: "questions", base, steps: [], checks: [], ok: true };
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

const LINK = "Can a guest order be linked to an account later?";
const CAP = "How long should a retry run before it gives up?";
const ONCALL = "Who is on call for the retry worker this week?";
const WAIT = "Should guest checkout wait for the fraud numbers?";
const APPLE = "Does Apple Pay need its own button on the summary bar?";
const LONG = "Does the one-page layout work with long addresses?";
const SHIP = "Ship guest checkout to everyone on Nov 20";

(async () => {
  const browser = await chromium.launch({ channel: process.env.STAND_BROWSER ?? "chrome", headless: !flags.includes("--headed") });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  let roomId;
  const feed = () => page.request.get(`${base}/api/rooms/${roomId}/feed`).then((r) => r.json());
  const row = (text) => page.locator(".followups li", { hasText: text });
  /** A question's row is on its project's page, under Questions. */
  let projectIds = {};
  const go = async (project, text) => {
    await page.goto(`${base}/s/${roomId}?project=${projectIds[project]}&show=questions`);
    if (text) await row(text).waitFor();
  };
  const openTexts = async () => (await feed()).open.map((n) => n.text);
  /** A toast stays while the pointer is on it, so the journey dismisses them itself. */
  const clearToasts = async () => {
    for (const x of await page.locator(".toast:not(.leaving) .toast-x").all()) await x.click().catch(() => {});
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  };
  try {
    await step("open the sample space's projects", async () => {
      const spaces = await page.request.get(`${base}/api/spaces`).then((r) => r.json());
      roomId = spaces.find((s) => s.name === "Acme Checkout")?.id;
      if (!roomId) throw new Error("No Acme Checkout space: this journey runs on the preview's sample data");
      projectIds = Object.fromEntries((await page.request.get(`${base}/api/rooms/${roomId}/projects`).then((r) => r.json())).map((p) => [p.name, p.id]));
      await go("Guest checkout", LINK);
      await snap("tasks-with-open-questions");
      const open = await openTexts();
      check("the space starts with six open questions", open.length === 6, open);
      check("an open question has an Answer button", (await row(LINK).getByRole("button", { name: "Answer", exact: true }).count()) === 1);
      await page.goto(`${base}/s/${roomId}`);
      await page.getByRole("button", { name: /Sweep questions/ }).waitFor();
      check("the sweep is offered beside the tabs, over the projects", (await page.getByRole("button", { name: /Sweep questions/ }).count()) === 1);
    });

    await step("sweep: untick one proposal, close the rest in one step", async () => {
      await clearToasts();
      const f = await feed();
      check("the feed carries what the last sweep proposes", f.questionSweep?.proposals.length === 3, f.questionSweep?.proposals.map((p) => p.text));
      const asked = [];
      const hear = (r) => /\/questions\//.test(r.url()) && asked.push(`${r.method()} ${new URL(r.url()).pathname}`);
      page.on("request", hear);
      const button = page.getByRole("button", { name: /Sweep questions/ });
      check("the button counts the proposals, not the open questions", /3\s*$/.test(await button.innerText()), await button.innerText());
      await button.click();
      const pop = page.locator(".sweep-pop");
      await pop.locator(".sweep-list li").first().waitFor();
      check("opening the list asks the server for nothing", asked.length === 0, asked);
      check("it says when Stand read the questions", /Stand read the open questions 3h ago/.test(await pop.innerText()));
      await pop.locator(".sweep-list li", { hasText: LONG }).getByRole("checkbox").uncheck();
      await snap("sweep-proposals");
      check("the button counts what is ticked", (await pop.getByRole("button", { name: "Close 2 questions" }).count()) === 1);
      await pop.getByRole("button", { name: "Close 2 questions" }).click();
      await page.locator(".toast", { hasText: "Closed 2 questions" }).waitFor();
      await clearToasts();
      check("one request closed them", asked.length === 1 && /^POST .*\/questions\/close$/.test(asked[0]), asked);
      page.off("request", hear);
      const after = await feed();
      const closed = (text) => after.closedQuestions.find((n) => n.text === text);
      check("the dropped one says why", closed(ONCALL)?.state === "dropped" && closed(ONCALL)?.dropReason === "A check on one week that has passed", closed(ONCALL) && [closed(ONCALL).state, closed(ONCALL).dropReason]);
      check("the answered one points at the decision the space had", closed(WAIT)?.closedBy === "answered" && closed(WAIT)?.answeredBy === SHIP, closed(WAIT) && [closed(WAIT).closedBy, closed(WAIT).answeredBy]);
      check("no new decision was written for it", after.decided.filter((n) => n.text === SHIP).length === 1);
      check("the unticked one stays open", after.open.some((n) => n.text === LONG), after.open.map((n) => n.text));
      check("and Stand doesn't propose it again", after.questionSweep === null, after.questionSweep);
      await button.waitFor({ state: "detached" });
      await go("Payments");
      await page.locator(".sh-done-toggle", { hasText: "Dropped" }).click();
      await page.locator(".sh-done li", { hasText: ONCALL }).locator(".rc-pill", { hasText: "Dropped" }).hover();
      await snap("after-sweep");
    });

    await step("answer a question under its line", async () => {
      await go("Guest checkout", LINK);
      await row(LINK).getByRole("button", { name: "Answer", exact: true }).click();
      const box = row(LINK).getByLabel("The answer");
      await box.waitFor();
      await snap("answer-box-open");
      await box.fill("A guest order joins an account when the shopper signs up with the same email");
      await box.press("Enter");
      await page.locator(".toast", { hasText: "Answered" }).waitFor();
      await snap("answered-toast");
      const f = await feed();
      const closed = f.closedQuestions.find((n) => n.text === LINK);
      check("the question is closed as answered, with its answer", closed?.closedBy === "answered" && /joins an account/.test(closed?.answeredBy ?? ""), closed && [closed.closedBy, closed.answeredBy]);
      const made = f.decided.find((n) => /joins an account/.test(n.text));
      check("the answer is a decision that says what it answers", made?.answers === LINK, made && [made.text, made.answers]);
      check("it left the open list", !f.open.some((n) => n.text === LINK));
    });

    await step("the answer shows under Answered and among the project's decisions", async () => {
      await clearToasts();
      await go("Guest checkout");
      await page.locator(".sh-done-toggle", { hasText: "Answered" }).click();
      const done = page.locator(".sh-done li", { hasText: LINK });
      await done.waitFor();
      await done.locator(".rc-pill", { hasText: "Answered" }).hover();
      await snap("done-with-answer");
      check("the Answered row carries the answer", /joins an account/.test(await done.innerText()));
      await page.getByRole("tablist", { name: "What to show" }).getByRole("tab", { name: /Decisions/ }).click();
      const decision = page.locator(".rc-points li", { hasText: "joins an account" });
      await decision.waitFor();
      // What a decision answers waits for the pointer on a wide screen.
      await decision.hover();
      await decision.locator(".rc-pill", { hasText: "Answer" }).hover();
      await snap("decision-from-answer");
      check("the decision names its question", (await decision.innerText()).includes(LINK));
    });

    await step("Undo takes the answer and its decision back", async () => {
      await clearToasts();
      await go("Payments", CAP);
      await row(CAP).getByRole("button", { name: "Answer", exact: true }).click();
      await row(CAP).getByLabel("The answer").fill("Give up after one hour");
      await row(CAP).getByRole("button", { name: "Answer", exact: true }).last().click();
      const t = page.locator(".toast", { hasText: "Answered" });
      await t.waitFor();
      check("the answer was kept first", (await feed()).decided.some((n) => n.text === "Give up after one hour"));
      await t.getByRole("button", { name: "Undo" }).click();
      await row(CAP).getByRole("button", { name: "Answer", exact: true }).waitFor();
      const f = await feed();
      check("the question is open again", f.open.some((n) => n.text === CAP));
      check("the decision the answer made is gone", !f.decided.some((n) => n.text === "Give up after one hour"));
      await snap("after-undo");
    });

    await step("answer from the task drawer", async () => {
      await clearToasts();
      await row(APPLE).locator(".fu-open").click();
      const drawer = page.locator(".task-drawer");
      await drawer.getByLabel("The answer").fill("Apple Pay keeps its own button above the summary bar");
      await snap("drawer-answer-box");
      await drawer.getByRole("button", { name: "Answer", exact: true }).click();
      await drawer.locator(".td-answer").waitFor();
      await snap("drawer-answered");
      check("the drawer shows the answer", /keeps its own button/.test(await drawer.locator(".td-answer").innerText()));
      check("the list let go of it", !(await openTexts()).includes(APPLE));
      await drawer.getByRole("button", { name: "Close" }).click();
    });

    await step("an agent lists the open questions and drops one over the MCP", async () => {
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
      const tool = async (id, name, args) => {
        const res = await call(id, "tools/call", { name, arguments: args });
        fs.writeFileSync(path.join(out, `mcp-${name}-${id}.json`), JSON.stringify(res, null, 2));
        return { error: !!res.result?.isError, text: res.result?.content?.[0]?.text ?? "", json: res.result?.isError ? null : JSON.parse(res.result.content[0].text) };
      };
      await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
      const names = ((await call(2, "tools/list", {})).result?.tools ?? []).map((t) => t.name);
      check("the MCP has list_questions and close_question", names.includes("list_questions") && names.includes("close_question"));
      const listed = (await tool(3, "list_questions", { space: roomId })).json;
      check("list_questions gives what is still open, oldest first", listed.count === 2 && listed.questions.map((x) => x.text).join("|") === [LONG, CAP].join("|"), listed.questions.map((x) => x.text));
      const long = listed.questions.find((x) => x.text === LONG);
      const none = await tool(4, "close_question", { ref: long.ref });
      check("close_question wants an answer, a decision or a drop", none.error && /Give one of answer/.test(none.text), none.text);
      const dropped = (await tool(5, "close_question", { ref: long.ref, drop: "The one-page layout shipped with long addresses", model: "verify-model" })).json;
      check("the agent's drop closes it, with why", dropped.status === "dropped" && /shipped with long addresses/.test(dropped.why_dropped), dropped);
      const got = (await tool(6, "get", { ref: long.ref })).json;
      check("get says where the question stands", got.status === "dropped" && /shipped/.test(got.why_dropped), [got.status, got.why_dropped]);
      await page.reload();
      await row(CAP).waitFor();
      await snap("tasks-at-the-end");
      check("one question is left open on the page", (await openTexts()).join() === CAP, await openTexts());
    });
    check("no errors in the browser", consoleErrors.length === 0, consoleErrors);
  } catch {
    // The step that failed is in the summary.
  } finally {
    summary.consoleErrors = consoleErrors;
    fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`${summary.ok ? "PASS" : "FAIL"}: evidence in ${out}`);
    process.exit(summary.ok ? 0 : 1);
  }
})();
