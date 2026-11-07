// A space's project: a GitHub repo linked to it, which Stand reads and never writes to. The space's
// creator links a repo from a Stand GitHub App installation they connected themselves. Stand keeps
// a bare copy of the repo's default branch under DATA_DIR/repos, pulls it every 10 minutes with a
// token that can read only that repo, and boils it down to a short digest (its files, README,
// merged PRs and the week's commits) that Ask Stand reads in a meeting. Design: docs/github-projects.md.
//
// The copy is a plain bare repo with no remote configured: each fetch names the URL and gets the
// token as a header for that one command, so nothing that could push is ever stored. It's a full
// copy rather than a partial clone, so reading it later never has to go back to GitHub.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LinkableRepo, SpaceProject } from "../shared/protocol.ts";
import type { MergedPr } from "./github.ts";

export const PROJECT_PULL_MS = 10 * 60_000;
/** Most repos one space may link. */
export const MAX_PROJECTS = 3;
/** Repos bigger than this (GitHub's packed size) aren't copied. */
export const MAX_REPO_KB = 1_000_000;
/** About 3k tokens: the digest sits in every Ask Stand prompt in the space. */
const DIGEST_MAX = 12_000;
const README_LINES = 60;
const COMMIT_DAYS = 7;
const COMMITS_MAX = 40;
const PER_DIR = 20;

export function initProjects(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS space_projects (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      owner TEXT NOT NULL, repo TEXT NOT NULL,
      installation_id INTEGER NOT NULL,
      default_branch TEXT NOT NULL,
      head_sha TEXT, pulled_at INTEGER, error TEXT, digest TEXT,
      linked_by TEXT NOT NULL, linked_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, owner, repo)
    );
  `);
}

/** What projects need from GitHub: the Stand GitHub App (github.ts). */
export interface ProjectGithub {
  linkableRepos(userId: string): Promise<Array<LinkableRepo & { installationId: number; defaultBranch: string; sizeKb: number }>>;
  readToken(installationId: number, repo: string): Promise<string>;
  mergedPrs(owner: string, repo: string, token: string): Promise<MergedPr[]>;
}

/** Runs git and returns what it printed. A token goes in as GitHub's auth header for that one command. */
export type Git = (args: string[], opts?: { cwd?: string; token?: string }) => Promise<string>;

export const runGit: Git = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    if (opts.token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`;
    }
    execFile("git", args, { cwd: opts.cwd, env, timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split("\n").at(-1) || err.message));
      else resolve(String(stdout));
    });
  });

/** A mistake in what someone asked for, said so they can fix it. */
export class ProjectError extends Error {}

/** Files never shown to a model, even when they're committed. */
export function hiddenPath(p: string): boolean {
  const name = (p.split("/").pop() ?? "").toLowerCase();
  return (
    /^\.env(\..*)?$/.test(name) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(name) ||
    /^(\.npmrc|\.pypirc|\.netrc|\.htpasswd)$/.test(name) ||
    /^(credentials|secrets?)(\.(json|ya?ml|toml|txt))?$/.test(name)
  );
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,200}$/;

/** "owner/repo", or a GitHub link to it. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(input.trim());
  if (!m || !OWNER.test(m[1]) || !REPO.test(m[2]) || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], repo: m[2] };
}

/** The repo's files as a short outline: its top level, and what's in each folder there. */
export function treeOutline(files: string[]): string {
  const top = new Map<string, Map<string, number>>();
  const topFiles: string[] = [];
  for (const f of files) {
    if (hiddenPath(f)) continue;
    const parts = f.split("/");
    if (parts.length === 1) {
      topFiles.push(f);
      continue;
    }
    const dir = top.get(parts[0]) ?? new Map<string, number>();
    const child = parts.length > 2 ? `${parts[1]}/` : parts[1];
    dir.set(child, (dir.get(child) ?? 0) + 1);
    top.set(parts[0], dir);
  }
  const lines: string[] = [];
  for (const [dir, kids] of [...top].sort(([a], [b]) => a.localeCompare(b))) {
    const total = [...kids.values()].reduce((a, b) => a + b, 0);
    const names = [...kids.keys()].sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
    const more = names.length > PER_DIR ? `, +${names.length - PER_DIR} more` : "";
    lines.push(`${dir}/ (${total} file${total === 1 ? "" : "s"}): ${names.slice(0, PER_DIR).join(", ")}${more}`);
  }
  if (topFiles.length) lines.push(`top level: ${topFiles.sort().slice(0, PER_DIR * 2).join(", ")}${topFiles.length > PER_DIR * 2 ? ", …" : ""}`);
  return lines.join("\n");
}

