import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { MeetingRecap } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { NoteList } from "../room/SidePanel.tsx";
import { colorFor, fmtDate, fmtDuration, fmtTime, keyOf } from "../util.ts";

export function RecapPage() {
  const { meetingId = "" } = useParams();
  const [data, setData] = useState<MeetingRecap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.meeting(meetingId).then(setData).catch((e) => setError(e.message));
  }, [meetingId]);

  if (error) return <div className="loading error">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const people = [...new Set(data.items.flatMap((g) => g.segments.map((s) => s.speakerName)))];

  return (
    <div className="doc">
      <nav className="crumbs">
        <Link to={`/r/${data.roomId}`}>← {data.roomName}</Link>
      </nav>
      <header className="doc-head">
        <h1>
          {data.roomName} · {fmtDate(data.startedAt)}
        </h1>
        <p className="muted">
          {fmtTime(data.startedAt)}
          {data.endedAt ? ` · ${fmtDuration(data.endedAt - data.startedAt)}` : " · in progress"}
          {people.length > 0 && ` · ${people.join(", ")}`}
        </p>
        {data.summary && <p className="lede">{data.summary}</p>}
      </header>
      {data.items.length === 0 && <p className="muted">Nothing was recorded in this meeting.</p>}
      {data.items.map((g) => {
        const key = g.item?.id ?? "general";
        return (
          <section key={key} className="doc-section meeting-block">
            <div className="meeting-block-head">
              <h2>
                {keyOf(g.item) && <span className="key">{keyOf(g.item)}</span>}
                {g.item ? <Link to={`/items/${g.item.id}`}>{g.item.title}</Link> : "General / off-agenda"}
              </h2>
              <span className="muted small">{[...new Set(g.segments.map((s) => s.speakerName))].join(", ")}</span>
            </div>
            <NoteList notes={g.notes} />
            <button className="link" onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
              {open[key] ? "Hide transcript" : `Show transcript (${g.segments.length})`}
            </button>
            {open[key] && (
              <div className="transcript static">
                {g.segments.map((s) => (
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
        );
      })}
    </div>
  );
}
