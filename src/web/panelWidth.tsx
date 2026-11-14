// Every right-hand panel (a to-do, an artifact) is one width, yours to drag from its left edge and kept
// for next time. While one is open the page makes way for it on a wide screen.

import { useEffect, useState } from "react";

/** Marks a panel as open while it is mounted. True when it replaced another panel, so it doesn't slide in again. */
export function useSidePanel(): boolean {
  const [swapped] = useState(() => "sidePanel" in document.documentElement.dataset);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidePanel = "";
    const w = savedPanelWidth();
    if (w) root.style.setProperty("--panel-w", `${w}px`);
    return () => {
      delete root.dataset.sidePanel;
      root.style.removeProperty("--panel-w");
    };
  }, []);
  return swapped;
}

// The panel's width is yours to drag, from its left edge; it is kept for next time. A double-click puts it back.
const PANEL_W = "stand.panelWidth";
const clampWidth = (w: number) => Math.round(Math.max(380, Math.min(w, window.innerWidth - 360, 1400)));
function savedPanelWidth(): number | null {
  try {
    const w = Number(localStorage.getItem(PANEL_W));
    return w > 0 ? clampWidth(w) : null;
  } catch {
    return null;
  }
}
export function PanelResizer() {
  const root = document.documentElement;
  const set = (w: number | null) => {
    if (w) root.style.setProperty("--panel-w", `${w}px`);
    else root.style.removeProperty("--panel-w");
    try {
      if (w) localStorage.setItem(PANEL_W, String(w));
      else localStorage.removeItem(PANEL_W);
    } catch {
      /* kept for this visit only */
    }
  };
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement!;
    const right = panel.getBoundingClientRect().right;
    root.dataset.resizing = "";
    const move = (m: PointerEvent) => set(clampWidth(right - m.clientX));
    const end = () => {
      delete root.dataset.resizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const now = e.currentTarget.parentElement!.getBoundingClientRect().width;
    set(clampWidth(now + (e.key === "ArrowLeft" ? 40 : -40)));
  };
  return <div className="af-resize" role="separator" aria-orientation="vertical" aria-label="Panel width" tabIndex={0} title="Drag to resize" onPointerDown={start} onKeyDown={key} onDoubleClick={() => set(null)} />;
}
