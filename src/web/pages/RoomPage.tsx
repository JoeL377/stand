import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Capabilities } from "../../shared/protocol.ts";
import { api, type RoomInfo } from "../api.ts";
import { useAuth, UserMenu } from "../auth.tsx";
import { fmtDate, fmtTime } from "../util.ts";
import { Meeting } from "../room/Meeting.tsx";
import { DeckIcon, LinkIcon, Logo, PdfIcon, TaskIcon, TicketIcon } from "../icons.tsx";
import { Avatar } from "../room/Stage.tsx";
import { FollowUpList, itemHref, saveFollowUp, sourceLabel } from "../FollowUps.tsx";

export function RoomPage() {
  const { roomId = "" } = useParams();
  const { user, caps } = useAuth();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [copied, setCopied] = useState(false);
  const nav = useNavigate();

  const load = useCallback(() => {
    api
      .room(roomId)
      .then(setRoom)
      .catch((e) => setError(e.message));
  }, [roomId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="home">
        <div className="home-card">
          <p className="error">{error}</p>
          <Link to="/">Back</Link>
        </div>
      </div>
    );
  }
  if (!room) return <div className="loading">Loading…</div>;

  if (joined) {
    return (
      <Meeting
        roomId={room.id}
        user={user}
        caps={caps}
        onEnded={(meetingId) => nav(`/meetings/${meetingId}`)}
        onLeave={() => {
          setJoined(false);
          load();
        }}
      />
    );
  }


  const past = room.meetings.filter((m) => m.endedAt && m.segmentCount > 0).slice(0, 5);
  const live = !!room.liveMeetingId;

  // The agenda as the meeting shows it: tasks and tickets, with a deck's
  // slides folded into one line.
  type Entry = { key: string; kind: "task" | "linear" | "deck" | "pdf"; title: string; meta: string | null; href: string };
  const entries: Entry[] = [];
  for (const it of room.items) {
    if (it.deckId) {
      const last = entries[entries.length - 1];
      if (last?.key === it.deckId) {
        last.meta = `${Number(last.meta?.split(" ")[0] ?? 0) + 1} slides`;
        continue;
      }
      const deck = room.decks.find((d) => d.id === it.deckId);
      entries.push({ key: it.deckId, kind: deck?.kind === "native" ? "deck" : "pdf", title: deck?.title ?? "Slides", meta: "1 slides", href: `/decks/${it.deckId}` });
    } else {
      entries.push({ key: it.id, kind: it.source === "linear" ? "linear" : "task", title: it.title, meta: it.externalId, href: `/items/${it.id}` });
    }
  }
  for (const e of entries) if (e.meta === "1 slides") e.meta = "1 slide";
  // Open follow-ups per agenda entry (a deck counts its slides').
  const openOn = new Map<string, number>();
  for (const f of room.followUps) {
    const it = room.items.find((i) => i.id === f.itemId);
    const key = it?.deckId ?? f.itemId;
    if (key) openOn.set(key, (openOn.get(key) ?? 0) + 1);
  }
  const kindIcon = { task: <TaskIcon />, linear: <TicketIcon />, deck: <DeckIcon />, pdf: <PdfIcon /> };

  const copy = () => {
    void navigator.clipboard?.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="lobby">
      <header className="lobby-bar">
        <Link to="/" className="lobby-brand">
          <Logo />
          Stand
        </Link>
        <UserMenu />
      </header>

      <main className="lobby-main">
        <section className="lobby-card">
          <span className={live ? "lobby-status live" : "lobby-status"}>
            <span className="dot" />
            {live ? "Meeting in progress" : "No one here yet"}
          </span>
          <h1>{room.name}</h1>
          {live && room.people.length > 0 && (
            <div className="lobby-people">
              <span className="stack">
                {room.people.slice(0, 4).map((p, i) => (
                  <Avatar key={i} id={p.name} name={p.name} picture={p.picture} size={26} />
                ))}
              </span>
              <span className="muted">
                {room.people.length === 1 ? `${room.people[0].name} is here` : `${room.people[0].name} and ${room.people.length - 1} more are here`}
              </span>
            </div>
          )}
          <div className="lobby-actions">
            <button className="primary lobby-join" autoFocus onClick={() => setJoined(true)}>
              {live ? "Join meeting" : "Start meeting"}
            </button>
            <button className="lobby-copy" onClick={copy} title="Copy a link others can join with">
              <LinkIcon />
              {copied ? "Copied" : "Invite"}
            </button>
          </div>
          <p className="lobby-as muted">
            You'll join as <strong>{user.name}</strong>
          </p>
          <ModeNote caps={caps} />
        </section>

        {entries.length > 0 && (
          <section className="lobby-section">
            <h2>
              Agenda <span className="count">{entries.length}</span>
            </h2>
            <ul className="lobby-list">
              {entries.map((e) => (
                <li key={e.key}>
                  <Link to={e.href}>
                    <span className="kind">{kindIcon[e.kind]}</span>
                    <span className="title">{e.title}</span>
                    {e.meta && <span className="meta">{e.meta}</span>}
                    {openOn.get(e.key) ? <span className="open-count" title="Open action items from past meetings">{openOn.get(e.key)} open</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {room.followUps.length > 0 && (
          <section className="lobby-section">
            <h2>
              Open follow-ups <span className="count">{room.followUps.length}</span>
              <span className="h2-links">
                <a href={`/api/rooms/${room.id}/followups.md`} target="_blank" rel="noreferrer" title="The open follow-ups as Markdown, for people and agents">
                  Markdown
                </a>
                <a href={`/api/rooms/${room.id}/followups.json`} target="_blank" rel="noreferrer" title="The open follow-ups as JSON, for agents and tools">
                  JSON
                </a>
              </span>
            </h2>
            <div className="lobby-followups">
              <FollowUpList
                notes={room.followUps}
                onToggle={saveFollowUp(room.id)}
                source={(n) => ({ label: sourceLabel(n.itemId, room.items, room.decks), href: itemHref(n.itemId, room.items) })}
                showDate
              />
            </div>
          </section>
        )}

        {past.length > 0 && (
          <section className="lobby-section">
            <h2>Past meetings</h2>
            <ul className="lobby-list">
              {past.map((m) => (
                <li key={m.id}>
                  <Link to={`/meetings/${m.id}`}>
                    <span className="title">
                      {fmtDate(m.startedAt)} · {fmtTime(m.startedAt)}
                    </span>
                    {m.summary && <span className="meta summary">{m.summary}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

export function ModeNote({ caps }: { caps: Capabilities }) {
  const missing: string[] = [];
  if (!caps.livekit) missing.push("shared audio");
  if (caps.transcription === "browser") missing.push("server transcription");
  if (!caps.llm) missing.push("AI notes");
  if (!missing.length) return null;
  return (
    <p
      className="mode-chip"
      title={`Not connected yet: ${missing.join(", ")}. ${!caps.livekit ? "People won't hear each other; each browser transcribes its own mic. " : ""}Use Play demo in the room to see a scripted standup.`}
    >
      Demo mode · {missing.length === 1 ? `${missing[0]} off` : `${missing.length} services not connected`}
    </p>
  );
}
