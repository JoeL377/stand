import { useEffect, useState } from "react";
import type { SpaceMember, SpaceMembers } from "../shared/protocol.ts";
import { api } from "./api.ts";

/** The people in a space and who manages it. The creator and admins make people admins and take that back. */
export function MembersPanel({ roomId }: { roomId: string }) {
  const [status, setStatus] = useState<SpaceMembers | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api.members(roomId).then(
      (s) => active && setStatus(s),
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [roomId]);

  async function setAdmin(m: SpaceMember, admin: boolean) {
    if (m.you && !admin && !window.confirm("Stop being an admin of this space? You won't be able to manage it, and another admin has to add you back.")) return;
    setBusy(m.id);
    setError("");
    try {
      setStatus(await api.setAdmin(roomId, m.id, admin));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!status) return error ? <p className="error">{error}</p> : null;

  return (
    <section className="members-panel">
      <h3>People</h3>
      <p className="muted small">Admins can rename the space, link its repos, change where its meetings are shared, and make other people admins.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status.members.map((m) => (
        <div className="members-row" key={m.id}>
          <span>
            {m.name}
            {m.you ? " (you)" : ""}
          </span>
          <span className="muted small">{m.role === "creator" ? "Created the space" : m.role === "admin" ? "Admin" : ""}</span>
          {status.canManage && m.role !== "creator" && (
            <button type="button" disabled={!!busy} onClick={() => void setAdmin(m, m.role !== "admin")}>
              {m.role === "admin" ? "Remove admin" : "Make admin"}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
