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

// Images placed on slides made in Stand's editor.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Array<[string, (b: Buffer) => boolean]> = [
  ["png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** The image's extension, or null if it isn't a PNG, JPEG, GIF or WebP. */
export function imageType(buf: Buffer) {
  return IMAGE_TYPES.find(([, test]) => buf.length > 12 && test(buf))?.[0] ?? null;
}

const imageDir = (deckId: string) => path.join(config.dataDir, "decks", deckId);

export function saveDeckImage(deckId: string, imageId: string, ext: string, buf: Buffer) {
  fs.mkdirSync(imageDir(deckId), { recursive: true });
  fs.writeFileSync(path.join(imageDir(deckId), `${imageId}.${ext}`), buf);
  return `${imageId}.${ext}`;
}

export function deckImageFile(deckId: string, image: string): string | null {
  if (!/^[a-z0-9]+$/.test(deckId) || !/^[a-z0-9]+\.(png|jpg|gif|webp)$/.test(image)) return null;
  const p = path.join(imageDir(deckId), image);
  return fs.existsSync(p) ? p : null;
}
