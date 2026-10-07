import type { Capabilities, DeckHistory, Item, ItemHistory, MeetingRecap, User } from "../shared/protocol.ts";

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
  items: Item[];
  meetings: Array<{ id: string; startedAt: number; endedAt: number | null; summary: string | null; segmentCount: number }>;
  liveMeetingId: string | null;
}

export const api = {
  config: () => call<Capabilities>("GET", "/api/config"),
  me: () => call<User>("GET", "/api/auth/me"),
  devSignIn: (name: string, email: string) => call<User>("POST", "/api/auth/dev", { name, email }),
  signOut: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  myRooms: () => call<Array<{ id: string; name: string; lastJoinedAt: number }>>("GET", "/api/my/rooms"),
  createRoom: (name: string) => call<{ id: string; name: string }>("POST", "/api/rooms", { name }),
  room: (id: string) => call<RoomInfo>("GET", `/api/rooms/${id}`),
  addAgenda: (roomId: string, titles: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items`, { titles }),
  importLinear: (roomId: string, input: string) => call<Item[]>("POST", `/api/rooms/${roomId}/items/linear`, { input }),
  loadSample: (roomId: string) => call<Item[]>("POST", `/api/rooms/${roomId}/items/sample`),
  renameItem: (roomId: string, itemId: string, title: string) =>
    call<Item[]>("PATCH", `/api/rooms/${roomId}/items/${itemId}`, { title }),
  removeItem: (roomId: string, itemId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/items/${itemId}`),
  reorder: (roomId: string, ids: string[]) => call<Item[]>("POST", `/api/rooms/${roomId}/items/reorder`, { ids }),
  removeDeck: (roomId: string, deckId: string) => call<Item[]>("DELETE", `/api/rooms/${roomId}/decks/${deckId}`),
  deckHistory: (deckId: string) => call<DeckHistory>("GET", `/api/decks/${deckId}/history`),
  itemHistory: (itemId: string) =>
    call<ItemHistory & { room: { id: string; name: string } }>("GET", `/api/items/${itemId}/history`),
  meeting: (id: string) => call<MeetingRecap>("GET", `/api/meetings/${id}`),
  token: (roomId: string) => call<{ url: string | null; token: string | null }>("POST", `/api/rooms/${roomId}/token`),
};
