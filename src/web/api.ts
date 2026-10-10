import type { DraftSlide } from "../shared/outline.ts";
import type { AgentToken, Capabilities, Deck, DeckDraft, DeckHistory, FollowUp, Item, ItemHistory, MeetingRecap, Note, SpaceSummary, UpNext, User } from "../shared/protocol.ts";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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

export const api = {
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
  addAgenda: (roomId: string, titles: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items`, { titles }),
  importLinear: (roomId: string, input: string) => call<Item[]>("POST", `/api/rooms/${roomId}/items/linear`, { input }),
  loadSample: (roomId: string) => call<Item[]>("POST", `/api/rooms/${roomId}/items/sample`),
  renameItem: (roomId: string, itemId: string, title: string) =>
    call<Item[]>("PATCH", `/api/rooms/${roomId}/items/${itemId}`, { title }),
  removeItem: (roomId: string, itemId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/items/${itemId}`),
  reorder: (roomId: string, ids: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items/reorder`, { ids }),
  removeDeck: (roomId: string, deckId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/decks/${deckId}`),
  newDeck: (roomId: string, title: string, brief: string, parentItemId: string | null = null) =>
    call<{ deck: Deck; slides: Item[] }>("POST", `/api/rooms/${roomId}/decks/new`, { title, brief, parentItemId }),
  moveDeck: (deckId: string, parentItemId: string | null) => call<Item[]>("PATCH", `/api/decks/${deckId}`, { parentItemId }),
  deck: (deckId: string) => call<{ deck: Deck; room: { id: string; name: string } | null; slides: Item[] }>("GET", `/api/decks/${deckId}`),
  saveDeck: (deckId: string, draft: DeckDraft) => call<{ deck: Deck; slides: Item[] }>("PUT", `/api/decks/${deckId}`, draft),
  draftSlides: (deckId: string, brief: string) => call<{ slides: DraftSlide[] }>("POST", `/api/decks/${deckId}/draft`, { brief }),
  deckHistory: (deckId: string) => call<DeckHistory>("GET", `/api/decks/${deckId}/history`),
  itemHistory: (itemId: string) =>
    call<ItemHistory & { room: { id: string; name: string } }>("GET", `/api/items/${itemId}/history`),
  meeting: (id: string) => call<MeetingRecap>("GET", `/api/meetings/${id}`),
  suggested: (roomId: string) => call<{ upNext: UpNext }>("GET", `/api/rooms/${roomId}/suggested.json`),
  setFollowUp: (roomId: string, noteId: string, done: boolean) => call<Note>("PATCH", `/api/rooms/${roomId}/followups/${noteId}`, { done }),
  token: (roomId: string) => call<{ url: string | null; token: string | null }>("POST", `/api/rooms/${roomId}/token`),
};
