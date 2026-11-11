// The Stand GitHub App: its webhook, and connecting it from the Connect an agent page.
import express, { type Express } from "express";
import type { GithubStatus } from "../../shared/protocol.ts";
import { config } from "../config.ts";
import { readEvent, signedByGithub } from "../github.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function githubWebhook(app: Express, ctx: Services) {
  const { githubApp, shipWatch } = ctx;
  // GitHub tells Stand when a PR closes or the app is installed. Its signature is checked against the
  // raw body, so this comes before the JSON parser.
  app.post(
    "/api/github/webhook",
    express.raw({ type: () => true, limit: "10mb" }),
    route(async (req, res) => {
      if (!githubApp || !config.githubApp.webhookSecret) return notFound(res);
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!signedByGithub(config.githubApp.webhookSecret, raw, req.header("x-hub-signature-256"))) return res.status(401).json({ error: "Bad signature" });
      const ev = readEvent(req.header("x-github-event"), JSON.parse(raw.toString("utf8") || "{}"));
      if (ev.kind === "pr-closed") shipWatch.settle(ev.pr);
      else if (ev.kind === "installed") await githubApp.remember(ev.id, null).catch(() => null);
      else if (ev.kind === "uninstalled") githubApp.forget(ev.id);
      res.json({ ok: true });
    }),
  );
}

export function githubRoutes(app: Express, ctx: Services) {
  const { githubApp } = ctx;
  // Connect GitHub, on the Connect an agent page: off to the app's install page, and back.
  app.get("/api/github", (_req, res) => {
    res.json({ available: !!githubApp, installations: githubApp?.list() ?? [] } satisfies GithubStatus);
  });
  app.get("/api/github/connect", (req, res) => {
    if (!githubApp) return notFound(res);
    res.redirect(githubApp.installUrl(req.user!.id));
  });
  // GitHub's Setup URL: where people land after installing the app or changing its repos.
  app.get(
    "/api/github/setup",
    route(async (req, res) => {
      if (!githubApp) return notFound(res);
      const id = Number(req.query.installation_id);
      const known = githubApp.list().some((i) => i.id === id);
      const ok = Number.isSafeInteger(id) && id > 0 && (githubApp.takeState(String(req.query.state ?? ""), req.user!.id) || known);
      const saved = ok ? await githubApp.remember(id, req.user!.id).catch(() => null) : null;
      res.redirect(`/agents?github=${saved ? "connected" : "failed"}`);
    }),
  );
}
