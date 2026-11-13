import type { PlanReview, PlanThread } from "../shared/planReview.ts";
import type { BriefChange, DesignReviewRan, DesignReviewRecord, DesignReviewState, DesignReviewView, DesignSpec, PlanBrief } from "../shared/designReview.ts";
import type { ChatCaught, ChatMessage, ChatSession, ChatThread } from "../shared/chat.ts";
import type { DraftSlide } from "../shared/outline.ts";
import type { Project } from "../shared/projects.ts";
import type { ChatNotify, NotifyStatus } from "../shared/push.ts";
import { phoneApp } from "./phoneApp.ts";
import type {
  BrainstormSummary,
  BrainstormView,
  ReviewSummary,
  ReviewView,
  ActionWork,
  AgentToken,
  Capabilities,
  Deck,
  DeckDraft,
  DeckHistory,
  FollowUp,
  GithubStatus,
  Item,
  ItemHistory,
  Jot,
  MeetingRecap,
  Note,
  QuestionClose,
  QuestionClosed,
  SourcesStatus,
  Snap,
  SpaceCost,
  SpaceFeed,
  SpaceMembers,
  SpaceSummary,
  TaskDetail,
  UpNext,
  User,
} from "../shared/protocol.ts";

/** Thrown when the server can't be reached at all, as opposed to saying no. */
export class OfflineError extends Error {
  constructor() {
    super("Can't reach Stand. Check your connection and try again.");
  }
}

/** Long enough for a slow network, short enough that a dead one doesn't look like a hang. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Claude drafting a deck, or a Linear import, takes a while; that isn't the network being down. */
const SLOW_REQUEST_MS = 120_000;

/** fetch, with a dead network, a timeout or a gateway answering for a server that's down
 *  turned into a plain message. For uploads and other calls that don't go through `call`. */
export async function request(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  let res: Response;
  try {
    // Older Safari has no AbortSignal.timeout; it just waits.
    res = await fetch(url, { ...init, signal: AbortSignal.timeout?.(timeoutMs) });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new Error("Stand is taking too long to answer. Try again in a moment.");
    throw new OfflineError();
  }
  const json = res.headers.get("content-type")?.includes("json");
  if ([502, 503, 504].includes(res.status) || (res.status === 500 && !json)) throw new OfflineError();
  return res;
}

async function call<T>(method: string, url: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const res = await request(
    url,
    { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined },
    timeoutMs,
  );
  const json = res.headers.get("content-type")?.includes("json");
  const data = json ? await res.json().catch(() => ({})) : {};
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    // Session expired: send them through sign-in and back here.
    location.reload();
  }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface RoomInfo {
  id: string;
  name: string;
  purpose: string;
  synthesisInstructions: string;
  items: Item[];
  decks: Deck[];
  /** The space's projects in order, archived ones too. */
  projects: Project[];
  people: Array<{ name: string; picture: string | null }>;
  meetings: Array<{ id: string; startedAt: number; endedAt: number | null; summary: string | null; segmentCount: number }>;
  /** Open action items from the room's past meetings. */
  followUps: FollowUp[];
  /** To-dos already checked off, most recently done first (the space page's To do tab folds them). */
  doneFollowUps?: FollowUp[];
  liveMeetingId: string | null;
}

