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
  const [tab, setTab] = useState<"talk" | "notes">("talk");
  const [scope, setScope] = useState<"item" | "all">("item");
  const { state, segments, notes, interims, send } = props;

  const shown = scope === "item" ? segments.filter((s) => s.itemId === state.focusItemId) : segments;
  const focusNotes = notes.filter((n) => n.itemId === state.focusItemId).length;

  return (
    <aside className="panel side">
      <div className="tabs">
        <button className={tab === "talk" ? "tab on" : "tab"} onClick={() => setTab("talk")}>
          Discussion
        </button>
        <button className={tab === "notes" ? "tab on" : "tab"} onClick={() => setTab("notes")}>
          Agent notes{focusNotes ? ` · ${focusNotes}` : ""}
        </button>
      </div>

      {tab === "talk" ? (
        <>
          <div className="scope">
            <button className={scope === "item" ? "chip on" : "chip"} onClick={() => setScope("item")}>
              This item
            </button>
            <button className={scope === "all" ? "chip on" : "chip"} onClick={() => setScope("all")}>
              Whole meeting
            </button>
          </div>
          <Transcript segments={shown} items={state.items} interims={interims} showDividers={scope === "all"} send={send} />
          <ChatBox send={send} />
        </>
      ) : (
        <NotesView notes={notes} items={state.items} focusItemId={state.focusItemId} llm={state.capabilities.llm} />
      )}
    </aside>
  );
}

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
      <input placeholder="Message the room (pinned to this item)" value={text} onChange={(e) => setText(e.target.value)} />
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
  llm,
}: {
  notes: Note[];
  items: Item[];
  focusItemId: string | null;
  llm: boolean;
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
      {!llm && <p className="muted small">Heuristic notes. Add an Anthropic key on the server for real summaries.</p>}
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
