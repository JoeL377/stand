import type { Deck, Item, Note } from "./protocol.ts";

export const TOPIC_MAX = 80;
export const normalizeTopic = (value: string) => value.trim().replace(/\s+/g, " ");
export const topicKey = (value: string) => normalizeTopic(value).toLowerCase();

/** null/undefined inherits the agenda item; an empty string explicitly leaves it ungrouped. */
export function topicOf(note: Pick<Note, "topic" | "itemId">, items: Item[], decks: Deck[] = []): string | null {
  if (note.topic != null) return normalizeTopic(note.topic) || null;
  const item = items.find((i) => i.id === note.itemId);
  const deck = decks.find((d) => d.id === item?.deckId);
  const parent = items.find((i) => i.id === deck?.parentItemId);
  return normalizeTopic(parent?.title ?? deck?.title ?? item?.title ?? "") || null;
}

/** One spelling per topic, shared by tasks and decisions, including agenda defaults. */
export function topicOptions(notes: Pick<Note, "topic" | "itemId">[], items: Item[], decks: Deck[] = []): string[] {
  const options = new Map<string, string>();
  for (const n of notes) {
    const topic = topicOf(n, items, decks);
    if (topic && !options.has(topicKey(topic))) options.set(topicKey(topic), topic);
  }
  return [...options.values()].sort((a, b) => a.localeCompare(b));
}

export function matchesTopic(topic: string | null, filter: string): boolean {
  return !filter || (filter === "none" ? !topic : !!topic && `topic:${topicKey(topic)}` === filter);
}
