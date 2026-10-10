// Short messages at the bottom of the screen: what just happened, with Undo
// when it can be taken back, and why something failed when it did.

import { useEffect, useState } from "react";

export interface ToastSpec {
  text: string;
  tone?: "info" | "error";
  /** One action, like Undo or Retry. Clicking it closes the toast. */
  action?: { label: string; run: () => void };
  ms?: number;
}
type Shown = ToastSpec & { key: number };

let shown: Shown[] = [];
const listeners = new Set<(list: Shown[]) => void>();
const emit = () => listeners.forEach((l) => l(shown));

export function toast(t: ToastSpec): number {
  const key = Date.now() + Math.random();
  shown = [...shown.slice(-2), { ...t, key }];
  emit();
  // Undo stays long enough to reach; errors long enough to read.
  const ms = t.ms ?? (t.action ? 7000 : t.tone === "error" ? Math.max(6000, t.text.length * 70) : 3500);
  setTimeout(() => dismissToast(key), ms);
  return key;
}

export function dismissToast(key: number) {
  shown = shown.filter((t) => t.key !== key);
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

export function Toasts() {
  const [list, setList] = useState(shown);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  // The region is always there, so screen readers announce what lands in it.
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.key} className={t.tone === "error" ? "toast error" : "toast"} role={t.tone === "error" ? "alert" : "status"}>
          <span className="toast-text">{t.text}</span>
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
