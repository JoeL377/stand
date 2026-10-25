import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { api } from "../api.ts";

/** A Stand reference link (/ref/action/<id>) opens the meeting recap it came from, or the space
 *  page for a to-do someone added by hand. */
export function RefPage() {
  const { kind = "", id = "" } = useParams();
  const [to, setTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.locateRef(kind, id).then(
      (r) => setTo(r.added ? `/s/${r.roomId}` : `/meetings/${r.meetingId}`),
      (e: Error) => setError(e.message),
    );
  }, [kind, id]);
  if (error) return <div className="loading error">{error}</div>;
  return to ? <Navigate to={to} replace /> : <div className="loading">Opening…</div>;
}
