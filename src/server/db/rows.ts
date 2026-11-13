// Reading rows: each table's row as the rest of the server sees it, and the types and SQL they share.
import { createHash } from "node:crypto";
import { type Actor, parseActor } from "../../shared/actors.ts";
import type { DesignOutcome, DesignRole } from "../../shared/designReview.ts";
import type { AgentToken, BrainNode, Deck, DeckTheme, DesignContext, DesignDiagram, Discussion, DiscussionOutcome, IdeaOutcome, IdeaSlideInfo, Item, ItemSource, ItemUpdate, Jot, Note, NoteKind, Quote, ReviewOutcome, Segment, SegmentKind, TaskState, UpdateStatus, User, WorkShot } from "../../shared/protocol.ts";
import type { BrainstormRow } from "../brainstorm.ts";
import type { SnapRow } from "../snaps.ts";

/** Reads a discussion with the earlier one it continues, if any. */
export const DISCUSSION_SELECT = `SELECT d.*, c.meeting_id AS c_meeting_id, c.topic AS c_topic, cm.started_at AS c_started_at,
  tm.parent_id AS merged_into, tm.group_title AS merge_group
  FROM discussions d LEFT JOIN discussions c ON c.id = d.continues_id LEFT JOIN meetings cm ON cm.id = c.meeting_id
  LEFT JOIN topic_merges tm ON tm.meeting_id = d.meeting_id AND tm.discussion_id = d.id`;

/** id: keep this one's id, for a topic carried over as it was (see settle.ts). */
export type DraftDiscussion = Pick<Discussion, "topic" | "positions" | "outcome" | "segmentIds"> & { continuesId: string | null; id?: string };

export type Row = Record<string, unknown>;

/** The notes columns that hold where a task stands (shared/tasks.ts), in one order. */
export const TASK_COLS = "state, done_when, parent_id, closed_by, drop_reason, said_done_json, checked_at";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const toUser = (r: Row): User => ({
  id: r.id as string,
  email: r.email as string,
  name: r.name as string,
  picture: (r.picture as string) ?? null,
});

export const toItem = (r: Row): Item => ({
  id: r.id as string,
  roomId: r.room_id as string,
  source: r.source as ItemSource,
  externalId: (r.external_id as string) ?? null,
  title: r.title as string,
  url: (r.url as string) ?? null,
  description: (r.description as string) ?? null,
  position: r.position as number,
  deckId: (r.deck_id as string) ?? null,
  slideNo: (r.slide_no as number) ?? null,
  slide: r.slide_json ? JSON.parse(r.slide_json as string) : null,
  taskId: (r.note_id as string) ?? null,
  projectId: (r.project_id as string) ?? null,
  ...(r.shows_project ? { showsProject: true } : {}),
});

export const toDeck = (r: Row): Deck => ({
  id: r.id as string,
  roomId: r.room_id as string,
  title: r.title as string,
  pageCount: r.page_count as number,
  kind: ((r.kind as string) ?? "pdf") as Deck["kind"],
  theme: ((r.theme as string) ?? "paper") as DeckTheme,
  parentItemId: (r.parent_item_id as string) ?? null,
  reviewId: (r.review_id as string) ?? null,
});

/** A product review and one of its slides, as stored (reviews.ts turns them into what people see).
 *  A design review (designReviews.ts) is kept the same way, with a spec where a feature would be. */
