// A space's own page, the one people open between meetings: what came into the space since
// last time (snaps and notes people saved, meetings, agents' updates), and where the space stands
// (to-dos, decisions, open questions and the suggested agenda). Start talking turns it into the
// meeting. It shows captures but doesn't make them: snaps and notes come from the Stand bar.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ItemUpdate, Jot, Snap, SpaceFeed, SpaceSummary, UpNext } from "../../shared/protocol.ts";
import { api, type RoomInfo } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { FollowUpList, itemHref, saveFollowUp } from "../FollowUps.tsx";
import { Face, FromChip, QuoteMark } from "../RecapChapters.tsx";
import { CameraIcon, CloseIcon, EditIcon, LinkIcon, MicIcon, TrashIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { Avatar } from "../room/Stage.tsx";
import { removeSnap } from "../Snaps.tsx";
import { errorToast, toast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { colorFor, fmtDate, fmtTime } from "../util.ts";
import { ModeNote } from "./RoomPage.tsx";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { SpacesShell } from "./SpacesShell.tsx";
import { SynthesisLine } from "../Synthesis.tsx";


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
  // The tab someone last looked at in this space; a new space opens on Meetings.
  const [tab, setTab] = useState<TabKey>(() => {
    try {
      const saved = localStorage.getItem(`stand.spaceTab.${room.id}`);
      if (saved && TABS.some((t) => t.key === saved)) return saved as TabKey;
    } catch {}
    return "meetings";
  });
  const pickTab = (key: TabKey) => {
    setTab(key);
    try {
      localStorage.setItem(`stand.spaceTab.${room.id}`, key);
    } catch {}
  };

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
  const counts: Record<TabKey, number> = {
    meetings: feed?.meetings.length ?? 0,
    todo: room.followUps.length,
    questions: feed?.open.length ?? 0,
    decisions: feed?.decided.filter((n) => !n.replacedBy).length ?? 0,
    next: agenda.length + suggested.length,
  };
  // Where each to-do came from, for its pill: the meeting and the chapter, as its recap files it.
  const fromOf = new Map(room.followUps.flatMap((f) => (f.from ? [[f.id, f.from] as const] : [])));

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

        <div className="sh-tabs" role="tablist" aria-label="The space">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "sh-tab on" : "sh-tab"} onClick={() => pickTab(t.key)}>
              {t.icon}
              {t.label}
              {counts[t.key] > 0 && <span className="count">{counts[t.key]}</span>}
            </button>
          ))}
        </div>

        <section className={`sh-panel ${tab}`} role="tabpanel">
          {tab === "meetings" && (
            <>
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
                    Nothing here yet. Meetings land here once they end, and so do snaps and notes saved from the Stand bar in the Mac app (
                    <strong>Control + Shift + S</strong> snaps, <strong>Control + Shift + N</strong> writes a note) and what agents report.
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
            </>
          )}

          {tab === "todo" &&
            (room.followUps.length ? (
              <FollowUpList
                oneLine
                notes={room.followUps}
                onToggle={saveFollowUp(room.id)}
                after={(n) => fromOf.get(n.id) && <FromChip from={fromOf.get(n.id)!} />}
                tail={(n) =>
                  n.owner ? (
                    <Face name={n.owner} color={colorFor(n.owner)} />
                  ) : (
                    <span className="rc-face none" title="Unassigned">
                      ?
                    </span>
                  )
                }
              />
            ) : (
              <p className="sh-card-empty">No open to-dos.</p>
            ))}

          {tab === "questions" && <PointList kind="question" notes={feed?.open ?? []} empty="No open questions." />}
          {tab === "decisions" && <PointList kind="decided" notes={feed?.decided ?? []} empty="No decisions yet." />}

          {tab === "next" &&
            (agenda.length + suggested.length ? (
              <>
                <ul className="sh-list">
                  {agenda.map((e) => (
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
                      {suggested.map((s) => (
                        <li key={s.key} title={s.reason}>
                          {s.kind === "capture" && (s.key.startsWith("jot:") ? <EditIcon size={12} /> : <CameraIcon size={12} />)}
                          <span>{s.title}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="sh-card-empty">Nothing on the agenda yet. Suggestions come from meetings and what people save here.</p>
            ))}
        </section>
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

type TabKey = "meetings" | "todo" | "questions" | "decisions" | "next";
/** The space's tabs, in the order people look at them. */
const TABS: Array<{ key: TabKey; label: string; icon?: React.ReactNode }> = [
  { key: "meetings", label: "Meetings", icon: <MicIcon /> },
  { key: "todo", label: "To do", icon: <TodoIcon size={14} /> },
  { key: "questions", label: "Questions", icon: <QuestionIcon size={14} /> },
  { key: "decisions", label: "Decisions", icon: <DecidedIcon size={14} /> },
  { key: "next", label: "Up next" },
];

/** Decisions or open questions across the space's meetings, as the recap lists them. A decision a
 *  later one replaced stays, muted and last, so the change of mind is still on record. */
function PointList(props: { kind: "decided" | "question"; notes: SpaceFeed["decided"]; empty: string }) {
  if (!props.notes.length) return <p className="sh-card-empty">{props.empty}</p>;
  const Icon = props.kind === "decided" ? DecidedIcon : QuestionIcon;
  return (
    <ul className={`rc-points ${props.kind}`}>
      {props.notes.map((n) => (
        <li key={n.id} className={n.replacedBy ? "replaced" : undefined}>
          <Icon />
          <span className="rc-point-body">
            <span>
              {n.text}
              {n.quote && <QuoteMark quote={n.quote} />}
              {n.from && <FromChip from={n.from} />}
              {n.replacedBy && <ReplacedChip by={n.replacedBy} />}
            </span>
          </span>
          <CopyForAgent kind={props.kind === "decided" ? "decision" : "question"} id={n.id} />
        </li>
      ))}
    </ul>
  );
}

/** On a decision a later meeting reversed: what it was replaced with, and when. */
function ReplacedChip({ by }: { by: NonNullable<SpaceFeed["decided"][number]["replacedBy"]> }) {
  const day = new Date(by.startedAt).toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <span className="rc-pill-wrap">
      <Link className="rc-pill sh-replaced" to={`/meetings/${by.meetingId}`} aria-label={`Replaced on ${day}: ${by.text}`}>
        Replaced
      </Link>
      <span className="rc-pop" role="tooltip">
        <span className="rc-pop-meta">Replaced on {fmtDate(by.startedAt)} by</span>
        <span className="rc-pop-crux">{by.text}</span>
      </span>
    </span>
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
