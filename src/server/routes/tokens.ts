// Agent tokens, and the stand:kind/id references agents and the Copy for agent button use.
import type { Express, Request, Response } from "express";
import { AgentError, parseRef } from "../agents.ts";
import { origin } from "../auth.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function tokenRoutes(app: Express, ctx: Services) {
  const { db, agents } = ctx;
  app.get(
    "/api/tokens",
    route((req, res) => {
      res.json(db.listTokens(req.user!.id));
    }),
  );

  /** A new agent token. The secret is in this response only. */
  app.post(
    "/api/tokens",
    route((req, res) => {
      const label =
        String(req.body?.label ?? "")
          .trim()
          .slice(0, 60) || "My agent";
      const scope = req.body?.scope === "read" ? "read" : "write";
      if (db.listTokens(req.user!.id).length >= 20)
        return void res.status(400).json({ error: "You have 20 agent tokens. Revoke one first." });
      res.json(db.createToken(req.user!.id, label, scope));
    }),
  );

  app.delete(
    "/api/tokens/:id",
    route((req, res) => {
      if (!db.revokeToken(req.user!.id, req.params.id)) return notFound(res);
      res.json({ ok: true });
    }),
  );

  const asWebCaller = (req: Request) => ({ user: req.user!, token: null });
  const agentErrors = (res: Response, err: unknown) => {
    if (err instanceof AgentError) return void res.status(404).json({ error: err.message });
    throw err;
  };

  /** Where a stand:kind/id reference lives, for /ref/... links. */
  app.get(
    "/api/refs/:kind/:id",
    route((req, res) => {
      if (!parseRef(`${req.params.kind}/${req.params.id}`)) return notFound(res);
      try {
        res.json(agents.locate(asWebCaller(req), req.params.kind, req.params.id));
      } catch (err) {
        agentErrors(res, err);
      }
    }),
  );

  /** The short prompt the Copy for agent button puts on the clipboard. */
  app.get(
    "/api/refs/:kind/:id/prompt",
    route((req, res) => {
      try {
        res.json({ text: agents.prompt(asWebCaller(req), `stand:${req.params.kind}/${req.params.id}`, origin(req)) });
      } catch (err) {
        agentErrors(res, err);
      }
    }),
  );
}
