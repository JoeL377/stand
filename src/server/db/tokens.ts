// Agent tokens, and the OAuth clients and codes that hand them out (oauth.ts).
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { AgentToken, User } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import { hashToken, type Row, toToken, toUser } from "./rows.ts";

export function tokensStore(db: DatabaseSync) {
  return {
    /** A new token for this user's agent. The secret is returned once and only its hash is kept. */
    createToken(
      userId: string,
      label: string,
      scope: AgentToken["scope"],
      opts: { clientId?: string } = {},
    ): { token: string; info: AgentToken; refresh: string | null } {
      const token = `stand_pat_${randomBytes(24).toString("base64url")}`;
      // Tokens from the sign-in flow come with a refresh token, which the app
      // swaps for a fresh pair; typed tokens from the Connect page don't need one.
      const refresh = opts.clientId ? `stand_rt_${randomBytes(24).toString("base64url")}` : null;
      const id = newId(10);
      const now = Date.now();
      const hint = token.slice(0, 14);
      db.prepare(
        "INSERT INTO api_tokens (id, user_id, label, hash, hint, scope, created_at, client_id, refresh_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, userId, label, hashToken(token), hint, scope, now, opts.clientId ?? null, refresh ? hashToken(refresh) : null);
      return { token, info: { id, label, scope, hint, createdAt: now, lastUsedAt: null }, refresh };
    },
    listTokens(userId: string): AgentToken[] {
      return (
        db.prepare("SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(userId) as Row[]
      ).map(toToken);
    },
    revokeToken(userId: string, id: string): boolean {
      return (
        db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), id, userId)
          .changes > 0
      );
    },
    /** Swaps a refresh token for a new access and refresh token; the old pair stops working. */
    refreshToken(refresh: string, clientId: string): { token: string; refresh: string; scope: AgentToken["scope"] } | null {
      const r = db
        .prepare("SELECT * FROM api_tokens WHERE refresh_hash = ? AND client_id = ? AND revoked_at IS NULL")
        .get(hashToken(refresh), clientId) as Row | undefined;
      if (!r) return null;
      db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), r.id as string);
      const made = this.createToken(r.user_id as string, r.label as string, r.scope as AgentToken["scope"], { clientId });
      return { token: made.token, refresh: made.refresh!, scope: made.info.scope };
    },
    /** Signing in again from the same app replaces its earlier token rather than piling up. */
    revokeClientTokens(userId: string, clientId: string) {
      db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL").run(
        Date.now(),
        userId,
        clientId,
      );
    },
    registerClient(name: string, redirectUris: string[]): { id: string; name: string; redirectUris: string[]; createdAt: number } {
      const id = `stand_client_${newId(16)}`;
      const now = Date.now();
      db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        name,
        JSON.stringify(redirectUris),
        now,
      );
      return { id, name, redirectUris, createdAt: now };
    },
    getClient(id: string): { id: string; name: string; redirectUris: string[] } | null {
      const r = db.prepare("SELECT * FROM oauth_clients WHERE id = ?").get(id) as Row | undefined;
      return r ? { id: r.id as string, name: r.name as string, redirectUris: JSON.parse(r.redirect_uris as string) as string[] } : null;
    },
    createAuthCode(c: { clientId: string; userId: string; redirectUri: string; challenge: string; scope: AgentToken["scope"] }): string {
      const code = randomBytes(24).toString("base64url");
      db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(Date.now());
      db.prepare(
        "INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(hashToken(code), c.clientId, c.userId, c.redirectUri, c.challenge, c.scope, Date.now() + 5 * 60_000);
      return code;
    },
    /** A code works once: it's deleted as it's read. */
    takeAuthCode(code: string) {
      const r = db.prepare("DELETE FROM oauth_codes WHERE hash = ? RETURNING *").get(hashToken(code)) as Row | undefined;
      if (!r || (r.expires_at as number) < Date.now()) return null;
      return {
        clientId: r.client_id as string,
        userId: r.user_id as string,
        redirectUri: r.redirect_uri as string,
        challenge: r.challenge as string,
        scope: r.scope as AgentToken["scope"],
      };
    },
    /** The user and token behind a bearer token, or null if it's unknown or revoked. */
    tokenUser(token: string): { user: User; verified: boolean; token: AgentToken } | null {
      const r = db
        .prepare(
          `SELECT t.*, u.id AS u_id, u.email, u.name, u.picture, u.google_sub FROM api_tokens t JOIN users u ON u.id = t.user_id
           WHERE t.hash = ? AND t.revoked_at IS NULL`,
        )
        .get(hashToken(token)) as Row | undefined;
      if (!r) return null;
      const now = Date.now();
      // Last used is shown on the Connect an agent page; minute precision is plenty.
      if (!r.last_used_at || now - (r.last_used_at as number) > 60_000)
        db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, r.id as string);
      return {
        user: toUser({ id: r.u_id, email: r.email, name: r.name, picture: r.picture }),
        verified: Boolean(r.google_sub),
        token: toToken({ ...r, last_used_at: now }),
      };
    },
  };
}
