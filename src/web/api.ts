import type { DraftSlide } from "../shared/outline.ts";
import type {
  AgentToken,
  Capabilities,
  Deck,
  DeckDraft,
  DeckHistory,
  FollowUp,
  Item,
  ItemHistory,
  Jot,
  MeetingRecap,
  Note,
  Snap,
  SpaceFeed,
  SpaceSummary,
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
  people: Array<{ name: string; picture: string | null }>;
  meetings: Array<{ id: string; startedAt: number; endedAt: number | null; summary: string | null; segmentCount: number }>;
  /** Open action items from the room's past meetings. */
  followUps: FollowUp[];
  liveMeetingId: string | null;
}

export interface ConxtStatus {
  destinations: Array<{ key: string; label: string }>;
  connection: { id: string; label: string; destinationKey: string; enabled: number } | null;
  canManage: boolean;
  deliveries: Array<{ id: string; meetingId: string; label: string; enabled: number; state: string; remoteStatus: string | null; error: string | null; attempts: number; updatedAt: number }>;
}

export const api = {
  conxtStatus: (roomId: string) => call<ConxtStatus>("GET", `/api/rooms/${roomId}/conxt`),
  connectConxt: (roomId: string, destinationKey: string) => call<{ ok: true }>("POST", `/api/rooms/${roomId}/conxt`, { destinationKey, confirmedTeamAccess: true }),
  disconnectConxt: (roomId: string) => call<{ ok: true }>("DELETE", `/api/rooms/${roomId}/conxt`),
  retryConxt: (roomId: string, deliveryId: string) => call<{ ok: true }>("POST", `/api/rooms/${roomId}/conxt/${deliveryId}/retry`, {}),
  tokens: () => call<AgentToken[]>("GET", "/api/tokens"),
  createToken: (label: string, scope: AgentToken["scope"]) => call<{ token: string; info: AgentToken }>("POST", "/api/tokens", { label, scope }),
  revokeToken: (id: string) => call<{ ok: true }>("DELETE", `/api/tokens/${id}`),
  locateRef: (kind: string, id: string) => call<{ meetingId: string; roomId: string; itemId: string | null }>("GET", `/api/refs/${kind}/${id}`),
  refPrompt: (kind: string, id: string) => call<{ text: string }>("GET", `/api/refs/${kind}/${id}/prompt`),
  config: () => call<Capabilities>("GET", "/api/config"),
  me: () => call<User>("GET", "/api/auth/me"),
  devSignIn: (name: string, email: string) => call<User>("POST", "/api/auth/dev", { name, email }),
  signOut: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  myRooms: () => call<Array<{ id: string; name: string; lastJoinedAt: number }>>("GET", "/api/my/rooms"),
  createRoom: (name: string, purpose = "") => call<{ id: string; name: string }>("POST", "/api/rooms", { name, purpose }),
  spaces: () => call<SpaceSummary[]>("GET", "/api/spaces"),
  updateSpace: (id: string, patch: { name?: string; purpose?: string; synthesisInstructions?: string }) =>
    call<{ id: string; name: string; purpose: string; synthesisInstructions: string }>("PATCH", `/api/rooms/${id}`, patch),
  room: (id: string) => call<RoomInfo>("GET", `/api/rooms/${id}`),
  feed: (id: string) => call<SpaceFeed>("GET", `/api/rooms/${id}/feed`),
  updateSnap: (id: string, patch: { itemId?: string | null; line?: string | null }) => call<Snap>("PATCH", `/api/snaps/${id}`, patch),
  saveJot: (roomId: string, jot: { text: string; itemId?: string | null; at?: number }) => call<Jot>("POST", `/api/rooms/${roomId}/jots`, jot),
  updateJot: (id: string, patch: { itemId?: string | null; text?: string }) => call<Jot>("PATCH", `/api/jots/${id}`, patch),
  deleteJot: (id: string) => call<{ ok: true }>("DELETE", `/api/jots/${id}`),
  /** Brings back a note deleted in the last minute, with its snaps. */
  restoreJot: (id: string) => call<Jot>("POST", `/api/jots/${id}/restore`),
  addAgenda: (roomId: string, titles: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items`, { titles }),
  importLinear: (roomId: string, input: string) => call<Item[]>("POST", `/api/rooms/${roomId}/items/linear`, { input }, SLOW_REQUEST_MS),
  renameItem: (roomId: string, itemId: string, title: string) =>
    call<Item[]>("PATCH", `/api/rooms/${roomId}/items/${itemId}`, { title }),
  removeItem: (roomId: string, itemId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/items/${itemId}`),
  restoreItems: (roomId: string, ids: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items/restore`, { ids }),
  reorder: (roomId: string, ids: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items/reorder`, { ids }),
  removeDeck: (roomId: string, deckId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/decks/${deckId}`),
  newDeck: (roomId: string, title: string, brief: string, parentItemId: string | null = null) =>
    call<{ deck: Deck; slides: Item[] }>("POST", `/api/rooms/${roomId}/decks/new`, { title, brief, parentItemId }, SLOW_REQUEST_MS),
  moveDeck: (deckId: string, parentItemId: string | null) => call<Item[]>("PATCH", `/api/decks/${deckId}`, { parentItemId }),
  deck: (deckId: string) => call<{ deck: Deck; room: { id: string; name: string } | null; slides: Item[] }>("GET", `/api/decks/${deckId}`),
  saveDeck: (deckId: string, draft: DeckDraft) => call<{ deck: Deck; slides: Item[] }>("PUT", `/api/decks/${deckId}`, draft),
  draftSlides: (deckId: string, brief: string) =>
    call<{ slides: DraftSlide[] }>("POST", `/api/decks/${deckId}/draft`, { brief }, SLOW_REQUEST_MS),
  deckHistory: (deckId: string) => call<DeckHistory>("GET", `/api/decks/${deckId}/history`),
  itemHistory: (itemId: string) =>
    call<ItemHistory & { room: { id: string; name: string } }>("GET", `/api/items/${itemId}/history`),
  meeting: (id: string) => call<MeetingRecap>("GET", `/api/meetings/${id}`),
  suggested: (roomId: string) => call<{ upNext: UpNext }>("GET", `/api/rooms/${roomId}/suggested.json`),
  setFollowUp: (roomId: string, noteId: string, done: boolean) => call<Note>("PATCH", `/api/rooms/${roomId}/followups/${noteId}`, { done }),
  token: (roomId: string) => call<{ url: string | null; token: string | null }>("POST", `/api/rooms/${roomId}/token`),
};
