import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { UserMenu } from "../auth.tsx";
import { Logo } from "../icons.tsx";
import { spaceHref } from "./Home.tsx";

/** The spaces you created: rename them and keep their purpose current. */
export function ManageSpaces() {
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.spaces().then((all) => setSpaces(all.filter((s) => s.mine)), (e: Error) => setError(e.message));
  }, []);

  return (
    <div className="spaces-page">
      <header className="sp-bar">
        <div className="sp-bar-inner">
          <Link to="/" className="lobby-brand">
            <Logo />
            Stand
          </Link>
          <span className="spacer" />
          <UserMenu />
        </div>
      </header>
      <main className="sp-main narrow">
        <section className="sp-find">
          <Link to="/" className="muted small">
            ← All spaces
          </Link>
          <h1>Manage spaces</h1>
          <p className="muted">Spaces you created. People get in by the link you share from inside the space.</p>
        </section>
        {error && <p className="error">{error}</p>}
        {spaces?.length === 0 && <p className="muted">You haven't created a space yet.</p>}
        <div className="sp-rows">
          {spaces?.map((s) => (
            <SpaceEditor key={s.id} s={s} />
          ))}
        </div>
      </main>
    </div>
  );
}

function SpaceEditor({ s }: { s: SpaceSummary }) {
  const [name, setName] = useState(s.name);
  const [purpose, setPurpose] = useState(s.purpose);
  const [saved, setSaved] = useState({ name: s.name, purpose: s.purpose });
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  const dirty = name.trim() !== saved.name || purpose.trim() !== saved.purpose;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("saving");
    try {
      const r = await api.updateSpace(s.id, { name: name.trim(), purpose: purpose.trim() });
      setSaved({ name: r.name, purpose: r.purpose });
      setState("saved");
    } catch (err) {
      setState((err as Error).message);
    }
  };

  return (
    <form className="sp-manage-row" onSubmit={save}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label>
        What is it for?
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="One line, e.g. Ship one-page checkout by Nov 15" maxLength={200} />
      </label>
      <div className="sp-manage-foot">
        <button className="primary" disabled={!dirty || state === "saving"}>
          Save
        </button>
        <Link to={spaceHref(s.id)} className="small">
          Enter
        </Link>
        <span className="muted small">
          {state === "saved" && !dirty ? "Saved" : state !== "idle" && state !== "saving" && state !== "saved" ? state : ""}
        </span>
      </div>
    </form>
  );
}
