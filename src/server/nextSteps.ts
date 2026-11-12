// Next steps the meeting agent offers during a call. The call is one loose talk; when someone says
// out loud that they want a brainstorm, a design session or a review, Stand puts one small card up:
// "Open a map for this?". Anyone can take it or wave it off, and nothing switches by itself.
//
// Two signals, both plain words matched on the lines as they are transcribed, with no model call:
// someone asks for it ("let's brainstorm on…"), or the talk of the last few minutes sounds like one
// (several people throwing out ideas; someone walking through how parts connect). The second is a
// guess, so it is slower to speak, says "Sounds like", and only ever offers a map or a diagram.
//
// A map or a diagram is drawn as a view beside the board. A review needs prepared slides or specs, so a
// review that was asked for is kept for the recap ("Suggested next") unless someone waves it off.
import type { NextKind, NextStep } from "../shared/protocol.ts";

/** How long a card stays up before it counts as missed. */
export const NEXT_SHOWN_MS = 60_000;
/** After a card of one kind was waved off, that kind stays quiet this long. */
export const NEXT_QUIET_MS = 5 * 60_000;
const TOPIC_MAX = 80;

// Someone proposing to do it now or soon: "let's", "we should", "can we", "I think we need"…
const LEAD = String.raw`\b(?:let'?s|let us|we (?:should|could|can|need|gotta|have to|might|may)|should we|can we|could we|shall we|do we want|(?:you |we |i )?(?:wanna|want to)|i(?:'| wi)ll|i(?: a|')m (?:gonna|going to)|we(?:'| a)re (?:gonna|going to)|need(?:s)? (?:to|a|an)|worth (?:a|an|doing)|time for (?:a|an|the))\b`;
const WHAT: Array<[NextKind, string]> = [
  ["design-review", String.raw`design[- ]review`],
  ["product-review", String.raw`product[- ]review`],
  ["diagram", String.raw`design(?:ing)? session|(?:diagram|draw|sketch|map) (?:this|that|it) out|draw (?:a|the) diagram`],
  ["map", String.raw`brain[- ]?storm(?:ing)?(?: session)?|mind[- ]?map`],
];
// Talk about one that already happened, or that isn't wanted.
const NOT = /\b(?:don'?t|doesn'?t|didn'?t|not|no need|never|without|already|did|had|was|were|yesterday|earlier|last (?:time|week|night)|instead of|rather than|fix|finish(?:ed)?|end(?:ed)?|exit|leave|left)\b/i;
const VAGUE = /^(?:this|that|it|these|those|them|here|now|right now|today|something|stuff|things?)\b/i;

export interface Heard {
  kind: NextKind;
  /** What it is on, when the speaker said ("…on the pricing page"); null when they said "this". */
  topic: string | null;
}

/** What one transcribed line asks for, if it asks for anything. */
export function heardIntent(text: string): Heard | null {
  // One clause at a time, so "we did a brainstorm yesterday. Let's review it" isn't read as one ask.
  for (const clause of text.split(/[.?!;]+/)) {
    for (const [kind, what] of WHAT) {
      const m = new RegExp(`${LEAD}([^,]{0,48}?)\\b(?:${what})\\b(.*)`, "i").exec(clause);
      if (!m) continue;
      // Just before it too ("we don't need a…"); further back is another thought, as fragments join without a stop.
      if (NOT.test(m[1]) || NOT.test(clause.slice(Math.max(0, m.index - 16), m.index))) continue;
      return { kind, topic: topicIn(m[2]) };
    }
  }
  return null;
}

function topicIn(after: string): string | null {
  const m = /^\s*(?:session\s+)?(?:on|about|for|of|around|over)\s+(.+)/i.exec(after);
  if (!m) return null;
  const t = m[1]
    .replace(/\b(?:right now|real quick|first|then|though|i think|i guess|maybe|like|okay|you know)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,:\s]+$/, "");
  if (t.length < 3 || VAGUE.test(t) || /^(?:the|a|an|our|how|what|some)$/i.test(t)) return null;
  const cut = t.length > TOPIC_MAX ? `${t.slice(0, TOPIC_MAX - 1).trimEnd()}…` : t;
  return cut[0].toUpperCase() + cut.slice(1);
}

/** A line of the call's talk, as the guess below reads it. */
export interface Said {
  speaker: string;
  text: string;
  ts: number;
}
/** How far back the guess listens, and how long a kind stays quiet after Stand guessed it once. */
export const SOUNDS_WINDOW_MS = 3 * 60_000;
export const SOUNDS_QUIET_MS = 15 * 60_000;
// Throwing out options: the sound of a brainstorm.
const IDEA = /\b(?:what if|how about|what about|another (?:idea|option|way|thought)|one (?:idea|option)|we could (?:also|just|even)?|maybe we|or (?:we|you|it) (?:could|can|might)|could also|alternatively|or maybe|idea is|imagine if)\b/gi;
// Walking through parts and how they connect: the sound of a design.
const PARTS = /\b(?:flows? (?:in)?to|(?:calls?|talks? to|sends?|writes? to|reads? from|pushes|pulls from|hits) the|pipeline|architecture|components?|schema|data model|end ?points?|web ?hooks?|database|tables?|queue|services?|back ?end|front ?end|and then it|which then)\b/gi;
const hits = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/** What the last few minutes of talk sound like, if they sound like anything: a brainstorm takes
 *  ideas from at least two people; a design takes one person saying how the parts connect. */
export function soundsLike(recent: Said[], now: number): "map" | "diagram" | null {
  const lines = recent.filter((l) => now - l.ts <= SOUNDS_WINDOW_MS);
  const ideas = lines.filter((l) => hits(IDEA, l.text) > 0);
  if (ideas.reduce((n, l) => n + hits(IDEA, l.text), 0) >= 4 && new Set(ideas.map((l) => l.speaker)).size >= 2) return "map";
  if (lines.reduce((n, l) => n + hits(PARTS, l.text), 0) >= 6) return "diagram";
  return null;
}

const REVIEW: NextKind[] = ["design-review", "product-review"];
export const isReviewKind = (k: NextKind) => REVIEW.includes(k);

/** What the recap shows under "Suggested next": the reviews people asked for in the call that
 *  nobody waved off and that didn't start there. One line per kind and topic. */
export function suggestedNext(steps: NextStep[]): NextStep[] {
  const seen = new Set<string>();
  return steps.filter((s) => {
    if (!isReviewKind(s.kind) || s.state === "waved" || s.state === "started") return false;
    const key = `${s.kind}:${s.topic.toLowerCase()}`;
    return !seen.has(key) && !!seen.add(key);
  });
}

/** The words on the card and in the recap. */
export function nextLabel(s: Pick<NextStep, "kind" | "topic">): string {
  const on = s.topic ? `: ${s.topic}` : "";
  if (s.kind === "map") return `Map${on}`;
  if (s.kind === "diagram") return `Diagram${on}`;
  return `${s.kind === "design-review" ? "Design review" : "Product review"}${on}`;
}
