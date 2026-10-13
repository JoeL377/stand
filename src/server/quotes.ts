// The words behind a line the agent wrote. A paraphrase can tilt what someone meant (in one call,
// "the shared logic sits beneath Stand" came out as "Stand is a review queue within Connect"), so
// the run as the meeting ends also points at the line each position or decision came from and
// copies the words. They're kept only when they really are in that line (or another line of the
// same person nearby), and what's kept is the transcript's own text, not the model's copy of it.

import type { Quote, Segment } from "../shared/protocol.ts";

/** What the model gives: the [number] of the line, and the words copied from it. */
export type Said = { line: number; words: string } | null | undefined;

/** Long enough to mean something, short enough for a pop-up. */
const MIN_WORDS = 3;
const MAX_CHARS = 320;

const tokens = (t: string) => [...t.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)].map((m) => ({ w: m[0].toLowerCase().replace(/’/g, "'"), at: m.index!, end: m.index! + m[0].length }));

/** Same person: the names match, or their first names do (the model writes "Andy" for "Andy Li"). */
export function samePerson(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || (!!x && !!y && x.split(/\s+/)[0] === y.split(/\s+/)[0]);
}

/** Where `words` sit in `text`, word for word (case and punctuation aside), as the text has them. */
export function excerpt(text: string, words: string): string | null {
  const want = tokens(words).map((t) => t.w);
  if (want.length < MIN_WORDS) return null;
  const have = tokens(text);
  for (let i = 0; i + want.length <= have.length; i++) {
    let k = 0;
    while (k < want.length && have[i + k].w === want[k]) k++;
    if (k === want.length) return text.slice(have[i].at, have[i + k - 1].end);
  }
  return null;
}

const clip = (t: string) => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1).trimEnd()}…` : t);

/** The quote, checked: first in the line given, then in `near` (the discussion's lines), then in
 *  `all`; when `speaker` is given, only in that person's lines. Null when the words aren't there. */
export function findQuote(said: Said, lineOf: (n: number) => Segment | undefined, speaker: string | null, near: Segment[], all: Segment[] = []): Quote | null {
  if (!said?.words?.trim()) return null;
  const given = lineOf(said.line);
  const seen = new Set<string>();
  for (const s of [...(given ? [given] : []), ...near, ...all]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (speaker && !samePerson(s.speakerName, speaker)) continue;
    const text = excerpt(s.text, said.words);
    if (text) return { segmentId: s.id, ts: s.ts, speaker: s.speakerName, text: clip(text) };
  }
  return null;
}
