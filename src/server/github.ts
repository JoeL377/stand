// The Stand GitHub App. Someone clicks Connect GitHub on the Connect an agent page, picks repos on
// GitHub's own install screen, and comes back: no tokens. From then on GitHub tells Stand the moment
// a pull request in those repos closes (POST /api/github/webhook), so a to-do reported ready with
// that PR (or whose ref is in the PR's description) is checked off right away, and the two-minute
// check in shipWatch.ts reads those repos as the app. The app only asks to read: pull requests, and
// contents for a repo linked to a space as a source (sources.ts).

import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GithubInstallation, LinkableRepo } from "../shared/protocol.ts";
import { githubPrState, type PrState } from "./shipWatch.ts";
import { prOf } from "./workLog.ts";

export interface GithubAppConfig {
  id?: string;
  slug?: string;
  privateKey?: string;
  webhookSecret?: string;
}

export const appReady = (c: GithubAppConfig): c is Required<GithubAppConfig> => Boolean(c.id && c.slug && c.privateKey && c.webhookSecret);

export function initGithub(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS github_installations (
      id INTEGER PRIMARY KEY, account TEXT NOT NULL, account_type TEXT NOT NULL, repos TEXT NOT NULL,
      connected_by TEXT NOT NULL, connected_at INTEGER NOT NULL
    );
  `);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The short-lived token that signs Stand in as the app itself (RS256, good for 9 minutes). */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Whether a webhook really came from GitHub: its X-Hub-Signature-256 against the shared secret. */
export function signedByGithub(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A closed pull request, from GitHub's webhook. */
export interface ClosedPr {
  url: string;
  merged: boolean;
  /** The PR's description, where agents put the to-do's ref. */
  body: string;
  author: string;
}

/** What a webhook delivery means for Stand, if anything. */
export type GithubEvent =
  | { kind: "pr-closed"; pr: ClosedPr }
  | { kind: "installed"; id: number }
  | { kind: "uninstalled"; id: number }
  | { kind: "other" };

export function readEvent(name: string | undefined, payload: Record<string, any>): GithubEvent {
  if (name === "pull_request" && payload.action === "closed" && payload.pull_request?.html_url)
    return {
      kind: "pr-closed",
      pr: {
        url: payload.pull_request.html_url,
        merged: Boolean(payload.pull_request.merged),
        body: String(payload.pull_request.body ?? ""),
        author: String(payload.pull_request.user?.login ?? "GitHub"),
      },
    };
  if (name === "installation" && payload.installation?.id) {
    if (payload.action === "deleted") return { kind: "uninstalled", id: payload.installation.id };
    return { kind: "installed", id: payload.installation.id };
  }
  if (name === "installation_repositories" && payload.installation?.id) return { kind: "installed", id: payload.installation.id };
  return { kind: "other" };
}

export interface MergedPr {
  number: number;
  title: string;
  author: string;
  mergedAt: number;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  author: string;
  mergedAt: number | null;
  base: string;
  head: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

type Fetch = typeof fetch;

export class GithubApp {
  private tokens = new Map<number, { token: string; until: number }>();
  /** Which installation covers a repo; null when none does. Kept a little while. */
  private repoInstall = new Map<string, { id: number | null; until: number }>();
  /** Connect GitHub sends people to GitHub with a nonce; the setup page they come back to must match it. */
  private states = new Map<string, { userId: string; until: number }>();

  constructor(
    private cfg: Required<GithubAppConfig>,
    private sql: DatabaseSync,
    private get: Fetch = fetch,
  ) {}

  private headers(auth: string) {
    return { Accept: "application/vnd.github+json", "User-Agent": "stand", Authorization: `Bearer ${auth}` };
  }

  /** Where Connect GitHub goes: the app's install page, with a nonce tied to the person. */
  installUrl(userId: string, now = Date.now()): string {
    for (const [k, v] of this.states) if (v.until < now) this.states.delete(k);
    const state = randomBytes(18).toString("base64url");
    this.states.set(state, { userId, until: now + 30 * 60_000 });
    return `https://github.com/apps/${this.cfg.slug}/installations/new?state=${state}`;
  }

  /** The person coming back from GitHub's install screen is the one who left for it. */
  takeState(state: string | undefined, userId: string, now = Date.now()): boolean {
    const s = state ? this.states.get(state) : undefined;
    if (!s || s.until < now || s.userId !== userId) return false;
    this.states.delete(state!);
    return true;
  }

  /** Looks an installation up as the app, which also proves it's this app's, and saves it. */
  async remember(id: number, connectedBy: string | null, now = Date.now()): Promise<GithubInstallation | null> {
    const res = await this.get(`https://api.github.com/app/installations/${id}`, {
      headers: this.headers(appJwt(this.cfg.id, this.cfg.privateKey, now)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const i = (await res.json()) as { id: number; account?: { login?: string; type?: string }; repository_selection?: string };
    const prev = this.sql.prepare("SELECT connected_by, connected_at FROM github_installations WHERE id = ?").get(id) as
      | { connected_by: string; connected_at: number }
      | undefined;
    const row = {
      id,
      account: i.account?.login ?? "?",
      type: i.account?.type === "Organization" ? "Organization" : "User",
      repos: i.repository_selection === "all" ? "all" : "selected",
      by: prev?.connected_by || connectedBy || "",
      at: prev?.connected_at ?? now,
    };
    this.sql
      .prepare("INSERT OR REPLACE INTO github_installations (id, account, account_type, repos, connected_by, connected_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.account, row.type, row.repos, row.by, row.at);
    this.repoInstall.clear();
    return this.list().find((x) => x.id === id) ?? null;
  }

  forget(id: number) {
    this.sql.prepare("DELETE FROM github_installations WHERE id = ?").run(id);
    this.tokens.delete(id);
    this.repoInstall.clear();
  }

  list(): GithubInstallation[] {
    return (
      this.sql
        .prepare(
          `SELECT g.*, u.name AS by_name FROM github_installations g LEFT JOIN users u ON u.id = g.connected_by ORDER BY g.connected_at`,
        )
        .all() as Array<Record<string, any>>
    ).map((r) => ({
      id: r.id as number,
      account: r.account as string,
      accountType: r.account_type as GithubInstallation["accountType"],
      repos: r.repos as GithubInstallation["repos"],
      connectedBy: (r.by_name as string) ?? null,
      connectedAt: r.connected_at as number,
      manageUrl:
        r.account_type === "Organization"
          ? `https://github.com/organizations/${r.account}/settings/installations/${r.id}`
          : `https://github.com/settings/installations/${r.id}`,
    }));
  }

  /** A token that reads this repo as the app, when someone connected it; null when nobody did. */
  async repoToken(owner: string, repo: string, now = Date.now()): Promise<string | null> {
    const key = `${owner}/${repo}`.toLowerCase();
    let hit = this.repoInstall.get(key);
    if (!hit || hit.until < now) {
      const res = await this.get(`https://api.github.com/repos/${owner}/${repo}/installation`, {
        headers: this.headers(appJwt(this.cfg.id, this.cfg.privateKey, now)),
        signal: AbortSignal.timeout(15_000),
      });
      const id = res.ok ? ((await res.json()) as { id: number }).id : null;
      hit = { id, until: now + 10 * 60_000 };
      this.repoInstall.set(key, hit);
    }
    if (hit.id === null) return null;
    return this.installToken(hit.id, now);
  }

  /** The installation's own token, for listing its repos and reading PRs. */
  private async installToken(id: number, now = Date.now()): Promise<string | null> {
    const cached = this.tokens.get(id);
    if (cached && cached.until > now) return cached.token;
    const res = await this.get(`https://api.github.com/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers: this.headers(appJwt(this.cfg.id, this.cfg.privateKey, now)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const t = (await res.json()) as { token: string; expires_at: string };
    this.tokens.set(id, { token: t.token, until: Date.parse(t.expires_at) - 5 * 60_000 });
    return t.token;
  }

  /** Repos in the installations this person connected: the ones they may link to a space. */
  async linkableRepos(userId: string, now = Date.now()): Promise<Array<LinkableRepo & { installationId: number; defaultBranch: string; sizeKb: number }>> {
    const ids = (this.sql.prepare("SELECT id FROM github_installations WHERE connected_by = ? ORDER BY connected_at").all(userId) as Array<{ id: number }>).map((r) => r.id);
    const out: Array<LinkableRepo & { installationId: number; defaultBranch: string; sizeKb: number }> = [];
    for (const id of ids) {
      const token = await this.installToken(id, now);
      if (!token) throw new Error("GitHub didn't let Stand list your repos. Check the Stand app on GitHub.");
      for (let page = 1; page <= 5; page++) {
        const res = await this.get(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
          headers: this.headers(token),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error("GitHub didn't let Stand list your repos. Check the Stand app on GitHub.");
        const body = (await res.json()) as { repositories?: Array<{ name: string; owner?: { login?: string }; private?: boolean; default_branch?: string; size?: number }> };
        const repos = body.repositories ?? [];
        for (const r of repos)
          out.push({ owner: r.owner?.login ?? "", repo: r.name, private: Boolean(r.private), installationId: id, defaultBranch: r.default_branch || "main", sizeKb: r.size ?? 0 });
        if (repos.length < 100) break;
      }
    }
    return out.filter((r) => r.owner && r.repo);
  }

  /** A token that can only read one repo (its code, metadata and PRs), for an hour. A source's
   *  pulls use only this, so a space can read exactly the repo it linked and nothing else. */
  async readToken(installationId: number, repo: string, now = Date.now()): Promise<string> {
    const key = `${installationId}:${repo.toLowerCase()}`;
    const cached = this.readTokens.get(key);
    if (cached && cached.until > now) return cached.token;
    const res = await this.get(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { ...this.headers(appJwt(this.cfg.id, this.cfg.privateKey, now)), "Content-Type": "application/json" },
      body: JSON.stringify({ repositories: [repo], permissions: { contents: "read", metadata: "read", pull_requests: "read" } }),
      signal: AbortSignal.timeout(15_000),
    });
    // 422: the installation hasn't granted Contents yet (GitHub asks its owner to accept it).
    if (res.status === 422) throw new Error("Accept Contents access for the Stand app on GitHub, then pull again.");
    if (!res.ok) throw new Error("Stand lost access to this repo on GitHub.");
    const t = (await res.json()) as { token: string; expires_at: string };
    this.readTokens.set(key, { token: t.token, until: Date.parse(t.expires_at) - 5 * 60_000 });
    return t.token;
  }

  private readTokens = new Map<string, { token: string; until: number }>();

  /** The repo's most recently merged PRs, newest first. */
  async mergedPrs(owner: string, repo: string, token: string, n = 15): Promise<MergedPr[]> {
    const res = await this.get(`https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, {
      headers: this.headers(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const prs = (await res.json()) as Array<{ number: number; title?: string; merged_at?: string | null; user?: { login?: string } }>;
    return prs
      .filter((p) => p.merged_at)
      .map((p) => ({ number: p.number, title: String(p.title ?? "").trim(), author: p.user?.login ?? "", mergedAt: Date.parse(p.merged_at!) }))
      .sort((a, b) => b.mergedAt - a.mergedAt)
      .slice(0, n);
  }

  /** One PR with its changed files, for Ask Stand's repo_pr. Null when GitHub has no such PR. */
  async pullRequest(owner: string, repo: string, number: number, token: string): Promise<PullRequestDetail | null> {
    const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
    const opts = { headers: this.headers(token), signal: AbortSignal.timeout(15_000) };
    const res = await this.get(base, opts);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("GitHub didn't answer about that PR.");
    const p = (await res.json()) as { title?: string; body?: string | null; state?: string; merged_at?: string | null; user?: { login?: string }; base?: { ref?: string }; head?: { ref?: string } };
    const files = await this.get(`${base}/files?per_page=100`, opts)
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ filename: string; status?: string; additions?: number; deletions?: number }>>) : []))
      .catch(() => []);
    return {
      number,
      title: String(p.title ?? "").trim(),
      body: String(p.body ?? ""),
      state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
      author: p.user?.login ?? "",
      mergedAt: p.merged_at ? Date.parse(p.merged_at) : null,
      base: p.base?.ref ?? "",
      head: p.head?.ref ?? "",
      files: files.map((f) => ({ path: f.filename, status: f.status ?? "", additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    };
  }

  /** A PR's state, read as the app when it covers the repo, else with the fallback token. */
  async prState(link: string, fallback?: string): Promise<PrState | null> {
    const pr = prOf(link);
    if (!pr) return null;
    const token = (await this.repoToken(pr.owner, pr.repo).catch(() => null)) ?? fallback;
    return githubPrState(link, token, this.get);
  }
}
