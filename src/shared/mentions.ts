// @Name in a task comment tags someone in the task's space. A full name always works; a first
// name works when nobody else in the space has it. Longer names win, so "@Joe Liang" never also
// tags a "Joe".

export interface Person {
  id: string;
  name: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = "\\p{L}\\p{N}_";

/** The names each person can be tagged by in this space. */
export function mentionNames(people: Person[]): Array<{ id: string; name: string }> {
  const first = (n: string) => n.trim().split(/\s+/)[0];
  const firsts = new Map<string, number>();
  for (const p of people) firsts.set(first(p.name).toLowerCase(), (firsts.get(first(p.name).toLowerCase()) ?? 0) + 1);
  return people.flatMap((p) => {
    const full = p.name.trim().replace(/\s+/g, " ");
    if (!full) return [];
    const f = first(full);
    return f !== full && firsts.get(f.toLowerCase()) === 1 ? [{ id: p.id, name: full }, { id: p.id, name: f }] : [{ id: p.id, name: full }];
  });
}

/** Where each @Name in a text is, from the @ to the end of the name, in order. */
export function mentionSpans(text: string, people: Person[]): Array<{ id: string; start: number; end: number }> {
  const names = mentionNames(people).sort((a, b) => b.name.length - a.name.length);
  let rest = text;
  const found: Array<{ id: string; start: number; end: number }> = [];
  for (const n of names) {
    const re = new RegExp(`(^|[^${WORD}@])@${esc(n.name).replace(/ /g, "\\s+")}(?![${WORD}])`, "giu");
    rest = rest.replace(re, (all, lead: string, at: number) => {
      found.push({ id: n.id, start: at + lead.length, end: at + all.length });
      return lead + " ".repeat(all.length - lead.length);
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The ids of the people a comment tags, in the order they come up. */
export function mentionedIn(text: string, people: Person[]): string[] {
  return [...new Set(mentionSpans(text, people).map((f) => f.id))];
}
