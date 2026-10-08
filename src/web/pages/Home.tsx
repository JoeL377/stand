import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { UserMenu } from "../auth.tsx";
import { Logo } from "../icons.tsx";
import { Avatar } from "../room/Stage.tsx";
import { fmtDuration } from "../util.ts";

type Filter = "all" | "live" | "decide";

const FILTERS: Array<{ id: Filter; label: string; test: (s: SpaceSummary) => boolean }> = [
  { id: "all", label: "All", test: () => true },
  { id: "live", label: "Talking now", test: (s) => s.live !== null },
  { id: "decide", label: "Needs a decision", test: (s) => s.toDecide > 0 },
];

export const spaceHref = (id: string) => `/s/${id}`;

/** Home: find one of your spaces and go in. Spaces are invite only, so these are
 *  the ones you created or opened from a link. Creating and managing sit in the header. */
export function Home() {
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.spaces().then(setSpaces, (e: Error) => setError(e.message));
    load();
    // Keep "Talking now" current while the page is open.
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const query = q.trim().toLowerCase();
  const matches = useMemo(() => (spaces ?? []).filter((s) => !query || s.search.includes(query)), [spaces, query]);
  const shown = matches.filter(FILTERS.find((f) => f.id === filter)!.test);
  const live = shown.filter((s) => s.live);
  const mine = shown.filter((s) => !s.live);

  return (
    <div className="spaces-page">
      <header className="sp-bar">
        <div className="sp-bar-inner">
          <Link to="/" className="lobby-brand">
            <Logo />
            Stand
          </Link>
          <span className="spacer" />
          <Link to="/spaces/manage" className="sp-manage">
            <SlidersIcon />
            Manage spaces
          </Link>
          <button className="sp-new" onClick={() => setCreating(creating === null ? "" : null)} aria-expanded={creating !== null}>
            <PlusIcon />
            New space
          </button>
          <UserMenu />
        </div>
      </header>

      <main className="sp-main">
        {creating !== null && <NewSpace initialName={creating} onClose={() => setCreating(null)} />}

        <section className="sp-find">
          <h1>Spaces</h1>
          <p className="muted">The spaces you’re in: see where each one stands, and jump in.</p>
          <label className="sp-search">
            <span className="sr-only">Search spaces</span>
            <SearchIcon />
            <input
              type="search"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search spaces, decisions, people…"
              autoComplete="off"
            />
          </label>
          <div className="sp-filters" role="group" aria-label="Filter spaces">
            {FILTERS.map((f) => (
              <button key={f.id} className={f.id === filter ? "sp-chip on" : "sp-chip"} aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
                {f.label}
                <span className="n">{matches.filter(f.test).length}</span>
              </button>
            ))}
          </div>
        </section>

        {error && <p className="error">{error}</p>}
        {spaces === null && !error && <p className="muted">Loading spaces…</p>}

        {live.length > 0 && (
          <section className="sp-section">
            <h2>Talking now</h2>
            <div className="sp-grid">
              {live.map((s) => (
                <LiveCard key={s.id} s={s} />
              ))}
            </div>
          </section>
        )}

        {mine.length > 0 && (
          <section className="sp-section">
            <h2>Your spaces</h2>
            <div className="sp-grid">
              {mine.map((s) => (
                <SpaceCard key={s.id} s={s} />
              ))}
            </div>
          </section>
        )}

        {spaces !== null && shown.length === 0 && (
          <section className="sp-empty">
            {query ? (
              <>
                <strong>No spaces match “{q.trim()}”</strong>
                <span className="muted">Try a person’s name or a decision. Or start a space for it.</span>
                <button className="sp-new" onClick={() => setCreating(q.trim())}>
                  Create “{q.trim()}” as a new space
                </button>
              </>
            ) : spaces.length === 0 ? (
              <>
                <strong>No spaces yet</strong>
                <span className="muted">A space is where one thing your team is working on lives: its items, decisions, to-dos and conversations. Spaces someone shares with you show up here once you open their link.</span>
                <button className="sp-new" onClick={() => setCreating("")}>
                  Create the first space
                </button>
              </>
            ) : (
              <span className="muted">Nothing here for this filter.</span>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function NewSpace(props: { initialName: string; onClose: () => void }) {
  const [name, setName] = useState(props.initialName);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const purposeRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    if (props.initialName) purposeRef.current?.focus();
  }, [props.initialName]);

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
    <form className="sp-newform" onSubmit={create} aria-label="New space">
      <div className="sp-newform-head">
        <strong>New space</strong>
        <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <label>
        Name
        <input autoFocus={!props.initialName} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout v2" maxLength={80} />
      </label>
      <label>
        What is it for?
        <input ref={purposeRef} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="One line, e.g. Ship one-page checkout by Nov 15" maxLength={200} />
      </label>
      <div className="sp-newform-foot">
        <button className="primary" disabled={busy}>
          Create and enter
        </button>
        <span className="muted small">Only people you share its link with can find it.</span>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function LiveCard({ s }: { s: SpaceSummary }) {
  const live = s.live!;
  const names = live.people.map((p) => p.name.split(/\s+/)[0]);
  const who = names.length === 1 ? `${names[0]} is` : names.length === 2 ? `${names[0]} and ${names[1]} are` : `${names[0]} and ${names.length - 1} others are`;
  return (
    <Link to={spaceHref(s.id)} className="sp-card live">
      <div className="sp-card-head">
        <span className="sp-live-dot" aria-hidden />
        <span className="sp-name">{s.name}</span>
        <span className="sp-enter primary">Enter</span>
      </div>
      <div>
        {who} {live.focusTitle ? <>on “{live.focusTitle}”</> : "talking"}
      </div>
      <div className="sp-card-foot">
        <span className="sp-faces">
          {live.people.slice(0, 4).map((p, i) => (
            <Avatar key={i} id={p.name} name={p.name} picture={p.picture} size={24} />
          ))}
        </span>
        <span className="sp-live-for">{Date.now() - live.since < 60_000 ? "Just started" : `Talking for ${fmtDuration(Date.now() - live.since)}`}</span>
      </div>
    </Link>
  );
}

function SpaceCard({ s }: { s: SpaceSummary }) {
  return (
    <Link to={spaceHref(s.id)} className="sp-card">
      <div className="sp-card-head">
        <span className="sp-name">{s.name}</span>
        {s.forYou > 0 && (
          <span className="sp-foryou" title="Open to-dos with your name on them">
            {s.forYou} for you
          </span>
        )}
      </div>
      <div className={s.purpose ? "muted" : "muted sp-nopurpose"}>{s.purpose || "No purpose yet"}</div>
      <StateChips s={s} />
      <div className="sp-last">
        <span className="sp-last-text">{s.last ? lastLine(s.last) : "Nothing decided yet"}</span>
        <span className="muted small">{ago(s.last?.ts ?? s.activeAt)}</span>
      </div>
    </Link>
  );
}

function StateChips({ s }: { s: SpaceSummary }) {
  if (!s.toDecide && !s.todos) return null;
  return (
    <span className="sp-states">
      {s.toDecide > 0 && <span className="sp-state decide">{s.toDecide} to decide</span>}
      {s.todos > 0 && <span className="sp-state todo">{s.todos} to-do{s.todos === 1 ? "" : "s"}</span>}
    </span>
  );
}

const lastLine = (l: NonNullable<SpaceSummary["last"]>) => `${l.kind === "decision" ? "Decided" : l.kind === "question" ? "Open" : "To do"}: ${l.text}`;

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
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
