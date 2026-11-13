import { useEffect, useRef, useState } from "react";

/** How long a card or sketch says it was just updated. */
const UPDATED_MS = 6_000;
/** A new line is written in over about this long, a word at a time. */
const TYPE_MS = 1_400;

/** When a card or sketch last gained something, for UPDATED_MS after; null otherwise. `ids` are
 *  what counts as new; an id that was already there isn't an update. With a `scope` (the subject
 *  on screen), what is there when the scope first shows isn't an update either. */
export function useUpdated(ids: string[], scope?: string): number | null {
  const seen = useRef<{ scope: string | undefined; ids: Set<string> } | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const sig = [...ids].sort().join(" ");
  useEffect(() => {
    const before = seen.current;
    seen.current = { scope, ids: new Set(ids) };
    if (scope !== undefined && (!before || before.scope !== scope)) return setAt(null);
    if (ids.some((id) => !before?.ids.has(id))) setAt(Date.now());
  }, [sig, scope]);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setAt(null), UPDATED_MS);
    return () => clearTimeout(timer);
  }, [at]);
  return at;
}

/** The ids that arrived while this was on screen, each for `ms` after. What was there at first
 *  isn't new. */
export function useArrived(ids: string[], ms = 7_000): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const sig = ids.join(" ");
  useEffect(() => {
    if (!seen.current) return void (seen.current = new Set(ids));
    const added = ids.filter((id) => !seen.current!.has(id));
    if (!added.length) return;
    for (const id of added) seen.current.add(id);
    const until = Date.now() + ms;
    setFresh((m) => new Map([...m, ...added.map((id) => [id, until] as const)]));
  }, [sig]);
  useEffect(() => {
    if (!fresh.size) return;
    const soonest = Math.min(...fresh.values());
    const timer = setTimeout(() => setFresh((m) => new Map([...m].filter(([, until]) => until > Date.now()))), Math.max(0, soonest - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [fresh]);
  return new Set(fresh.keys());
}

const STILL = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Words Stand just wrote, written in one at a time. The words still to come hold their place
 *  unseen, so nothing moves while it writes. */
export function Typed({ text, on }: { text: string; on: boolean }) {
  const words = text.split(" ");
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!on || STILL || words.length < 2) return setShown(null);
    setShown(0);
    const step = Math.min(90, Math.max(25, TYPE_MS / words.length));
    const timer = setInterval(
      () =>
        setShown((n) => {
          if (n === null || n + 1 >= words.length) {
            clearInterval(timer);
            return null;
          }
          return n + 1;
        }),
      step,
    );
    return () => clearInterval(timer);
    // The mark stays on for seconds after the writing is done; only new words start it again.
  }, [on, text]);
  if (shown === null) return <>{text}</>;
  return (
    <span className="typed" aria-label={text}>
      <span aria-hidden>{words.slice(0, shown).join(" ")}</span>
      <span className="typed-caret" aria-hidden />
      <span className="typed-rest" aria-hidden>
        {(shown ? " " : "") + words.slice(shown).join(" ")}
      </span>
    </span>
  );
}
