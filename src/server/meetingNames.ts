// What a meeting is called: the name someone gave it, or else the name its kind gives it, the same
// way the Meetings tab reads it (an idea review over a product review over a design review over a
// brainstorm or design session, and "Meeting" when it was none of them).

import type { DB } from "./db.ts";

/** Longest name a meeting takes: one line on the Meetings tab. */
export const MEETING_TITLE_MAX = 80;

/** The name a meeting's kind gives it, before anyone names it. */
export function meetingKindName(db: DB, meetingId: string): string {
  if (db.reviewByMeeting(meetingId, "ideas")?.status === "done") return "Idea review";
  if (db.reviewByMeeting(meetingId, "product")) return "Product review";
  if (db.reviewByMeeting(meetingId, "design")) return "Design review";
  const b = db.brainstormByMeeting(meetingId);
  if (b?.status === "done") return b.kind === "design" ? "Design session" : "Brainstorm";
  return "Meeting";
}

/** A name as someone typed it: one line, trimmed, at most MEETING_TITLE_MAX characters. Null when blank. */
export function cleanMeetingTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const one = title.replace(/\s+/g, " ").trim();
  return one ? one.slice(0, MEETING_TITLE_MAX) : null;
}
