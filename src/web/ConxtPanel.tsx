import { useEffect, useState } from "react";
import { api, type ConxtStatus } from "./api.ts";

export function ConxtPanel({ roomId, meetingId }: { roomId: string; meetingId?: string }) {
  const [status, setStatus] = useState<ConxtStatus | null>(null);
  const [destination, setDestination] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => api.conxtStatus(roomId).then(s => {
      if (active) { setStatus(s); setError(""); }
    }, e => { if (active) setError((e as Error).message); });
    void refresh(); const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [roomId]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); setStatus(await api.conxtStatus(roomId)); setConfirmed(false); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="conxt-panel">
    <h3>Conxt</h3>
    <p className="muted small">Share live transcripts and finalized meeting synthesis with your team’s project. Review and publication happen in Conxt.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {status && <>
      <p>{status.connection?.enabled ? `Connected to ${status.connection.label}` : "Not connected"}</p>
      {status.canManage && !meetingId && <>
        <label>Conxt destination<select value={destination} onChange={e => { setDestination(e.target.value); setConfirmed(false); }}>
          <option value="">Choose team and project</option>
          {status.destinations.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select></label>
        {!status.destinations.length && <p className="muted small">Your server operator needs to configure a Conxt connection before you can select it here.</p>}
        <label className="conxt-consent"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          Share live and finalized transcripts from meetings started after connecting with every member of the selected Conxt team, for cloud processing and review.
        </label>
        <p className="muted small">Past meetings and meetings already in progress are excluded. Disconnecting pauses pending deliveries; reconnecting applies to new meetings.</p>
        <div className="sp-manage-foot">
          <button type="button" disabled={busy || !confirmed || !destination} onClick={() => void change(() => api.connectConxt(roomId, destination))}>Connect Conxt</button>
          {Boolean(status.connection?.enabled) && <button type="button" disabled={busy} onClick={() => void change(() => api.disconnectConxt(roomId))}>Disconnect Conxt</button>}
          <button type="button" disabled={busy} onClick={() => void change(async () => {})}>Refresh delivery status</button>
        </div>
      </>}
      {(status.liveDeliveries ?? []).filter(d => !meetingId || d.meetingId === meetingId).map(d => <div className="conxt-delivery" key={`live:${d.meetingId}`}>
        <a href={`/meetings/${encodeURIComponent(d.meetingId)}`}>Meeting</a>
        <span>{!d.enabled && d.state !== "ended" ? "Live sharing paused" : d.state === "ended" ? "Live transcript complete" : d.state === "failed" ? "Live delivery needs attention" : d.sequence ? `Live transcript connected · update ${d.sequence}` : "Connecting live transcript"}</span>
        {d.error && <p className="muted small">{d.error}</p>}
        {status.canManage && Boolean(d.enabled) && d.state === "failed" && <button type="button" disabled={busy} onClick={() => void change(() => api.retryLiveConxt(roomId, d.meetingId))}>Retry live delivery</button>}
      </div>)}
      {meetingId && !status.liveDeliveries?.some(d => d.meetingId === meetingId) && !status.deliveries.some(d => d.meetingId === meetingId) && <p className="muted small">This meeting has not been submitted to Conxt.</p>}
      {status.deliveries.filter(d => !meetingId || d.meetingId === meetingId).map(d => <div className="conxt-delivery" key={d.id}>
        <a href={`/meetings/${encodeURIComponent(d.meetingId)}`}>Meeting</a>
        <span>{!d.enabled && !["ready", "skipped"].includes(d.state) ? "Paused" : d.state === "ready" ? "Processed in Conxt · publication requires review" :
          d.state === "delivered" ? "Received by Conxt · processing" : d.state === "sending" ? "Confirming delivery" : d.state}</span>
        {d.error && <p className="muted small">{d.error}</p>}
        {status.canManage && Boolean(d.enabled) && d.state === "failed" && d.remoteStatus !== "failed" && <button type="button" disabled={busy} onClick={() => void change(() => api.retryConxt(roomId, d.id))}>Retry delivery</button>}
      </div>)}
    </>}
  </section>;
}
