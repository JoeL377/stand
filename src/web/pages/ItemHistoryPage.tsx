import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.ts";
import { NoteList } from "../room/SidePanel.tsx";
import { SlideView } from "../slides.tsx";
import { colorFor, fmtDate, fmtTime, keyOf } from "../util.ts";

type Data = Awaited<ReturnType<typeof api.itemHistory>>;

export function ItemHistoryPage() {
  const { itemId = "" } = useParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.itemHistory(itemId).then(setData).catch((e) => setError(e.message));
  }, [itemId]);

  if (error) return <div className="loading error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const { item, meetings, room } = data;
  const allActions = meetings.flatMap((m) => m.notes.filter((n) => n.kind === "action").map((n) => ({ ...n, when: m.startedAt })));
  const allDecisions = meetings.flatMap((m) => m.notes.filter((n) => n.kind === "decision").map((n) => ({ ...n, when: m.startedAt })));

  return (
    <div className="doc">
      <nav className="crumbs">
        <Link to={`/r/${room.id}`}>← {room.name}</Link>
      </nav>
      <header className="doc-head">
        {keyOf(item) && <span className="key big">{keyOf(item)}</span>}
        <h1>{item.title}</h1>
        {item.deckId && item.slideNo && (
          <>
            <SlideView deckId={item.deckId} page={item.slideNo} width={480} />
            <Link to={`/decks/${item.deckId}`}>Whole deck →</Link>
          </>
        )}
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer">
            Open in {item.source === "linear" ? "Linear" : "new tab"} ↗
          </a>
        )}
        <p className="muted">
          Discussed in {meetings.length} meeting{meetings.length === 1 ? "" : "s"}
          {meetings.length > 0 && ` · last on ${fmtDate(meetings[0].startedAt)}`}
        </p>
      </header>

      {meetings.length === 0 && <p className="muted">Nothing has been said about this item yet.</p>}

      {(allDecisions.length > 0 || allActions.length > 0) && (
        <section className="doc-section two-col">
          <div>
            <h2>Decisions</h2>
            {allDecisions.length === 0 && <p className="muted">None yet.</p>}
            <ul className="note-list">
              {allDecisions.map((n) => (
                <li key={n.id} className="note decision">
                  <span className="note-icon">✓</span>
                  <span className="note-text">
                    {n.text} <span className="muted small">{fmtDate(n.when)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2>Action items</h2>
            {allActions.length === 0 && <p className="muted">None yet.</p>}
            <ul className="note-list">
              {allActions.map((n) => (
                <li key={n.id} className="note action">
                  <span className="note-icon">☐</span>
                  <span className="note-text">
                    {n.text} {n.owner && <span className="owner">{n.owner}</span>}{" "}
                    <span className="muted small">{fmtDate(n.when)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {meetings.map((m) => (
        <section key={m.meetingId} className="doc-section meeting-block">
          <div className="meeting-block-head">
            <h2>
              <Link to={`/meetings/${m.meetingId}`}>
                {fmtDate(m.startedAt)} · {fmtTime(m.startedAt)}
              </Link>
            </h2>
            <span className="muted small">{m.participants.join(", ")}</span>
          </div>
          <NoteList notes={m.notes} />
          <button className="link" onClick={() => setOpen((o) => ({ ...o, [m.meetingId]: !o[m.meetingId] }))}>
            {open[m.meetingId] ? "Hide transcript" : `Show transcript (${m.segments.length})`}
          </button>
          {open[m.meetingId] && (
            <div className="transcript static">
              {m.segments.map((s) => (
                <div key={s.id} className={s.kind === "chat" ? "seg chat" : "seg"}>
                  <div className="seg-head">
                    <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
                      {s.speakerName}
                    </span>
                    {s.kind === "chat" && <span className="seg-kind">chat</span>}
                    <span className="seg-time">{fmtTime(s.ts)}</span>
                  </div>
                  <div className="seg-text">{s.text}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
