// The words of a brainstorm, for its word cloud (room/BrainWords.tsx): what the map's directions and
// ideas say, and the words people said them in, counted. A word keeps the ideas that mention it, so
// picking one leads back to them.

import type { BrainNode } from "../shared/protocol.ts";

export interface BrainWord {
  word: string;
  /** How much the brainstorm made of it: a name on the map counts more than a word in a quote. */
  count: number;
  /** The directions and ideas that mention it, in the order they were raised. */
  nodes: string[];
}

/** Words that say nothing about a topic. Short on purpose: a word left in is easy to ignore, a
 *  topic word taken out is lost. */
const STOP = new Set(
  `a about above after again all also am an and any are aren't as at be because been before being below between both but by can can't cannot could
did didn't do does doesn't doing don't down during each even ever few for from further get gets getting go goes going gonna got had has have having he her
here hers him his how i i'd i'll i'm i've if in into is isn't it it's its just kind know let let's like lot make makes many may maybe me might more most much
must my need needs no nor not now of off ok okay on once one only or other our ours out over own really right same say says see she should so some something
sort still such sure take than that that's the their theirs them then there there's these they they're thing things think this those through to too under until
up us use used using very want wants was wasn't way we we'd we'll we're we've well were what what's when where which while who why will with won't would yeah
yes yet you you're your yours`.split(/\s+/),
);

const WEIGHT = { label: 3, detail: 2, point: 1, quote: 1 };

const wordsOf = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]*/gu) ?? [])
    .map((w) => w.replace(/’/g, "'").replace(/'s$/, "").replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));

/** The brainstorm's words, most made-of first, at most `limit`. A plural joins its singular. */
export function brainWords(nodes: BrainNode[], limit = 60): BrainWord[] {
  const found = new Map<string, { count: number; nodes: Set<string>; first: number }>();
  let order = 0;
  const add = (text: string | null | undefined, weight: number, nodeId: string) => {
    if (!text) return;
    for (const w of wordsOf(text)) {
      const at = found.get(w) ?? { count: 0, nodes: new Set<string>(), first: order++ };
      at.count += weight;
      at.nodes.add(nodeId);
      found.set(w, at);
    }
  };
  for (const n of [...nodes].sort((a, b) => a.ts - b.ts)) {
    add(n.label, WEIGHT.label, n.id);
    add(n.detail, WEIGHT.detail, n.id);
    add(n.quote?.text, WEIGHT.quote, n.id);
    for (const p of n.points) {
      add(p.text, WEIGHT.point, n.id);
      add(p.quote?.text, WEIGHT.quote, n.id);
    }
  }
  // "checkouts" joins "checkout" when both were said; the form said more is the one shown.
  for (const [w, plural] of [...found]) {
    const stem = w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : null;
    const single = stem ? found.get(stem) : undefined;
    if (!stem || !single) continue;
    const kept = plural.count > single.count ? w : stem;
    found.delete(w);
    found.delete(stem);
    found.set(kept, { count: plural.count + single.count, nodes: new Set([...single.nodes, ...plural.nodes]), first: Math.min(single.first, plural.first) });
  }
  return [...found]
    .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
    .slice(0, limit)
    .map(([word, f]) => ({ word, count: f.count, nodes: nodes.filter((n) => f.nodes.has(n.id)).sort((a, b) => a.ts - b.ts).map((n) => n.id) }));
}

/** The same words, the biggest in the middle and the rest alternating out to each side, so a wrapped
 *  row of them reads as a cloud and not as a ranking. */
export function centerOut<T>(ranked: T[]): T[] {
  const out: T[] = [];
  ranked.forEach((w, i) => (i % 2 ? out.unshift(w) : out.push(w)));
  return out;
}
