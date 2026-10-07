// Renders pages of an uploaded deck. Every browser draws the same PDF page
// itself, so the host flipping a slide costs one small message, not a video
// stream, and slides stay sharp at any size.

import { useEffect, useRef, useState } from "react";
// The legacy build: the default one needs JavaScript features that current
// Safari and Chrome don't ship yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Deck, DeckTheme, Item, SlideContent, SlideLayout } from "../shared/protocol.ts";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

const docs = new Map<string, Promise<PDFDocumentProxy>>();
function loadDeck(deckId: string) {
  let p = docs.get(deckId);
  if (!p) {
    p = pdfjs.getDocument({ url: `/api/decks/${deckId}/file`, withCredentials: true }).promise;
    p.catch(() => docs.delete(deckId));
    docs.set(deckId, p);
  }
  return p;
}

/** Draws one page to fit its box. `width` fixes the size (for thumbnails);
 *  without it the page fills the parent, letterboxed. */
export function SlideView({ deckId, page, width, className }: { deckId: string; page: number; width?: number; className?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(width ? { w: width, h: Infinity } : null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (width) return;
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  useEffect(() => {
    if (!box || box.w < 10) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const doc = await loadDeck(deckId);
        const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const scale = Math.min(box.w / base.width, box.h / base.height);
        const dpr = window.devicePixelRatio || 1;
        const vp = p.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current!;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
        canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
        task = p.render({ canvas, viewport: vp });
        await task.promise;
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled && (e as Error).name !== "RenderingCancelledException") setError("Couldn't load this slide.");
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [deckId, page, box?.w, box?.h]);

  return (
    <div ref={boxRef} className={`slide-view ${className ?? ""}`} data-ready={ready || undefined}>
      {error ? <p className="muted small">{error}</p> : <canvas ref={canvasRef} aria-label={`Slide ${page}`} />}
    </div>
  );
}

/** Uploads a PDF deck to a room. */
export async function uploadDeck(roomId: string, file: File, parentItemId: string | null = null) {
  if (file.size > 50 * 1024 * 1024) throw new Error("That file is over 50 MB.");
  const parent = parentItemId ? `&parent=${encodeURIComponent(parentItemId)}` : "";
  const res = await fetch(`/api/rooms/${roomId}/decks?name=${encodeURIComponent(file.name)}${parent}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Slides made in Stand's own editor. Each is laid out on a fixed 1280×720
// canvas and scaled to its box, so a thumbnail, the stage and the editor all
// show exactly the same slide.

const W = 1280;
const H = 720;

export const THEMES: Array<{ id: DeckTheme; name: string }> = [
  { id: "paper", name: "Paper" },
  { id: "night", name: "Night" },
  { id: "ocean", name: "Ocean" },
  { id: "sunset", name: "Sunset" },
];

export const LAYOUTS: Array<{ id: SlideLayout; name: string }> = [
  { id: "title", name: "Title" },
  { id: "bullets", name: "Bullets" },
  { id: "section", name: "Section" },
  { id: "image", name: "Image" },
  { id: "quote", name: "Quote" },
];

export const imageUrl = (deckId: string, image: string) => `/api/decks/${deckId}/images/${image}`;

function useFit(width: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(width ? { w: width, h: Infinity } : null);
  useEffect(() => {
    if (width) return setBox({ w: width, h: Infinity });
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return { ref, scale: box ? Math.min(box.w / W, box.h / H) : 0 };
}

export function NativeSlide(props: {
  deckId: string;
  theme: DeckTheme;
  title: string;
  slide: SlideContent;
  width?: number;
  className?: string;
}) {
  const { deckId, theme, title, slide, width, className } = props;
  const { ref, scale } = useFit(width);
  const lines = slide.body.split("\n").filter((l) => l.trim());
  const bullets = (
    <ul className="ns-bullets">
      {lines.map((l, i) => (
        <li key={i} className={/^\s{2,}/.test(l) ? "sub" : undefined}>
          {l.trim()}
        </li>
      ))}
    </ul>
  );
  let content;
  switch (slide.layout) {
    case "title":
      content = (
        <div className="ns-center">
          <h1 className="ns-hero">{title}</h1>
          {slide.body.trim() && <p className="ns-sub">{slide.body}</p>}
        </div>
      );
      break;
    case "section":
      content = (
        <div className="ns-section">
          <div className="ns-rule" />
          <h1 className="ns-hero">{title}</h1>
          {slide.body.trim() && <p className="ns-sub">{slide.body}</p>}
        </div>
      );
      break;
    case "quote":
      content = (
        <div className="ns-center">
          <blockquote className="ns-quote">“{slide.body.trim() || "Your quote here"}”</blockquote>
          {title && !title.startsWith("“") && <p className="ns-cite">{title}</p>}
        </div>
      );
      break;
    case "image":
      content = (
        <div className="ns-split">
          <div className="ns-col">
            <h2 className="ns-title">{title}</h2>
            {bullets}
          </div>
          <div className="ns-img">{slide.image ? <img src={imageUrl(deckId, slide.image)} alt="" /> : <span>No image yet</span>}</div>
        </div>
      );
      break;
    default:
      content = (
        <div className="ns-col">
          <h2 className="ns-title">{title}</h2>
          {bullets}
        </div>
      );
  }
  return (
    <div ref={ref} className={`slide-view ${className ?? ""}`} data-ready={scale > 0 || undefined}>
      {scale > 0 && (
        <div className="ns-frame" style={{ width: W * scale, height: H * scale }}>
          <div className={`ns theme-${theme} layout-${slide.layout}`} style={{ width: W, height: H, transform: `scale(${scale})` }}>
            {content}
          </div>
        </div>
      )}
    </div>
  );
}

/** Any slide: a page of an uploaded PDF, or one made in Stand. */
export function Slide({ item, deck, width, className }: { item: Item; deck: Deck | null | undefined; width?: number; className?: string }) {
  if (item.slide && item.deckId)
    return <NativeSlide deckId={item.deckId} theme={deck?.theme ?? "paper"} title={item.title} slide={item.slide} width={width} className={className} />;
  if (item.deckId && item.slideNo) return <SlideView deckId={item.deckId} page={item.slideNo} width={width} className={className} />;
  return null;
}
