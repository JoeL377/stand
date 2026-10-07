import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.ts";

const RECENT = "standup.recentRooms";
type Recent = { id: string; name: string };

export function recentRooms(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {
    return [];
  }
}
export function rememberRoom(r: Recent) {
  try {
    const list = [r, ...recentRooms().filter((x) => x.id !== r.id)].slice(0, 8);
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function Home() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const recent = recentRooms();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const room = await api.createRoom(name.trim() || "Team standup");
      rememberRoom(room);
      nav(`/r/${room.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="home-card">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▍▌▋
          </span>
          Standup
        </div>
        <h1>Meetings that remember what each ticket was about.</h1>
        <p className="muted">
          Talk in a voice room and share your screen. An agent listens, works out which ticket or section is on screen,
          and pins every remark, decision and action item to it.
        </p>
        <form onSubmit={create} className="row">
          <input
            autoFocus
            placeholder="Room name, e.g. Platform standup"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <button className="primary" disabled={busy}>
            Create room
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        {recent.length > 0 && (
          <div className="recent">
            <h3>Your rooms</h3>
            {recent.map((r) => (
              <Link key={r.id} to={`/r/${r.id}`} className="recent-row">
                {r.name}
                <span className="muted">Join →</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
