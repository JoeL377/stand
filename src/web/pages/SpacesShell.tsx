import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { ChevronDown, LayoutGrid, Mic, User, PanelLeftClose, PanelLeftOpen, Plug, Plus, SlidersHorizontal, type LucideIcon } from "lucide-react";
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

/** How many tasks in this space wait on you: your work to look at, or a comment that tags you. */
function WaitingCount(props: { count: number; collapsed: boolean }) {
  const tick = useArrivalTick(props.count);
  if (props.count === 0) return null;
  const label = `${props.count} ${props.count === 1 ? "task waits" : "tasks wait"} on you: work to look at, or a comment that tags you`;
  return (
    <span key={tick} className={`sp-count${props.collapsed ? " folded" : ""}${tick > 0 ? " arriving" : ""}`} title={label} aria-label={label}>
      {props.count}
    </span>
  );
}

/** New chat in a space: a dot, or an @ when a message you haven't read tags you. */
function ChatMark(props: { unread: number; mentions: number; collapsed: boolean }) {
  const tick = useArrivalTick(props.mentions);
  if (!props.unread) return null;
  const folded = props.collapsed ? " folded" : "";
  if (props.mentions > 0) {
    const label = `${props.mentions} ${props.mentions === 1 ? "chat message mentions" : "chat messages mention"} you`;
    return (
      <span key={tick} className={`sp-chat-mark mention${folded}${tick > 0 ? " arriving" : ""}`} title={label} aria-label={label}>
        @
      </span>
    );
  }
  const label = `${props.unread} unread in chat`;
  return <span className={`sp-chat-mark${folded}`} title={label} aria-label={label} />;
}

/** One space in the nav. A space is the team's home, so you only have a few and they stay in view:
 *  one click goes in, and the mic starts talking there. */
function SpaceRow(props: { space: SpaceSummary; collapsed: boolean }) {
  const { space: s, collapsed } = props;
  return (
    <div className="sp-spacerow">
      {/* Pointing at a space reads it, so it is there by the time the click lands. */}
      <NavLink to={spaceHref(s.id)} className="sp-navrow" title={collapsed ? s.name : s.purpose || s.name} aria-label={s.name} onPointerEnter={() => api.warm(s.id)} onFocus={() => api.warm(s.id)}>
        {({ isActive }) => (
          <>
            {isActive && <SelectedTabWeld />}
            <span className="sp-space-tile" style={{ background: colorFor(s.id) }} aria-hidden>
              {initials(s.name)}
              {s.live && <span className="sp-side-dot live" />}
            </span>
            <span className={s.unread ? "sp-side-text unread" : "sp-side-text"}>{s.name}</span>
            {s.live && <span className="sr-only">(talking now)</span>}
            <ChatMark unread={s.unread ?? 0} mentions={s.chatMentions ?? 0} collapsed={collapsed} />
            <WaitingCount count={(s.waiting ?? 0) + (s.mentions ?? 0)} collapsed={collapsed} />
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

/** On a phone, the way around from inside a space: its projects (straight into one), the other
 *  spaces, and the app's own pages. It slides in from the left over the page. */
export function PhoneMenu(props: {
  spaces: SpaceSummary[] | null;
  current: { id: string; name: string };
  projects: Array<{ id: string; name: string; pinned: boolean }>;
  openProject: string | null;
  /** Your own open work in this space, across its projects. */
  mine: { on: boolean; count: number; open: () => void };
  onProject: (id: string) => void;
  onClose: () => void;
}) {
  const newSpace = useNewSpace();
  const others = [...(props.spaces ?? [])]
    .filter((s) => s.id !== props.current.id)
    .sort((a, b) => Number(!!b.live) - Number(!!a.live) || a.name.localeCompare(b.name));
  const [switching, setSwitching] = useState(false);
  // Out the way it came: the panel slides back left and the shade fades, then it unmounts.
  const [closing, setClosing] = useState(false);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const close = () => {
    if (closing) return;
    if (reduced) return props.onClose();
    setClosing(true);
    window.setTimeout(props.onClose, 180);
  };
  const elsewhere = others.some((s) => s.live || (s.unread ?? 0) > 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = was;
    };
  }, []);
  const go = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div className={closing ? "pm-wrap closing" : "pm-wrap"} onClick={close}>
      <nav className="pm" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        {/* The space's name is the switcher: tap it for your other spaces. */}
        <button type="button" className="pm-head" aria-expanded={switching} onClick={() => setSwitching((v) => !v)}>
          <span className="sp-space-tile" style={{ background: colorFor(props.current.id) }} aria-hidden>
            {initials(props.current.name)}
          </span>
          <strong>{props.current.name}</strong>
          {elsewhere && !switching && <span className="pm-new" aria-label="Something new in another space" />}
          <ChevronDown size={16} aria-hidden className={switching ? "pm-caret open" : "pm-caret"} />
        </button>
        {switching && (
          <div className="pm-switch">
            {others.map((s) => (
              <Link key={s.id} to={spaceHref(s.id)} className="pm-row" onClick={close}>
                <span className="sp-space-tile" style={{ background: colorFor(s.id) }} aria-hidden>
                  {initials(s.name)}
                  {s.live && <span className="sp-side-dot live" />}
                </span>
                <span className="pm-text">{s.name}</span>
                {(s.unread ?? 0) > 0 && <span className="pm-new" aria-label="New messages" />}
              </Link>
            ))}
            <Link to="/" className="pm-row" onClick={close}>
              <LayoutGrid size={16} aria-hidden />
              <span className="pm-text">All spaces</span>
            </Link>
            <button type="button" className="pm-row" onClick={go(() => newSpace(""))}>
              <Plus size={16} aria-hidden />
              <span className="pm-text">New space</span>
            </button>
          </div>
        )}
        <p className="pm-label">Projects</p>
        <button type="button" className={props.mine.on ? "pm-row on" : "pm-row"} onClick={go(props.mine.open)}>
          <User size={16} aria-hidden />
          <span className="pm-text">Mine</span>
          {props.mine.count > 0 && <span className="pm-count">{props.mine.count}</span>}
        </button>
        <button type="button" className={props.openProject === "" ? "pm-row on" : "pm-row"} onClick={go(() => props.onProject(""))}>
          <LayoutGrid size={16} aria-hidden />
          <span className="pm-text">All projects</span>
        </button>
        {props.projects.map((p) => (
          <button key={p.id} type="button" className={props.openProject === p.id ? "pm-row on" : "pm-row"} onClick={go(() => props.onProject(p.id))}>
            <span className={p.pinned ? "pm-dot pinned" : "pm-dot"} aria-hidden />
            <span className="pm-text">{p.name}</span>
          </button>
        ))}
        <div className="pm-foot">
          {FOOT_ROWS.map(({ label, icon: Icon, to }) => (
            <Link key={to} to={to} className="pm-row" onClick={close}>
              <Icon size={16} aria-hidden />
              <span className="pm-text">{label}</span>
            </Link>
          ))}
          <div className="pm-user">
            <ProfileMenu collapsed={false} />
          </div>
        </div>
      </nav>
    </div>
  );
}
