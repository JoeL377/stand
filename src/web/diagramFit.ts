// A design review slide keeps its diagrams on screen. When the slide is taller than its box, the
// diagrams give up the height it is over by, the tallest first, down to a floor; past the floor the
// slide scrolls, as it does when its text alone is too long.

import { useLayoutEffect, type RefObject } from "react";

/** Below this a diagram can't be read, so the slide scrolls instead. */
export const DIAGRAM_MIN = 120;

/** The height no diagram may pass for the slide to fit, given each diagram's height and how far the
 *  slide is over. Null when the slide fits as it is. */
export function diagramCap(heights: number[], over: number, min = DIAGRAM_MIN): number | null {
  if (over <= 0 || !heights.length) return null;
  const sorted = [...heights].sort((a, b) => a - b);
  let left = sorted.reduce((a, b) => a + b, 0) - over;
  for (let i = 0; i < sorted.length; i++) {
    const share = left / (sorted.length - i);
    // The ones that are left are all taller than an equal share: that share is the cap.
    if (sorted[i] >= share) return Math.max(min, Math.floor(share));
    left -= sorted[i];
  }
  return null;
}

/** Fits the diagrams inside `box` (a slide that scrolls) each time what it shows or its size changes. */
export function useDiagramFit(box: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.removeProperty("--ds-diagram-max");
      const heights = [...el.querySelectorAll(".ds-diagram svg")].map((svg) => svg.getBoundingClientRect().height);
      const cap = diagramCap(heights, el.scrollHeight - el.clientHeight);
      if (cap !== null) el.style.setProperty("--ds-diagram-max", `${cap}px`);
    };
    fit();
    // A diagram is drawn after the slide is; lines and questions change while it is up.
    const changed = new MutationObserver(fit);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    const resized = new ResizeObserver(fit);
    resized.observe(el);
    return () => {
      changed.disconnect();
      resized.disconnect();
    };
  }, [box]);
}