export interface DigestInput {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  pulledAt: number;
  files: string[];
  readme: { path: string; text: string } | null;
  prs: MergedPr[];
  commits: Array<{ sha: string; author: string; date: string; subject: string }>;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The project as Ask Stand reads it: what the repo holds and what landed in it lately. */
export function buildDigest(d: DigestInput): string {
  const head = `Project: github.com/${d.owner}/${d.repo}, branch ${d.branch} at ${d.sha.slice(0, 7)} (pulled ${day(d.pulledAt)})`;
  const parts = [head, `Files:\n${treeOutline(d.files) || "(empty)"}`];
  if (d.prs.length) parts.push(`Merged pull requests, newest first:\n${d.prs.map((p) => `- #${p.number} ${clip(p.title, 120)} (${p.author || "?"}, ${day(p.mergedAt)})`).join("\n")}`);
  parts.push(
    `Commits on ${d.branch} in the last ${COMMIT_DAYS} days, newest first:\n${d.commits.map((c) => `- ${c.date} ${c.sha} ${c.author}: ${clip(c.subject, 120)}`).join("\n") || "(none)"}`,
  );
  if (d.readme) {
    const text = d.readme.text.split("\n").slice(0, README_LINES).join("\n").trim();
    if (text) parts.push(`${d.readme.path}, first lines:\n${text}`);
  }
  return clip(parts.join("\n\n"), DIGEST_MAX);
}

/** The digests of a space's projects, for Ask Stand's prompt; null when it has none pulled. */
export function projectDigest(sql: DatabaseSync, roomId: string): string | null {
  const rows = sql.prepare("SELECT digest FROM space_projects WHERE room_id = ? AND digest IS NOT NULL ORDER BY linked_at").all(roomId) as Array<{ digest: string }>;
  return rows.length ? rows.map((r) => r.digest).join("\n\n---\n\n") : null;
}

type Row = Record<string, any>;

const toProject = (r: Row, names: (id: string) => string | null): SpaceProject => ({
  owner: r.owner,
  repo: r.repo,
  branch: r.default_branch,
  headSha: r.head_sha ?? null,
  pulledAt: r.pulled_at ?? null,
  error: r.error ?? null,
  linkedBy: names(r.linked_by),
  linkedAt: r.linked_at,
  url: `https://github.com/${r.owner}/${r.repo}`,
});

export class Projects {
  private pulling = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private again = false;

  constructor(
    private sql: DatabaseSync,
    /** Where the copies live: DATA_DIR/repos. */
    private dir: string,
    private github: ProjectGithub | null,
    private git: Git = runGit,
    /** Where a repo is fetched from; tests point it at a local repo. */
    private remote: (owner: string, repo: string) => string = (o, r) => `https://github.com/${o}/${r}.git`,
  ) {}

  private names = (id: string) => ((this.sql.prepare("SELECT name FROM users WHERE id = ?").get(id) as Row | undefined)?.name as string | undefined) ?? null;

  list(roomId: string): SpaceProject[] {
    return (this.sql.prepare("SELECT * FROM space_projects WHERE room_id = ? ORDER BY linked_at").all(roomId) as Row[]).map((r) => toProject(r, this.names));
  }

  private row(roomId: string, owner: string, repo: string): Row | undefined {
    return this.sql.prepare("SELECT * FROM space_projects WHERE room_id = ? AND lower(owner) = lower(?) AND lower(repo) = lower(?)").get(roomId, owner, repo) as Row | undefined;
  }

  repoDir(roomId: string, owner: string, repo: string) {
    return path.join(this.dir, roomId, `${owner.toLowerCase()}__${repo.toLowerCase()}`);
  }

  /** Repos this person could link: from installations they connected. */
  async linkable(userId: string): Promise<LinkableRepo[]> {
    if (!this.github) return [];
    return (await this.github.linkableRepos(userId)).map(({ owner, repo, private: p }) => ({ owner, repo, private: p }));
  }

  /** Links a repo to a space and pulls it once. The caller checks the person may change the space;
   *  this checks they connected the repo on GitHub themselves. */
  async link(roomId: string, userId: string, input: string, now = Date.now()): Promise<SpaceProject> {
    if (!this.github) throw new ProjectError("The Stand GitHub App isn't set up on this server.");
    const want = parseRepo(input);
    if (!want) throw new ProjectError("Pick a repo as owner/name.");
    if (this.row(roomId, want.owner, want.repo)) throw new ProjectError("That repo is already linked to this space.");
    if (this.list(roomId).length >= MAX_PROJECTS) throw new ProjectError(`A space can link up to ${MAX_PROJECTS} repos.`);
    const repos = await this.github.linkableRepos(userId);
    const r = repos.find((x) => x.owner.toLowerCase() === want.owner.toLowerCase() && x.repo.toLowerCase() === want.repo.toLowerCase());
    if (!r) throw new ProjectError("You can only link a repo from a GitHub connection you made. Connect GitHub on the Connect an agent page and include this repo.");
    if (r.sizeKb > MAX_REPO_KB) throw new ProjectError("That repo is too big for Stand to copy (over 1 GB).");
    if (!BRANCH.test(r.defaultBranch)) throw new ProjectError("Stand can't read that repo's default branch name.");
    this.sql
      .prepare("INSERT INTO space_projects (room_id, owner, repo, installation_id, default_branch, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(roomId, r.owner, r.repo, r.installationId, r.defaultBranch, userId, now);
    await this.pull(roomId, r.owner, r.repo);
    return this.list(roomId).find((p) => p.owner === r.owner && p.repo === r.repo)!;
  }

  /** Unlinks a repo and deletes Stand's copy of it. */
  unlink(roomId: string, owner: string, repo: string): boolean {
    const r = this.row(roomId, owner, repo);
    if (!r) return false;
    this.sql.prepare("DELETE FROM space_projects WHERE room_id = ? AND owner = ? AND repo = ?").run(roomId, r.owner, r.repo);
    fs.rmSync(this.repoDir(roomId, r.owner, r.repo), { recursive: true, force: true });
    return true;
  }

  /** Fetches the repo's default branch and rebuilds its digest. A failure is kept on the project to show. */
  pull(roomId: string, owner: string, repo: string): Promise<void> {
    const key = `${roomId}/${owner}/${repo}`.toLowerCase();
    const running = this.pulling.get(key);
    if (running) return running;
    const p = this.pullNow(roomId, owner, repo).finally(() => this.pulling.delete(key));
    this.pulling.set(key, p);
    return p;
  }

  private async pullNow(roomId: string, owner: string, repo: string, now = Date.now()) {
    const r = this.row(roomId, owner, repo);
    if (!r || !this.github) return;
    const dir = this.repoDir(roomId, r.owner, r.repo);
    const ref = `refs/heads/${r.default_branch}`;
    try {
      const token = await this.github.readToken(r.installation_id, r.repo);
      if (!fs.existsSync(path.join(dir, "HEAD"))) {
        fs.mkdirSync(dir, { recursive: true });
        await this.git(["init", "--bare", "--quiet", dir]);
      }
      await this.git(["fetch", "--quiet", "--no-tags", this.remote(r.owner, r.repo), `+${ref}:${ref}`], { cwd: dir, token });
      const sha = (await this.git(["rev-parse", ref], { cwd: dir })).trim();
      const files = (await this.git(["ls-tree", "-r", "-z", "--name-only", sha], { cwd: dir })).split("\0").filter(Boolean);
      const readmePath = files.find((f) => /^readme(\.(md|markdown|txt|rst))?$/i.test(f));
      const readme = readmePath ? { path: readmePath, text: await this.git(["show", `${sha}:${readmePath}`], { cwd: dir }) } : null;
      const since = new Date(now - COMMIT_DAYS * 86_400_000).toISOString();
      const commits = (await this.git(["log", `-n${COMMITS_MAX}`, `--since=${since}`, "--date=short", "--format=%h%x1f%an%x1f%ad%x1f%s", sha], { cwd: dir }))
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [s, author, date, subject] = l.split("\x1f");
          return { sha: s, author, date, subject: subject ?? "" };
        });
      const prs = await this.github.mergedPrs(r.owner, r.repo, token).catch(() => []);
      const digest = buildDigest({ owner: r.owner, repo: r.repo, branch: r.default_branch, sha, pulledAt: now, files, readme, prs, commits });
      this.sql
        .prepare("UPDATE space_projects SET head_sha = ?, pulled_at = ?, error = NULL, digest = ? WHERE room_id = ? AND owner = ? AND repo = ?")
        .run(sha, now, digest, roomId, r.owner, r.repo);
    } catch (e) {
      const message = clip((e as Error).message || "Couldn't pull from GitHub.", 200);
      console.warn(`[projects] ${r.owner}/${r.repo} for ${roomId}: ${message}`);
      this.sql.prepare("UPDATE space_projects SET error = ? WHERE room_id = ? AND owner = ? AND repo = ?").run(message, roomId, r.owner, r.repo);
    }
  }

  start() {
    this.timer = setInterval(() => void this.pullAll(), PROJECT_PULL_MS);
    this.timer.unref();
    void this.pullAll();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One pass over every project, one at a time. A call while a pass runs makes it go round once more. */
  async pullAll() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        const rows = this.sql.prepare("SELECT room_id, owner, repo FROM space_projects ORDER BY linked_at").all() as Row[];
        for (const r of rows) await this.pull(r.room_id, r.owner, r.repo);
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }
}
