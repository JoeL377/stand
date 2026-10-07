import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, Item, Note, RoomState, Segment } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtTime, keyOf } from "../util.ts";

export function SidePanel(props: {
  state: RoomState;
  segments: Segment[];
  notes: Note[];
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => void;
  participantId: string;
}) {
  const [view, setView] = useState<View>("item");
  const [menu, setMenu] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const { state, segments, notes, interims, send } = props;
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const shown = view === "item" ? segments.filter((s) => s.itemId === state.focusItemId) : segments;
  const focusNotes = notes.filter((n) => n.itemId === state.focusItemId);
  const views: { view: View; label: string; hint: string }[] = [
    { view: "item", label: "This item", hint: "Notes and discussion for what's in focus" },
    { view: "all", label: "Whole meeting", hint: "Everything said, across items" },
    { view: "notes", label: "All notes", hint: "The agent's notes for every item" },
  ];

  return (
    <aside className="panel side">
      <div className="panel-head">
        <h2>{view === "notes" ? "Agent notes" : "Discussion"}</h2>
        <div className="add-menu-wrap" ref={menuRef}>
          <button className="ghost small view-btn" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            {views.find((v) => v.view === view)!.label} ▾
          </button>
          {menu && (
            <div className="add-menu" role="menu">
              {views.map((v) => (
                <button
                  key={v.view}
                  role="menuitemradio"
                  aria-checked={v.view === view}
                  className={v.view === view ? "on" : ""}
                  onClick={() => {
                    setView(v.view);
                    setMenu(false);
                  }}
                >
                  <span>{v.label}</span>
                  <span className="muted">{v.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {view === "notes" ? (
        <NotesView notes={notes} items={state.items} focusItemId={state.focusItemId} />
      ) : (
        <>
          {view === "item" && focusNotes.length > 0 && (
            <section className={notesOpen ? "focus-notes open" : "focus-notes"}>
              <button className="focus-notes-head" aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)}>
                <span>Agent notes</span>
                <span className="muted">{focusNotes.length}</span>
                <span className="chev" aria-hidden>
                  {notesOpen ? "▾" : "▸"}
                </span>
              </button>
              {notesOpen && (
                <div className="focus-notes-body">
                  <NoteList notes={focusNotes} />
                </div>
              )}
            </section>
          )}
          <Transcript segments={shown} items={state.items} interims={interims} showDividers={view === "all"} send={send} />
          <ChatBox send={send} />
        </>
      )}
    </aside>
  );
}

type View = "item" | "all" | "notes";

function Transcript(props: {
  segments: Segment[];
  items: Item[];
  interims: Record<string, Interim>;
  showDividers: boolean;
  send: (m: ClientMessage) => void;
}) {
  const { segments, items, interims, showDividers, send } = props;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const interimList = Object.values(interims);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [segments.length, interimList.length, interimList.map((i) => i.text).join("")]);

  const itemName = (id: string | null) => {
    const it = items.find((i) => i.id === id);
    return it ? `${keyOf(it) ? keyOf(it) + " · " : ""}${it.title}` : "General / off-agenda";
  };

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
      {segments.map((s, i) => (
        <div key={s.id}>
          {showDividers && (i === 0 || segments[i - 1].itemId !== s.itemId) && <div className="divider">{itemName(s.itemId)}</div>}
          <SegmentRow segment={s} items={items} send={send} />
        </div>
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

export function NotesView({
  notes,
  items,
  focusItemId,
}: {
  notes: Note[];
  items: Item[];
  focusItemId: string | null;
}) {
  const groups = useMemo(() => {
    const ids = [...new Set(notes.map((n) => n.itemId))];
    ids.sort((a, b) => {
      if (a === focusItemId) return -1;
      if (b === focusItemId) return 1;
      return (items.find((i) => i.id === a)?.position ?? 1e9) - (items.find((i) => i.id === b)?.position ?? 1e9);
    });
    return ids.map((id) => ({ item: items.find((i) => i.id === id) ?? null, id, notes: notes.filter((n) => n.itemId === id) }));
  }, [notes, items, focusItemId]);

  return (
    <div className="notes">
      {groups.length === 0 && <p className="muted empty">The agent writes notes per item as people talk.</p>}
      {groups.map((g) => (
        <section key={g.id ?? "general"} className={g.id === focusItemId ? "note-group active" : "note-group"}>
          <h3>
            {keyOf(g.item) && <span className="key">{keyOf(g.item)}</span>}
            {g.item ? g.item.title : "General / off-agenda"}
          </h3>
          <NoteList notes={g.notes} />
        </section>
      ))}
    </div>
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
            <li key={n.id} className="note action">
              <span className="note-icon">☐</span>
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
