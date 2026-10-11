// When something in a list grows, shrinks or goes away, what's below it glides to its new
// place instead of jumping (the FLIP technique, on the `translate` property, so it runs on
// the GPU, can be interrupted and doesn't fight other transforms).

import { type RefObject, useLayoutEffect, useRef } from "react";

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const GLIDE_MS = 200;
const shiftOf = (el: Element) => parseFloat(getComputedStyle(el).translate.split(" ")[1] ?? "0") || 0;

/** `groups` (cards) are measured against the container, `items` (rows) against their card,
 *  so each moves only by its own change. Runs after every render. A row that's new fades in;
 *  a card whose rows are gliding gets the `gliding` class, so it can keep them inside its edge. */
export function useGlide(ref: RefObject<HTMLElement | null>, groups: string, items: string) {
  const was = useRef(new WeakMap<Element, number>());
  const width = useRef<number | null>(null);
  const timers = useRef(new WeakMap<Element, number>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !root.animate) return;
    const box = root.getBoundingClientRect();
    // The first look, and after the panel changes width: everything reflows at once, and
    // nothing is a change worth showing. Just note where things are.
    const quiet = width.current !== box.width || matchMedia("(prefers-reduced-motion: reduce)").matches;
    width.current = box.width;
    const clipped = new Set<Element>();
    for (const el of root.querySelectorAll(`${groups}, ${items}`)) {
      const parent = el.matches(items) ? el.parentElement?.closest(groups) : null;
      const shift = shiftOf(el);
      // Where it sits now, without any glide still under way.
      const top = el.getBoundingClientRect().top - shift - (parent ? parent.getBoundingClientRect().top : box.top);
      const before = was.current.get(el);
      was.current.set(el, top);
      if (quiet) continue;
      if (before === undefined) {
        if (parent) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" });
        continue;
      }
      if (Math.abs(before - top) < 1) continue;
      el.animate([{ translate: `0 ${before + shift - top}px` }, { translate: "0 0" }], { duration: GLIDE_MS, easing: EASE });
      if (parent) clipped.add(parent);
    }
    for (const card of clipped) {
      card.classList.add("gliding");
      clearTimeout(timers.current.get(card));
      timers.current.set(card, window.setTimeout(() => card.classList.remove("gliding"), GLIDE_MS));
    }
  });
}
