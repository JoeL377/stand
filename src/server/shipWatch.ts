// When an agent finishes a to-do as a pull request, it reports the to-do "ready" with the PR's link
// and Stand takes it from there: every couple of minutes it asks GitHub about the PRs of to-dos
// still waiting, checks a to-do off when its PR merges, and says so in the to-do's log when the PR
// is closed without merging. So nobody has to remember to come back and tick it once it ships.

import type { ItemUpdate } from "../shared/protocol.ts";
import type { DB } from "./db.ts";
import type { ClosedPr } from "./github.ts";
import { prOf } from "./workLog.ts";

export const SHIP_CHECK_MS = 2 * 60_000;

export type PrState = "open" | "merged" | "closed";

/** Asks GitHub whether a PR is open, merged or closed; null when it can't tell (no access, a hiccup). */
export async function githubPrState(
  link: string,
  token: string | undefined,
  get: typeof fetch = fetch,
): Promise<PrState | null> {
  const pr = prOf(link);
  if (!pr) return null;
  const res = await get(
    `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "stand",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
  };
  if (body.merged || body.merged_at) return "merged";
  return body.state === "closed" ? "closed" : "open";
}

export class ShipWatch {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private again = false;
  /** PRs Stand couldn't read, so the log says so once, not every couple of minutes. */
  private unreadable = new Set<string>();

  constructor(
    private db: DB,
    private notify: (roomId: string) => void,
    private prState: (link: string) => Promise<PrState | null>,
  ) {}

  start() {
    this.timer = setInterval(() => void this.check(), SHIP_CHECK_MS);
    this.timer.unref();
    void this.check();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One pass over the to-dos waiting to ship. Safe to call any time: a call while a pass runs
   *  makes it go round once more, so a to-do reported ready mid-pass isn't left for the next round. */
  async check() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private async pass() {
    for (const u of this.db.readyToShip()) {
      const pr = u.links.find((l) => prOf(l));
      if (!pr || !u.noteId) continue;
      let state: PrState | null = null;
      try {
        state = await this.prState(pr);
      } catch {
        state = null;
      }
      if (state === null) {
        if (!this.unreadable.has(pr))
          console.warn(
            `[ship] can't read ${pr} (private repo the Stand GitHub App isn't installed on?)`,
          );
        this.unreadable.add(pr);
        continue;
      }
      this.unreadable.delete(pr);
      if (state !== "open") this.close(u, pr, state === "merged");
    }
  }

  /** GitHub said a PR closed (the Stand GitHub App's webhook): settle the to-dos reported ready with
   *  it now, and on a merge check off any open to-do whose ref is in the PR's description, so one
   *  the agent forgot to report still ships. */
  settle(pr: ClosedPr) {
    const same = (link: string) => samePr(link, pr.url);
    const settled = new Set<string>();
    for (const u of this.db.readyToShip()) {
      const link = u.links.find(same);
      if (!link || !u.noteId) continue;
      this.close(u, link, pr.merged);
      settled.add(u.noteId);
    }
    if (!pr.merged) return;
    for (const id of refsIn(pr.body)) {
      const n = this.db.getNote(id);
      if (!n || n.kind !== "action" || n.doneAt || settled.has(id)) continue;
      const who = { userId: "github", userName: pr.author, client: "GitHub" };
      if (!this.db.setActionDone(n.roomId, n.id, `${pr.author} via GitHub`, `pr:${pr.url}`)) continue;
      this.db.addUpdate({
        roomId: n.roomId,
        itemId: n.itemId,
        noteId: n.id,
        noteText: n.text,
        ...who,
        status: "done",
        text: `Shipped: ${prLabel(pr.url)} merged.`,
        links: [pr.url],
      });
      this.notify(n.roomId);
    }
  }

  private close(u: ItemUpdate & { userId: string }, pr: string, merged: boolean) {
    if (!u.noteId) return;
    const who = {
      roomId: u.roomId,
      itemId: u.itemId,
      noteId: u.noteId,
      noteText: u.noteText,
      userId: u.userId,
      userName: u.userName,
      client: u.client,
    };
    if (merged) {
      const by = u.client ? `${u.userName} via ${u.client}` : u.userName;
      if (!this.db.setActionDone(u.roomId, u.noteId, by, `pr:${pr}`)) return;
      this.db.addUpdate({
        ...who,
        status: "done",
        text: `Shipped: ${prLabel(pr)} merged. ${u.text}`.trim(),
        links: u.links,
      });
    } else {
      this.db.addUpdate({
        ...who,
        status: "blocked",
        text: `${prLabel(pr)} was closed without merging, so this to-do is still open.`,
        links: u.links,
      });
    }
    this.notify(u.roomId);
  }
}

/** Two links to the same pull request (case, a trailing /files and the like aside). */
export function samePr(a: string, b: string): boolean {
  const x = prOf(a);
  const y = prOf(b);
  return !!x && !!y && x.number === y.number && x.owner.toLowerCase() === y.owner.toLowerCase() && x.repo.toLowerCase() === y.repo.toLowerCase();
}

/** To-do ids named in a PR description: stand:action/<id>, or a Stand /ref/action/<id> link. */
export function refsIn(text: string): string[] {
  const ids = [...text.matchAll(/(?:stand:action\/|\/ref\/action\/)([a-z0-9]{4,24})\b/g)].map((m) => m[1]);
  return [...new Set(ids)].slice(0, 20);
}

const prLabel = (link: string) => {
  const pr = prOf(link);
  return pr ? `PR #${pr.number}` : "The PR";
};
