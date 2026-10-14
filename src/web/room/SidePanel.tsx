import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Item, Note, RoomState, Segment } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtTime, keyOf } from "../util.ts";
import { SnapsPill } from "../Snaps.tsx";
import { SendIcon } from "../icons.tsx";
import { Linkified } from "../Linkified.tsx";

export function SidePanel(props: {
  state: RoomState;
  segments: Segment[];
  notesBusy: string[];
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => boolean;
  participantId: string;
}) {
  const { state, segments, interims, send } = props;
  // Two tabs: the meeting's chat and the spoken transcript. The topics and their notes sit on the
  // middle screen, so the transcript opens first.
  const [tab, setTab] = useState<"chat" | "transcript">("transcript");
  const focus = state.items.find((i) => i.id === state.focusItemId) ?? null;
  const shown = segments.filter((s) => s.itemId === state.focusItemId && s.kind !== "chat");
  // Chat is one conversation for the whole meeting, whichever item it landed on.
  const chats = segments.filter((s) => s.kind === "chat");
  const notesUpdating = props.notesBusy.includes(state.focusItemId ?? "");
  // The agent's last try at this item failed: it says so here until a later try works.
  const notesFailed = (state.notesFailing ?? []).includes(state.focusItemId);
  // New remarks for this item while the Transcript tab isn't open.
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (tab === "transcript") setSeen(shown.length);
  }, [tab, shown.length]);
  useEffect(() => setSeen(shown.length), [state.focusItemId]);
  const unseen = Math.max(0, shown.length - seen);
  // Messages from others since the Chat tab was last open; your own don't count.
  const othersChats = chats.filter((s) => s.speakerId !== props.participantId).length;
  const [chatSeen, setChatSeen] = useState(othersChats);
  useEffect(() => {
    if (tab === "chat") setChatSeen(othersChats);
  }, [tab, othersChats]);
  const chatUnseen = Math.max(0, othersChats - chatSeen);
  const isHost = state.participants.some((p) => p.id === props.participantId && p.isHost);
  const focusSnaps = (state.snaps ?? []).filter((p) => p.itemId === state.focusItemId);

  return (
    <aside className="panel side">
      <div className="side-head">
        <h2 className="side-head-title" title={focus?.title}>
          {focus ? focus.title : "General / off-agenda"}
        </h2>
        <SnapsPill snaps={focusSnaps} me={props.participantId} isHost={isHost} className="side-head-snaps" />
        {keyOf(focus) && <span className="side-head-key">{keyOf(focus)}</span>}
      </div>

      <div className="side-toggle" role="tablist" aria-label="Discussion views">
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          Chat
          {tab !== "chat" && chatUnseen > 0 && (
            <span className="side-tab-badge" aria-label={`${chatUnseen} new`}>
              {chatUnseen}
            </span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === "transcript"}
          className={tab === "transcript" ? "on" : ""}
          onClick={() => setTab("transcript")}
        >
          Transcript
          {tab !== "transcript" && unseen > 0 && (
            <span className="side-tab-badge" aria-label={`${unseen} new`}>
              {unseen}
            </span>
          )}
        </button>
      </div>
      {/* The topics on the middle screen come from these notes, so a failure still says so here. */}
      {notesFailed && (
        <p className="notes-paused side-notes-paused" role="status">
          {state.notesTrouble === "credit"
            ? "Notes stopped: the Anthropic account Stand uses is out of credit. Everything said is kept."
            : state.notesTrouble === "busy"
              ? "Notes are behind: the model's rate limit was hit. They catch up by themselves."
              : "The agent couldn't update the notes. Everything said is kept."}
          {!notesUpdating && state.notesTrouble !== "busy" && (
            <button className="link" onClick={() => send({ type: "notes.retry", itemId: state.focusItemId })}>
              Try again
            </button>
          )}
        </p>
      )}
      {tab === "transcript" ? (
        <Transcript segments={shown} items={state.items} interims={interims} send={send} empty="Nothing said about this yet." />
      ) : (
        <>
          <Transcript segments={chats} items={state.items} interims={{}} send={send} empty="No messages yet." />
          {!state.ending && <ChatBox send={send} />}
        </>
      )}
      <div className="side-foot">
        <a
          href={`/meetings/${state.meetingId}`}
          target="_blank"
          rel="noreferrer"
          title="Everything said and noted in this meeting, across items"
        >
          Meeting recap ↗
        </a>
      </div>
    </aside>
  );
}

function Transcript(props: {
  segments: Segment[];
  items: Item[];
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => boolean;
  empty: string;
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
        <p className="muted empty">{props.empty}</p>
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

/** Typed messages for everyone in the meeting. They land in the transcript on the item in focus, and the notes read them like speech. */
function ChatBox({ send }: { send: (m: ClientMessage) => boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grows with what's typed, up to a few lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [text]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    // Kept in the box if it couldn't go out, so nothing typed is lost.
    if (send({ type: "chat", text: t })) setText("");
  };
  return (
    <form
      className="chat-box"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={2000}
        placeholder="Message everyone"
        aria-label="Message everyone"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {text.trim() && (
        <button type="submit" className="chat-send" aria-label="Send">
          <SendIcon />
        </button>
      )}
    </form>
  );
}

function SegmentRow({ segment: s, items, send }: { segment: Segment; items: Item[]; send: (m: ClientMessage) => boolean }) {
  const [moving, setMoving] = useState(false);
  return (
    <div className={s.kind === "chat" ? "seg chat" : "seg"}>
      <div className="seg-head">
        <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
          {s.speakerName}
        </span>
        <span className="seg-time">{fmtTime(s.ts)}</span>
        <button className="seg-move" onClick={() => setMoving((m) => !m)} title="This was about a different item">
          Move
        </button>
      </div>
      <div className="seg-text">
        <Linkified text={s.text} />
      </div>
      {moving && (
        <select
          className="seg-select"
          autoFocus
          value={s.itemId ?? ""}
          onChange={(e) => {
            send({
              type: "segment.move",
              segmentId: s.id,
              itemId: e.target.value || null,
            });
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
            <li
              key={n.id}
              className={n.doneAt ? "note action done" : "note action"}
              title={n.doneAt ? `Done${n.doneBy ? ` by ${n.doneBy}` : ""}` : undefined}
            >
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
