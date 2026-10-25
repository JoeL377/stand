import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type { SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { UserMenu } from "../auth.tsx";
import { Logo, MicIcon, PanelIcon } from "../icons.tsx";

export const spaceHref = (id: string) => `/s/${id}`;
/** Straight into talking in the space, past its overview page. */
export const joinHref = (id: string) => `/s/${id}?join=1`;

/** Opens the New space pop-up, optionally with a name filled in. */
const NewSpaceContext = createContext<(name?: string) => void>(() => {});
export const useNewSpace = () => useContext(NewSpaceContext);

const IS_MAC = /Mac/.test(navigator.platform);
const SHORTCUT = IS_MAC ? "Command + B" : "Control + B";
const COLLAPSED_KEY = "stand.sideCollapsed";

/** Whether the sidebar is folded to a rail of icons, remembered in this browser. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b") return;
      // Typing keeps its own Command + B.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [collapsed, toggle] as const;
}

/** The frame around the spaces pages: a left sidebar for creating, navigating and
 *  jumping into a space, and the page itself on the right. */
export function SpacesShell(props: { spaces: SpaceSummary[] | null; children: React.ReactNode }) {
  const [creating, setCreating] = useState<string | null>(null);
  const [collapsed, toggle] = useCollapsed();
  // Folded, each item says what it is on hover.
  const tip = (label: string) => (collapsed ? label : undefined);
  const waiting = (props.spaces ?? []).reduce((n, s) => n + (s.waiting ?? 0), 0);
  const quick = [...(props.spaces ?? [])].sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.activeAt - a.activeAt);
  return (
    <NewSpaceContext.Provider value={(name = "") => setCreating(name)}>
      <div className={collapsed ? "spaces-page sp-shell collapsed" : "spaces-page sp-shell"}>
        <aside className="sp-side" aria-label="Spaces navigation">
          <div className="sp-side-head">
            <Link to="/" className="lobby-brand sp-side-brand" title={tip("Stand")}>
              <Logo />
              <span className="sp-side-text">Stand</span>
            </Link>
            <button
              className="sp-side-fold"
              onClick={toggle}
              aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
              aria-expanded={!collapsed}
              title={`${collapsed ? "Expand" : "Collapse"} the sidebar (${SHORTCUT})`}
            >
              <PanelIcon size={16} open={!collapsed} />
            </button>
          </div>
          <button className="sp-side-new" onClick={() => setCreating("")} title={tip("New space")} aria-label="New space">
            <PlusIcon />
            <span className="sp-side-text">New space</span>
          </button>
          <nav className="sp-side-nav">
            <NavLink to="/" end title={tip("All spaces")} aria-label="All spaces">
              <GridIcon />
              <span className="sp-side-text">All spaces</span>
            </NavLink>
            <NavLink to="/spaces/manage" title={tip("Manage spaces")} aria-label="Manage spaces">
              <SlidersIcon />
              <span className="sp-side-text">Manage spaces</span>
            </NavLink>
            <NavLink to="/agents" title={tip("Connect an agent")} aria-label="Connect an agent">
              <PlugIcon />
              <span className="sp-side-text">Connect an agent</span>
            </NavLink>
          </nav>
          {quick.length > 0 && (
            <div className="sp-side-list">
              <div className="sp-side-label">Your spaces</div>
              {quick.map((s) => (
                <div key={s.id} className="sp-side-row">
                  <Link to={spaceHref(s.id)} className="sp-side-space" title={collapsed ? s.name : s.purpose || s.name}>
                    <span className={s.live ? "sp-side-dot live" : "sp-side-dot"} aria-hidden />
                    <span className="sp-side-initial" aria-hidden>
                      {s.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="sp-side-name">{s.name}</span>
                    {s.live && <span className="sr-only">(talking now)</span>}
                  </Link>
                  <Link
                    to={joinHref(s.id)}
                    className="sp-side-join"
                    title={s.live ? "Join them" : "Start talking"}
                    aria-label={`${s.live ? "Join them in" : "Start talking in"} ${s.name}`}
                  >
                    <MicIcon />
                  </Link>
                </div>
              ))}
            </div>
          )}
          <div className="sp-side-user">
            <UserMenu />
            {waiting > 0 && (
              <span className="sp-side-waiting" title={`${waiting} of your tasks ${waiting === 1 ? "has" : "have"} work in and ${waiting === 1 ? "waits" : "wait"} on your look`}>
                {waiting} waiting on you
              </span>
            )}
          </div>
        </aside>
        <div className="sp-content">{props.children}</div>
        {creating !== null && <NewSpaceDialog initialName={creating} onClose={() => setCreating(null)} />}
      </div>
    </NewSpaceContext.Provider>
  );
}

function NewSpaceDialog(props: { initialName: string; onClose: () => void }) {
  const [name, setName] = useState(props.initialName);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const purposeRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const { onClose } = props;

  useEffect(() => {
    (props.initialName ? purposeRef : nameRef).current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.initialName, onClose]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the space a name.");
    setBusy(true);
    setError(null);
    try {
      const room = await api.createRoom(name.trim(), purpose.trim());
      nav(spaceHref(room.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog sp-newdialog" role="dialog" aria-modal="true" aria-labelledby="new-space-title" onSubmit={create}>
        <div className="sp-newform-head">
          <strong id="new-space-title">New space</strong>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <label>
          Name
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout v2" maxLength={80} />
        </label>
        <label>
          What is it for?
          <input
            ref={purposeRef}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="One line, e.g. Ship one-page checkout by Nov 15"
            maxLength={200}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <p className="muted small sp-newdialog-note">Only people you share its link with can find it.</p>
        <div className="sp-newdialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Create and enter
          </button>
        </div>
      </form>
    </div>
  );
}

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const GridIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
);
const SlidersIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </svg>
);
const PlugIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" />
  </svg>
);
