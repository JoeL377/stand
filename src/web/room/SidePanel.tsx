import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Discussion, Item, ItemUpdate, Note, RoomState, Segment } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, fmtTime, keyOf } from "../util.ts";
import { FollowUpList } from "../FollowUps.tsx";
import { LiveItemNotes, type NoteEditing } from "../Discussions.tsx";

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
  const [earlierOpen, setEarlierOpen] = useState(true);
  const { state, segments, notes, interims, send } = props;
  // Two tabs: the agent's notes and topics first, the raw transcript second.
  const [tab, setTab] = useState<"notes" | "transcript">("notes");
  const focus = state.items.find((i) => i.id === state.focusItemId) ?? null;
  const shown = segments.filter((s) => s.itemId === state.focusItemId);
  const focusNotes = notes.filter((n) => n.itemId === state.focusItemId);
  const focusDiscussions = props.discussions.filter((d) => d.itemId === state.focusItemId);
  const notesUpdating = props.notesBusy.includes(state.focusItemId ?? "");
  // Action items about this item from earlier meetings, still open (or just checked off).
  const earlier = (state.followUps ?? []).filter((f) => f.itemId === state.focusItemId);
  const earlierOpenCount = earlier.filter((f) => !f.doneAt).length;
  // What agents and people reported on this item since the last meeting.
  const since = (state.updates ?? []).filter((u) => u.itemId === state.focusItemId);
  const hasNotes = since.length > 0 || earlier.length > 0 || focusNotes.length > 0 || notesUpdating;
  // New remarks for this item while the Transcript tab isn't open.
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (tab === "transcript") setSeen(shown.length);
  }, [tab, shown.length]);
  useEffect(() => setSeen(shown.length), [state.focusItemId]);
  const unseen = Math.max(0, shown.length - seen);
  // The host can fix what the agent wrote: edit, delete or add notes for the item in focus.
  const isHost = state.participants.some((p) => p.id === props.participantId && p.isHost);
  const editing: NoteEditing | undefined = isHost
    ? {
        change: (n, text, owner) => send({ type: "note.edit", noteId: n.id, text, owner }),
        remove: (n) => send({ type: "note.remove", noteId: n.id }),
        add: (kind, text, owner) => send({ type: "note.add", itemId: state.focusItemId, kind, text, owner }),
      }
    : undefined;

  return (
    <aside className="panel side">
      <div className="side-head">
        <h2 className="side-head-title" title={focus?.title}>
          {focus ? focus.title : "General / off-agenda"}
        </h2>
        <div className="side-head-meta">
          {keyOf(focus) && <span>{keyOf(focus)}</span>}
          <a
            href={`/meetings/${state.meetingId}`}
            target="_blank"
            rel="noreferrer"
            title="Everything said and noted in this meeting, across items"
          >
            Meeting recap ↗
          </a>
        </div>
      </div>

      <div className="side-toggle" role="tablist" aria-label="Discussion views">
        <button role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
          Notes & topics
          {notesUpdating && <span className="side-toggle-dot" title="Updating notes" aria-label="Updating" />}
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
      {tab === "notes" ? (
        <div className="side-notes-tab">
          <LiveSliver segments={shown} interims={interims} onOpen={() => setTab("transcript")} />
          {!hasNotes && <p className="side-notes-empty">Agent notes and topics for this item show up here once people start talking.</p>}
          {since.length > 0 && <SinceLastTime updates={since} />}
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
            <section className="side-agent-notes">
              {!focusNotes.length && <p className="tk-empty">Writing the first notes…</p>}
              {focusNotes.length > 0 && (
                <LiveItemNotes
                  notes={focusNotes}
                  discussions={focusDiscussions}
                  segments={segments}
                  onToggle={(n, done) => send({ type: "followup.done", noteId: n.id, done })}
                  editing={editing}
                />
              )}
            </section>
          )}
          {isHost && focusNotes.length === 0 && !notesUpdating && (
            <section className="side-agent-notes">
              <LiveItemNotes notes={[]} discussions={[]} segments={[]} editing={editing} />
            </section>
          )}
        </div>
      ) : (
        <Transcript segments={shown} items={state.items} interims={interims} send={send} />
      )}
    </aside>
  );
}

/** The last thing heard about this item, so people can tell at a glance that Stand is capturing. */
function LiveSliver(props: { segments: Segment[]; interims: Record<string, Interim>; onOpen: () => void }) {
  const live = Object.values(props.interims).at(-1);
  const last = props.segments.at(-1);
  if (!live && !last) return null;
  const who = live ? live.speakerName : last!.speakerName;
  const id = live ? live.speakerId : last!.speakerId;
  return (
    <button className={live ? "side-sliver live" : "side-sliver"} onClick={props.onOpen} title="Open the transcript">
      <span className="side-sliver-dot" aria-hidden />
      <span className="side-sliver-who" style={{ color: colorFor(id) }}>
        {who}
      </span>
      <span className="side-sliver-text">{live ? `${live.text}…` : last!.text}</span>
      {!live && <span className="side-sliver-time">{fmtTime(last!.ts)}</span>}
    </button>
  );
}

function Transcript(props: { segments: Segment[]; items: Item[]; interims: Record<string, Interim>; send: (m: ClientMessage) => void }) {
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

const STATUS: Record<ItemUpdate["status"], string> = {
  done: "Done",
  blocked: "Blocked",
  needs_decision: "Needs a decision",
  progress: "Progress",
};

/** Links read as "PR #12" or the site's name rather than a raw URL. */
function linkLabel(url: string) {
  try {
    const u = new URL(url);
    const pr = /\/pull\/(\d+)/.exec(u.pathname);
    if (u.hostname === "github.com" && pr) return `PR #${pr[1]}`;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Updates agents and people posted on the item in focus since the last meeting. */
function SinceLastTime({ updates }: { updates: ItemUpdate[] }) {
  return (
    <section className="side-since tk-card">
      <h4>Since last time</h4>
      <ul>
        {updates.map((u) => (
          <li key={u.id} className={`since ${u.status}`}>
            <span className={`since-status ${u.status}`}>{STATUS[u.status]}</span>
            <span className="since-body">
              <span className="since-text">{u.text}</span>
              {u.noteText && <span className="since-on">On: {u.noteText}</span>}
              <span className="since-meta">
                {u.client ? `${u.userName.split(/\s+/)[0]} via ${u.client}` : u.userName} · {fmtAgo(u.ts)}
                {u.links.map((l) => (
                  <a key={l} href={l} target="_blank" rel="noreferrer">
                    {linkLabel(l)}
                  </a>
                ))}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function fmtAgo(ts: number) {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
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
