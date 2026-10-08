// Sign-in for agents that connect with just the MCP URL, such as a custom
// connector in Claude (desktop, web or mobile). It is the OAuth 2.1 flow the MCP
// spec describes: the app finds Stand's endpoints, registers itself, sends the
// person here to sign in with Google and approve, and gets an agent token back.
// The token is an ordinary agent token, so it shows on the Connect an agent page
// and can be revoked there.

import { createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { AgentToken } from "../shared/protocol.ts";
import { googleEnabled } from "./config.ts";
import type { DB } from "./db.ts";
import { origin, userFromRequest } from "./auth.ts";

const SCOPES: Record<AgentToken["scope"], string> = { write: "stand", read: "stand:read" };

/** Where an app may be sent back to: https anywhere, or http on this computer (Claude Code, Cursor). */
function redirectAllowed(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: Response, status: number, title: string, body: string) {
  res
    .status(status)
    .set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*",
    )
    .set("X-Frame-Options", "DENY")
    .type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Stand</title><style>
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#1f1f1f;--muted:#6b6b6b;--line:#e6e6e3;--blue:#2d6cdf}
@media (prefers-color-scheme:dark){:root{--bg:#191919;--card:#232323;--text:#ececec;--muted:#9b9b9b;--line:#333}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,-apple-system,sans-serif;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:13px}ul{margin:0 0 16px;padding-left:20px}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
button,a.btn{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;text-decoration:none}
button.primary,a.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.brand{font-weight:700;margin-bottom:16px}</style></head><body><main class="card"><div class="brand">Stand</div>${body}</main></body></html>`);
}

/** The OAuth details from an authorize request, checked against the registered app. */
function readAuthorize(db: DB, q: Record<string, unknown>) {
  const s = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const client = db.getClient(s("client_id"));
  const redirectUri = s("redirect_uri");
  // Without a known app and one of its own return addresses there's nowhere safe to send an error.
  if (!client || !client.redirectUris.includes(redirectUri))
    return { error: "This app isn't registered with Stand. Try adding the connector again." } as const;
  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (s("state")) u.searchParams.set("state", s("state"));
    return u.toString();
  };
  if (s("response_type") !== "code") return { redirect: back({ error: "unsupported_response_type" }) } as const;
  if (!s("code_challenge") || (s("code_challenge_method") || "plain") !== "S256")
    return { redirect: back({ error: "invalid_request", error_description: "PKCE with S256 is required" }) } as const;
  const asked = s("scope").split(/\s+/).filter(Boolean);
  const scope: AgentToken["scope"] = asked.length > 0 && asked.every((x) => x === SCOPES.read) ? "read" : "write";
  return { client, redirectUri, challenge: s("code_challenge"), state: s("state"), scope, back } as const;
}

export function oauthRoutes(db: DB) {
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  // Apps call these from anywhere, without cookies.
  const open = (_req: Request, res: Response, next: () => void) => {
    res.set("Access-Control-Allow-Origin", "*").set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
    next();
  };

  const resourceMeta = (req: Request, res: Response) => {
    const o = origin(req);
    res.json({
      resource: `${o}/mcp`,
      authorization_servers: [o],
      scopes_supported: Object.values(SCOPES),
      bearer_methods_supported: ["header"],
      resource_name: "Stand",
    });
  };
  r.get("/.well-known/oauth-protected-resource", open, resourceMeta);
  r.get("/.well-known/oauth-protected-resource/mcp", open, resourceMeta);

  const serverMeta = (req: Request, res: Response) => {
    const o = origin(req);
    res.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      scopes_supported: Object.values(SCOPES),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  };
  r.get("/.well-known/oauth-authorization-server", open, serverMeta);
  r.get("/.well-known/oauth-authorization-server/mcp", open, serverMeta);
  r.get("/.well-known/openid-configuration", open, serverMeta);

  r.options(["/oauth/register", "/oauth/token"], open, (_req, res) => {
    res.set("Access-Control-Allow-Methods", "POST").status(204).end();
  });

  // Dynamic client registration (RFC 7591): the app introduces itself.
  r.post("/oauth/register", open, (req, res) => {
    const body = (req.body ?? {}) as { client_name?: unknown; redirect_uris?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(redirectAllowed))
      return void res
        .status(400)
        .json({ error: "invalid_redirect_uri", error_description: "Give https return addresses, or http on localhost" });
    const name = (typeof body.client_name === "string" && body.client_name.trim().slice(0, 60)) || "An agent";
    const c = db.registerClient(name, uris);
    res.status(201).json({
      client_id: c.id,
      client_id_issued_at: Math.floor(c.createdAt / 1000),
      client_name: c.name,
      redirect_uris: c.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // The consent page: sign in to Stand if needed, then approve this app.
  r.get("/oauth/authorize", (req, res) => {
    const a = readAuthorize(db, req.query);
    if ("error" in a) return page(res, 400, "Can't connect", `<h1>Can't connect</h1><p>${esc(a.error!)}</p>`);
    if ("redirect" in a) return res.redirect(a.redirect!);
    const user = userFromRequest(db, req);
    if (!user) {
      if (googleEnabled()) return res.redirect(`/api/auth/google?next=${encodeURIComponent(req.originalUrl)}`);
      return page(
        res,
        401,
        "Sign in",
        `<h1>Sign in to Stand first</h1><p>Open <a href="/">Stand</a> in this browser, sign in, then come back and reload this page.</p>`,
      );
    }
    const hidden = Object.entries(req.query)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v as string)}">`)
      .join("");
    const can =
      a.scope === "write"
        ? "<li>Read the to-dos, decisions, questions and topics in the spaces you’re in</li><li>Post progress updates and check off to-dos, shown as you via this app</li>"
        : "<li>Read the to-dos, decisions, questions and topics in the spaces you’re in</li>";
    page(
      res,
      200,
      "Connect",
      `<h1>Connect ${esc(a.client.name)} to Stand?</h1>
<p class="muted">Signed in as ${esc(user.email)}</p>
<p>It will be able to:</p><ul>${can}</ul>
<p class="muted">It goes back to ${esc(new URL(a.redirectUri).host)}. You can disconnect it any time on the Connect an agent page.</p>
<form method="post" action="/oauth/authorize">${hidden}<div class="row">
<button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="allow">Allow</button></div></form>`,
    );
  });

  r.post("/oauth/authorize", form, (req, res) => {
    // The session cookie is SameSite=Lax, so another site can't post this form as you.
    const user = userFromRequest(db, req);
    const a = readAuthorize(db, req.body ?? {});
    if ("error" in a) return page(res, 400, "Can't connect", `<h1>Can't connect</h1><p>${esc(a.error!)}</p>`);
    if ("redirect" in a) return res.redirect(303, a.redirect!);
    if (!user) return res.redirect(303, `/oauth/authorize?${new URLSearchParams(req.body as Record<string, string>)}`);
    if (req.body.decision !== "allow") return res.redirect(303, a.back({ error: "access_denied" }));
    const code = db.createAuthCode({
      clientId: a.client.id,
      userId: user.id,
      redirectUri: a.redirectUri,
      challenge: a.challenge,
      scope: a.scope,
    });
    res.redirect(303, a.back({ code }));
  });

  r.post("/oauth/token", open, form, (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const fail = (error: string, error_description: string, status = 400) => void res.status(status).json({ error, error_description });
    const client = b.client_id ? db.getClient(b.client_id) : null;
    if (!client) return fail("invalid_client", "Unknown client", 401);

    if (b.grant_type === "authorization_code") {
      const c = b.code ? db.takeAuthCode(b.code) : null;
      if (!c || c.clientId !== client.id || c.redirectUri !== b.redirect_uri)
        return fail("invalid_grant", "The code is wrong, used or expired");
      const verifier = b.code_verifier ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return fail("invalid_grant", "PKCE check failed");
      db.revokeClientTokens(c.userId, client.id);
      const made = db.createToken(c.userId, client.name, c.scope, { clientId: client.id });
      return void res.json({ access_token: made.token, token_type: "Bearer", refresh_token: made.refresh, scope: SCOPES[c.scope] });
    }
    if (b.grant_type === "refresh_token") {
      const next = b.refresh_token ? db.refreshToken(b.refresh_token, client.id) : null;
      if (!next) return fail("invalid_grant", "The refresh token is wrong or was revoked");
      return void res.json({ access_token: next.token, token_type: "Bearer", refresh_token: next.refresh, scope: SCOPES[next.scope] });
    }
    fail("unsupported_grant_type", "Use authorization_code or refresh_token");
  });

  return r;
}