export type ReviewKind = "product" | "design" | "ideas";
export interface ReviewRow {
  id: string;
  roomId: string;
  kind: ReviewKind;
  status: "draft" | "live" | "done";
  deckId: string | null;
  meetingId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Idea reviews (ideaReview.ts): what it is called, and the brainstorm its ideas come from. */
  title: string | null;
  sourceId: string | null;
}
export interface ReviewSlideRow {
  id: string;
  reviewId: string;
  position: number;
  title: string;
  /** What people call it, in two or three words; null when nobody named it. */
  name: string | null;
  body: string;
  noteId: string | null;
  owner: string | null;
  addedBy: string | null;
  pr: string | null;
  itemId: string | null;
  /** A product review's slide ends Ship, Ship with fixes or Not yet; a design review's point and verdict have their own. */
  outcome: ReviewOutcome | DesignOutcome | IdeaOutcome | null;
  outcomeBy: string | null;
  outcomeAt: number | null;
  createdAt: number;
  /** Design reviews: what the slide is. A spec waiting on the next review is its overview; the
   *  sections, points and verdict join when the review starts. */
  role: DesignRole | null;
  /** Design reviews: the plan version under review. */
  planVersion: string | null;
  /** Design reviews: the heading of a section slide, and of the section a point is in. */
  section: string | null;
  /** Design reviews: the comment thread a point slide is about. */
  threadId: string | null;
  /** Idea reviews: the idea the slide shows, as the brainstorm left it. */
  idea: IdeaSlideSaved | null;
}
/** An idea on a slide, as stored: its outcome is the slide's own. */
export type IdeaSlideSaved = Omit<IdeaSlideInfo, "outcome" | "outcomeBy">;
export const toReview = (r: Row): ReviewRow => ({
  id: r.id as string,
  roomId: r.room_id as string,
  kind: ((r.kind as string) ?? "product") as ReviewKind,
  status: r.status as ReviewRow["status"],
  deckId: (r.deck_id as string) ?? null,
  meetingId: (r.meeting_id as string) ?? null,
  createdAt: r.created_at as number,
  startedAt: (r.started_at as number) ?? null,
  endedAt: (r.ended_at as number) ?? null,
  title: (r.title as string) ?? null,
  sourceId: (r.source_id as string) ?? null,
});
export const toBrainstorm = (r: Row): BrainstormRow => ({
  id: r.id as string,
  roomId: r.room_id as string,
  prompt: r.prompt as string,
  status: r.status as BrainstormRow["status"],
  itemId: (r.item_id as string) ?? null,
  meetingId: (r.meeting_id as string) ?? null,
  startedBy: (r.started_by as string) ?? null,
  startedAt: r.started_at as number,
  endedAt: (r.ended_at as number) ?? null,
  nodes: r.map_json ? (JSON.parse(r.map_json as string) as BrainNode[]) : [],
  kind: r.kind === "design" ? "design" : "map",
  diagram: r.diagram_json ? (JSON.parse(r.diagram_json as string) as DesignDiagram) : null,
  seed: (r.seed as string) ?? null,
  taskId: (r.task_id as string) ?? null,
  context: r.context_json ? (JSON.parse(r.context_json as string) as DesignContext[]) : [],
  starred: r.stars_json ? (JSON.parse(r.stars_json as string) as string[]) : [],
  threadId: (r.thread_id as string) ?? null,
  spans: r.spans_json ? (JSON.parse(r.spans_json as string) as Array<[number, number]>) : null,
  sketch: r.sketch_json ? (JSON.parse(r.sketch_json as string) as BrainstormRow["sketch"]) : null,
});
export const toReviewSlide = (r: Row): ReviewSlideRow => ({
  id: r.id as string,
  reviewId: r.review_id as string,
  position: r.position as number,
  title: r.title as string,
  name: (r.name as string) ?? null,
  body: r.body as string,
  noteId: (r.note_id as string) ?? null,
  owner: (r.owner as string) ?? null,
  addedBy: (r.added_by as string) ?? null,
  pr: (r.pr as string) ?? null,
  itemId: (r.item_id as string) ?? null,
  outcome: ((r.outcome as string) ?? null) as ReviewSlideRow["outcome"],
  outcomeBy: (r.outcome_by as string) ?? null,
  outcomeAt: (r.outcome_at as number) ?? null,
  createdAt: r.created_at as number,
  role: ((r.role as string) ?? null) as ReviewSlideRow["role"],
  planVersion: (r.plan_version as string) ?? null,
  section: (r.section as string) ?? null,
  threadId: (r.thread_id as string) ?? null,
  idea: r.idea_json ? (JSON.parse(r.idea_json as string) as IdeaSlideSaved) : null,
});

export type NewItem = Pick<Item, "source" | "externalId" | "title" | "url" | "description"> & { deckId?: string; slideNo?: number };

export const toSegment = (r: Row): Segment => ({
  id: r.id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  speakerId: r.speaker_id as string,
  speakerName: r.speaker_name as string,
  kind: r.kind as SegmentKind,
  text: r.text as string,
  ts: r.ts as number,
});

export const toSnapRow = (r: Row): SnapRow => ({
  id: r.id as string,
  roomId: r.room_id as string,
  meetingId: (r.meeting_id as string) ?? null,
  itemId: (r.item_id as string) ?? null,
  itemSuggested: !!r.item_suggested,
  ts: r.ts as number,
  ext: r.ext as string,
  version: r.version as number,
  width: r.width as number,
  height: r.height as number,
  source: r.source as SnapRow["source"],
  takenById: (r.taken_by_id as string) ?? null,
  takenBy: r.taken_by as string,
  sharerId: (r.sharer_id as string) ?? null,
  sharerName: (r.sharer_name as string) ?? null,
  caption: (r.caption as string) ?? null,
  noteId: (r.note_id as string) ?? null,
  topicId: (r.discussion_id as string) ?? null,
  line: (r.line as string) ?? null,
  screenText: (r.screen_text as string) ?? null,
  jotId: (r.jot_id as string) ?? null,
});

