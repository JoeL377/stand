// Turns a plain outline into slides, so a deck can start from notes someone
// already has. Headings (#) or unindented lines start a slide, "-" lines are
// bullets, "> " is a quote, "Notes:" lines become speaker notes, and "---"
// forces a break. Shared so the editor and the server agree.

import type { SlideContent } from "./protocol.ts";

export type DraftSlide = { title: string } & SlideContent;

type Draft = { title: string; lines: string[]; quote: string[]; notes: string[]; plain: string[] };

export function outlineToSlides(text: string): DraftSlide[] {
  const slides: DraftSlide[] = [];
  const st: { cur: Draft | null } = { cur: null };
  const hasHeadings = /^\s*#{1,6}\s/m.test(text);
  const flush = () => {
    const c = st.cur;
    st.cur = null;
    if (!c) return;
    const notes = c.notes.join("\n");
    const first = slides.length === 0;
    if (c.quote.length) slides.push({ title: c.title, layout: "quote", body: c.quote.join(" "), image: null, notes });
    else if (c.lines.length) slides.push({ title: c.title, layout: "bullets", body: c.lines.join("\n"), image: null, notes });
    else if (c.plain.length) slides.push({ title: c.title, layout: first ? "title" : "bullets", body: c.plain.join("\n"), image: null, notes });
    else slides.push({ title: c.title, layout: first ? "title" : "section", body: "", image: null, notes });
  };
  const start = (title: string) => {
    flush();
    st.cur = { title, lines: [], quote: [], notes: [], plain: [] };
    return st.cur;
  };
  let inNotes = false;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flush();
      continue;
    }
    const heading = t.match(/^#{1,6}\s+(.*)$/);
    const bullet = t.match(/^(?:[-*\u2022]|\d+[.)])\s+(.*)$/);
    const quote = t.match(/^>\s?(.*)$/);
    const notes = t.match(/^notes?:\s*(.*)$/i);
    const indented = /^\s/.test(line);
    if (quote && !st.cur) {
      start("").quote.push(quote[1]);
      inNotes = false;
      continue;
    }
    if (heading || !st.cur || (!hasHeadings && !indented && !bullet && !quote && !notes)) {
      start(heading ? heading[1].trim() : bullet ? bullet[1] : t);
      inNotes = false;
      continue;
    }
    const c = st.cur;
    if (notes) {
      inNotes = true;
      if (notes[1]) c.notes.push(notes[1]);
    } else if (inNotes && !bullet) c.notes.push(t);
    else if (bullet) c.lines.push((/^\s{2,}/.test(line) ? "  " : "") + bullet[1]);
    else if (quote) c.quote.push(quote[1]);
    else c.plain.push(t);
  }
  flush();
  return slides.map((s) => ({ ...s, title: s.title.slice(0, 140), body: s.body.slice(0, 2000) }));
}
