// @Name in what people write stands out wherever it shows: chat, comments, notes and reports. The
// people of the space come from the page around the text, so only real names are marked, and a
// mention of you is marked more strongly than one of someone else.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { mentionSpans, type Person } from "../shared/mentions.ts";
import { api } from "./api.ts";

export interface MentionScopeValue {
  people: Person[];
  /** Your id, so a mention of you can look different. */
  me: string | null;
}

const Scope = createContext<MentionScopeValue>({ people: [], me: null });
export const useMentionScope = () => useContext(Scope);

/** The people text under it can mention. A nested scope replaces the outer one. */
export function MentionScope(props: MentionScopeValue & { children?: React.ReactNode }) {
  const { people, me } = props;
  const value = useMemo(() => ({ people, me }), [people, me]);
  return <Scope.Provider value={value}>{props.children}</Scope.Provider>;
}

const cache = new Map<string, Person[]>();

/** The people in a space, for a mention scope. Kept for the session, then brought up to date. */
export function useSpacePeople(roomId: string | null | undefined): Person[] {
  const [people, setPeople] = useState<Person[]>(() => (roomId && cache.get(roomId)) || []);
  useEffect(() => {
    if (!roomId) return;
    setPeople(cache.get(roomId) ?? []);
    let gone = false;
    api.members(roomId).then(
      (r) => {
        const list = r.members.map((m) => ({ id: m.id, name: m.name })).filter((p) => p.name);
        cache.set(roomId, list);
        if (!gone) setPeople(list);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [roomId]);
  return people;
}

/** The class a mention is drawn with: "mention", and "mention you" when it names you. */
export const mentionClass = (id: string, me: string | null) => (id === me ? "mention you" : "mention");

/** Plain text with each @Name in it marked. */
export function MentionText({ text }: { text: string }) {
  const { people, me } = useMentionScope();
  const spans = useMemo(() => (people.length && text.includes("@") ? mentionSpans(text, people) : []), [text, people]);
  if (!spans.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const s of spans) {
    if (s.start > last) parts.push(text.slice(last, s.start));
    parts.push(
      <span key={s.start} className={mentionClass(s.id, me)} title={s.id === me ? "Mentions you" : undefined}>
        {text.slice(s.start, s.end)}
      </span>,
    );
    last = s.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
