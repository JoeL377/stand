import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Discussion, Item, Note, RoomState, Segment } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtTime, keyOf } from "../util.ts";
import { FollowUpList } from "../FollowUps.tsx";
import { LiveItemNotes, liveNotesCount } from "../Discussions.tsx";

const SPLIT_KEY = "stand.sideSplit";
const DEFAULT_SPLIT = 50;
const clampSplit = (v: number) => Math.min(75, Math.max(15, v));

export function SidePanel(props: {
  state: RoomState;
  segments: Segment[];
  notes: Note[];
  discussions: Discussion[];
  notesBusy: string[];
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => void;
  participantId: string;
}) {
  const [notesOpen, setNotesOpen] = useState(true);
  const [earlierOpen, setEarlierOpen] = useState(true);
  const { state, segments, notes, interims, send } = props;
  // Notes on top, transcript below; the share of height the notes get is
  // remembered per browser.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [split, setSplitRaw] = useState(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return v ? clampSplit(v) : DEFAULT_SPLIT;
    } catch {
      return DEFAULT_SPLIT;
    }
  });
  const setSplit = (next: number | ((v: number) => number)) =>
    setSplitRaw((v) => {
      const out = typeof next === "function" ? next(v) : next;
      try {
        localStorage.setItem(SPLIT_KEY, String(out));
      } catch {
        /* private window */
      }
      return out;
    });
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSplit(clampSplit(((ev.clientY - box.top) / box.height) * 100));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const focus = state.items.find((i) => i.id === state.focusItemId) ?? null;
  const shown = segments.filter((s) => s.itemId === state.focusItemId);
  const focusNotes = notes.filter((n) => n.itemId === state.focusItemId);
  const focusDiscussions = props.discussions.filter((d) => d.itemId === state.focusItemId);
  const notesUpdating = props.notesBusy.includes(state.focusItemId ?? "");
  // Action items about this item from earlier meetings, still open (or just checked off).
  const earlier = (state.followUps ?? []).filter((f) => f.itemId === state.focusItemId);
  const earlierOpenCount = earlier.filter((f) => !f.doneAt).length;
  const hasNotes = earlier.length > 0 || focusNotes.length > 0 || notesUpdating;

  return (
    <aside className="panel side">
      <div className="panel-head">
        <div className="side-title">
          <h2>Discussion</h2>
          <span className="side-item" title={focus?.title}>
            {keyOf(focus) && <span className="key">{keyOf(focus)}</span>}
            {focus ? focus.title : "General / off-agenda"}
          </span>
        </div>
        <a className="recap-link" href={`/meetings/${state.meetingId}`} target="_blank" rel="noreferrer" title="Everything said and noted in this meeting, across items">
          Meeting recap ↗
        </a>
      </div>

      <div className="side-body" ref={bodyRef}>
      <div className="side-notes" style={hasNotes && (notesOpen || earlierOpen) ? { height: `${split}%` } : undefined}>
      {!hasNotes && (
        <p className="side-notes-empty">Agent notes for this item show up here once people start talking.</p>
      )}
      {earlier.length > 0 && (
        <section className={earlierOpen ? "focus-notes earlier open" : "focus-notes earlier"}>
          <button className="focus-notes-head" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((o) => !o)}>
            <span>From earlier meetings</span>
            <span className="muted">{earlierOpenCount} open</span>
            <span className="chev" aria-hidden>
              {earlierOpen ? "▾" : "▸"}
            </span>
          </button>
          {earlierOpen && (
            <div className="focus-notes-body">
              <FollowUpList
                compact
                showDate
                notes={earlier}
                onToggle={(n, done) => send({ type: "followup.done", noteId: n.id, done })}
              />
            </div>
          )}
        </section>
      )}
      {(focusNotes.length > 0 || notesUpdating) && (
        <section className={notesOpen ? "focus-notes open" : "focus-notes"}>
          <button className="focus-notes-head" aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)}>
            <span>Agent notes</span>
            <span className="muted">
              {liveNotesCount(focusNotes, focusDiscussions)}
            </span>
            {notesUpdating && <span className="notes-updating">Updating…</span>}
            <span className="chev" aria-hidden>
              {notesOpen ? "▾" : "▸"}
            </span>
          </button>
          {notesOpen && (
            <div className="focus-notes-body">
              {!focusNotes.length && <p className="tk-empty">Writing the first notes…</p>}
              {focusNotes.length > 0 && <LiveItemNotes
                notes={focusNotes}
                discussions={focusDiscussions}
                segments={segments}
                onToggle={(n, done) => send({ type: "followup.done", noteId: n.id, done })}
              />}
            </div>
          )}
        </section>
      )}
      </div>
      <div
        className="side-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize notes and transcript"
        aria-valuenow={Math.round(split)}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setSplit((v) => clampSplit(v - 5));
          if (e.key === "ArrowDown") setSplit((v) => clampSplit(v + 5));
        }}
      />
      <div className="side-transcript">
        <div className="side-pane-label">Live transcript</div>
        <Transcript segments={shown} items={state.items} interims={interims} send={send} />
        <ChatBox send={send} />
      </div>
      </div>
    </aside>
  );
}

