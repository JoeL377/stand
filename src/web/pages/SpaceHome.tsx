// A space's own page, the one people open between meetings: what came into the space since
// last time (snaps and notes people saved, and meetings), and where the space stands
// (to-dos, decisions, open questions and the suggested agenda). Start talking turns it into the
// meeting. It shows captures but doesn't make them: snaps and notes come from the Stand bar.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ArchivedKind, ArchivedRow, FollowUp, Jot, Note, NoteFrom, Snap, SpaceFeed, SpaceSummary, UpNext } from "../../shared/protocol.ts";
import { stateOf } from "../../shared/tasks.ts";
import { ClosedPill, SaidDonePill } from "../TaskMarks.tsx";
import { useWork } from "../WorkLog.tsx";
import { api, type RoomInfo } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { FollowUpList, type FollowUpNote } from "../FollowUps.tsx";
import { Face, FromChip, QuoteMark } from "../RecapChapters.tsx";
import { ArchiveIcon, CameraIcon, ChevronIcon, CloseIcon, EditIcon, LinkIcon, MicIcon, TrashIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { Avatar } from "../room/Stage.tsx";
import { removeSnap } from "../Snaps.tsx";
import { errorToast, toast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { colorFor, fmtDate, fmtTime } from "../util.ts";
import { ModeNote } from "./RoomPage.tsx";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { SpacesShell } from "./SpacesShell.tsx";
import { Slide } from "../room/Opener.tsx";

type Entry =
  | { kind: "snap"; at: number; snap: Snap }
  | { kind: "jot"; at: number; jot: Jot }
  | { kind: "meeting"; at: number; meeting: SpaceFeed["meetings"][number] };

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
  const [showArchived, setShowArchived] = useState(false);
  // The tab someone last looked at in this space; a new space opens on Meetings.
  const [tab, setTab] = useState<TabKey>(() => {
    try {
      const saved = localStorage.getItem(`stand.spaceTab.${room.id}`);
      // To do and Questions became one Tasks tab.
      if (saved === "todo" || saved === "questions") return "tasks";
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
    api.suggested(room.id).then(
      (s) => setUpNext(s.upNext),
      () => {},
    );
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

  // Archiving takes a row off the page right away; Archived at the bottom of its tab brings it back.
  const archived = feed?.archived ?? [];
  const gone = new Set(archived.map((a) => a.ref));
  const restore = (ref: string) => {
    setFeed((f) => f && { ...f, archived: f.archived.filter((a) => a.ref !== ref) });
    api.archive(room.id, { ref, archived: false }).then(load, (err) => {
      load();
      errorToast("Couldn't bring it back")(err);
    });
  };
  const archive = (ref: string, suggestion?: { title: string; keys: string[] }) => {
    const row: ArchivedRow = {
      ref,
      kind: ref.split(":")[0] as ArchivedKind,
      title: suggestion?.title ?? "",
      ts: Date.now(),
      at: Date.now(),
      by: user.name,
    };
    setFeed((f) => f && { ...f, archived: [row, ...f.archived] });
    api.archive(room.id, { ref, ...suggestion }).then(
      () => {
        load();
        toast({ text: "Archived", action: { label: "Undo", run: () => restore(ref) } });
      },
      (err) => {
        load();
        errorToast("Couldn't archive it")(err);
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
  const agenda: Array<{ key: string; ref: string; title: string; href: string; open: number }> = [];
  for (const it of room.items) {
    const key = it.deckId ?? it.id;
    if (agenda.some((a) => a.key === key)) continue;
    const deck = it.deckId ? room.decks.find((d) => d.id === it.deckId) : null;
    const ref = deck ? `deck:${deck.id}` : `item:${it.id}`;
    if (gone.has(ref)) continue;
    agenda.push({ key, ref, title: deck ? deck.title : it.title, href: deck ? `/decks/${deck.id}` : `/items/${it.id}`, open: 0 });
  }
  const todos = room.followUps.filter((f) => !gone.has(`todo:${f.id}`));
  for (const f of todos) {
    const it = room.items.find((i) => i.id === f.itemId);
    const row = it && agenda.find((a) => a.key === (it.deckId ?? it.id));
    if (row) row.open++;
  }
  const suggested = (upNext?.suggestions ?? []).filter((s) => !gone.has(`suggestion:${s.key}`));
  const questions = (feed?.open ?? []).filter((n) => !gone.has(`question:${n.id}`));
  const decisions = (feed?.decided ?? []).filter((n) => !gone.has(`decision:${n.id}`));
  const meetings = (feed?.meetings ?? []).filter((m) => !gone.has(`meeting:${m.id}`));
  const counts: Record<TabKey, number> = {
    meetings: meetings.length,
    tasks: todos.length + questions.length,
    decisions: decisions.filter((n) => !n.replacedBy).length,
    next: agenda.length + suggested.length,
    done: feed?.doneDeck?.closed ?? 0,
  };
  const deck = feed?.doneDeck ?? null;
  // Where each to-do came from, for its pill: the meeting and the chapter, as its recap files it.
  const done = (room.doneFollowUps ?? []).filter((f) => !gone.has(`todo:${f.id}`));
  const closedQuestions = (feed?.closedQuestions ?? []).filter((n) => !gone.has(`question:${n.id}`));

  const entries: Entry[] = feed
    ? [
        ...feed.captures.filter((x) => !gone.has(`snap:${x.id}`)).map((snap) => ({ kind: "snap" as const, at: snap.ts, snap })),
        ...(feed.jots ?? []).filter((x) => !gone.has(`jot:${x.id}`)).map((jot) => ({ kind: "jot" as const, at: jot.ts, jot })),
        ...meetings.map((meeting) => ({ kind: "meeting" as const, at: meeting.endedAt, meeting })),
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
        <ModeNote caps={caps} />

        <div className="sh-tabs" role="tablist" aria-label="The space">
          {TABS.filter((t) => t.key !== "done" || deck).map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? "sh-tab on" : "sh-tab"}
              onClick={() => pickTab(t.key)}
            >
              {t.icon}
              {t.key === "done" && deck ? `Done since ${new Date(deck.sinceStartedAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : t.label}
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
                    <strong>Control + Shift + S</strong> snaps, <strong>Control + Shift + N</strong> writes a note).
                  </p>
                </div>
              )}
              {days.map((d) => (
                <div key={d.label} className="sh-day">
                  <h3>{d.label}</h3>
                  <ul className="sh-rows">
                    {d.entries.map((e) =>
                      e.kind === "snap" ? (
                        <SnapRow
                          key={e.snap.id}
                          snap={e.snap}
                          room={room}
                          me={user.id}
                          onOpen={() => setViewing({ snaps: [e.snap], i: 0 })}
                          onPick={(id) => pickItem(e.snap, id)}
                          onArchive={() => archive(`snap:${e.snap.id}`)}
                        />
                      ) : e.kind === "jot" ? (
                        <JotRow
                          key={e.jot.id}
                          jot={e.jot}
                          room={room}
                          me={user.id}
                          onOpen={() => setViewing({ snaps: e.jot.snaps ?? [], i: 0, jot: e.jot })}
                          onPick={(id) => pickJotItem(e.jot, id)}
                          onDelete={() => deleteJot(e.jot)}
                          onArchive={() => archive(`jot:${e.jot.id}`)}
                        />
                      ) : (
                        <MeetingRow key={e.meeting.id} m={e.meeting} onArchive={() => archive(`meeting:${e.meeting.id}`)} />
                      ),
                    )}
                  </ul>
                </div>
              ))}
            </>
          )}

          {tab === "tasks" && (
            <TasksTab
              roomId={room.id}
              me={user.name}
              open={[...todos, ...questions]}
              closed={[...done, ...closedQuestions]}
              onArchive={(n) => archive(`${n.kind === "question" ? "question" : "todo"}:${n.id}`)}
              reload={load}
            />
          )}
          {tab === "done" &&
            (deck ? (
              <div className="sh-done-since">
                <p className="topic-summary">
                  {deck.by === "claude" && (
                    <>
                      <span className="agent-mark" aria-hidden>
                        ✦
                      </span>{" "}
                    </>
                  )}
                  {deck.summary ?? `${deck.closed} ${deck.closed === 1 ? "task" : "tasks"} closed since the last meeting.`}
                </p>
                {deck.slides.map((s, i) => (
                  <div key={i} className="sh-day">
                    <h3>{s.title}</h3>
                    <Slide s={s} at={deck.at} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="sh-card-empty">Nothing closed since the last meeting.</p>
            ))}
          {tab === "decisions" && (
            <PointList kind="decided" notes={decisions} empty="No decisions yet." onArchive={(id) => archive(`decision:${id}`)} />
          )}

          {tab === "next" &&
            (agenda.length + suggested.length ? (
              <>
                <ul className="sh-list">
                  {agenda.map((e) => (
                    <li key={e.key}>
                      <Link to={e.href}>{e.title}</Link>
                      {e.open > 0 && <span className="sh-open-count">{e.open} open</span>}
                      <ArchiveButton onClick={() => archive(e.ref)} />
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
                          <ArchiveButton onClick={() => archive(`suggestion:${s.key}`, { title: s.title, keys: s.merged })} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="sh-card-empty">Nothing on the agenda yet. Suggestions come from meetings and what people save here.</p>
            ))}

          <ArchivedList
            rows={archived.filter((a) => TAB_KINDS[tab].includes(a.kind))}
            open={showArchived}
            onToggle={() => setShowArchived((v) => !v)}
            onRestore={restore}
          />
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

function SnapRow(props: {
  snap: Snap;
  room: RoomInfo;
  me: string;
  onOpen: () => void;
  onPick: (itemId: string | null) => void;
  onArchive: () => void;
}) {
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
      <ArchiveButton onClick={props.onArchive} />
    </li>
  );
}

/**
 * A note saved from the bar: its first line, all of it when clicked, and the snaps pinned to it
 * (the first as the thumbnail, "+2" for more). Whoever wrote it can delete it.
 */
function JotRow(props: {
  jot: Jot;
  room: RoomInfo;
  me: string;
  onOpen: () => void;
  onPick: (itemId: string | null) => void;
  onDelete: () => void;
  onArchive: () => void;
}) {
  const { jot } = props;
  const [open, setOpen] = useState(false);
  const mine = jot.byId === props.me;
  const long = jot.text.length > 90 || jot.text.includes("\n");
  const snaps = jot.snaps ?? [];
  return (
    <li className="sh-row">
      {snaps.length ? (
        <button
          className="sh-thumb"
          onClick={props.onOpen}
          aria-label={snaps.length > 1 ? `Open its ${snaps.length} snaps` : "Open its snap"}
        >
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
          <button
            className={`sh-what sh-jot${open ? " open" : ""}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            title={open ? undefined : jot.text}
          >
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
      <ArchiveButton onClick={props.onArchive} />
    </li>
  );
}

function ItemPill(props: {
  of: { itemId: string | null; itemSuggested: boolean };
  room: RoomInfo;
  onPick: (itemId: string | null) => void;
}) {
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
            <button
              key={it.id}
              role="menuitem"
              className={it.id === props.of.itemId && !suggested ? "on" : undefined}
              onClick={() => pick(it.id)}
            >
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

function MeetingRow({ m, onArchive }: { m: SpaceFeed["meetings"][number]; onArchive: () => void }) {
  const minutes = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  // What came out of it, in the tabs' order and colors.
  const counts = [
    { n: m.todos, kind: "todo", Icon: TodoIcon, label: plural(m.todos, "to-do") },
    { n: m.open, kind: "question", Icon: QuestionIcon, label: plural(m.open, "open question") },
    { n: m.decided, kind: "decided", Icon: DecidedIcon, label: plural(m.decided, "decision") },
  ].filter((c) => c.n > 0);
  return (
    <li className="sh-row">
      <Link to={`/meetings/${m.id}`} className="sh-row-link" title={m.summary ?? undefined}>
        <span className="sh-icon" aria-hidden>
          <MicIcon />
        </span>
        <span className="sh-row-text">
          <span className="sh-who">Meeting</span>
          <span className="sh-what muted">{minutes} min</span>
          {counts.length > 0 && (
            <span className="sh-counts">
              {counts.map(({ n, kind, Icon, label }) => (
                <span key={kind} className={`sh-count ${kind}`} title={label} aria-label={label}>
                  <Icon size={13} />
                  {n}
                </span>
              ))}
            </span>
          )}
        </span>
        <time className="sh-time">{fmtTime(m.endedAt)}</time>
      </Link>
      <ArchiveButton onClick={onArchive} />
    </li>
  );
}

type TaskNote = FollowUpNote & { from?: NoteFrom; answeredBy?: string };

/**
 * One list for everything still to do in the space: to-dos (Do) and open questions (Answer). Work
 * waiting on someone's look (a PR reported ready) comes first, then the rest grouped by owner, yours
 * first, then folded Done and Dropped. Anyone can tick a task off, drop it or reopen it, with Undo.
 */
function TasksTab(props: { roomId: string; me: string; open: TaskNote[]; closed: TaskNote[]; onArchive: (n: Note) => void; reload: () => void }) {
  const [showDone, setShowDone] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const work = useWork(props.open.filter((n) => n.kind === "action").map((n) => n.id));
  const waiting = props.open.filter((n) => work[n.id]?.ready);
  const groups = new Map<string, TaskNote[]>();
  for (const n of props.open.filter((x) => !work[x.id]?.ready)) {
    const k = n.owner ? firstName(n.owner) : "";
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const me = firstName(props.me);
  const owners = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
  function rank(k: string) {
    return k === me ? 0 : k === "" ? 2 : 1;
  }
  const done = props.closed.filter((n) => stateOf(n) !== "dropped");
  const dropped = props.closed.filter((n) => stateOf(n) === "dropped");

  const move = (n: Note, state: "done" | "dropped" | "open") =>
    api.setTask(props.roomId, n.id, { state }).then(
      (saved) => {
        props.reload();
        if (state !== "open")
          toast({
            text: state === "dropped" ? "Dropped" : n.kind === "question" ? "Answered" : "Done",
            action: { label: "Undo", run: () => void api.setTask(props.roomId, n.id, { state: "open" }).then(props.reload, errorToast("Couldn't undo it")) },
          });
        return saved;
      },
      (err) => {
        errorToast(state === "dropped" ? "Couldn't drop it" : "Couldn't save that")(err);
        return undefined;
      },
    );
  const notSaid = (n: Note) => void api.setTask(props.roomId, n.id, { saidDone: false }).then(props.reload, errorToast("Couldn't change it"));

  const list = (notes: TaskNote[], closed = false) => (
    <FollowUpList
      oneLine
      notes={notes}
      onToggle={(n, d) => move(n, d ? "done" : "open")}
      after={(n: TaskNote) => (
        <>
          {n.kind === "question" && <span className="task-verb">Answer</span>}
          {n.saidDone && !n.doneAt && <SaidDonePill quote={n.saidDone} onUndo={() => notSaid(n)} />}
          {!closed && n.state === "doing" && !work[n.id]?.working && <span className="rc-pill task-doing">Doing</span>}
          {closed && <ClosedPill note={n} />}
          {closed && n.answeredBy && (
            <span className="rc-pill-wrap">
              <span className="rc-pill task-closed" tabIndex={0}>
                Answered
              </span>
              <span className="rc-pop" role="tooltip">
                <span className="rc-pop-crux">{n.answeredBy}</span>
              </span>
            </span>
          )}
          {n.from && <FromChip from={n.from} />}
        </>
      )}
      tail={(n: TaskNote) => (
        <>
          {!closed && (
            <button className="sh-archive sh-drop" aria-label="Drop: no longer wanted" title="Drop: no longer wanted" onClick={() => void move(n, "dropped")}>
              <CloseIcon />
            </button>
          )}
          <ArchiveButton onClick={() => props.onArchive(n)} />
          {n.owner ? (
            <Face name={n.owner} color={colorFor(n.owner)} title={`${n.owner}${n.doneAt && n.doneBy ? ` · ${n.state === "dropped" ? "dropped" : "done"} by ${n.doneBy}` : ""}`} />
          ) : (
            <span className="rc-face none" title={n.kind === "question" ? "Anyone" : "Unassigned"}>
              ?
            </span>
          )}
        </>
      )}
    />
  );

  const fold = (label: string, n: number, open: boolean, toggle: () => void, icon: React.ReactNode) =>
    n > 0 && (
      <button className="sh-done-toggle" aria-expanded={open} onClick={toggle}>
        <ChevronIcon />
        {icon}
        {label}
        <span className="count">{n}</span>
      </button>
    );

  return (
    <>
      {!props.open.length && <p className="sh-card-empty">Nothing open. New tasks come from meetings and what people save here.</p>}
      {waiting.length > 0 && (
        <div className="sh-task-group">
          <p className="sh-group waiting" title="A PR or other work is in and needs someone with a say to look">
            Waiting on you · {waiting.length}
          </p>
          {list(waiting)}
        </div>
      )}
      {owners.map((o) => (
        <div key={o || "nobody"} className="sh-task-group">
          <p className="sh-group">
            {o === me ? "You" : o || "No owner"} · {groups.get(o)!.length}
          </p>
          {list(groups.get(o)!)}
        </div>
      ))}
      {done.length > 0 && (
        <div className={showDone ? "sh-done open" : "sh-done"}>
          {fold("Done", done.length, showDone, () => setShowDone((v) => !v), <DoneIcon />)}
          {showDone && list(done, true)}
        </div>
      )}
      {dropped.length > 0 && (
        <div className={showDropped ? "sh-done open" : "sh-done"}>
          {fold("Dropped", dropped.length, showDropped, () => setShowDropped((v) => !v), <CloseIcon size={13} />)}
          {showDropped && list(dropped, true)}
        </div>
      )}
    </>
  );
}

/** A checked box, as a finished to-do shows. */
const DoneIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
    <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="3.5" fill="currentColor" />
    <path d="M3.8 7.2 6 9.3l4.2-4.6" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type TabKey = "meetings" | "done" | "tasks" | "decisions" | "next";
/** The space's tabs, in the order people look at them. */
/** Shows on a row while the pointer is on it (always on touch screens). */
function ArchiveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="sh-archive"
      aria-label="Archive"
      title="Archive"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <ArchiveIcon />
    </button>
  );
}

/** Which archived rows each tab lists at its bottom. */
const TAB_KINDS: Record<TabKey, ArchivedKind[]> = {
  meetings: ["meeting", "snap", "jot"],
  done: [],
  tasks: ["todo", "question"],
  decisions: ["decision"],
  next: ["item", "deck", "suggestion"],
};

/** A tab's archived rows, folded at its bottom like Done, each with Restore. */
function ArchivedList(props: { rows: ArchivedRow[]; open: boolean; onToggle: () => void; onRestore: (ref: string) => void }) {
  if (!props.rows.length) return null;
  return (
    <div className={props.open ? "sh-done archived open" : "sh-done archived"}>
      <button className="sh-done-toggle" aria-expanded={props.open} onClick={props.onToggle}>
        <ChevronIcon />
        <ArchiveIcon size={13} />
        Archived
        <span className="count">{props.rows.length}</span>
      </button>
      {props.open && (
        <ul className="sh-archived">
          {props.rows.map((a) => (
            <li key={a.ref}>
              <span className="sh-archived-title">{a.kind === "meeting" ? `Meeting · ${fmtDate(a.ts)}` : a.title}</span>
              <span className="sh-archived-by" title={`Archived ${fmtDate(a.at)} by ${a.by}`}>
                {firstName(a.by)}
              </span>
              <button className="sh-archived-restore" onClick={() => props.onRestore(a.ref)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TABS: Array<{ key: TabKey; label: string; icon?: React.ReactNode }> = [
  { key: "meetings", label: "Meetings", icon: <MicIcon /> },
  // Shown only while there's something done since the last meeting; labeled with its date.
  { key: "done", label: "Done since", icon: <span className="agent-mark small" aria-hidden>✦</span> },
  { key: "tasks", label: "Tasks", icon: <TodoIcon size={14} /> },
  { key: "decisions", label: "Decisions", icon: <DecidedIcon size={14} /> },
  { key: "next", label: "Up next" },
];

/** Decisions or open questions across the space's meetings, as the recap lists them. A decision a
 *  later one replaced stays, muted and last, so the change of mind is still on record. */
function PointList(props: { kind: "decided" | "question"; notes: SpaceFeed["decided"]; empty: string; onArchive: (id: string) => void }) {
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
          <ArchiveButton onClick={() => props.onArchive(n.id)} />
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
