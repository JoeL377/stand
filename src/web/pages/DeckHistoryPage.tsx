import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DeckHistory } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { NoteList } from "../room/SidePanel.tsx";
import { Slide } from "../slides.tsx";
import { FollowUpList, saveFollowUp } from "../FollowUps.tsx";
import { colorFor, fmtDate, fmtTime } from "../util.ts";

/** Every slide of a deck next to what was said and decided about it. */
export function DeckHistoryPage() {
  const { deckId = "" } = useParams();
  const [data, setData] = useState<DeckHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDiscussed, setOnlyDiscussed] = useState(false);

  useEffect(() => {
    api.deckHistory(deckId).then(setData).catch((e) => setError(e.message));
  }, [deckId]);

  if (error) return <div className="loading error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const { deck, room, slides } = data;
  const discussed = slides.filter((s) => s.segments.length || s.notes.length);
  const shown = onlyDiscussed ? discussed : slides;
  const actions = slides
    .flatMap((s) => s.notes.filter((n) => n.kind === "action").map((n) => ({ ...n, slide: s.item.slideNo })))
    .sort((a, b) => Number(Boolean(a.doneAt)) - Number(Boolean(b.doneAt)));
  const openCount = actions.filter((n) => !n.doneAt).length;
  const decisions = slides.flatMap((s) => s.notes.filter((n) => n.kind === "decision").map((n) => ({ ...n, slide: s.item.slideNo })));

  return (
    <div className="doc">
      {room && (
        <nav className="crumbs">
          <Link to={`/r/${room.id}`}>← {room.name}</Link>
        </nav>
      )}
      <header className="doc-head">
        <h1>{deck.title}</h1>
        <p className="muted">
          {deck.pageCount} slides · {discussed.length} discussed{" "}
          {deck.kind === "native" ? (
            <Link to={`/decks/${deck.id}/edit`}>Edit slides</Link>
          ) : (
            <a href={`/api/decks/${deck.id}/file`} target="_blank" rel="noreferrer">
              Open PDF ↗
            </a>
          )}
        </p>
        <label className="small check">
          <input type="checkbox" checked={onlyDiscussed} onChange={(e) => setOnlyDiscussed(e.target.checked)} /> Only slides that were
          discussed
        </label>
      </header>

      {(decisions.length > 0 || actions.length > 0) && (
        <section className="doc-section two-col">
          <div>
            <h2>Decisions</h2>
            {decisions.length === 0 && <p className="muted">None yet.</p>}
            <ul className="note-list">
              {decisions.map((n) => (
                <li key={n.id} className="note decision">
                  <span className="note-icon">✓</span>
                  <span className="note-text">
                    {n.text} <span className="muted small">Slide {n.slide}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2>
              Action items {openCount > 0 && <span className="count">{openCount} open</span>}
            </h2>
            {actions.length === 0 && <p className="muted">None yet.</p>}
            <FollowUpList
              notes={actions}
              onToggle={saveFollowUp(deck.roomId)}
              source={(n) => ({ label: `Slide ${(n as (typeof actions)[number]).slide}`, href: n.itemId ? `/items/${n.itemId}` : null })}
            />
          </div>
        </section>
      )}

      {shown.map(({ item, segments, notes }) => (
        <section key={item.id} className="doc-section deck-slide">
          <Link to={`/items/${item.id}`} className="slide-thumb-link" title="History of this slide">
            <Slide item={item} deck={deck} width={280} />
          </Link>
          <div>
            <h2>
              <span className="slide-no">{item.slideNo}</span> {item.title}
            </h2>
            {segments.length === 0 && notes.length === 0 && <p className="muted small">Not discussed yet.</p>}
            <NoteList notes={notes} />
            {segments.length > 0 && (
              <div className="transcript static">
                {segments.map((s) => (
                  <div key={s.id} className={s.kind === "chat" ? "seg chat" : "seg"}>
                    <div className="seg-head">
                      <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
                        {s.speakerName}
                      </span>
                      {s.kind === "chat" && <span className="seg-kind">chat</span>}
                      <span className="seg-time">
                        {fmtDate(s.ts)} {fmtTime(s.ts)}
                      </span>
                    </div>
                    <div className="seg-text">{s.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
