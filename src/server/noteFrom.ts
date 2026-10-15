// Where a to-do, decision or question came from, for the space page, which lists them across
// meetings: the meeting, and the chapter its recap files it under (the same chapters the recap and
// the chapter bar show), so the space page can carry the recap's chapter pill.

import { meetingChapters } from "../shared/chapters.ts";
import type { Note, NoteFrom } from "../shared/protocol.ts";
import type { DB } from "./db.ts";

/** A finished meeting's chapters barely change, and the space page asks every 20 seconds. */
const KEEP_MS = 5 * 60_000;
const cache = new Map<string, { at: number; startedAt: number; byTopic: Map<string, NonNullable<NoteFrom["chapter"]>> }>();

function chaptersOf(db: DB, meetingId: string) {
  const hit = cache.get(meetingId);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit;
  const m = db.getMeeting(meetingId);
  if (!m) return null;
  const segments = db.meetingSegments(meetingId).sort((a, b) => a.ts - b.ts);
  const end = m.endedAt ?? segments.at(-1)?.ts ?? m.startedAt;
  const written = new Map((m.chapters ?? []).map((c) => [c.key, c]));
  const byTopic = new Map<string, NonNullable<NoteFrom["chapter"]>>();
  meetingChapters(db.meetingDiscussions(meetingId), segments, end).forEach((c, i) => {
    const chapter = { i, title: c.title, at: c.start, minutes: Math.max(1, Math.round(c.minutes)), outcome: c.outcome, crux: written.get(c.key)?.crux || null };
    for (const id of c.topicIds) byTopic.set(id, chapter);
  });
  const entry = { at: Date.now(), startedAt: m.startedAt, byTopic };
  // Only finished meetings keep: a live one's chapters move with every remark.
  if (m.endedAt) cache.set(meetingId, entry);
  return entry;
}

/** The notes with where each came from. */
export function withFrom<N extends Note>(db: DB, notes: N[]): Array<N & { from?: NoteFrom }> {
  return notes.map((n) => {
    const m = chaptersOf(db, n.meetingId);
    if (!m) return n;
    return { ...n, from: { meetingId: n.meetingId, startedAt: m.startedAt, chapter: (n.discussionId && m.byTopic.get(n.discussionId)) || null } };
  });
}
