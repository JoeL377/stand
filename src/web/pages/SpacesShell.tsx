import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import type { SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { UserMenu } from "../auth.tsx";
import { Logo } from "../icons.tsx";

export const spaceHref = (id: string) => `/s/${id}`;

/** Opens the New space pop-up, optionally with a name filled in. */
const NewSpaceContext = createContext<(name?: string) => void>(() => {});
export const useNewSpace = () => useContext(NewSpaceContext);

/** The frame around the spaces pages: a left sidebar for creating, navigating and
 *  jumping into a space, and the page itself on the right. */
export function SpacesShell(props: { spaces: SpaceSummary[] | null; children: React.ReactNode }) {
  const [creating, setCreating] = useState<string | null>(null);
  const quick = [...(props.spaces ?? [])].sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.activeAt - a.activeAt);
  return (
    <NewSpaceContext.Provider value={(name = "") => setCreating(name)}>
      <div className="spaces-page sp-shell">
        <aside className="sp-side" aria-label="Spaces navigation">
          <Link to="/" className="lobby-brand sp-side-brand">
            <Logo />
            Stand
          </Link>
          <button className="sp-side-new" onClick={() => setCreating("")}>
            <PlusIcon />
            New space
          </button>
          <nav className="sp-side-nav">
            <NavLink to="/" end>
              <GridIcon />
              All spaces
            </NavLink>
            <NavLink to="/spaces/manage">
              <SlidersIcon />
              Manage spaces
            </NavLink>
            <NavLink to="/agents">
              <PlugIcon />
              Connect an agent
            </NavLink>
          </nav>
          {quick.length > 0 && (
            <div className="sp-side-list">
              <div className="sp-side-label">Your spaces</div>
              {quick.map((s) => (
                <Link key={s.id} to={spaceHref(s.id)} className="sp-side-space" title={s.purpose || s.name}>
                  <span className={s.live ? "sp-side-dot live" : "sp-side-dot"} aria-hidden />
                  <span className="sp-side-name">{s.name}</span>
                  {s.live && <span className="sr-only">(talking now)</span>}
                </Link>
              ))}
            </div>
          )}
          <div className="sp-side-user">
            <UserMenu />
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
