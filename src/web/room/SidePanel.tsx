import { usePersonColors } from "../PersonColors.tsx";
import { useEffect, useRef, useState } from "react";
import type { AgentCard, Board, ClientMessage, Item, ListNote, Note, RoomState, Segment } from "../../shared/protocol.ts";
import { buildTimeline, type TimelineEntry } from "../../shared/timeline.ts";
import { AgentRow, AskRow, MadeBy } from "../Timeline.tsx";
import { showCard } from "./AgentCard.tsx";
import { moverText } from "./TopicBoard.tsx";
import type { Interim } from "./useRoomSocket.ts";
import { fmtTime, keyOf } from "../util.ts";
import { SnapsPill } from "../Snaps.tsx";
import { ChatIcon, PanelIcon, SendIcon, TranscriptIcon } from "../icons.tsx";
import { Linkified } from "../Linkified.tsx";

/** How long a chat message keeps the folded panel open. */
const PEEK_MS = 12_000;

export function SidePanel(props: {
  state: RoomState;
  segments: Segment[];
  notesBusy: string[];
  notes: Note[];
  list: ListNote[] | null;
  /** What ✦ Stand was asked in this meeting, and what it answered. */
  cards?: AgentCard[] | null;
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => boolean;
  participantId: string;
  board?: Board | null;
  /** Folded to a rail (the board gets the room); peeking: open for a moment on a new chat message. */
  folded?: boolean;
  peeking?: boolean;
  onFold?: () => void;
  onPeek?: (on: boolean) => void;
  /** On a phone the panel is a sheet over the call: open or not, never a rail. */
  phone?: boolean;
  open?: boolean;
  /** Chat messages from others that came in while the sheet was closed. */
  onUnseen?: (n: number) => void;
}) {
  const { state, segments, interims, send } = props;
  // Two tabs. The transcript is the record of the item on screen, in order: what was said, what was
  // typed in the chat, what Stand caught, what Stand was asked and answered, and what agents reported.
  // The chat is the meeting's one conversation, whichever item each message landed on. The topics
  // and their notes sit on the middle screen, so the transcript opens first.
  const [tab, setTab] = useState<"chat" | "transcript">("transcript");
  const shut = props.phone ? !props.open : !!props.folded && !props.peeking;
  const focus = state.items.find((i) => i.id === state.focusItemId) ?? null;
  // The running list sits out a product review (the notes agent files what's said under the slide),
  // so on a review slide what was caught comes from the notes.
  const captures = (focus?.slide?.layout === "review" || focus?.slide?.layout === "design" ? props.notes : (props.list ?? props.notes)).filter(
    (n) => n.meetingId === state.meetingId && n.itemId === state.focusItemId && n.kind !== "summary" && !("closed" in n && (n as ListNote).closed?.how === "wrong"),
  );
  const shown = buildTimeline({
    meeting: { startedAt: state.meetingStartedAt, endedAt: null },
    segments,
    notes: captures,
    discussions: [],
    cards: props.cards ?? [],
    focus: [],
    updates: state.updates ?? [],
    itemById: (id) => state.items.find((i) => i.id === id) ?? null,
  })
    .filter((e) => e.itemId === state.focusItemId)
    // The panel is already the record of what's on screen, so "on screen" on each row would only repeat its title.
    .map(({ shown: _shown, points: _points, ...e }) => e);
  const transcriptCount = shown.length;
  // Each time the board moved to another topic on this item, and who moved it (Stand by itself, or a person).
  const threads = props.board?.threads ?? [];
  const moves = (props.board?.moves ?? []).flatMap((m) => {
    const t = threads.find((x) => x.id === m.threadId);
    return m.via !== "first" && t && t.itemId === state.focusItemId ? [{ key: `${m.threadId}-${m.at}`, ts: m.at, by: m.by, text: moverText(m), title: t.title }] : [];
  });
  // Chat is one conversation for the whole meeting, whichever item it landed on.
  const chats = segments.filter((s) => s.kind === "chat");
  const notesUpdating = props.notesBusy.includes(state.focusItemId ?? "");
  // The agent's last try at this item failed: it says so here until a later try works.
  const notesFailed = (state.notesFailing ?? []).includes(state.focusItemId);
  // New remarks for this item while the Transcript tab isn't open.
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (tab === "transcript" && !shut) setSeen(transcriptCount);
  }, [tab, transcriptCount, shut]);
  useEffect(() => setSeen(transcriptCount), [state.focusItemId]);
  const unseen = Math.max(0, transcriptCount - seen);
  // Messages from others since the Chat tab was last open; your own don't count.
  const othersChats = chats.filter((s) => s.speakerId !== props.participantId).length;
  const [chatSeen, setChatSeen] = useState(othersChats);
  useEffect(() => {
    // On a phone the open sheet shows chat in either view.
    if ((tab === "chat" || props.phone) && !shut) setChatSeen(othersChats);
  }, [tab, othersChats, shut, props.phone]);
  const chatUnseen = Math.max(0, othersChats - chatSeen);
  useEffect(() => props.onUnseen?.(chatUnseen), [chatUnseen]);
  // Folded, a message from someone else opens the chat for a moment, then it folds again unless the
  // pointer or the cursor is in it.
  const lastChats = useRef(othersChats);
  useEffect(() => {
    if (othersChats > lastChats.current && props.folded) {
      setTab("chat");
      props.onPeek?.(true);
    }
    lastChats.current = othersChats;
  }, [othersChats]);
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    if (!props.peeking || !props.folded || holding) return;
    const t = setTimeout(() => props.onPeek?.(false), PEEK_MS);
    return () => clearTimeout(t);
  }, [props.peeking, props.folded, holding, othersChats]);
  const isHost = state.participants.some((p) => p.id === props.participantId && p.isHost);
  const focusSnaps = (state.snaps ?? []).filter((p) => p.itemId === state.focusItemId);

  if (shut && !props.phone)
    return (
      <aside className="panel side rail" aria-label="Chat and transcript">
        <button className="icon side-fold" title="Show chat and transcript" aria-label="Show chat and transcript" onClick={props.onFold}>
          <PanelIcon open={false} right />
        </button>
        {(["chat", "transcript"] as const).map((t) => {
          const n = t === "chat" ? chatUnseen : unseen;
          return (
            <button
              key={t}
              className="rail-item side-rail-tab"
              title={t === "chat" ? "Chat" : "Transcript"}
              aria-label={`${t === "chat" ? "Chat" : "Transcript"}${n ? `, ${n} new` : ""}`}
              onClick={() => {
                setTab(t);
                props.onFold?.();
              }}
            >
              {t === "chat" ? <ChatIcon /> : <TranscriptIcon />}
              {n > 0 && <span className="side-tab-badge">{n}</span>}
            </button>
          );
        })}
      </aside>
    );

  return (
    <aside
      className={props.peeking && props.folded ? "panel side peeking" : "panel side"}
      onMouseEnter={() => setHolding(true)}
      onMouseLeave={() => setHolding(false)}
      onFocus={() => setHolding(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHolding(false)}
    >
      <div className="side-head">
        <h2 className="side-head-title" title={focus?.title}>
          {focus ? focus.title : "General / off-agenda"}
        </h2>
        <SnapsPill snaps={focusSnaps} me={props.participantId} isHost={isHost} className="side-head-snaps" />
        {keyOf(focus) && <span className="side-head-key">{keyOf(focus)}</span>}
        {props.onFold && (
          <button
            className="icon side-fold"
            title={props.peeking && props.folded ? "Keep chat and transcript open" : "Hide chat and transcript"}
            aria-label={props.peeking && props.folded ? "Keep open" : "Hide chat and transcript"}
            onClick={props.onFold}
          >
            <PanelIcon open={!(props.peeking && props.folded)} right />
          </button>
        )}
      </div>

      <div className="side-toggle" role="tablist" aria-label="Discussion views">
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          {props.phone ? "Chat only" : "Chat"}
          {tab !== "chat" && chatUnseen > 0 && !props.phone && (
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
          {props.phone ? "Everything" : "Transcript"}
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
        <Transcript entries={shown} segments={segments} captures={captures} moves={moves} items={state.items} interims={interims} send={send} empty="Nothing said about this yet." tagChat />
      ) : (
        <Transcript entries={chats.map(lineOf)} segments={chats} items={state.items} interims={{}} send={send} empty="No messages yet." />
      )}
      {/* Under both tabs: what's typed from the transcript lands in it, at the moment it was sent. */}
      {!state.ending && <ChatBox send={send} />}
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

/** A line in the transcript where the board moved to another topic. */
type MoveRow = { key: string; ts: number; by: string | null; text: string; title: string };

/** A line said or typed, as the timeline has it. */
const lineOf = (s: Segment): TimelineEntry => ({ id: `${s.kind}:${s.id}`, kind: s.kind, ts: s.ts, actor: { kind: "person", person: s.speakerName, personId: s.speakerId }, who: s.speakerName, whoId: s.speakerId, text: s.text, itemId: s.itemId });

function Transcript(props: {
  /** What to show, in order (shared/timeline.ts). */
  entries: TimelineEntry[];
  /** The lines and notes those entries came from, for moving a line and for a capture's state. */
  segments: Segment[];
  /** Mark typed lines as chat (the transcript; the chat tab has only those). */
  tagChat?: boolean;
  moves?: MoveRow[];
  captures?: Note[];
  items: Item[];
  interims: Record<string, Interim>;
  send: (m: ClientMessage) => boolean;
  empty: string;
}) {
  const colorFor = usePersonColors();
  const { entries, items, interims, send } = props;
  const segOf = new Map(props.segments.map((s) => [s.id, s]));
  const noteOf = new Map((props.captures ?? []).map((n) => [n.id, n]));
  const sourceId = (e: TimelineEntry) => e.id.slice(e.kind.length + 1);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const interimList = Object.values(interims);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, entries.filter((e) => e.answer).length, props.moves?.length, interimList.length, interimList.map((i) => i.text).join("")]);

  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {entries.length === 0 && !props.moves?.length && interimList.length === 0 && (
        <p className="muted empty">{props.empty}</p>
      )}
      {[...entries.map((e) => ({ ts: e.ts, e, move: null as MoveRow | null })), ...(props.moves ?? []).map((m) => ({ ts: m.ts, e: null as TimelineEntry | null, move: m }))]
        .sort((a, b) => a.ts - b.ts)
        .map((r) => {
          const e = r.e;
          if (!e)
            return (
              <div key={r.move!.key} className="seg board-move" role="note" title={`${r.move!.text}: ${r.move!.title}`}>
                <span className="board-move-text">
                  {!r.move!.by && (
                    <span className="agent-mark" aria-hidden>
                      ✦{" "}
                    </span>
                  )}
                  {r.move!.text} · <strong>{r.move!.title}</strong>
                </span>
                <span className="seg-time">{fmtTime(r.move!.ts)}</span>
              </div>
            );
          if (e.kind === "ask") return <AskRow key={e.id} e={e} onShow={() => showCard(sourceId(e))} />;
          if (e.kind === "agent") return <AgentRow key={e.id} e={e} />;
          if (e.kind === "capture") {
            const note = noteOf.get(sourceId(e));
            return note ? <CaptureRow key={e.id} note={note} entry={e} /> : null;
          }
          const seg = segOf.get(sourceId(e));
          return seg ? <SegmentRow key={e.id} segment={seg} items={items} send={send} tag={props.tagChat} /> : null;
        })}
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

/** Capture confirmations stay alongside the words they came from, including after reconnecting. */
function CaptureRow({ note, entry }: { note: Note; entry: TimelineEntry }) {
  const heard = note.kind === "decision" && "heard" in note && !!note.heard;
  const label = note.kind === "action" ? "Added to Todo!"
    : note.kind === "decision" ? heard ? "Decision heard" : "Added to Decided!"
    : note.kind === "question" ? "Added to Open questions!" : "Added to Context!";
  return (
    <div className={`seg capture-event capture-${note.kind}`} role="note">
      <div className="capture-head">
        <strong>{label}</strong>
        <span className="seg-time">{fmtTime(note.ts)}</span>
      </div>
      <div className="capture-text"><Linkified text={note.text} /></div>
      <MadeBy e={entry} />
      {heard && <span className="capture-owner">Awaiting confirmation</span>}
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

function SegmentRow({ segment: s, items, send, tag }: { segment: Segment; items: Item[]; send: (m: ClientMessage) => boolean; tag?: boolean }) {
  const colorFor = usePersonColors();
  const [moving, setMoving] = useState(false);
  return (
    <div className={s.kind === "chat" ? "seg chat" : "seg"}>
      <div className="seg-head">
        <span className="seg-who" style={{ color: colorFor(s.speakerId) }}>
          {s.speakerName}
        </span>
        {tag && s.kind === "chat" && <span className="seg-kind">chat</span>}
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
