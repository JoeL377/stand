// A meeting's timeline (shared/timeline.ts), read from what each part already keeps: segments
// (speech and chat), notes (what Stand caught), the Ask Stand cards, the focus log, and the reports
// agents posted to the space while the meeting ran. The live call builds the same thing in the page.

import { buildTimeline, type TimelineEntry } from "../shared/timeline.ts";
import type { DB } from "./db.ts";

export { buildTimeline, itemKey } from "../shared/timeline.ts";

export function meetingTimeline(db: DB, meetingId: string): TimelineEntry[] {
  const m = db.getMeeting(meetingId);
  if (!m) return [];
  return buildTimeline({
    meeting: m,
    segments: db.meetingSegments(m.id),
    notes: db.meetingNotes(m.id),
    discussions: db.meetingDiscussions(m.id),
    cards: db.meetingAgentCards(m.id) ?? [],
    focus: db.focusEvents(m.id),
    updates: db.roomUpdates(m.roomId, m.startedAt, 1000),
    itemById: (id) => db.getItem(id),
    stage: db.stageEvents(m.id),
    snaps: db.meetingSnaps(m.id).map((p) => ({ id: p.id, ts: p.ts, caption: p.caption, url: `/api/snaps/${p.id}.${p.ext}?v=${p.version}` })),
  });
}