export const toJot = (r: Row): Jot => ({
  id: r.id as string,
  roomId: r.room_id as string,
  itemId: (r.item_id as string) ?? null,
  itemSuggested: !!r.item_suggested,
  text: r.text as string,
  byId: (r.by_id as string) ?? null,
  by: r.by_name as string,
  ts: r.ts as number,
});

export const toNote = (r: Row): Note => ({
  ...(r.project_set_by != null ? { projectId: (r.project_id as string) ?? null, projectSetBy: r.project_set_by as string } : {}),
  ...(r.suggested_project_id != null ? { suggestedProjectId: r.suggested_project_id as string } : {}),
  ...(r.project_judged_at != null ? { projectJudgedAt: r.project_judged_at as number } : {}),
  id: r.id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  kind: r.kind as NoteKind,
  text: r.text as string,
  owner: (r.owner as string) ?? null,
  ts: r.ts as number,
  doneAt: (r.done_at as number) ?? null,
  doneBy: (r.done_by as string) ?? null,
  doneActor: r.done_actor_json ? (JSON.parse(r.done_actor_json as string) as Actor) : parseActor(r.done_by as string | null),
  addedActor: r.added_actor_json ? (JSON.parse(r.added_actor_json as string) as Actor) : null,
  discussionId: (r.discussion_id as string) ?? null,
  editedBy: (r.edited_by as string) ?? null,
  quote: r.quote_json ? (JSON.parse(r.quote_json as string) as Quote) : null,
  state: (r.state as TaskState) ?? null,
  doneWhen: (r.done_when as string) ?? null,
  parentId: (r.parent_id as string) ?? null,
  closedBy: (r.closed_by as string) ?? null,
  dropReason: (r.drop_reason as string) ?? null,
  saidDone: r.said_done_json ? (JSON.parse(r.said_done_json as string) as Quote) : null,
  checkedAt: (r.checked_at as number) ?? null,
});

/** An update's actor when nothing richer was given, and for rows saved before actors were kept. */
export const actorOfUpdate = (name: string, client: string | null, userId?: string): Actor | null => {
  const actor = parseActor(client ? `${name} via ${client}` : name);
  return actor && userId && actor.kind !== "github" ? { ...actor, personId: userId } : actor;
};

export const toUpdate = (r: Row): ItemUpdate => ({
  id: r.id as string,
  roomId: r.room_id as string,
  itemId: (r.item_id as string) ?? null,
  noteId: (r.note_id as string) ?? null,
  noteText: (r.note_text as string) ?? null,
  userName: r.user_name as string,
  client: (r.client as string) ?? null,
  actor: r.actor_json ? (JSON.parse(r.actor_json as string) as Actor) : actorOfUpdate(r.user_name as string, (r.client as string) ?? null, r.user_id as string),
  status: r.status as UpdateStatus,
  text: r.text as string,
  links: JSON.parse(r.links_json as string),
  ts: r.ts as number,
});

export const toWorkShot = (r: Row): WorkShot => ({
  id: r.id as string,
  noteId: r.note_id as string,
  updateId: (r.update_id as string) ?? null,
  userName: r.user_name as string,
  client: (r.client as string) ?? null,
  caption: (r.caption as string) ?? null,
  ext: r.ext as string,
  ts: r.ts as number,
});

export const toToken = (r: Row): AgentToken => ({
  id: r.id as string,
  label: r.label as string,
  scope: r.scope as AgentToken["scope"],
  hint: r.hint as string,
  createdAt: r.created_at as number,
  lastUsedAt: (r.last_used_at as number) ?? null,
});

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const toDiscussion = (r: Row): Discussion => ({
  id: r.id as string,
  meetingId: r.meeting_id as string,
  itemId: (r.item_id as string) ?? null,
  topic: r.topic as string,
  positions: JSON.parse(r.positions_json as string),
  outcome: r.outcome as DiscussionOutcome,
  segmentIds: JSON.parse(r.segment_ids_json as string),
  continues: r.c_meeting_id
    ? { id: r.continues_id as string, meetingId: r.c_meeting_id as string, startedAt: r.c_started_at as number, topic: r.c_topic as string }
    : null,
  mergedInto: (r.merged_into as string) ?? null,
  group: (r.merge_group as string) ?? null,
  ts: r.ts as number,
});

export interface OpenMeeting {
  id: string;
  roomId: string;
  startedAt: number;
  /** Who was hosting when it last ran. */
  hostId: string | null;
  endRequestedAt: number | null;
  segmentCount: number;
  /** When anything last happened in it: speech, a focus change or a note. */
  activeAt: number;
}