function Transcript(props: {
  segments: Segment[];
  items: Item[];
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => void;
}) {
  const { segments, items, interims, send } = props;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const interimList = Object.values(interims);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [segments.length, interimList.length, interimList.map((i) => i.text).join("")]);

  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {segments.length === 0 && interimList.length === 0 && (
        <p className="muted empty">Nothing said about this yet. Speech and chat show up here, pinned to the item in focus.</p>
      )}
      {segments.map((s) => (
        <SegmentRow key={s.id} segment={s} items={items} send={send} />
      ))}
      {interimList.map((i) => (
        <div key={i.speakerId} className="seg interim">
          <span className="seg-who" style={{ color: colorFor(i.speakerId) }}>
            {i.speakerName}
          </span>
          <span className="seg-text">{i.text}…</span>
        </div>
      ))}
    </div>
  );
}

function SegmentRow({ segment: s, items, send }: { segment: Segment; items: Item[]; send: (m: ClientMessage) => void }) {
  const [moving, setMoving] = useState(false);
  return (
    <div className={s.kind === "chat" ? "seg chat" : "seg"}>
      <div className="seg-head">
        <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
          {s.speakerName}
        </span>
        {s.kind === "chat" && <span className="seg-kind">chat</span>}
        <span className="seg-time">{fmtTime(s.ts)}</span>
        <button className="seg-move" onClick={() => setMoving((m) => !m)} title="This was about a different item">
          Move
        </button>
      </div>
      <div className="seg-text">{s.text}</div>
      {moving && (
        <select
          className="seg-select"
          autoFocus
          value={s.itemId ?? ""}
          onChange={(e) => {
            send({ type: "segment.move", segmentId: s.id, itemId: e.target.value || null });
            setMoving(false);
          }}
          onBlur={() => setMoving(false)}
        >
          {items.map((it) => (
            <option key={it.id} value={it.id}>
              {keyOf(it) ? `${keyOf(it)} · ` : ""}
              {it.title}
            </option>
          ))}
          <option value="">General / off-agenda</option>
        </select>
      )}
    </div>
  );
}

function ChatBox({ send }: { send: (m: ClientMessage) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="chatbox"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        send({ type: "chat", text });
        setText("");
      }}
    >
      <input placeholder="Message the room" title="Goes into the discussion for the item in focus" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="primary" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}

export function NoteList({ notes }: { notes: Note[] }) {
  const by = (k: Note["kind"]) => notes.filter((n) => n.kind === k);
  return (
    <>
      {by("summary").map((n) => (
        <p key={n.id} className="note-summary">
          {n.text}
        </p>
      ))}
      {by("decision").length > 0 && (
        <ul className="note-list">
          {by("decision").map((n) => (
            <li key={n.id} className="note decision">
              <span className="note-icon">✓</span>
              <span className="note-text">{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      {by("action").length > 0 && (
        <ul className="note-list">
          {by("action").map((n) => (
            <li key={n.id} className={n.doneAt ? "note action done" : "note action"} title={n.doneAt ? `Done${n.doneBy ? ` by ${n.doneBy}` : ""}` : undefined}>
              <span className="note-icon">{n.doneAt ? "☑" : "☐"}</span>
              <span className="note-text">
                {n.text} {n.owner && <span className="owner">{n.owner}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {by("question").length > 0 && (
        <ul className="note-list">
          {by("question").map((n) => (
            <li key={n.id} className="note question">
              <span className="note-icon">?</span>
              <span className="note-text">{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
