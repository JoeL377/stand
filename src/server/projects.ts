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
import type { MergedPr, PullRequestDetail } from "./github.ts";

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
  pullRequest?(owner: string, repo: string, number: number, token: string): Promise<PullRequestDetail | null>;
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
      if (err) reject(Object.assign(new Error(String(stderr).trim().split("\n").at(-1) || err.message), { exitCode: typeof err.code === "number" ? err.code : null }));
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

  /** Ask Stand's tools over the space's pulled repos, for one run; null when it has none. */
  tools(roomId: string): RepoTools | null {
    const rows = (this.sql.prepare("SELECT * FROM space_projects WHERE room_id = ? AND head_sha IS NOT NULL ORDER BY linked_at").all(roomId) as Row[])
      .map((r) => ({ owner: r.owner as string, repo: r.repo as string, sha: r.head_sha as string, installationId: r.installation_id as number, digest: (r.digest as string) ?? "", dir: this.repoDir(roomId, r.owner, r.repo) }))
      .filter((r) => fs.existsSync(path.join(r.dir, "HEAD")));
    return rows.length ? new RepoTools(rows, this.git, this.github) : null;
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

// Ask Stand's tools over a space's repos (phase 2 of the design). They only read the local copy, at the
// commit last pulled, plus GitHub's PR API with the read-only token, so nothing the model reads can lead
// to a write. Files that hiddenPath catches are never searched, read or listed.

/** Most repo tool calls in one Ask Stand run. */
export const REPO_TOOL_CALLS = 8;
const SEARCH_HITS = 40;
const HIT_CHARS = 200;
const READ_LINES = 300;
const LINE_CHARS = 500;
const LOG_ROWS = 30;
const PR_BODY = 4000;
const PR_FILES = 60;

interface LinkedRepo {
  owner: string;
  repo: string;
  sha: string;
  installationId: number;
  digest: string;
  dir: string;
}

/** A tool as Claude's API takes it. */
export interface RepoToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const seenKey = (r: { owner: string; repo: string }, what: string) => `${r.owner}/${r.repo}/${what}`.toLowerCase();
const blobUrl = (r: LinkedRepo, p: string) => `https://github.com/${r.owner}/${r.repo}/blob/${r.sha}/${p.split("/").map(encodeURIComponent).join("/")}`;

/** A path as the model gave it, made relative; anything that climbs out or uses git's pathspec magic is refused. */
function cleanPath(p: string): string {
  const s = p.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (s === "." || s === "") return "";
  if (s.startsWith(":") || s.split("/").some((part) => part === ".." || part === "")) throw new ProjectError(`${p} isn't a path in the repo.`);
  return s;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

/** One Ask Stand run's view of the space's repos: the tools, what it did (for the card), and what it saw
 *  (so the answer can only cite files, PRs and commits the run was actually shown). */
export class RepoTools {
  /** What the run did, oldest first, as the card shows it: "Searched “pilotUse”", "Read src/server/room.ts". */
  readonly steps: string[] = [];
  private seen = new Set<string>();

  constructor(
    private repos: LinkedRepo[],
    private git: Git,
    private github: ProjectGithub | null,
  ) {
    // The digest is in the prompt, so its PRs and commits count as seen.
    for (const r of repos) {
      for (const m of r.digest.matchAll(/^- #(\d+) /gm)) this.seen.add(seenKey(r, `pull/${m[1]}`));
      for (const m of r.digest.matchAll(/^- \d{4}-\d{2}-\d{2} ([0-9a-f]{7,40}) /gm)) this.seen.add(seenKey(r, `commit/${m[1]}`));
    }
  }

  get names() {
    return this.repos.map((r) => `${r.owner}/${r.repo}`);
  }

  get defs(): RepoToolDef[] {
    const many = this.repos.length > 1;
    const repo = many ? { repo: { type: "string", enum: this.names, description: "Which repo" } } : {};
    const need = (...k: string[]) => (many ? [...k, "repo"] : k);
    const where = many ? `the space's repos (${this.names.join(", ")})` : `the space's repo (${this.names[0]})`;
    const defs: RepoToolDef[] = [
      {
        name: "repo_search",
        description: `Search the code of ${where} at the commit last pulled: git grep, case-insensitive, extended regex. Gives up to ${SEARCH_HITS} matching lines as path:line: text. Use it to find where something is, then read the lines that matter.`,
        input_schema: {
          type: "object",
          properties: { pattern: { type: "string", description: "A word, identifier or regex" }, path: { type: "string", description: "Only under this folder or file, like src/server" }, ...repo },
          required: ["pattern"],
        },
      },
      {
        name: "repo_read",
        description: `Read a file of ${where}: up to ${READ_LINES} numbered lines a call, with the link to cite. A folder lists what's in it.`,
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, from: { type: "integer", description: "First line, from 1" }, to: { type: "integer", description: "Last line" }, ...repo },
          required: need("path"),
        },
      },
      {
        name: "repo_log",
        description: `Commits on the default branch of ${where}, newest first, ${LOG_ROWS} at most. Merge commits name their PR. Narrow by a path, words in the message, or a start date.`,
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, query: { type: "string", description: "Words in the commit message" }, since: { type: "string", description: "YYYY-MM-DD" }, ...repo },
          required: need(),
        },
      },
    ];
    if (this.github?.pullRequest)
      defs.push({
        name: "repo_pr",
        description: `One pull request in ${where}: its title, state, author, description and changed files.`,
        input_schema: { type: "object", properties: { number: { type: "integer" }, ...repo }, required: need("number") },
      });
    return defs;
  }

  /** Runs one tool call. Its text goes back to the model; error marks a call that didn't work. */
  async run(name: string, input: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
    try {
      const repo = opt(input.repo);
      let text: string;
      if (name === "repo_search") text = await this.search(str(input.pattern), opt(input.path), repo);
      else if (name === "repo_read") text = await this.read(str(input.path), int(input.from), int(input.to), repo);
      else if (name === "repo_log") text = await this.log(opt(input.path), opt(input.query), opt(input.since), repo);
      else if (name === "repo_pr" && this.github?.pullRequest) text = await this.pr(int(input.number), repo);
      else return { text: `There's no tool called ${name}.`, error: true };
      return { text, error: false };
    } catch (e) {
      return { text: clip((e as Error).message || "That didn't work.", 300), error: true };
    }
  }

  private step(s: string) {
    this.steps.push(s);
  }

  private pick(name: string | undefined, all: boolean): LinkedRepo[] {
    if (name) {
      const r = this.repos.find((x) => `${x.owner}/${x.repo}`.toLowerCase() === name.toLowerCase());
      if (!r) throw new ProjectError(`No linked repo is called ${name}. Linked: ${this.names.join(", ")}.`);
      return [r];
    }
    if (all) return this.repos;
    if (this.repos.length === 1) return this.repos;
    throw new ProjectError(`Say which repo: ${this.names.join(" or ")}.`);
  }

  private async search(pattern: string, under: string | undefined, repo: string | undefined) {
    if (!pattern.trim()) throw new ProjectError("Give a pattern to search for.");
    const p = under ? cleanPath(under) : "";
    const label = this.repos.length > 1;
    const out: string[] = [];
    let total = 0;
    for (const r of this.pick(repo, true)) {
      let text: string;
      try {
        text = await this.git(["grep", "-n", "-I", "-i", "-E", "--max-count=5", "-e", pattern, r.sha, "--", ...(p ? [p] : [])], { cwd: r.dir });
      } catch (e) {
        // git grep exits 1 when nothing matches.
        if ((e as { exitCode?: number }).exitCode === 1) continue;
        throw new ProjectError(`The search failed: ${clip((e as Error).message, 200)}`);
      }
      for (const line of text.split("\n")) {
        const m = /^(.*?):(\d+):(.*)$/.exec(line.startsWith(`${r.sha}:`) ? line.slice(r.sha.length + 1) : line);
        if (!m || hiddenPath(m[1])) continue;
        total++;
        if (out.length >= SEARCH_HITS) continue;
        this.seen.add(seenKey(r, `file/${m[1]}`));
        out.push(`${label ? `${r.owner}/${r.repo} ` : ""}${m[1]}:${m[2]}: ${clip(m[3].trim(), HIT_CHARS)}`);
      }
    }
    this.step(`Searched “${clip(pattern, 40)}”`);
    if (!out.length) return `Nothing matches ${pattern}${p ? ` under ${p}` : ""}.`;
    return `${out.join("\n")}${total > out.length ? `\n(${total - out.length} more not shown: narrow the pattern or the path)` : ""}`;
  }

  private async read(file: string, from: number | undefined, to: number | undefined, repo: string | undefined) {
    const [r] = this.pick(repo, false);
    const p = cleanPath(file);
    if (p && hiddenPath(p)) throw new ProjectError(`${p} is never shown: it could hold secrets.`);
    const spec = `${r.sha}:${p}`;
    const type = await this.git(["cat-file", "-t", spec], { cwd: r.dir }).then(
      (t) => t.trim(),
      () => null,
    );
    if (!type) throw new ProjectError(`There's no ${p} in ${r.owner}/${r.repo}. Use repo_search to find it.`);
    if (type === "tree") {
      const entries = (await this.git(["ls-tree", "-z", spec], { cwd: r.dir }))
        .split("\0")
        .filter(Boolean)
        .map((e) => {
          const [meta, name] = e.split("\t");
          return meta.split(" ")[1] === "tree" ? `${name}/` : name;
        })
        .filter((n) => !hiddenPath(n));
      this.step(`Looked in ${p || "the top level"}`);
      return `${r.owner}/${r.repo} ${p || "(top level)"}:\n${entries.join("\n") || "(empty)"}`;
    }
    if (type !== "blob") throw new ProjectError(`${p} isn't a file.`);
    const text = await this.git(["cat-file", "blob", spec], { cwd: r.dir });
    this.step(`Read ${p}`);
    if (text.slice(0, 8000).includes("\0")) return `${p} is a binary file.`;
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const a = Math.min(Math.max(1, from ?? 1), Math.max(1, lines.length));
    const b = Math.max(a, Math.min(lines.length, to ?? Infinity, a + READ_LINES - 1));
    this.seen.add(seenKey(r, `file/${p}`));
    const body = lines
      .slice(a - 1, b)
      .map((l, i) => `${a + i}| ${clip(l, LINE_CHARS)}`)
      .join("\n");
    return `${r.owner}/${r.repo} ${p}, lines ${a}-${b} of ${lines.length}. Cite: ${blobUrl(r, p)}#L${a}-L${b}\n${body}${b < lines.length ? `\n(more below: read from ${b + 1})` : ""}`;
  }

  private async log(under: string | undefined, query: string | undefined, since: string | undefined, repo: string | undefined) {
    const [r] = this.pick(repo, false);
    const args = ["log", `-n${LOG_ROWS}`, "--date=short", "--format=%h%x1f%an%x1f%ad%x1f%s", "--regexp-ignore-case", "--fixed-strings"];
    if (query) args.push(`--grep=${query}`);
    if (since) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new ProjectError("Give since as YYYY-MM-DD.");
      args.push(`--since=${since}`);
    }
    args.push(r.sha);
    const p = under ? cleanPath(under) : "";
    if (p) args.push("--", p);
    const rows = (await this.git(args, { cwd: r.dir })).split("\n").filter(Boolean);
    this.step(`Read the history${p ? ` of ${p}` : ""}${query ? ` for “${clip(query, 30)}”` : ""}`);
    if (!rows.length) return "No commits match.";
    return rows
      .map((l) => {
        const [s, author, date, subject] = l.split("\x1f");
        this.seen.add(seenKey(r, `commit/${s}`));
        return `- ${date} ${s} ${author}: ${clip(subject ?? "", 160)}`;
      })
      .join("\n");
  }

  private async pr(n: number | undefined, repo: string | undefined) {
    const [r] = this.pick(repo, false);
    if (!n || n < 1) throw new ProjectError("Give the PR's number.");
    if (!this.github?.pullRequest) throw new ProjectError("Stand can't read PRs here.");
    const token = await this.github.readToken(r.installationId, r.repo);
    const pr = await this.github.pullRequest(r.owner, r.repo, n, token);
    this.step(`Opened PR #${n}`);
    if (!pr) return `There's no PR #${n} in ${r.owner}/${r.repo}.`;
    this.seen.add(seenKey(r, `pull/${n}`));
    const files = pr.files.filter((f) => !hiddenPath(f.path));
    return [
      `PR #${n} in ${r.owner}/${r.repo}: ${pr.title}`,
      `${pr.state}${pr.mergedAt ? ` ${day(pr.mergedAt)}` : ""}, by ${pr.author || "?"}, ${pr.head} into ${pr.base}. Cite: https://github.com/${r.owner}/${r.repo}/pull/${n}`,
      `Description:\n${clip(pr.body.trim(), PR_BODY) || "(none)"}`,
      `Changed files (${files.length}):\n${files
        .slice(0, PR_FILES)
        .map((f) => `- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`)
        .join("\n")}${files.length > PR_FILES ? `\n(+${files.length - PR_FILES} more)` : ""}`,
    ].join("\n\n");
  }

  /** A link the answer gives as a source, checked against what this run saw. For a linked repo: the
   *  link pinned to the commit read, or null when the run never saw that file, PR or commit (dropped).
   *  Undefined for any other link, which isn't the repo's to judge. */
  cite(url: string): string | null | undefined {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return undefined;
    }
    if (u.hostname !== "github.com") return undefined;
    let parts: string[];
    try {
      parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    const [owner = "", name = "", kind, ...rest] = parts;
    const r = this.repos.find((x) => x.owner.toLowerCase() === owner.toLowerCase() && x.repo.toLowerCase() === name.replace(/\.git$/i, "").toLowerCase());
    if (!r) return undefined;
    const base = `https://github.com/${r.owner}/${r.repo}`;
    if (!kind) return base;
    if (kind === "blob" && rest.length >= 2) {
      const p = rest.slice(1).join("/");
      if (hiddenPath(p) || !this.seen.has(seenKey(r, `file/${p}`))) return null;
      return `${blobUrl(r, p)}${/^#L\d+(-L\d+)?$/.test(u.hash) ? u.hash : ""}`;
    }
    if (kind === "pull" && /^\d+$/.test(rest[0] ?? "")) return this.seen.has(seenKey(r, `pull/${rest[0]}`)) ? `${base}/pull/${rest[0]}` : null;
    if (kind === "commit" && /^[0-9a-f]{7,40}$/i.test(rest[0] ?? "")) {
      const s = rest[0].toLowerCase();
      const prefix = seenKey(r, "commit/");
      const known = [...this.seen].some((k) => k.startsWith(prefix) && (s.startsWith(k.slice(prefix.length)) || k.slice(prefix.length).startsWith(s)));
      return known ? `${base}/commit/${s}` : null;
    }
    return null;
  }
}

let shared: Projects | null = null;
/** The server's projects, so a meeting room can hand Ask Stand its space's repo tools. */
export function setProjects(p: Projects | null) {
  shared = p;
}
export function repoTools(roomId: string): RepoTools | null {
  return shared?.tools(roomId) ?? null;
}
