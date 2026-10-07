// Renders pages of an uploaded deck. Every browser draws the same PDF page
// itself, so the host flipping a slide costs one small message, not a video
// stream, and slides stay sharp at any size.

import { useEffect, useRef, useState } from "react";
// The legacy build: the default one needs JavaScript features that current
// Safari and Chrome don't ship yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

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
export async function uploadDeck(roomId: string, file: File) {
  if (file.size > 50 * 1024 * 1024) throw new Error("That file is over 50 MB.");
  const res = await fetch(`/api/rooms/${roomId}/decks?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
  return data;
}
