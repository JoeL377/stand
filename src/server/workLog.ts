// What agents do on a to-do, as people see it on the to-do: "working" while an
// agent is on it, and a log of what it reported, with the screenshots it
// attached. Agents report through the MCP (post_update, complete_action);
// screenshots come in through a short-lived upload link the MCP hands out, since
// an agent can't put a file into a tool call but can run curl.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ActionWork, ItemUpdate, WorkShot } from "../shared/protocol.ts";
import { config } from "./config.ts";

/** An agent that has said nothing for this long is taken to have stopped. */
export const WORKING_QUIET_MS = 30 * 60_000;
/** How long an upload link works, and how many screenshots it takes. */
export const UPLOAD_LINK_MS = 30 * 60_000;
export const UPLOAD_LINK_MAX = 10;
export const MAX_SHOT_BYTES = 10 * 1024 * 1024;

const by = (u: { userName: string; client: string | null }) => (u.client ? `${u.userName} via ${u.client}` : u.userName);

/** Who is on the to-do right now, if anyone: an agent whose latest word was "working" or progress,
 *  not long ago, on a to-do that isn't checked off. */
export function workingOn(updates: ItemUpdate[], done: boolean, now = Date.now()): ActionWork["working"] {
  const last = updates.at(-1);
  if (done || !last || !last.client || (last.status !== "working" && last.status !== "progress")) return null;
  if (now - last.ts > WORKING_QUIET_MS) return null;
  // The run started at the first of the unbroken working/progress reports leading up to now.
  let start = updates.length - 1;
  while (start > 0 && (updates[start - 1].status === "working" || updates[start - 1].status === "progress")) start--;
  return { by: by(last), since: updates[start].ts, text: last.text };
}

/** The log of one to-do, newest first: each report with the screenshots that came with it, and any
 *  screenshots no report has picked up yet as an entry of their own. */
export function workLog(updates: ItemUpdate[], shots: WorkShot[]): ActionWork["log"] {
  const shotView = (s: WorkShot) => ({ url: shotUrl(s), caption: s.caption });
  const entries: ActionWork["log"] = updates.map((u) => ({
    id: u.id,
    by: by(u),
    status: u.status,
    text: u.text,
    links: u.links,
    shots: shots.filter((s) => s.updateId === u.id).map(shotView),
    ts: u.ts,
  }));
  const loose = shots.filter((s) => !s.updateId || !updates.some((u) => u.id === s.updateId));
  if (loose.length)
    entries.push({ id: `shots-${loose[0].id}`, by: by(loose[0]), status: "shots", text: "", links: [], shots: loose.map(shotView), ts: loose.at(-1)!.ts });
  return entries.sort((a, b) => b.ts - a.ts);
}

export const shotUrl = (s: Pick<WorkShot, "id" | "ext">, baseUrl = "") => `${baseUrl}/api/work-shots/${s.id}.${s.ext}`;

// ---- files ------------------------------------------------------------------

const dir = () => path.join(config.dataDir, "work-shots");

export function saveShotFile(id: string, ext: string, buf: Buffer) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${id}.${ext}`), buf);
}

export function shotFile(id: string, ext: string): string | null {
  if (!/^[a-z0-9]+$/.test(id) || !/^(png|jpg|webp|gif)$/.test(ext)) return null;
  const p = path.join(dir(), `${id}.${ext}`);
  return fs.existsSync(p) ? p : null;
}

// ---- upload links -----------------------------------------------------------

export interface UploadGrant {
  roomId: string;
  noteId: string;
  userId: string;
  userName: string;
  client: string | null;
  expires: number;
  left: number;
}

/** Upload links live in memory: one instance, and a link is only good for half an hour anyway. */
export class UploadLinks {
  private grants = new Map<string, UploadGrant>();

  create(g: Omit<UploadGrant, "expires" | "left">, now = Date.now()): string {
    for (const [k, v] of this.grants) if (v.expires < now) this.grants.delete(k);
    const secret = randomBytes(24).toString("base64url");
    this.grants.set(secret, { ...g, expires: now + UPLOAD_LINK_MS, left: UPLOAD_LINK_MAX });
    return secret;
  }

  /** Spends one upload on the link; null when it's unknown, expired or used up. */
  use(secret: string, now = Date.now()): UploadGrant | null {
    const g = this.grants.get(secret);
    if (!g || g.expires < now || g.left <= 0) return null;
    g.left--;
    return g;
  }
}
