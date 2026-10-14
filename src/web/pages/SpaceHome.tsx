// A space's own page, the one people open between meetings: what came into the space since
// last time (snaps and notes people saved, meetings, agents' updates), and where the space stands
// (to-dos, decisions, open questions and the suggested agenda). Start talking turns it into the
// meeting. It shows captures but doesn't make them: snaps and notes come from the Stand bar.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ItemUpdate, Jot, Note, Snap, SpaceFeed, SpaceSummary, UpNext } from "../../shared/protocol.ts";
import { api, type RoomInfo } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { FollowUpList, itemHref, saveFollowUp, sourceLabel } from "../FollowUps.tsx";
import { CameraIcon, CloseIcon, EditIcon, LinkIcon, MicIcon, TrashIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { Avatar } from "../room/Stage.tsx";
import { removeSnap } from "../Snaps.tsx";
import { errorToast, toast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { fmtDate, fmtTime } from "../util.ts";
import { ModeNote } from "./RoomPage.tsx";
import { SpacesShell } from "./SpacesShell.tsx";
import { SynthesisLine } from "../Synthesis.tsx";

/** Rows each right-hand card shows before folding the rest into "N more". */
const CARD_ROWS = 4;
/** Suggestions Up next shows under the agenda before folding. */
const SUGGESTED_ROWS = 3;

type Entry =
  | { kind: "snap"; at: number; snap: Snap }
  | { kind: "jot"; at: number; jot: Jot }
  | { kind: "meeting"; at: number; meeting: SpaceFeed["meetings"][number] }
  | { kind: "update"; at: number; update: ItemUpdate };

export function SpaceHome(props: { room: RoomInfo; onJoin: () => void; reload: () => void }) {
  const { room, reload } = props;
  const { user, caps } = useAuth();
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [feed, setFeed] = useState<SpaceFeed | null>(null);
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The snap open big: one on its own, or a note's pictures with the note.
  const [viewing, setViewing] = useState<{ snaps: Snap[]; i: number; jot?: Jot } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    reload();
    api.feed(room.id).then(
      (f) => {
        setFeed(f);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    api.suggested(room.id).then((s) => setUpNext(s.upNext), () => {});
  }, [room.id, reload]);

  useEffect(() => {
    load();
    api.spaces().then(setSpaces, () => {});
    // What others save shows up while the page is open, and when you come back to it.
    const t = setInterval(load, 20_000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const pickItem = (snap: Snap, itemId: string | null) => {
    setFeed((f) => f && { ...f, captures: f.captures.map((c) => (c.id === snap.id ? { ...c, itemId, itemSuggested: false } : c)) });
    api.updateSnap(snap.id, { itemId }).then(load, (err) => {
      load();
      errorToast("Couldn't move it")(err);
    });
  };

  const pickJotItem = (jot: Jot, itemId: string | null) => {
    setFeed((f) => f && { ...f, jots: f.jots.map((j) => (j.id === jot.id ? { ...j, itemId, itemSuggested: false } : j)) });
    api.updateJot(jot.id, { itemId }).then(load, (err) => {
      load();
      errorToast("Couldn't move it")(err);
    });
  };
  // Deleted at once, with its pictures; Undo brings both back for a minute.
  const deleteJot = (jot: Jot) => {
    setFeed((f) => f && { ...f, jots: f.jots.filter((j) => j.id !== jot.id) });
    api.deleteJot(jot.id).then(
      () =>
        toast({
          text: "Note deleted",
          action: { label: "Undo", run: () => void api.restoreJot(jot.id).then(load, errorToast("Couldn't bring the note back")) },
        }),
      (err) => {
        load();
        errorToast("Couldn't delete the note")(err);
      },
    );
  };

  const live = !!room.liveMeetingId;
  const wrapping = live && room.people.length === 0;
  const members = spaces?.find((s) => s.id === room.id)?.people ?? [];
  const faces = live && room.people.length ? room.people : members.map((name) => ({ name, picture: null }));

  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    const show = () => toast({ text: `Copy this link: ${location.href}`, ms: 15_000 });
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, show);
    else show();
  };

  // The agenda as the meeting shows it, a deck as one line, then what the agent would add.
  const agenda: Array<{ key: string; title: string; href: string; open: number }> = [];
  for (const it of room.items) {
    const key = it.deckId ?? it.id;
    if (agenda.some((a) => a.key === key)) continue;
    const deck = it.deckId ? room.decks.find((d) => d.id === it.deckId) : null;
    agenda.push({ key, title: deck ? deck.title : it.title, href: deck ? `/decks/${deck.id}` : `/items/${it.id}`, open: 0 });
  }
  for (const f of room.followUps) {
    const it = room.items.find((i) => i.id === f.itemId);
    const row = it && agenda.find((a) => a.key === (it.deckId ?? it.id));
    if (row) row.open++;
  }
  const suggested = upNext?.suggestions ?? [];

  const entries: Entry[] = feed
    ? [
        ...feed.captures.map((snap) => ({ kind: "snap" as const, at: snap.ts, snap })),
        ...(feed.jots ?? []).map((jot) => ({ kind: "jot" as const, at: jot.ts, jot })),
        ...feed.meetings.map((meeting) => ({ kind: "meeting" as const, at: meeting.endedAt, meeting })),
        ...feed.updates.map((update) => ({ kind: "update" as const, at: update.ts, update })),
      ].sort((a, b) => b.at - a.at)
    : [];
  const days: Array<{ label: string; entries: Entry[] }> = [];
  for (const e of entries) {
    const label = dayLabel(e.at);
    if (days.at(-1)?.label !== label) days.push({ label, entries: [] });
    days.at(-1)!.entries.push(e);
  }

  return (
    <SpacesShell spaces={spaces}>
      <main className="sh-main">
        <header className="sh-head">
          <h1>{room.name}</h1>
          {room.purpose && <span className="sh-purpose">{room.purpose}</span>}
          <span className="sh-head-end">
            {live && (
              <span
                className={wrapping ? "sh-live wrapping" : "sh-live"}
                title={wrapping ? "Nobody's in the meeting now. It ends by itself in about 2 minutes unless someone joins." : undefined}
              >
                <span className="dot" />
                {wrapping ? "Wrapping up" : "Talking now"}
              </span>
            )}
            {faces.length > 0 && (
              <span className="sh-faces stack" title={faces.map((f) => f.name).join(", ")}>
                {faces.slice(0, 4).map((p, i) => (
                  <Avatar key={i} id={p.name} name={p.name} picture={p.picture} size={24} />
                ))}
                {faces.length > 4 && <span className="sh-faces-more">+{faces.length - 4}</span>}
              </span>
            )}
            <button className="sh-invite" onClick={copy} title="Copy a link others can join with">
              <LinkIcon />
              {copied ? "Copied" : "Invite"}
            </button>
            <button className="primary sh-join" onClick={props.onJoin}>
              <MicIcon />
              {wrapping ? "Join" : live ? "Join them" : "Start talking"}
            </button>
          </span>
        </header>
        <div className="sh-synth">
          <SynthesisLine roomId={room.id} instructions={room.synthesisInstructions} onSaved={() => reload()} />
        </div>
        <ModeNote caps={caps} />

        <div className="sh-cols">
          <section className="sh-feed" aria-labelledby="sh-feed-title">
            <h2 id="sh-feed-title">Since last time</h2>
            {error && !feed && (
              <p className="error">
                {error}{" "}
                <button className="link" onClick={load}>
                  Try again
                </button>
              </p>
            )}
            {feed && !entries.length && (
              <div className="sh-empty">
                <CameraIcon size={18} />
                <p>
                  Nothing here yet. Snaps and notes you save from the Stand bar in the Mac app land here (<strong>Control + Shift + S</strong>{" "}
                  snaps, <strong>Control + Shift + N</strong> writes a note), and so do meetings once they end and what agents report.
                </p>
              </div>
            )}
            {days.map((d) => (
              <div key={d.label} className="sh-day">
                <h3>{d.label}</h3>
                <ul className="sh-rows">
                  {d.entries.map((e) =>
                    e.kind === "snap" ? (
                      <SnapRow key={e.snap.id} snap={e.snap} room={room} me={user.id} onOpen={() => setViewing({ snaps: [e.snap], i: 0 })} onPick={(id) => pickItem(e.snap, id)} />
                    ) : e.kind === "jot" ? (
                      <JotRow
                        key={e.jot.id}
                        jot={e.jot}
                        room={room}
                        me={user.id}
                        onOpen={() => setViewing({ snaps: e.jot.snaps ?? [], i: 0, jot: e.jot })}
                        onPick={(id) => pickJotItem(e.jot, id)}
                        onDelete={() => deleteJot(e.jot)}
                      />
                    ) : e.kind === "meeting" ? (
                      <MeetingRow key={e.meeting.id} m={e.meeting} />
                    ) : (
                      <UpdateRow key={e.update.id} u={e.update} room={room} />
                    ),
                  )}
                </ul>
              </div>
            ))}
          </section>

          <aside className="sh-side" aria-label="Where the space stands">
            <Card title="To do" tone="todo" count={room.followUps.length} empty="No open to-dos.">
              {(all) => (
                <FollowUpList
                  compact
                  notes={all ? room.followUps : room.followUps.slice(0, CARD_ROWS)}
                  onToggle={saveFollowUp(room.id)}
                  source={(n) => ({ label: sourceLabel(n.itemId, room.items, room.decks), href: itemHref(n.itemId, room.items) })}
                />
              )}
            </Card>
            <NoteCard title="Decided" tone="decided" notes={feed?.decided ?? []} room={room} empty="No decisions yet." />
            <NoteCard title="Open" tone="question" notes={feed?.open ?? []} room={room} empty="No open questions from the last meeting." />
            <Card
              title="Up next"
              count={agenda.length + suggested.length}
              folded={Math.max(0, agenda.length - CARD_ROWS) + Math.max(0, suggested.length - SUGGESTED_ROWS)}
              empty="Nothing on the agenda yet. Suggestions come from meetings and what people save here.">
              {(all) => (
                <>
                  <ul className="sh-list">
                    {(all ? agenda : agenda.slice(0, CARD_ROWS)).map((e) => (
                      <li key={e.key}>
                        <Link to={e.href}>{e.title}</Link>
                        {e.open > 0 && <span className="sh-open-count">{e.open} open</span>}
                      </li>
                    ))}
                  </ul>
                  {suggested.length > 0 && (
                    <>
                      <p className="sh-group" title="What the agent suggests adding when the next meeting starts">
                        <span className="sh-mark">✦</span>Suggested · {suggested.length}
                      </p>
                      <ul className="sh-list suggested">
                        {(all ? suggested : suggested.slice(0, SUGGESTED_ROWS)).map((s) => (
                          <li key={s.key} title={s.reason}>
                            {s.kind === "capture" && (s.key.startsWith("jot:") ? <EditIcon size={12} /> : <CameraIcon size={12} />)}
                            <span>{s.title}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </Card>
          </aside>
        </div>
        {viewing && viewing.snaps[viewing.i] && (
          <SnapView
            snap={viewing.snaps[viewing.i]}
            of={viewing.jot && { jot: viewing.jot, i: viewing.i, n: viewing.snaps.length, go: (i) => setViewing({ ...viewing, i }) }}
            me={user.id}
            room={room}
            onClose={() => setViewing(null)}
            onDeleted={load}
          />
        )}
      </main>
    </SpacesShell>
  );
}

function dayLabel(ts: number) {
  const day = (t: number) => new Date(t).toDateString();
  if (day(ts) === day(Date.now())) return "Today";
  if (day(ts) === day(Date.now() - 86_400_000)) return "Yesterday";
  return fmtDate(ts);
}

const firstName = (name: string) => name.split(" ")[0];

function SnapRow(props: { snap: Snap; room: RoomInfo; me: string; onOpen: () => void; onPick: (itemId: string | null) => void }) {
  const { snap } = props;
  const who = snap.takenById === props.me ? "You" : firstName(snap.takenBy);
  return (
    <li className="sh-row">
      <button className="sh-thumb" onClick={props.onOpen} aria-label="Open the snap">
        <img src={snap.url} alt="" loading="lazy" />
      </button>
      <span className="sh-row-text">
        <span className="sh-who">{who}</span>
        {snap.line ? (
          <span className="sh-what">{snap.line}</span>
        ) : snap.caption ? (
          <span className="sh-what agent">✦ {snap.caption}</span>
        ) : (
          <span className="sh-what muted">Snap</span>
        )}
      </span>
      <ItemPill of={snap} room={props.room} onPick={props.onPick} />
      <time className="sh-time">{fmtTime(snap.ts)}</time>
    </li>
  );
}

/**
 * A note saved from the bar: its first line, all of it when clicked, and the snaps pinned to it
 * (the first as the thumbnail, "+2" for more). Whoever wrote it can delete it.
 */
function JotRow(props: { jot: Jot; room: RoomInfo; me: string; onOpen: () => void; onPick: (itemId: string | null) => void; onDelete: () => void }) {
  const { jot } = props;
  const [open, setOpen] = useState(false);
  const mine = jot.byId === props.me;
  const long = jot.text.length > 90 || jot.text.includes("\n");
  const snaps = jot.snaps ?? [];
  return (
    <li className="sh-row">
      {snaps.length ? (
        <button className="sh-thumb" onClick={props.onOpen} aria-label={snaps.length > 1 ? `Open its ${snaps.length} snaps` : "Open its snap"}>
          <img src={snaps[0].url} alt="" loading="lazy" />
          {snaps.length > 1 && <span className="sh-thumb-more">+{snaps.length - 1}</span>}
        </button>
      ) : (
        <span className="sh-icon" aria-hidden>
          <EditIcon size={16} />
        </span>
      )}
      <span className="sh-row-text">
        <span className="sh-who">{mine ? "You" : firstName(jot.by)}</span>
        {long ? (
          <button className={`sh-what sh-jot${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? undefined : jot.text}>
            {jot.text}
          </button>
        ) : (
          <span className="sh-what">{jot.text}</span>
        )}
      </span>
      {mine && (
        <button
          className="sh-row-del"
          onClick={props.onDelete}
          aria-label={snaps.length ? "Delete the note and its snaps" : "Delete the note"}
          title={snaps.length ? "Delete the note and its snaps" : "Delete the note"}
        >
          <TrashIcon />
        </button>
      )}
      <ItemPill of={jot} room={props.room} onPick={props.onPick} />
      <time className="sh-time">{fmtTime(jot.ts)}</time>
    </li>
  );
}

function ItemPill(props: { of: { itemId: string | null; itemSuggested: boolean }; room: RoomInfo; onPick: (itemId: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const items = props.room.items.filter((i) => !i.deckId);
  const item = props.room.items.find((i) => i.id === props.of.itemId);
  const suggested = props.of.itemSuggested && !!item;
  const pick = (id: string | null) => {
    setOpen(false);
    props.onPick(id);
  };
  return (
    <span className="sh-pill-wrap" ref={ref}>
      <button
        className={`sh-pill${suggested ? " suggested" : ""}${props.of.itemId ? "" : " none"}`}
        aria-expanded={open}
        title={suggested ? "The agent's pick. Click to confirm it or choose another item." : "Choose the item it's about"}
        onClick={() => setOpen((o) => !o)}
      >
        {suggested && "✦ "}
        {item ? item.title : props.of.itemId ? "An earlier item" : "No item"}
      </button>
      {open && (
        <span className="sh-menu" role="menu">
          {suggested && (
            <button role="menuitem" className="sh-menu-confirm" onClick={() => pick(item.id)}>
              Confirm {item.title}
            </button>
          )}
          {items.map((it) => (
            <button key={it.id} role="menuitem" className={it.id === props.of.itemId && !suggested ? "on" : undefined} onClick={() => pick(it.id)}>
              {it.title}
            </button>
          ))}
          <button role="menuitem" className={!props.of.itemId ? "on" : undefined} onClick={() => pick(null)}>
            No item
          </button>
          {item && (
            <Link role="menuitem" className="sh-menu-link" to={`/items/${item.id}`}>
              Open {item.title}
            </Link>
          )}
        </span>
      )}
    </span>
  );
}

function MeetingRow({ m }: { m: SpaceFeed["meetings"][number] }) {
  const minutes = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const out = [m.todos && plural(m.todos, "to-do"), m.decided && `${m.decided} decided`, m.open && `${m.open} open`].filter(Boolean).join(" · ");
  return (
    <li className="sh-row">
      <Link to={`/meetings/${m.id}`} className="sh-row-link" title={m.summary ?? undefined}>
        <span className="sh-icon" aria-hidden>
          <MicIcon />
        </span>
        <span className="sh-row-text">
          <span className="sh-who">Meeting</span>
          <span className="sh-what">
            {minutes} min{out && <span className="muted"> · {out}</span>}
          </span>
        </span>
        <time className="sh-time">{fmtTime(m.endedAt)}</time>
      </Link>
    </li>
  );
}

const UPDATE_LABEL: Record<ItemUpdate["status"], string | null> = { working: "Started", progress: null, blocked: "Blocked", needs_decision: "Needs a decision", ready: "Ready to ship", done: "Done" };

function UpdateRow({ u, room }: { u: ItemUpdate; room: RoomInfo }) {
  const item = room.items.find((i) => i.id === u.itemId);
  const label = UPDATE_LABEL[u.status];
  return (
    <li className="sh-row">
      <span className="sh-icon agent" aria-hidden>
        ✦
      </span>
      <span className="sh-row-text">
        <span className="sh-who">{u.client === "GitHub" ? "GitHub" : u.client ? `${firstName(u.userName)}'s agent` : firstName(u.userName)}</span>
        {label && <span className={`sh-status ${u.status}`}>{label}</span>}
        <span className="sh-what">{u.text || u.noteText}</span>
      </span>
      {item && (
        <Link className="sh-pill" to={itemHref(item.id, room.items) ?? `/items/${item.id}`}>
          {item.title}
        </Link>
      )}
      <time className="sh-time">{fmtTime(u.ts)}</time>
    </li>
  );
}

/** A right-hand card: a small header with a count, and its rows folded past CARD_ROWS. */
function Card(props: {
  title: string;
  count: number;
  /** How many rows are folded away; the rows past CARD_ROWS unless the card says. */
  folded?: number;
  mark?: boolean;
  /** Colors the card like the meeting recap does: to do blue, decided green, open orange. */
  tone?: Tone;
  empty: string;
  children: (all: boolean) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const folded = props.folded ?? props.count - CARD_ROWS;
  return (
    <section className={props.tone ? `sh-card ${props.tone}` : "sh-card"}>
      <h2>
        {props.mark && <span className="sh-mark">✦</span>}
        {props.tone && TONE_ICON[props.tone]}
        {props.title}
        {props.count > 0 && <span className="count">{props.count}</span>}
      </h2>
      {props.count ? props.children(all) : <p className="sh-card-empty">{props.empty}</p>}
      {folded > 0 && (
        <button className="sh-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `${folded} more`}
        </button>
      )}
    </section>
  );
}

type Tone = "todo" | "decided" | "question";
const TONE_ICON: Record<Tone, React.ReactNode> = { todo: <TodoIcon size={14} />, decided: <DecidedIcon size={14} />, question: <QuestionIcon size={14} /> };

function NoteCard(props: { title: string; tone: "decided" | "question"; notes: Note[]; room: RoomInfo; empty: string }) {
  return (
    <Card title={props.title} tone={props.tone} count={props.notes.length} empty={props.empty}>
      {(all) => (
        <ul className="sh-list">
          {(all ? props.notes : props.notes.slice(0, CARD_ROWS)).map((n) => (
            <li key={n.id}>
              {TONE_ICON[props.tone]}
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * One snap, big: what was typed with it, the agent's line, and the text read off it. A note's
 * snaps open with the note in place of the line, Left and Right stepping through them.
 */
function SnapView(props: {
  snap: Snap;
  of?: { jot: Jot; i: number; n: number; go: (i: number) => void };
  me: string;
  room: RoomInfo;
  onClose: () => void;
  /** Something changed: load the feed again. */
  onDeleted: () => void;
}) {
  const { snap, of, onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (!of || (e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "ArrowLeft" && of.i > 0) of.go(of.i - 1);
      if (e.key === "ArrowRight" && of.i < of.n - 1) of.go(of.i + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, of]);
  const item = props.room.items.find((i) => i.id === snap.itemId);
  const mine = snap.takenById === props.me;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog sh-view" role="dialog" aria-modal="true" aria-label={of ? "Note" : "Snap"}>
        <div className="sh-view-head">
          <strong>
            {mine ? "You" : snap.takenBy} · {fmtDate(snap.ts)} {fmtTime(snap.ts)}
            {item && <span className="muted"> · {item.title}</span>}
          </strong>
          {of && of.n > 1 && (
            <span className="sh-view-step">
              <button className="icon-btn" aria-label="Previous snap" disabled={of.i === 0} onClick={() => of.go(of.i - 1)}>
                ‹
              </button>
              <span className="muted">
                {of.i + 1} of {of.n}
              </span>
              <button className="icon-btn" aria-label="Next snap" disabled={of.i === of.n - 1} onClick={() => of.go(of.i + 1)}>
                ›
              </button>
            </span>
          )}
          {mine && !of && (
            <button
              className="icon-btn"
              title="Delete"
              aria-label="Delete the snap"
              onClick={() => {
                removeSnap(snap.id);
                onClose();
                setTimeout(props.onDeleted, 400);
              }}
            >
              <TrashIcon />
            </button>
          )}
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <img className="sh-view-img" src={snap.url} alt={of?.jot.text ?? snap.line ?? snap.caption ?? "Snap"} />
        {of ? (
          <p className="sh-view-line sh-view-note">{of.jot.text}</p>
        ) : mine ? (
          <input
            className="sh-view-line edit"
            defaultValue={snap.line ?? ""}
            placeholder="Add a line about it for the space"
            maxLength={300}
            aria-label="What it's about"
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              const line = e.currentTarget.value.trim();
              if (line === (snap.line ?? "")) return;
              api.updateSnap(snap.id, { line }).then(props.onDeleted, errorToast("Couldn't save the line"));
            }}
          />
        ) : (
          snap.line && <p className="sh-view-line">{snap.line}</p>
        )}
        {snap.caption && <p className="sh-view-caption">✦ {snap.caption}</p>}
        {snap.screenText && (
          <details className="sh-view-text">
            <summary>Text in it</summary>
            <pre>{snap.screenText}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
