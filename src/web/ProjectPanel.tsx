import { useEffect, useState } from "react";
import type { ProjectsStatus, SpaceProject } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { fmtAgo } from "./util.ts";

/** The space's project: GitHub repos Stand reads (never writes to) so Ask Stand can answer about the code. */
export function ProjectPanel({ roomId }: { roomId: string }) {
  const [status, setStatus] = useState<ProjectsStatus | null>(null);
  const [pick, setPick] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api.projects(roomId).then(
      (s) => active && setStatus(s),
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [roomId]);

  async function change(label: string, action: () => Promise<ProjectsStatus>) {
    setBusy(label);
    setError("");
    try {
      setStatus(await action());
      setPick("");
      setConfirmed(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!status) return error ? <p className="error">{error}</p> : null;
  const linked = new Set(status.projects.map((p) => `${p.owner}/${p.repo}`.toLowerCase()));
  const choices = (status.linkable ?? []).filter((r) => !linked.has(`${r.owner}/${r.repo}`.toLowerCase()));

  return (
    <section className="project-panel">
      <h3>Project</h3>
      <p className="muted small">Link the space's GitHub repo so Ask Stand can answer about the code and what shipped. Stand reads it and never writes to it.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status.projects.map((p) => (
        <ProjectRow
          key={`${p.owner}/${p.repo}`}
          p={p}
          canManage={status.canManage}
          busy={busy}
          onPull={() => void change(`pull:${p.owner}/${p.repo}`, () => api.pullProject(roomId, p.owner, p.repo))}
          onUnlink={() => {
            if (window.confirm(`Unlink ${p.owner}/${p.repo}? Stand deletes its copy, and Ask Stand stops reading it.`))
              void change(`unlink:${p.owner}/${p.repo}`, () => api.unlinkProject(roomId, p.owner, p.repo));
          }}
        />
      ))}
      {!status.projects.length && <p>No repo linked</p>}
      {!status.available && <p className="muted small">The Stand GitHub App isn't set up on this server.</p>}
      {status.available && status.canManage && (
        <>
          {status.linkableError && <p className="muted small">{status.linkableError}</p>}
          {status.linkable && !status.linkable.length && (
            <p className="muted small">
              Connect GitHub on the <a href="/agents">Connect an agent</a> page and include the repo, then come back here.
            </p>
          )}
          {choices.length > 0 && (
            <>
              <label>
                Link a repo
                <select
                  value={pick}
                  onChange={(e) => {
                    setPick(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">Choose a repo</option>
                  {choices.map((r) => (
                    <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>
                      {r.owner}/{r.repo}
                      {r.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="project-consent">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                Everyone with this space's link can ask Stand about this repo's code, and Stand sends what it reads to Anthropic's models. Files like .env and keys are never shown, but other secrets committed to the repo could be.
              </label>
              <div className="sp-manage-foot">
                <button type="button" disabled={!!busy || !confirmed || !pick} onClick={() => void change("link", () => api.linkProject(roomId, pick))}>
                  {busy === "link" ? "Linking…" : "Link repo"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function ProjectRow({ p, canManage, busy, onPull, onUnlink }: { p: SpaceProject; canManage: boolean; busy: string | null; onPull: () => void; onUnlink: () => void }) {
  const name = `${p.owner}/${p.repo}`;
  return (
    <div className="project-row">
      <a href={p.url} target="_blank" rel="noreferrer">
        {name}
      </a>
      <span className="muted small">
        {p.branch}
        {p.headSha ? ` at ${p.headSha.slice(0, 7)}` : ""}
        {p.pulledAt ? ` · pulled ${fmtAgo(p.pulledAt)}` : " · not pulled yet"}
      </span>
      {p.error && <p className="error small">{p.error}</p>}
      {canManage && (
        <div className="sp-manage-foot">
          <button type="button" disabled={!!busy} onClick={onPull}>
            {busy === `pull:${name}` ? "Pulling…" : "Pull now"}
          </button>
          <button type="button" disabled={!!busy} onClick={onUnlink}>
            Unlink
          </button>
        </div>
      )}
    </div>
  );
}
