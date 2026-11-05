import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { Check, ChevronUp, FolderOpen, LayoutGrid, Mic, PanelLeftClose, PanelLeftOpen, Plug, Plus, SlidersHorizontal, type LucideIcon } from "lucide-react";
import type { SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { UserMenu } from "../auth.tsx";
import { ConxtLogo } from "../ConxtLogo.tsx";
import { SelectedTabWeld } from "../SideNavWeld.tsx";
import { useDismiss } from "../useDismiss.ts";

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

const ROWS: Array<{ label: string; icon: LucideIcon; to: string }> = [
  { label: "All spaces", icon: LayoutGrid, to: "/" },
  { label: "Manage spaces", icon: SlidersHorizontal, to: "/spaces/manage" },
  { label: "Connect an agent", icon: Plug, to: "/agents" },
];

/** Counts each rise in what's waiting, so the badge plays its ping once per arrival. */
function useArrivalTick(count: number) {
  const [state, setState] = useState({ tick: 0, seen: count });
  if (state.seen !== count) setState({ tick: count > state.seen ? state.tick + 1 : state.tick, seen: count });
  return state.tick;
}

/** How many of your tasks have work in and wait on your look. */
function WaitingCount(props: { count: number; tick: number; collapsed: boolean }) {
  const label = `${props.count} of your tasks ${props.count === 1 ? "has" : "have"} work in and ${props.count === 1 ? "waits" : "wait"} on your look`;
  const arriving = props.tick > 0 ? " arriving" : "";
  return (
    <span key={props.tick} className={`sp-count${props.collapsed ? " folded" : ""}${arriving}`} title={label} aria-label={label}>
      {props.count}
    </span>
  );
}

/** Which space you're in and the way to the others, like Conxt's project switcher. */
function SpaceSwitcher(props: { spaces: SpaceSummary[] | null; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const nav = useNavigate();
  const newSpace = useNewSpace();
  const inSpace = useMatch("/s/:roomId");
  const inRoom = useMatch("/r/:roomId");
  const here = inSpace?.params.roomId ?? inRoom?.params.roomId;
  const spaces = [...(props.spaces ?? [])].sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.activeAt - a.activeAt);
  const current = spaces.find((s) => s.id === here);
  const label = current?.name ?? "Choose a space";
  const anyLive = spaces.some((s) => s.live);
  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };
  return (
    <div className="sp-switch" ref={ref}>
      {!props.collapsed && <p className="sp-switch-label">Space</p>}
      <button
        type="button"
        className="sp-switch-btn"
        onClick={() => setOpen(!open)}
        disabled={!props.spaces}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch space"
        title={props.collapsed ? `Space: ${label}` : undefined}
      >
        <FolderOpen size={14} aria-hidden />
        {anyLive && <span className="sp-side-dot live" title="Someone is talking" aria-hidden />}
        {!props.collapsed && (
          <>
            <span className="sp-switch-name">{label}</span>
            <ChevronUp size={14} aria-hidden />
          </>
        )}
      </button>
      {open && (
        <div className="sp-switch-pop" role="menu">
          <p className="sp-switch-label">Your spaces</p>
          {spaces.map((s) => (
            <div key={s.id} className="sp-switch-row">
              <button type="button" role="menuitem" onClick={() => go(spaceHref(s.id))} title={s.purpose || s.name}>
                <span className={s.live ? "sp-side-dot live" : "sp-side-dot"} aria-hidden />
                <span className="sp-switch-name">{s.name}</span>
                {s.live && <span className="sr-only">(talking now)</span>}
                {s.id === here && <Check size={15} aria-hidden />}
              </button>
              <Link
                to={joinHref(s.id)}
                className="sp-side-join"
                title={s.live ? "Join them" : "Start talking"}
                aria-label={`${s.live ? "Join them in" : "Start talking in"} ${s.name}`}
              >
                <Mic size={15} aria-hidden />
              </Link>
            </div>
          ))}
          <div className="sp-switch-foot">
            <button type="button" role="menuitem" onClick={() => go("/")}>
              <LayoutGrid size={15} aria-hidden />
              All spaces
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                newSpace();
              }}
            >
              <Plus size={15} aria-hidden />
              New space
            </button>
            <button type="button" role="menuitem" onClick={() => go("/spaces/manage")}>
              <SlidersHorizontal size={15} aria-hidden />
              Manage spaces
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The frame around the spaces pages, after Conxt's: the nav on a darker ground, and the page on
 *  an inset panel that lifts off it. The selected row welds to that panel. */
export function SpacesShell(props: { spaces: SpaceSummary[] | null; children: React.ReactNode }) {
  const [creating, setCreating] = useState<string | null>(null);
  const [collapsed, toggle] = useCollapsed();
  // Folded, each item says what it is on hover.
  const tip = (label: string) => (collapsed ? label : undefined);
  const waiting = (props.spaces ?? []).reduce((n, s) => n + (s.waiting ?? 0), 0);
  const tick = useArrivalTick(waiting);
  return (
    <NewSpaceContext.Provider value={(name = "") => setCreating(name)}>
      <div className={collapsed ? "spaces-page sp-shell collapsed" : "spaces-page sp-shell"}>
        <aside className="sp-side" aria-label="Spaces navigation">
          <div className="sp-side-head">
            <Link to="/" className="sp-side-brand" title="Conxt">
              <ConxtLogo />
            </Link>
          </div>
          <nav className="sp-side-nav">
            <button className="sp-navrow" onClick={() => setCreating("")} title={tip("New space")} aria-label="New space">
              <Plus size={16} aria-hidden />
              <span className="sp-side-text">New space</span>
            </button>
            {ROWS.map(({ label, icon: Icon, to }) => (
              <NavLink key={to} to={to} end={to === "/"} className="sp-navrow" title={tip(label)} aria-label={label}>
                {({ isActive }) => (
                  <>
                    {isActive && <SelectedTabWeld />}
                    <Icon size={16} aria-hidden />
                    <span className="sp-side-text">{label}</span>
                    {to === "/" && waiting > 0 && <WaitingCount count={waiting} tick={tick} collapsed={collapsed} />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="sp-side-user">
            <UserMenu />
          </div>
          <div className="sp-side-foldrow">
            <button
              className="sp-side-fold"
              onClick={toggle}
              aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
              aria-expanded={!collapsed}
              title={`${collapsed ? "Expand" : "Collapse"} the sidebar (${SHORTCUT})`}
            >
              {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
            </button>
          </div>
          <div className="sp-side-switch">
            <SpaceSwitcher spaces={props.spaces} collapsed={collapsed} />
          </div>
        </aside>
        <div className="sp-content">
          <div className="sp-surface">{props.children}</div>
        </div>
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
