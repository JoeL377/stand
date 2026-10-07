// Slide decks arrive as PDFs (Keynote, PowerPoint and Google Slides all export
// one). The file is kept as-is and every browser renders the same page, so
// slides look exactly as designed. Here we only read the text of each page:
// the biggest line becomes the slide's title in the agenda, and the rest gives
// the notes agent context about what was on screen.

import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { config } from "./config.ts";

export const MAX_DECK_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 300;

export interface ParsedSlide {
  title: string;
  text: string;
}

export async function parseDeck(pdf: Uint8Array): Promise<ParsedSlide[]> {
  // pdf.js takes ownership of the buffer, so hand it a copy.
  const task = getDocument({ data: pdf.slice(), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    if (doc.numPages > MAX_PAGES) throw new Error(`That PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}.`);
    const slides: ParsedSlide[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const runs = content.items
        .filter((i): i is typeof i & { str: string; height: number } => "str" in i && i.str.trim() !== "")
        .map((i) => ({ str: i.str.replace(/\s+/g, " ").trim(), height: i.height }));
      const biggest = Math.max(0, ...runs.map((r) => r.height));
      const title = runs
        .filter((r) => r.height >= biggest * 0.9)
        .map((r) => r.str)
        .join(" ")
        .slice(0, 140);
      slides.push({ title: title || `Slide ${n}`, text: runs.map((r) => r.str).join("\n").slice(0, 3000) });
      page.cleanup();
    }
    return slides;
  } finally {
    await task.destroy();
  }
}

const deckPath = (deckId: string) => path.join(config.dataDir, "decks", `${deckId}.pdf`);

export function saveDeckFile(deckId: string, pdf: Uint8Array) {
  fs.mkdirSync(path.dirname(deckPath(deckId)), { recursive: true });
  fs.writeFileSync(deckPath(deckId), pdf);
}

export function deckFile(deckId: string): string | null {
  const p = deckPath(deckId);
  return /^[a-z0-9]+$/.test(deckId) && fs.existsSync(p) ? p : null;
}

export function looksLikePdf(buf: Uint8Array) {
  return buf.length > 4 && Buffer.from(buf.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/** "Q4 Roadmap.pdf" → "Q4 Roadmap" */
export function deckTitle(filename: string | undefined, fallback: string) {
  const t = (filename ?? "").replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim().slice(0, 100);
  return t || fallback;
}
