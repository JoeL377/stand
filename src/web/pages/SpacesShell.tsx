import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LayoutGrid, Mic, PanelLeftClose, PanelLeftOpen, Plug, Plus, SlidersHorizontal, type LucideIcon } from "lucide-react";
import type { SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { ConxtLogo } from "../ConxtLogo.tsx";
import { ProfileMenu } from "../ProfileMenu.tsx";
import { SelectedTabWeld } from "../SideNavWeld.tsx";
import { colorFor, initials } from "../util.ts";

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

const FOOT_ROWS: Array<{ label: string; icon: LucideIcon; to: string }> = [
  { label: "Manage spaces", icon: SlidersHorizontal, to: "/spaces/manage" },
  { label: "Connect an agent", icon: Plug, to: "/agents" },
];

/** Counts each rise in what's waiting, so the badge plays its ping once per arrival. */
function useArrivalTick(count: number) {
  const [state, setState] = useState({ tick: 0, seen: count });
  if (state.seen !== count) setState({ tick: count > state.seen ? state.tick + 1 : state.tick, seen: count });
  return state.tick;
}

/** How many of your tasks in this space have work in and wait on your look. */
function WaitingCount(props: { count: number; collapsed: boolean }) {
  const tick = useArrivalTick(props.count);
  if (props.count === 0) return null;
  const label = `${props.count} of your tasks ${props.count === 1 ? "has" : "have"} work in and ${props.count === 1 ? "waits" : "wait"} on your look`;
  return (
    <span key={tick} className={`sp-count${props.collapsed ? " folded" : ""}${tick > 0 ? " arriving" : ""}`} title={label} aria-label={label}>
      {props.count}
    </span>
  );
}

/** One space in the nav. A space is the team's home, so you only have a few and they stay in view:
 *  one click goes in, and the mic starts talking there. */
function SpaceRow(props: { space: SpaceSummary; collapsed: boolean }) {
  const { space: s, collapsed } = props;
  return (
    <div className="sp-spacerow">
      <NavLink to={spaceHref(s.id)} className="sp-navrow" title={collapsed ? s.name : s.purpose || s.name} aria-label={s.name}>
        {({ isActive }) => (
          <>
            {isActive && <SelectedTabWeld />}
            <span className="sp-space-tile" style={{ background: colorFor(s.id) }} aria-hidden>
              {initials(s.name)}
              {s.live && <span className="sp-side-dot live" />}
            </span>
            <span className="sp-side-text">{s.name}</span>
            {s.live && <span className="sr-only">(talking now)</span>}
            <WaitingCount count={s.waiting ?? 0} collapsed={collapsed} />
          </>
        )}
      </NavLink>
      {!collapsed && (
        <Link
          to={joinHref(s.id)}
          className="sp-side-join"
          title={s.live ? "Join them" : "Start talking"}
          aria-label={`${s.live ? "Join them in" : "Start talking in"} ${s.name}`}
        >
          <Mic size={15} aria-hidden />
        </Link>
      )}
    </div>
  );
}

/** The frame around the spaces pages, after Conxt's: the nav on a darker ground, and the page on
 *  an inset panel that lifts off it. The selected row welds to that panel. Conxt keeps its projects
 *  behind a switcher; here spaces are the main thing in the nav, so they're listed. */
export function SpacesShell(props: { spaces: SpaceSummary[] | null; children: React.ReactNode }) {
  const [creating, setCreating] = useState<string | null>(null);
  const [collapsed, toggle] = useCollapsed();
  // Folded, each item says what it is on hover.
  const tip = (label: string) => (collapsed ? label : undefined);
  // By name, so a row stays put when you open it. A call moves its space to the top.
  const spaces = [...(props.spaces ?? [])].sort((a, b) => Number(!!b.live) - Number(!!a.live) || a.name.localeCompare(b.name));
  const row = ({ label, icon: Icon, to }: (typeof FOOT_ROWS)[number]) => (
    <NavLink key={to} to={to} end={to === "/"} className="sp-navrow" title={tip(label)} aria-label={label}>
      {({ isActive }) => (
        <>
          {isActive && <SelectedTabWeld />}
          <Icon size={16} aria-hidden />
          <span className="sp-side-text">{label}</span>
        </>
      )}
    </NavLink>
  );
  return (
    <NewSpaceContext.Provider value={(name = "") => setCreating(name)}>
      <div className={collapsed ? "spaces-page sp-shell collapsed" : "spaces-page sp-shell"}>
        <aside className="sp-side" aria-label="Spaces navigation">
          <div className="sp-side-head">
            <Link to="/" className="sp-side-brand" title="Conxt">
              <ConxtLogo />
            </Link>
          </div>
          <nav className="sp-side-nav">{row({ label: "All spaces", icon: LayoutGrid, to: "/" })}</nav>
          <div className="sp-side-spaces">
            {spaces.length > 0 && <p className="sp-side-label">Spaces</p>}
            {spaces.map((s) => (
              <SpaceRow key={s.id} space={s} collapsed={collapsed} />
            ))}
            <button className="sp-navrow" onClick={() => setCreating("")} title={tip("New space")} aria-label="New space">
              <Plus size={16} aria-hidden />
              <span className="sp-side-text">New space</span>
            </button>
          </div>
          <nav className="sp-side-nav sp-side-foot">{FOOT_ROWS.map(row)}</nav>
          <div className="sp-side-user">
            <ProfileMenu collapsed={collapsed} />
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