export const api = {
  work: (ids: string[]) => call<Record<string, ActionWork>>("GET", `/api/work?ids=${ids.join(",")}`),
  tokens: () => call<AgentToken[]>("GET", "/api/tokens"),
  createToken: (label: string, scope: AgentToken["scope"]) => call<{ token: string; info: AgentToken }>("POST", "/api/tokens", { label, scope }),
  revokeToken: (id: string) => call<{ ok: true }>("DELETE", `/api/tokens/${id}`),
  github: () => call<GithubStatus>("GET", "/api/github"),
  sources: (roomId: string) => call<SourcesStatus>("GET", `/api/rooms/${roomId}/sources`),
  /** Linking clones the repo first, which can take a while. */
  linkSource: (roomId: string, repo: string) => call<SourcesStatus>("POST", `/api/rooms/${roomId}/sources`, { repo }, SLOW_REQUEST_MS),
  pullSource: (roomId: string, owner: string, repo: string) =>
    call<SourcesStatus>("POST", `/api/rooms/${roomId}/sources/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull`, {}, SLOW_REQUEST_MS),
  unlinkSource: (roomId: string, owner: string, repo: string) =>
    call<SourcesStatus>("DELETE", `/api/rooms/${roomId}/sources/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`),
  locateRef: (kind: string, id: string) => call<{ meetingId: string; roomId: string; itemId: string | null; added?: boolean }>("GET", `/api/refs/${kind}/${id}`),
  refPrompt: (kind: string, id: string) => call<{ text: string }>("GET", `/api/refs/${kind}/${id}/prompt`),
  config: () => call<Capabilities>("GET", "/api/config"),
  me: () => call<User>("GET", "/api/auth/me"),
  devSignIn: (name: string, email: string) => call<User>("POST", "/api/auth/dev", { name, email }),
  // In the iPhone app, its phone stops getting notifications for whoever signs out.
  signOut: () => call<{ ok: true }>("POST", "/api/auth/logout", { pushToken: phoneApp()?.pushToken }),
  createRoom: (name: string, purpose = "") => call<{ id: string; name: string }>("POST", "/api/rooms", { name, purpose }),
  spaces: () => call<SpaceSummary[]>("GET", "/api/spaces"),
  updateSpace: (id: string, patch: { name?: string; purpose?: string; synthesisInstructions?: string }) =>
    call<{ id: string; name: string; purpose: string; synthesisInstructions: string }>("PATCH", `/api/rooms/${id}`, patch),
  members: (roomId: string) => call<SpaceMembers>("GET", `/api/rooms/${roomId}/members`),
  setAdmin: (roomId: string, userId: string, admin: boolean) => call<SpaceMembers>("PUT", `/api/rooms/${roomId}/members/${userId}`, { admin }),
  /** What Stand spent for the space over the last `days` days, by day in this browser's time. */
  spaceCost: (roomId: string, days: number) => call<SpaceCost>("GET", `/api/rooms/${roomId}/cost?days=${days}&tz=${-new Date().getTimezoneOffset()}`),
  room: (id: string) => call<RoomInfo>("GET", `/api/rooms/${id}`),
  feed: (id: string) => call<SpaceFeed>("GET", `/api/rooms/${id}/feed`),
  updateSnap: (id: string, patch: { itemId?: string | null; line?: string | null }) => call<Snap>("PATCH", `/api/snaps/${id}`, patch),
  updateJot: (id: string, patch: { itemId?: string | null; text?: string }) => call<Jot>("PATCH", `/api/jots/${id}`, patch),
  /** Archives a row off the space page ("todo:<id>", see server/archive.ts), or restores it. */
  archive: (roomId: string, body: { ref: string; archived?: boolean; title?: string; keys?: string[] }) =>
    call<{ ok: true }>("POST", `/api/rooms/${roomId}/archive`, body),
  deleteJot: (id: string) => call<{ ok: true }>("DELETE", `/api/jots/${id}`),
  /** Brings back a note deleted in the last minute, with its snaps. */
  restoreJot: (id: string) => call<Jot>("POST", `/api/jots/${id}/restore`),
  addAgenda: (roomId: string, titles: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items`, { titles }),
  importLinear: (roomId: string, input: string) => call<Item[]>("POST", `/api/rooms/${roomId}/items/linear`, { input }, SLOW_REQUEST_MS),
  removeItem: (roomId: string, itemId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/items/${itemId}`),
  restoreItems: (roomId: string, ids: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items/restore`, { ids }),
  removeDeck: (roomId: string, deckId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/decks/${deckId}`),
  newDeck: (roomId: string, title: string, brief: string, parentItemId: string | null = null) =>
    call<{ deck: Deck; slides: Item[] }>("POST", `/api/rooms/${roomId}/decks/new`, { title, brief, parentItemId }, SLOW_REQUEST_MS),
  deck: (deckId: string) => call<{ deck: Deck; room: { id: string; name: string } | null; slides: Item[] }>("GET", `/api/decks/${deckId}`),
  saveDeck: (deckId: string, draft: DeckDraft) => call<{ deck: Deck; slides: Item[] }>("PUT", `/api/decks/${deckId}`, draft),
  draftSlides: (deckId: string, brief: string) =>
    call<{ slides: DraftSlide[] }>("POST", `/api/decks/${deckId}/draft`, { brief }, SLOW_REQUEST_MS),
  deckHistory: (deckId: string) => call<DeckHistory>("GET", `/api/decks/${deckId}/history`),
  itemHistory: (itemId: string) =>
    call<ItemHistory & { room: { id: string; name: string } }>("GET", `/api/items/${itemId}/history`),
  meeting: (id: string) => call<MeetingRecap>("GET", `/api/meetings/${id}`),
  review: (roomId: string, reviewId: string) =>
    call<{ roomName: string; review: ReviewView | null; reviews: ReviewSummary[] }>("GET", `/api/rooms/${roomId}/reviews/${encodeURIComponent(reviewId)}`),
  /** With `design` it starts a design session: what to start from (pasted notes or a diagram) and the to-do its draft spec goes on. */
  startBrainstorm: (roomId: string, prompt: string, design?: { seed: string; taskId: string | null }) =>
    call<{ brainstorm: BrainstormView }>("POST", `/api/rooms/${roomId}/brainstorm/start`, { prompt, design }),
  /** Opens the call's sketch (the one already on, if one is). `style` is how its first subject is drawn to begin with. */
  startSketch: (roomId: string, prompt: string, style?: "map" | "diagram") => call<{ brainstorm: BrainstormView }>("POST", `/api/rooms/${roomId}/brainstorm/start`, { prompt, sketch: true, style }),
  brainstorm: (roomId: string, id: string) =>
    call<{ roomName: string; brainstorm: BrainstormView; brainstorms: BrainstormSummary[] }>("GET", `/api/rooms/${roomId}/brainstorms/${encodeURIComponent(id)}`),
  /** Sets up the idea review of a brainstorm, or rebuilds the one waiting. */
  setUpIdeaReview: (roomId: string, brainstormId: string) => call<{ reviewId: string; slides: number }>("POST", `/api/rooms/${roomId}/brainstorms/${encodeURIComponent(brainstormId)}/review`),
  startIdeaReview: (roomId: string, review?: string) => call<{ reviewId: string; firstItemId: string }>("POST", `/api/rooms/${roomId}/idea-review/start`, { review }),
  starIdea: (roomId: string, id: string, idea: string, on: boolean) =>
    call<{ brainstorm: BrainstormView }>("POST", `/api/rooms/${roomId}/brainstorms/${encodeURIComponent(id)}/star`, { idea, on }),
  /** "Finish this" in a call: ends the review, brainstorm or design session on its board. */
  finishExperience: (roomId: string) => call<{ finished: string[] }>("POST", `/api/rooms/${roomId}/experience/finish`),
  startReview: (roomId: string) => call<{ review: ReviewView | null; firstItemId: string }>("POST", `/api/rooms/${roomId}/review/start`),
  removeReviewSlide: (roomId: string, slideId: string) => call<{ review: ReviewView | null }>("DELETE", `/api/rooms/${roomId}/review/slides/${slideId}`),
  suggested: (roomId: string) => call<{ upNext: UpNext }>("GET", `/api/rooms/${roomId}/suggested.json`),
  setFollowUp: (roomId: string, noteId: string, done: boolean) => call<Note>("PATCH", `/api/rooms/${roomId}/followups/${noteId}`, { done }),
  confirmReplaced: (roomId: string, noteId: string, by: string, replaced: boolean) =>
    call<unknown>("POST", `/api/rooms/${roomId}/decisions/${noteId}/replaced`, { by, replaced }),
  projects: (roomId: string) => call<Project[]>("GET", `/api/rooms/${roomId}/projects`),
  createProject: (roomId: string, input: { name: string; goal?: string; fromItemId?: string }) => call<Project>("POST", `/api/rooms/${roomId}/projects`, input),
  updateProject: (roomId: string, projectId: string, change: { name?: string; goal?: string | null; position?: number; archived?: boolean }) =>
    call<Project>("PATCH", `/api/rooms/${roomId}/projects/${projectId}`, change),
  deleteProject: (roomId: string, projectId: string) => call<{ ok: true }>("DELETE", `/api/rooms/${roomId}/projects/${projectId}`),
  /** A project's id, null for Unassigned, or "auto" to follow the rules again. */
  setNoteProject: (roomId: string, noteId: string, projectId: string | null | "auto") =>
    call<Note>("PATCH", `/api/rooms/${roomId}/notes/${noteId}/project`, projectId === "auto" ? { auto: true } : { projectId }),
  /** The to-do it is a part of, or null to take it off. */
  setNoteParent: (roomId: string, noteId: string, parentId: string | null) => call<Note>("PATCH", `/api/rooms/${roomId}/notes/${noteId}/parent`, { parentId }),
  /** Links an agenda item to a project, or takes the link off. Returns the agenda. */
  setItemProject: (roomId: string, itemId: string, projectId: string | null) => call<Item[]>("PATCH", `/api/rooms/${roomId}/items/${itemId}`, { projectId }),
  /** undoAnswer: with state open on a question, also takes back the decision its answer made. */
  setTask: (roomId: string, noteId: string, change: { state?: "done" | "dropped" | "open"; reason?: string; saidDone?: false; undoAnswer?: string }) =>
    call<Note>("PATCH", `/api/rooms/${roomId}/tasks/${noteId}`, change),
  /** Closes open questions: each with an answer (kept as a decision), a decision the space has, or a drop with why.
   *  keep: the sweep's proposals someone unticked, which Stand doesn't propose again. */
  closeQuestions: (roomId: string, rows: QuestionClose[], keep: string[] = []) =>
    call<{ closed: QuestionClosed[] }>("POST", `/api/rooms/${roomId}/questions/close`, { rows, keep }),
  setTaskOwner: (roomId: string, noteId: string, owner: string | null) =>
    call<Note>("PATCH", `/api/rooms/${roomId}/tasks/${noteId}/owner`, { owner }),
  planReview: (id: string, version?: string) =>
    call<PlanReview>("GET", `/api/tasks/${id}/plan-review${version ? `?version=${encodeURIComponent(version)}` : ""}`),
  changePlanReview: (id: string, input: object) =>
    call<PlanThread>("POST", `/api/tasks/${id}/plan-review`, input),
  commentOnTask: (id: string, text: string) =>
    call<TaskDetail["work"]["log"][number]>("POST", `/api/tasks/${id}/comments`, { text }),
  clearMentions: (id: string) => call<{ ok: true }>("POST", `/api/tasks/${id}/mentions/clear`),
  presentationTasks: (roomId: string) => call<Note[]>("GET", `/api/rooms/${roomId}/presentation-tasks`),
  taskBrief: (id: string, retry = false) => call<PlanBrief>("POST", `/api/tasks/${id}/presentation-brief`, { retry }, SLOW_REQUEST_MS),
  designReview: (roomId: string) => call<{ roomName: string; review: DesignReviewView | null; reviews: DesignReviewRan[] }>("GET", `/api/rooms/${roomId}/design-review`),
  designReviewRecord: (roomId: string, reviewId: string) =>
    call<{ roomName: string; review: DesignReviewRecord; reviews: DesignReviewRan[] }>("GET", `/api/rooms/${roomId}/design-reviews/${encodeURIComponent(reviewId)}`),
  startDesignReview: (roomId: string) => call<{ review: DesignReviewView | null; firstItemId: string }>("POST", `/api/rooms/${roomId}/design-review/start`),
  designReviewState: (taskId: string) => call<DesignReviewState>("GET", `/api/tasks/${taskId}/design-review`),
  requestDesignReview: (taskId: string) => call<DesignReviewState>("POST", `/api/tasks/${taskId}/design-review`),
  removeDesignReview: (taskId: string) => call<DesignReviewState>("DELETE", `/api/tasks/${taskId}/design-review`),
  prepareDesignReview: (taskId: string, change: BriefChange) => call<{ spec: DesignSpec | null }>("PATCH", `/api/tasks/${taskId}/design-review`, change),
  task: (id: string) => call<TaskDetail>("GET", `/api/tasks/${id}`),
  chat: (roomId: string) => call<ChatThread>("GET", `/api/rooms/${roomId}/chat`),
  notify: (roomId: string) => call<NotifyStatus>("GET", `/api/rooms/${roomId}/notify`),
  setNotify: (roomId: string, level: ChatNotify) => call<NotifyStatus>("PUT", `/api/rooms/${roomId}/notify`, { level }),
  testPush: () => call<{ sent: number }>("POST", "/api/push/test"),
  /** A page of a channel's messages: those before a seq, or those after one. */
  chatMessages: (channelId: string, page: { before?: number; after?: number }) =>
    call<{ messages: ChatMessage[]; sessions: ChatSession[]; caught: ChatCaught[] }>("GET", `/api/channels/${channelId}/messages?${page.after !== undefined ? `after=${page.after}` : `before=${page.before ?? ""}`}`),
  /** key: sent again with the same one, a message is saved once. */
  sendChat: (roomId: string, body: { text: string; key: string; replyTo?: string }) => call<ChatMessage>("POST", `/api/rooms/${roomId}/chat/messages`, body),
  editChat: (id: string, text: string) => call<ChatMessage>("PATCH", `/api/chat/messages/${id}`, { text }),
  deleteChat: (id: string) => call<ChatMessage>("DELETE", `/api/chat/messages/${id}`),
  /** What Stand caught from one session of chat. */
  chatCaught: (sessionId: string) => call<ChatCaught>("GET", `/api/chat/sessions/${sessionId}/caught`),
  /** A line Stand caught from chat that isn't one. */
  removeCaught: (noteId: string) => call<{ removed: string }>("DELETE", `/api/chat/caught/${noteId}`),
  readChat: (channelId: string, upTo: number) => call<{ readUpTo: number }>("POST", `/api/channels/${channelId}/read`, { upTo }),
  token: (roomId: string) => call<{ url: string | null; token: string | null }>("POST", `/api/rooms/${roomId}/token`),
};
