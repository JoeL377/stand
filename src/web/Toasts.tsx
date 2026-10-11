// Short messages at the bottom of the screen: what just happened, with Undo
// when it can be taken back, and why something failed when it did.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ToastSpec {
  text: string;
  tone?: "info" | "error";
  /** One action, like Undo or Retry. Clicking it closes the toast. */
  action?: { label: string; run: () => void };
  ms?: number;
}
type Shown = ToastSpec & { key: number; leaving?: boolean };

let shown: Shown[] = [];
const listeners = new Set<(list: Shown[]) => void>();
const emit = () => listeners.forEach((l) => l(shown));

// Each toast's time left; it stops running while the pointer or keyboard focus is on the toast.
const timers = new Map<number, { left: number; started: number; t?: ReturnType<typeof setTimeout> }>();
function runTimer(key: number) {
  const x = timers.get(key);
  if (!x || x.t) return;
  x.started = Date.now();
  x.t = setTimeout(() => dismissToast(key), x.left);
}
function holdTimer(key: number) {
  const x = timers.get(key);
  if (!x?.t) return;
  clearTimeout(x.t);
  x.t = undefined;
  x.left = Math.max(1500, x.left - (Date.now() - x.started));
}

export function toast(t: ToastSpec): number {
  const key = Date.now() + Math.random();
  const item = { ...t, key };
  // Three at a time, but a newer message never pushes out one that can still be undone.
  shown = [...shown, item];
  for (;;) {
    const staying = shown.filter((x) => !x.leaving);
    if (staying.length <= 3) break;
    const i = staying.findIndex((x) => !x.action && x !== item);
    if (i < 0 && staying.length <= 5) break;
    leave(staying[i < 0 ? 0 : i].key);
  }
  emit();
  // Undo stays long enough to reach; errors long enough to read.
  const ms = t.ms ?? (t.action ? 7000 : t.tone === "error" ? Math.max(6000, t.text.length * 70) : 3500);
  timers.set(key, { left: ms, started: Date.now() });
  runTimer(key);
  return key;
}

/** Marks a toast as leaving: it fades out the way it came, then goes. */
function leave(key: number) {
  clearTimeout(timers.get(key)?.t);
  timers.delete(key);
  if (!shown.some((t) => t.key === key && !t.leaving)) return;
  shown = shown.map((t) => (t.key === key ? { ...t, leaving: true } : t));
  setTimeout(() => {
    shown = shown.filter((t) => t.key !== key);
    emit();
  }, LEAVE_MS);
}
const LEAVE_MS = 160;

export function dismissToast(key: number) {
  leave(key);
  emit();
}

/** "Couldn't remove it. Can't reach Stand…" from a failed request. */
export function errorToast(what: string, retry?: () => void) {
  return (err: unknown) =>
    toast({
      tone: "error",
      text: `${what}. ${(err as Error)?.message ?? String(err)}`,
      ...(retry ? { action: { label: "Try again", run: retry } } : {}),
    });
}

/** An Undo that needs the connection: when it's down, the message keeps a button to try again. */
export function undoing(run: () => boolean) {
  const attempt = () => {
    if (!run()) toast({ tone: "error", text: "Couldn't undo while Stand is reconnecting.", action: { label: "Try again", run: attempt } });
  };
  return attempt;
}

export function Toasts() {
  const [list, setList] = useState(shown);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  // When one arrives or leaves, the others glide to their new places instead of jumping
  // (the FLIP technique, on the `translate` property so it doesn't fight their own entry).
  const els = useRef(new Map<number, HTMLDivElement>());
  const tops = useRef(new Map<number, number>());
  const glides = useRef(new Map<number, Animation>());
  useLayoutEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const keys = new Set(list.map((t) => t.key));
    for (const m of [els.current, tops.current, glides.current]) for (const k of m.keys()) if (!keys.has(k)) m.delete(k);
    for (const [key, el] of els.current) {
      const cs = getComputedStyle(el);
      const shift = parseFloat(cs.translate.split(" ")[1] ?? "0") || 0;
      // Its own entry offset (rising into place) isn't where it lives either.
      const rising = cs.transform === "none" ? 0 : new DOMMatrixReadOnly(cs.transform).m42;
      const top = el.getBoundingClientRect().top - shift - rising;
      const was = tops.current.get(key);
      tops.current.set(key, top);
      if (was === undefined || Math.abs(was - top) < 1 || still || !el.animate) continue;
      glides.current.get(key)?.cancel();
      glides.current.set(
        key,
        el.animate([{ translate: `0 ${was + shift - top}px` }, { translate: "0 0" }], { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }),
      );
    }
  }, [list]);
  // The region is always there, so screen readers announce what lands in it.
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.key}
          ref={(el) => void (el && els.current.set(t.key, el))}
          className={`toast${t.tone === "error" ? " error" : ""}${t.leaving ? " leaving" : ""}`}
          role={t.tone === "error" ? "alert" : "status"}
          aria-hidden={t.leaving || undefined}
          onMouseEnter={() => holdTimer(t.key)}
          onMouseLeave={() => runTimer(t.key)}
          onFocus={() => holdTimer(t.key)}
          onBlur={() => runTimer(t.key)}
        >
          <span className="toast-text" dir="auto">
            {t.text}
          </span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.key);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.key)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
