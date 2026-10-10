// Snaps: stills of the shared screen, kept at the size they were shared and
// pinned to the item in focus. Files live next to the database; the rows say
// who took them, whose screen it was, and what the agent saw on it.

import fs from "node:fs";
import path from "node:path";
import type { Discussion, Segment, Snap } from "../shared/protocol.ts";
import { config } from "./config.ts";

export const MAX_SNAP_BYTES = 15 * 1024 * 1024;

/** A snap as stored, before it's matched to the talk around it. */
export type SnapRow = Omit<Snap, "url" | "discussionId" | "segmentIds"> & {
  roomId: string;
  ext: string;
  version: number;
  /** The topic the recap placed it under; otherwise the remarks around it decide. */
  topicId?: string | null;
};

const dir = () => path.join(config.dataDir, "snaps");

export function saveSnapFile(id: string, ext: string, buf: Buffer) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${id}.${ext}`), buf);
}

export function snapFile(id: string, ext: string): string | null {
  if (!/^[a-z0-9]+$/.test(id) || !/^(png|jpg|webp)$/.test(ext)) return null;
  const p = path.join(dir(), `${id}.${ext}`);
  return fs.existsSync(p) ? p : null;
}

export function removeSnapFile(id: string, ext: string) {
  const p = snapFile(id, ext);
  if (p) fs.rmSync(p, { force: true });
}

/** Remarks this close to a snap count as said about it. */
const NEAR_MS = 45_000;
/** With nothing that close, the topic of the nearest remark within this. */
const TOPIC_MS = 120_000;

/** Matches each snap to the remarks spoken around it and the topic they belong to,
 *  unless the recap already placed it. Topics are redrafted as the meeting goes
 *  on, so this runs on every read. */
export function linkSnaps(rows: SnapRow[], segments: Segment[], discussions: Discussion[], baseUrl = ""): Snap[] {
  return rows.map(({ roomId: _r, ext, version, topicId, ...s }) => {
    const onItem = segments.filter((g) => g.itemId === s.itemId);
    const byDistance = onItem.map((g) => ({ g, d: Math.abs(g.ts - s.ts) })).sort((a, b) => a.d - b.d);
    const near = byDistance.filter((x) => x.d <= NEAR_MS).slice(0, 6);
    const pool = near.length ? near : byDistance.filter((x) => x.d <= TOPIC_MS).slice(0, 1);
    const topicOf = (segId: string) => discussions.find((d) => d.itemId === s.itemId && d.segmentIds.includes(segId))?.id ?? null;
    const votes = new Map<string, number>();
    for (const { g } of pool) {
      const t = topicOf(g.id);
      if (t) votes.set(t, (votes.get(t) ?? 0) + 1);
    }
    const placed = topicId && discussions.some((d) => d.id === topicId) ? topicId : null;
    const discussionId = placed ?? [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      ...s,
      url: `${baseUrl}/api/snaps/${s.id}.${ext}?v=${version}`,
      discussionId,
      segmentIds: near
        .map((x) => x.g)
        .sort((a, b) => a.ts - b.ts)
        .map((g) => g.id),
    };
  });
}
