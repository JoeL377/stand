import { useEffect, useState } from "react";
import type { AgentToken, SpaceSummary } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { fmtDate } from "../util.ts";
import { SpacesShell } from "./SpacesShell.tsx";

type Client = "claude" | "cursor" | "codex";

const CLIENTS: Array<{ id: Client; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
];

function setup(client: Client, url: string, token: string): { where: string; text: string } {
  if (client === "claude")
    return {
      where: "Run this in a terminal. It works in every project on this computer.",
      text: `claude mcp add --transport http --scope user stand ${url} \\\n  --header "Authorization: Bearer ${token}"`,
    };
  if (client === "cursor")
    return {
      where: "Add this to ~/.cursor/mcp.json (or Settings → MCP → Add new server).",
      text: JSON.stringify({ mcpServers: { stand: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    };
  return {
    where: "Add this to ~/.codex/config.toml, then set STAND_TOKEN in your shell profile.",
    text: `[mcp_servers.stand]\nurl = "${url}"\nbearer_token_env_var = "STAND_TOKEN"\n\n# in ~/.zshrc or ~/.bashrc\nexport STAND_TOKEN="${token}"`,
  };
}

/** Connect an agent: make a token for Claude Code, Cursor or Codex, and revoke old ones. */
export function ConnectAgentPage() {
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("Claude Code on my laptop");
  const [scope, setScope] = useState<AgentToken["scope"]>("write");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ token: string; info: AgentToken } | null>(null);
  const [client, setClient] = useState<Client>("claude");
  const [copied, setCopied] = useState<string | null>(null);
  const url = `${location.origin}/mcp`;

  useEffect(() => {
    api.spaces().then(setSpaces, () => setSpaces([]));
    api.tokens().then(setTokens, (e: Error) => setError(e.message));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createToken(label.trim(), scope);
      setMade(r);
      setTokens((t) => [r.info, ...(t ?? [])]);
      setClient(/cursor/i.test(label) ? "cursor" : /codex/i.test(label) ? "codex" : "claude");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: AgentToken) => {
    if (!confirm(`Revoke "${t.label}"? Agents using it lose access right away.`)) return;
    try {
      await api.revokeToken(t.id);
      setTokens((all) => all?.filter((x) => x.id !== t.id) ?? null);
      if (made?.info.id === t.id) setMade(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
  };

  const snippet = made ? setup(client, url, made.token) : null;

  return (
    <SpacesShell spaces={spaces}>
      <main className="sp-main narrow agents-page">
        <section className="sp-find">
          <h1>Connect an agent</h1>
          <p className="muted">
            Let Claude Code, Cursor or Codex read your to-dos, decisions and topics from Stand, and report back when the work is done. An
            agent sees only the spaces you’re in, and acts as you.
          </p>
        </section>

        {error && <p className="error">{error}</p>}

        {made && snippet ? (
          <section className="ag-card ag-made" aria-live="polite">
            <div className="ag-made-head">
              <strong>“{made.info.label}” is ready</strong>
              <span className="muted small">Copy it now. Stand only shows it once.</span>
            </div>
            <div className="ag-tabs" role="tablist" aria-label="Your agent">
              {CLIENTS.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={client === c.id}
                  className={client === c.id ? "ag-tab on" : "ag-tab"}
                  onClick={() => setClient(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <p className="muted small ag-where">{snippet.where}</p>
            <div className="ag-code">
              <pre>{snippet.text}</pre>
              <button className="ag-copy" onClick={() => void copy("snippet", snippet.text)}>
                {copied === "snippet" ? "Copied" : "Copy"}
              </button>
            </div>
            <details className="ag-raw">
              <summary>Just the token</summary>
              <div className="ag-code">
                <pre>{made.token}</pre>
                <button className="ag-copy" onClick={() => void copy("token", made.token)}>
                  {copied === "token" ? "Copied" : "Copy"}
                </button>
              </div>
            </details>
            <div className="ag-next">
              <strong>Then try it</strong>
              <span>
                Ask your agent “what’s mine from standup?”, or click <em>Copy for agent</em> on any to-do, decision or topic in Stand and
                paste it in.
              </span>
            </div>
            <div className="ag-made-foot">
              <button onClick={() => setMade(null)}>Done</button>
            </div>
          </section>
        ) : (
          <form className="ag-card ag-new" onSubmit={create}>
            <strong>New agent token</strong>
            <label>
              Name it after where it runs
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Cursor on my work laptop" />
            </label>
            <fieldset className="ag-scope">
              <legend>What it can do</legend>
              <label className={scope === "write" ? "on" : undefined}>
                <input type="radio" name="scope" checked={scope === "write"} onChange={() => setScope("write")} />
                <span>
                  <strong>Read and report back</strong>
                  <span className="muted small">Reads your spaces, posts progress updates, checks off to-dos it finishes.</span>
                </span>
              </label>
              <label className={scope === "read" ? "on" : undefined}>
                <input type="radio" name="scope" checked={scope === "read"} onChange={() => setScope("read")} />
                <span>
                  <strong>Read only</strong>
                  <span className="muted small">Reads your spaces and changes nothing.</span>
                </span>
              </label>
            </fieldset>
            <div>
              <button className="primary" disabled={busy || !label.trim()}>
                Create token
              </button>
            </div>
          </form>
        )}

        <section className="sp-section">
          <h2>Your agent tokens</h2>
          {tokens?.length === 0 && <p className="muted">None yet.</p>}
          {tokens && tokens.length > 0 && (
            <div className="sp-rows">
              {tokens.map((t) => (
                <div key={t.id} className="sp-row ag-row">
                  <div className="sp-row-main">
                    <strong>{t.label}</strong>
                    <span className="muted small">
                      {t.scope === "write" ? "Read and report back" : "Read only"} · {t.hint}… · made {fmtDate(t.createdAt)} ·{" "}
                      {t.lastUsedAt ? `last used ${fmtDate(t.lastUsedAt)}` : "not used yet"}
                    </span>
                  </div>
                  <button className="ag-revoke" onClick={() => void revoke(t)}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </SpacesShell>
  );
}
