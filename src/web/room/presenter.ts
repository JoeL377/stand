// The presenter of a call (RoomState.presenter): whoever last started what's in the middle of it.
// Starting something else while they present asks first, and the top bar names them.

import type { Presenter, RoomState } from "../../shared/protocol.ts";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "the map", "their screen": what they present, as a sentence says it. */
export const presentingWords = (p: Presenter) => (p.what === "screen" ? "their screen" : `the ${p.what}`);

/** For the top bar: "Janesh is presenting · Map", or "You're presenting · Map". */
export function presentingLine(p: Presenter, me: string) {
  const what = p.what === "screen" ? "Screen" : p.what[0].toUpperCase() + p.what.slice(1);
  return `${p.id === me ? "You're" : `${first(p.name)} is`} presenting · ${what}`;
}

/** Someone else is presenting: ask before taking over from them. True to go ahead. */
export function mayTakeOver(state: Pick<RoomState, "presenter"> | null | undefined, me: string): boolean {
  const p = state?.presenter;
  if (!p || p.id === me) return true;
  return confirm(`${first(p.name)} is presenting ${presentingWords(p)}. Take over?`);
}
