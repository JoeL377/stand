import { useLayoutEffect, useRef } from "react";

/** Motion for moving around the app, and only for that: a tab, a project, a space, a drawer or a
 *  sheet. Lists and data that change on their own never move here; the call board has its own
 *  signals for those. Every move is short (120 to 200 ms), eases out, uses only opacity and
 *  transform, and is skipped when someone asks their system for less motion. */

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Whether to hold still: the system asks for less motion, or there's no way to animate. */
export function still(): boolean {
  if (typeof matchMedia !== "function") return true;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type From = { x?: number; y?: number; scale?: number };

const shift = ({ x = 0, y = 0, scale = 1 }: From) => `translate(${x}px, ${y}px)${scale !== 1 ? ` scale(${scale})` : ""}`;

/** Bring an element in from a little offset and transparent, to where it already is. Started
 *  before paint (from a layout effect), the new view never shows a frame at full strength first. */
export function enter(el: Element | null | undefined, from: From = {}, ms = 180): void {
  if (!el || still() || typeof (el as HTMLElement).animate !== "function") return;
  (el as HTMLElement).animate([{ opacity: 0, transform: shift(from) }, { opacity: 1, transform: "none" }], { duration: ms, easing: EASE_OUT });
}

/** Take an element out, a touch quicker than it came in, then settle. Resolves at once with less
 *  motion, so whatever closes it never waits. */
export function leave(el: Element | null | undefined, to: From = {}, ms = 140): Promise<void> {
  if (!el || still() || typeof (el as HTMLElement).animate !== "function") return Promise.resolve();
  const a = (el as HTMLElement).animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: shift(to) }], { duration: ms, easing: "ease-in", fill: "forwards" });
  return a.finished.then(() => undefined, () => undefined);
}

/** Bring in a view when `key` changes, never on first show. `from` picks the direction from the
 *  previous key, so going into something and coming back out move opposite ways. */
export function useEnterOnChange<K>(ref: React.RefObject<Element | null>, key: K, from: (prev: K, next: K) => From | null, ms = 180): void {
  const prev = useRef(key);
  useLayoutEffect(() => {
    if (Object.is(prev.current, key)) return;
    const was = prev.current;
    prev.current = key;
    const f = from(was, key);
    if (f) enter(ref.current, f, ms);
    // `from` is a pure picker; only the key decides when to run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** The line under a row of tabs, one element that slides and stretches to the selected tab (set
 *  as --ink-x and --ink-w on the row; CSS draws it with transform only). It glides when the
 *  selection changes, and snaps when a tab only resizes, so a count arriving never moves it. */
export function useTabInk(ref: React.RefObject<HTMLElement | null>, selectedKey: unknown): void {
  const place = (glide: boolean) => {
    const row = ref.current;
    const tab = row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!row) return;
    if (!tab) {
      row.classList.remove("inked");
      return;
    }
    const x = `${tab.offsetLeft}px`;
    const w = `${tab.offsetWidth}`;
    if (row.style.getPropertyValue("--ink-x") === x && row.style.getPropertyValue("--ink-w") === w) return;
    row.classList.toggle("ink-glide", glide && row.classList.contains("inked") && !still());
    row.style.setProperty("--ink-x", x);
    row.style.setProperty("--ink-w", w);
    row.classList.add("inked");
  };
  // Placed when the selection changes, not on every render: reading a tab's place costs a layout.
  useLayoutEffect(() => place(true), [selectedKey]);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(row);
    for (const t of row.querySelectorAll('[role="tab"]')) ro.observe(t);
    return () => ro.disconnect();
    // The tabs themselves are fixed for a row; re-observe if the selection changes which exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);
}
