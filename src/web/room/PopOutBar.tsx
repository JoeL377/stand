// The floating bar for web meetings. Chrome and Edge let a page pop a small always-on-top
// window out of itself (Document Picture-in-Picture), so the item in focus, your mic, Snap
// and the space's to-dos stay in reach while you share your screen or work in another app.
// The Mac app has its own bar (desktop/bar.html); this is the same bar for the browser.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { BarTodo } from "../macApp.ts";
import { CameraIcon, MicIcon, MicOffIcon } from "../icons.tsx";

type PipApi = { requestWindow(o: { width: number; height: number }): Promise<Window>; window: Window | null };
const pipApi = () => (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
export const canPopOut = () => Boolean(pipApi());

const BAR_H = 52;
const ROW_H = 30;

/** The popped-out window while it's open. open() needs a click (the browser insists). */
export function usePopOut() {
  const [win, setWin] = useState<Window | null>(null);
  const open = useCallback(async () => {
    const api = pipApi();
    if (!api) return;
    if (api.window) return api.window.focus();
    const w = await api.requestWindow({ width: 420, height: BAR_H });
    const style = w.document.createElement("style");
    style.textContent = CSS;
    w.document.head.append(style);
    w.document.title = "Stand";
    w.addEventListener("pagehide", () => setWin(null), { once: true });
    setWin(w);
  }, []);
  // Leaving the meeting closes it.
  useEffect(() => () => pipApi()?.window?.close(), []);
  return { win, open };
}

export function PopOutBar(props: {
  win: Window;
  space: string;
  itemKey: string | null;
  item: string | null;
  micOn: boolean;
  onMic: () => void;
  /** Snaps the shared screen, when one is up; resolves to whether it worked. */
  onSnap: (() => Promise<boolean>) | null;
  todos: BarTodo[];
  /** Where the page sends your mic level (0 to 1) for the ring. */
  levels: MutableRefObject<((level: number) => void) | null>;
}) {
  return createPortal(<Bar {...props} />, props.win.document.body);
}

function Bar(p: Parameters<typeof PopOutBar>[0]) {
  const pill = useRef<HTMLDivElement>(null);
  const [listOpen, setListOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [mutedTalk, setMutedTalk] = useState(false);

  // Your voice: the ring brightens as you talk. Talk while muted (loud for a moment, so a
  // cough doesn't count) and it turns amber and says "You're muted" until a while after.
  const micOn = useRef(p.micOn);
  micOn.current = p.micOn;
  useEffect(() => {
    if (p.micOn) setMutedTalk(false);
  }, [p.micOn]);
  useEffect(() => {
    let loudSince = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    p.levels.current = (v) => {
      pill.current?.style.setProperty("--v", String(micOn.current ? v : 0));
      if (micOn.current) return;
      if (v < 0.45) {
        loudSince = 0;
        return;
      }
      loudSince ||= Date.now();
      if (Date.now() - loudSince < 400) return;
      clearTimeout(quiet);
      quiet = setTimeout(() => setMutedTalk(false), 2500);
      setMutedTalk(true);
    };
    return () => {
      p.levels.current = null;
      clearTimeout(quiet);
    };
  }, [p.levels]);

  // The list makes the window taller, as far as the browser lets a page resize it.
  const rows = Math.min(p.todos.length, 8);
  useEffect(() => {
    const want = BAR_H + (listOpen ? 30 + rows * ROW_H + 10 : 0);
    const w = p.win;
    try {
      if (w.innerHeight !== want) w.resizeTo(w.outerWidth, w.outerHeight - w.innerHeight + want);
    } catch {
      // Not allowed right now: the list scrolls instead.
    }
  }, [listOpen, rows, p.win]);
  useEffect(() => {
    if (!p.todos.length) setListOpen(false);
  }, [p.todos.length]);

  const copy = async (t: BarTodo, plain: boolean) => {
    let text = t.text;
    if (!plain) {
      // The prompt Stand's Copy for agent makes: the words plus the to-do's Stand reference.
      const r = await fetch(`/api/refs/action/${t.id}/prompt`).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as { text?: string } | null) : null;
      if (j?.text) text = j.text;
    }
    // This window has the focus after the click, so it's the one allowed to write.
    await p.win.navigator.clipboard.writeText(text).then(
      () => {
        setCopied(t.id);
        setTimeout(() => setCopied((c) => (c === t.id ? null : c)), 1600);
      },
      () => say(false, "Couldn't copy it"),
    );
  };
  const sayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = (ok: boolean, text: string) => {
    clearTimeout(sayTimer.current);
    setSaid({ ok, text });
    sayTimer.current = setTimeout(() => setSaid(null), ok ? 3000 : 5000);
  };
  const snap = async () => {
    if (!p.onSnap) return;
    if (await p.onSnap()) say(true, "✓ Snapped for everyone");
    else say(false, "Snap didn't work");
  };

  return (
    <>
      <div ref={pill} className={mutedTalk ? "pill muted-talk" : p.micOn ? "pill voice" : "pill"}>
        <span className="logo" aria-hidden>
          <svg viewBox="0 0 32 32">
            <rect width="32" height="32" rx="8" fill="#2d6cdf" />
            <path d="M9 20v-8M14 23V9M19 19v-6M24 17v-2" stroke="white" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
        <span className={said ? (said.ok ? "what said" : "what said bad") : mutedTalk ? "what warn" : "what"} title={p.item ? `${p.space}: ${p.item}` : p.space}>
          {said ? (
            said.text
          ) : mutedTalk ? (
            "You're muted"
          ) : (
            <>
              {p.itemKey && <span className="key">{p.itemKey}</span>}
              {p.item ?? p.space}
            </>
          )}
        </span>
        {p.todos.length > 0 && (
          <button className={listOpen ? "todos on" : "todos"} onClick={() => setListOpen((o) => !o)} title="To-dos in this space: click one to copy it">
            <svg viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="4" />
              <path d="M8.5 12.5l2.5 2.5 4.5-5.5" />
            </svg>
            {p.todos.length}
          </button>
        )}
        <button className={p.micOn ? "mic" : "mic off"} onClick={p.onMic} title={p.micOn ? "Mute" : "Unmute"} aria-label={p.micOn ? "Mute" : "Unmute"}>
          {p.micOn ? <MicIcon /> : <MicOffIcon />}
        </button>
        {p.onSnap && (
          <button className="snap" onClick={() => void snap()} title="Snap the shared screen for everyone in the meeting">
            <CameraIcon />
            Snap
          </button>
        )}
      </div>
      {listOpen && (
        <div className="list">
          <div className="list-head">
            <b>To-dos in {p.space}</b>
            <span>Click to copy for your agent</span>
          </div>
          <ul className="rows">
            {p.todos.map((t) => (
              <li key={t.id} className={copied === t.id ? "todo copied" : "todo"} title={t.text} onClick={(e) => void copy(t, Boolean((e.target as HTMLElement).closest(".plain")))}>
                <span className="t">{t.text}</span>
                <span className="meta">{copied === t.id ? "✓ Copied" : [t.owner, t.itemKey].filter(Boolean).join(" · ")}</span>
                <span className="plain" title="Copy just the to-do's words">
                  Text only
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// The Mac bar's look (desktop/bar.html), filling the little window.
const CSS = `
:root { color-scheme: dark; font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
html, body { margin: 0; background: #111216; color: #e8e8ee; user-select: none; overflow: hidden; }
.pill { --v: 0; position: relative; margin: 6px; height: 40px; display: flex; align-items: center; gap: 6px; padding: 0 5px; border-radius: 999px; background: rgb(24 25 30); box-shadow: 0 0 0 1.5px rgb(96 150 255 / 0.9), 0 0 0 4px rgb(45 108 223 / 0.28); }
.pill.voice { box-shadow: 0 0 0 calc(1.5px + var(--v) * 0.5px) color-mix(in srgb, rgb(170 205 255) calc(var(--v) * 100%), rgb(96 150 255 / 0.9)), 0 0 0 4px rgb(45 108 223 / calc(0.28 + var(--v) * 0.5)); transition: box-shadow 0.12s linear; }
.pill.muted-talk { box-shadow: 0 0 0 1.5px rgb(251 191 36), 0 0 0 4px rgb(245 158 11 / 0.4); }
.pill.muted-talk .mic { background: rgb(245 158 11 / 0.22); color: #fbbf24; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; height: 30px; padding: 0; border: 0; border-radius: 999px; background: none; color: inherit; font: inherit; cursor: pointer; }
button:hover { background: rgb(255 255 255 / 0.1); }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.logo { display: inline-flex; width: 30px; justify-content: center; }
.logo svg { width: 22px; height: 22px; stroke: none; }
.what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d7d7e0; font-size: 12.5px; }
.what .key { margin-right: 6px; padding: 1px 5px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.2); color: #a5a5b3; font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.what.said { color: #86efac; }
.what.said.bad, .what.warn { color: #fcd34d; }
.mic { width: 30px; }
.mic.off { color: #ff7b7b; }
.snap { padding: 0 12px 0 10px; background: #2d6cdf; color: #fff; font-size: 12.5px; font-weight: 500; }
.snap:hover { background: #3d7cf0; }
.todos { padding: 0 8px; gap: 4px; color: #a5a5b3; font-size: 12px; font-variant-numeric: tabular-nums; }
.todos svg { width: 14px; height: 14px; }
.todos.on { background: rgb(255 255 255 / 0.12); color: #e8e8ee; }
.list { margin: 0 6px 6px; padding: 4px; border-radius: 12px; background: rgb(24 25 30); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12); }
.list-head { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px 6px; color: #8e8e9c; font-size: 11px; }
.list-head b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c9c9d3; font-weight: 600; }
.rows { max-height: ${8 * ROW_H}px; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.todo { display: flex; align-items: center; gap: 8px; height: ${ROW_H}px; padding: 0 8px; border-radius: 8px; cursor: pointer; }
.todo:hover { background: rgb(255 255 255 / 0.08); }
.todo .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e3e3ea; font-size: 12.5px; }
.todo .meta { flex: none; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8e8e9c; font-size: 11px; }
.todo .plain { display: none; flex: none; padding: 2px 6px; border-radius: 5px; color: #a5a5b3; font-size: 11px; }
.todo .plain:hover { background: rgb(255 255 255 / 0.12); color: #fff; }
.todo:hover .plain { display: inline; }
.todo:hover .meta { display: none; }
.todo.copied .meta, .todo.copied:hover .meta { display: inline; color: #86efac; }
.todo.copied .plain { display: none; }
`;
