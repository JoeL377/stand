// Google sign-in (OAuth 2.0 authorization code flow) and cookie sessions.
// Without Google credentials, a stand-in sign-in takes a name and email so
// the app can be tried locally; it is labelled as unverified in the UI.

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { User } from "../shared/protocol.ts";
import { config, googleEnabled } from "./config.ts";
import type { DB } from "./db.ts";

const SESSION_COOKIE = "standup_session";
const STATE_COOKIE = "standup_oauth";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number) {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.production,
    maxAge: maxAgeMs,
    path: "/",
  });
}

/** True when ALLOWED_EMAILS or ALLOWED_EMAIL_DOMAINS limits who can get in. */
export const accessRestricted = () => config.allowedEmails.length > 0 || config.allowedDomains.length > 0;

/** Whether this email may use the app: on the email allowlist or in an allowed domain. */
export function emailAllowed(email: string) {
  if (!accessRestricted()) return true;
  const e = email.trim().toLowerCase();
  return config.allowedEmails.includes(e) || config.allowedDomains.includes(e.split("@")[1] ?? "");
}

/** The user behind a request's session cookie (HTTP or WebSocket upgrade).
 *  Access is checked on every request, not just at sign-in, so taking someone
 *  off the allowlist or turning on Google locks out existing sessions too. */
export function userFromRequest(db: DB, req: IncomingMessage): User | null {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const s = sid ? db.sessionUser(sid) : null;
  if (!s || !emailAllowed(s.user.email)) return null;
  // A stand-in sign-in proves nothing about the email, so it only counts while
  // the app is open to anyone and Google isn't set up.
  if (!s.verified && (googleEnabled() || accessRestricted())) return null;
  return s.user;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function requireUser(db: DB) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = userFromRequest(db, req);
    if (!user) return res.status(401).json({ error: "Sign in first" });
    req.user = user;
    next();
  };
}

/** The user behind an agent's "Authorization: Bearer stand_pat_…" token, with the
 *  same access checks as a signed-in session, so taking someone off the allowlist
 *  also locks out their agents. */
export function agentFromRequest(db: DB, req: IncomingMessage) {
  const m = /^Bearer\s+(stand_pat_[A-Za-z0-9_-]{20,})\s*$/.exec(req.headers.authorization ?? "");
  const found = m ? db.tokenUser(m[1]) : null;
  if (!found || !emailAllowed(found.user.email)) return null;
  if (!found.verified && (googleEnabled() || accessRestricted())) return null;
  return { user: found.user, token: found.token };
}

export function origin(req: Request) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
}

/** Only same-site paths, so the sign-in flow can't be used as an open redirect. */
const safeNext = (next: unknown) => (typeof next === "string" && /^\/(?!\/)/.test(next) ? next : "/");

function signIn(db: DB, res: Response, user: User) {
  const s = db.createSession(user.id);
  setCookie(res, SESSION_COOKIE, s.id, s.maxAgeMs);
}

export function authRoutes(db: DB) {
  const r = express.Router();

  r.get("/me", (req, res) => {
    const user = userFromRequest(db, req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    res.json(user);
  });

  r.post("/logout", (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) db.deleteSession(sid);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  r.get("/google", (req, res) => {
    if (!googleEnabled()) return res.redirect("/");
    const state = randomBytes(16).toString("base64url");
    setCookie(res, STATE_COOKIE, JSON.stringify({ state, next: safeNext(req.query.next) }), 10 * 60 * 1000);
    const params = new URLSearchParams({
      client_id: config.google.clientId!,
      redirect_uri: `${origin(req)}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  r.get("/google/callback", async (req, res) => {
    const fail = (why: string) => res.redirect(`/?signin_error=${encodeURIComponent(why)}`);
    let saved: { state: string; next: string };
    try {
      saved = JSON.parse(parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "");
    } catch {
      return fail("Sign-in expired. Try again.");
    }
    res.clearCookie(STATE_COOKIE, { path: "/" });
    if (!saved?.state || req.query.state !== saved.state) return fail("Sign-in expired. Try again.");
    if (typeof req.query.code !== "string") return fail("Google sign-in was cancelled.");

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.google.clientId!,
          client_secret: config.google.clientSecret!,
          redirect_uri: `${origin(req)}/api/auth/google/callback`,
          grant_type: "authorization_code",
        }),
      });
      const tokens = (await tokenRes.json()) as { access_token?: string; error_description?: string };
      if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error_description ?? "token exchange failed");

      // The token came straight from Google over TLS, so its userinfo is trustworthy.
      const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
      if (!infoRes.ok || !info.sub || !info.email) throw new Error("couldn't read your Google profile");
      if (!info.email_verified) return fail("Your Google email isn't verified.");
      if (!emailAllowed(info.email)) return fail(`${info.email} doesn't have access. Ask the person who runs Stand to add you.`);

      const user = db.upsertUser({
        googleSub: info.sub,
        email: info.email,
        name: info.name || info.email.split("@")[0],
        picture: info.picture ?? null,
      });
      signIn(db, res, user);
      res.redirect(saved.next);
    } catch (err) {
      console.error("[auth] Google sign-in failed:", err);
      fail("Google sign-in failed. Try again.");
    }
  });

  // Stand-in sign-in, only while Google isn't configured.
  r.post("/dev", (req, res) => {
    if (googleEnabled()) return res.status(404).json({ error: "Use Google sign-in" });
    if (accessRestricted()) return res.status(403).json({ error: "Sign-in needs Google here. Ask the person who runs Stand to set it up." });
    const name = String(req.body?.name ?? "").trim().slice(0, 60);
    const email = String(req.body?.email ?? "").trim().toLowerCase().slice(0, 120);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter your name and email." });
    const user = db.upsertUser({ googleSub: null, email, name, picture: null });
    signIn(db, res, user);
    res.json(user);
  });

  return r;
}
