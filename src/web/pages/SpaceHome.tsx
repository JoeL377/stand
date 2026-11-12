import { PersonColors, useColorRegistry, usePersonColors } from "../PersonColors.tsx";
// A space's own page, the one people open between meetings: what came into the space since
// last time (snaps and notes people saved, and meetings), and where the space stands
// (to-dos, decisions, open questions and the suggested agenda). Start talking turns it into the
// meeting. It shows captures but doesn't make them: snaps and notes come from the Stand bar.

import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ArchivedKind, ArchivedRow, BrainstormSummary, DoneDeck, FollowUp, Jot, Note, NoteFrom, ReplacedBy, ReviewSummary, ReviewView, Snap, SpaceFeed, SpaceSummary, TaskMention } from "../../shared/protocol.ts";
import { matchesTopic, topicKey, topicOf, topicOptions } from "../../shared/topics.ts";
import { TopicPicker } from "../TopicPicker.tsx";
import { stateOf } from "../../shared/tasks.ts";
import { ClosedPill, SaidDonePill } from "../TaskMarks.tsx";
import { useWork } from "../WorkLog.tsx";
import { api, type RoomInfo } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { FollowUpList, type FollowUpNote } from "../FollowUps.tsx";
import { Face, FromChip, QuoteMark } from "../RecapChapters.tsx";
import { ArchiveIcon, CameraIcon, ChatIcon, ChevronIcon, CloseIcon, EditIcon, LinkIcon, MicIcon, TrashIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { Avatar } from "../room/Stage.tsx";
import { removeSnap } from "../Snaps.tsx";
import { errorToast, toast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { fmtDate, fmtTime } from "../util.ts";
import { ModeNote } from "./RoomPage.tsx";
import { brainstormHref } from "./BrainstormPage.tsx";
import { VerdictCounts, designRecordHref, designReviewHref } from "./DesignReviewPage.tsx";
import { OutcomeCounts, reviewHref } from "./ReviewPage.tsx";
import { ShotZoom } from "../room/ReviewStage.tsx";
import type { DesignReviewRan, DesignReviewSummary } from "../../shared/designReview.ts";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { SpacesShell } from "./SpacesShell.tsx";
import { TaskDrawer } from "../TaskDrawer.tsx";
import { SpaceChat, useSpaceChat } from "../SpaceChat.tsx";
import { Opener } from "../room/Opener.tsx";

type Entry =
  | { kind: "snap"; at: number; snap: Snap }
  | { kind: "jot"; at: number; jot: Jot }
  | { kind: "meeting"; at: number; meeting: SpaceFeed["meetings"][number] };

export function SpaceHome(props: { room: RoomInfo; onJoin: () => void; reload: () => void }) {
  const { room, reload } = props;
  const colorFor = useColorRegistry(room.id, room.people.map((p) => ({ id: p.name, name: p.name })));
  const { user, caps } = useAuth();
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(null);
  const [feed, setFeed] = useState<SpaceFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chat = useSpaceChat(room.id, user.id);
  // The snap open big: one on its own, or a note's pictures with the note.
  const [viewing, setViewing] = useState<{ snaps: Snap[]; i: number; jot?: Jot } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // The task open in the drawer, in the URL so a link can open it.
  const [params, setParams] = useSearchParams();
  const openTask = params.get("task");
  const showTask = useCallback((id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev); next.set("task", id); next.delete("view"); return next;
  }), [setParams]);
  const closeTask = useCallback(() => setParams((prev) => {
    const next = new URLSearchParams(prev); next.delete("task"); next.delete("view"); return next;
  }, { replace: true }), [setParams]);
  const topicFilter = params.get("topic") ?? "";
  const setTopicFilter = (value: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set("topic", value); else next.delete("topic");
    return next;
  });
  // The tab someone last looked at in this space; a new space opens on Tasks, and so does a link to a task.
  const [showReview, setShowReview] = useState(false);
  const [showBrain, setShowBrain] = useState(false);
  const [showSession, setShowSession] = useState(false);
  const [kind, setKind] = useState<"" | "review" | "design" | "brainstorm" | "session">("");
  const [tab, setTab] = useState<TabKey>(() => {
    if (openTask) return "tasks";
    try {
      const saved = localStorage.getItem(`stand.spaceTab.${room.id}`);
      // To do and Questions became one Tasks tab, and Done since moved into it. Up next is gone: saved "next" falls through to Tasks.
      if (saved === "todo" || saved === "questions" || saved === "done") return "tasks";
      if (saved && TABS.some((t) => t.key === saved)) return saved as TabKey;
    } catch {}
    return "tasks";
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

  const todos = room.followUps.filter((f) => !gone.has(`todo:${f.id}`));
  const questions = (feed?.open ?? []).filter((n) => !gone.has(`question:${n.id}`));
  const decisions = (feed?.decided ?? []).filter((n) => !gone.has(`decision:${n.id}`));
  const context = feed?.context ?? [];
  const meetings = (feed?.meetings ?? []).filter((m) => !gone.has(`meeting:${m.id}`));
  const counts: Record<TabKey, number> = {
    meetings: meetings.length,
    tasks: todos.length + questions.length,
    decisions: decisions.filter((n) => !n.replacedBy).length,
    // Chat counts what you haven't read, not what is there.
    chat: chat.unread,
  };
  const deck = feed?.doneDeck ?? null;
  // Where each to-do came from, for its pill: the meeting and the chapter, as its recap files it.
  const done = (room.doneFollowUps ?? []).filter((f) => !gone.has(`todo:${f.id}`));
  const closedQuestions = (feed?.closedQuestions ?? []).filter((n) => !gone.has(`question:${n.id}`));

  const allNotes = [...todos, ...questions, ...decisions, ...done, ...closedQuestions];
  const topics = topicOptions(allNotes, room.items, room.decks);
  const topic = (n: Note) => topicOf(n, room.items, room.decks);
  const matching = (n: Note) => matchesTopic(topic(n), topicFilter);
  const topicPicker = (n: Note) => <TopicPicker note={n} roomId={room.id} topic={topic(n)}
    inherited={topicOf({ ...n, topic: null }, room.items, room.decks)} options={topics} onSaved={load} />;

  const reviews = feed?.reviews ?? [];
  const designReviews = feed?.designReviews ?? [];
  const ran = (feed?.brainstorms ?? []).filter((b) => b.status === "done");
  const brainstorms = ran.filter((b) => !b.design);
  const sessions = ran.filter((b) => b.design);
  const kinds = [
    { key: "review" as const, label: "Product reviews", n: reviews.length },
    { key: "design" as const, label: "Design reviews", n: designReviews.length },
    { key: "brainstorm" as const, label: "Brainstorms", n: brainstorms.length },
    { key: "session" as const, label: "Design sessions", n: sessions.length },
  ].filter((k) => k.n > 0);
  /** What a meeting was, with the page it left behind. */
  const kindOf = new Map<string, { name: string; open: string; to: string }>();
  for (const b of brainstorms) if (b.meetingId) kindOf.set(b.meetingId, { name: "Brainstorm", open: "Map", to: brainstormHref(room.id, b.id) });
  for (const b of sessions) if (b.meetingId) kindOf.set(b.meetingId, { name: "Design session", open: "Diagram", to: brainstormHref(room.id, b.id) });
  for (const r of designReviews) if (r.meetingId) kindOf.set(r.meetingId, { name: "Design review", open: "Spec", to: designRecordHref(room.id, r.id) });
  for (const r of reviews) if (r.meetingId) kindOf.set(r.meetingId, { name: "Product review", open: "Slides", to: reviewHref(room.id, r.id) });
  for (const r of feed?.ideaReviews ?? []) if (r.meetingId && r.status === "done") kindOf.set(r.meetingId, { name: "Idea review", open: "Ideas", to: reviewHref(room.id, r.id) });
  const startReview = async () => {
    try {
      await api.startReview(room.id);
      props.onJoin();
    } catch (err) {
      errorToast("Couldn't start the review")(err);
    }
  };
  const startBrainstorm = async (prompt: string) => {
    try {
      await api.startBrainstorm(room.id, prompt);
      props.onJoin();
    } catch (err) {
      errorToast("Couldn't start the brainstorm")(err);
    }
  };
  const startSession = async (prompt: string, seed: string, taskId: string | null) => {
    try {
      await api.startBrainstorm(room.id, prompt, { seed, taskId });
      props.onJoin();
    } catch (err) {
      errorToast("Couldn't start the design session")(err);
    }
  };
  const removeSlide = async (slideId: string) => {
    try {
      await api.removeReviewSlide(room.id, slideId);
      load();
    } catch (err) {
      errorToast("Couldn't take the slide off")(err);
    }
  };

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
  <PersonColors.Provider value={colorFor}>
    <SpacesShell spaces={spaces && spaces.map((s) => (s.id === room.id ? { ...s, unread: chat.unread } : s))}>
      <main className="sh-main">
        {/* A fixed top of the page: only the lists under it scroll. On a phone the page scrolls and only the tabs stay. */}
        <div className="sh-top">
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
            <StartMenu
              label={wrapping ? "Join" : live ? "Join them" : "Start talking"}
              review={feed?.review ?? null}
              designReview={feed?.designReview ?? null}
              ideaReviews={(feed?.ideaReviews ?? []).filter((r) => r.status !== "done").map((r) => ({ ...r, href: reviewHref(room.id, r.id) }))}
              brainstorm={(feed?.brainstorms ?? []).find((b) => b.status === "live") ?? null}
              onSession={() => setShowSession(true)}
              designHref={designReviewHref(room.id)}
              onTalk={props.onJoin}
              onReview={() => setShowReview(true)}
              onBrainstorm={() => setShowBrain(true)}
            />
          </span>
        </header>
        <ModeNote caps={caps} />

        <div className="sh-tabs" role="tablist" aria-label="The space">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? `sh-tab ${t.key} on` : `sh-tab ${t.key}`}
              onClick={() => pickTab(t.key)}
            >
              {t.icon}
              {t.label}
              {counts[t.key] > 0 && <span className="count">{counts[t.key]}</span>}
            </button>
          ))}
          {/* One pill at the end of the tab row filters Tasks and Decisions by topic. */}
          {(tab === "tasks" || tab === "decisions") && (
            <label className={topicFilter ? "sh-topic-filter on" : "sh-topic-filter"} title="Filter by topic">
              {/* A phone has room for the mark only; the menu opens from it. */}
              <svg className="sh-topic-mark" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                <path d="M2.5 4h11M4.5 8h7M6.5 12h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <select aria-label="Filter by topic" value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)}>
                <option value="">All topics</option>
                <option value="none">No topic</option>
                {topics.map((t) => <option key={topicKey(t)} value={`topic:${topicKey(t)}`}>{t}</option>)}
                {topicFilter.startsWith("topic:") && !topics.some((t) => `topic:${topicKey(t)}` === topicFilter) && <option value={topicFilter}>{topicFilter.slice(6)}</option>}
              </select>
            </label>
          )}
        </div>
        </div>
        {/* The lists scroll in here, under the header, which is a fixed part of the page. */}
        <div className={tab === "chat" ? "sh-body chat" : "sh-body"} onScroll={(e) => e.currentTarget.previousElementSibling?.classList.toggle("over", e.currentTarget.scrollTop > 2)}>

        {showReview && feed?.review && (
          <ReviewPop roomId={room.id} review={feed.review} reviews={reviews} onStart={startReview} onRemove={removeSlide} onClose={() => setShowReview(false)} />
        )}
        {showBrain && <BrainstormPop onStart={startBrainstorm} onClose={() => setShowBrain(false)} />}
        {showSession && <DesignSessionPop todos={todos.filter((t) => !t.doneAt)} onStart={startSession} onClose={() => setShowSession(false)} />}

        <section className={`sh-panel ${tab}`} role="tabpanel">
          {tab === "chat" && <SpaceChat roomId={room.id} me={user} chat={chat} />}
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
              {kinds.length > 0 && (
                <div className="sh-kinds" role="group" aria-label="Kind of meeting">
                  {[{ key: "" as const, label: "All", n: 0 }, ...kinds].map((k) => (
                    <button key={k.key} type="button" className={kind === k.key ? "rp-pill on" : "rp-pill"} aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
                      {k.label}
                      {k.n > 0 && <span className="muted">{k.n}</span>}
                    </button>
                  ))}
                </div>
              )}
              {kind && (
                <ul className="sh-rows">
                  {kind === "review" &&
                    reviews.map((r) => (
                      <KindRow key={r.id} to={reviewHref(room.id, r.id)} name="Product review" at={r.startedAt}>
                        <span className="sh-what muted">{r.slides} {r.slides === 1 ? "slide" : "slides"}</span>
                        <OutcomeCounts outcomes={r.outcomes} />
                      </KindRow>
                    ))}
                  {kind === "design" &&
                    designReviews.map((r) => (
                      <KindRow key={r.id} to={designRecordHref(room.id, r.id)} name="Design review" at={r.startedAt}>
                        <span className="sh-what muted" dir="auto">{r.titles.join(" · ")}</span>
                        <VerdictCounts verdicts={r.verdicts} />
                      </KindRow>
                    ))}
                  {kind === "session" &&
                    sessions.map((b) => (
                      <KindRow key={b.id} to={brainstormHref(room.id, b.id)} name="Design session" at={b.startedAt}>
                        <span className="sh-what muted" dir="auto">{b.prompt}</span>
                        <span className="sh-what muted">{b.design!.boxes} {b.design!.boxes === 1 ? "part" : "parts"}</span>
                      </KindRow>
                    ))}
                  {kind === "brainstorm" &&
                    brainstorms.map((b) => (
                      <KindRow key={b.id} to={brainstormHref(room.id, b.id)} name="Brainstorm" at={b.startedAt}>
                        <span className="sh-what muted" dir="auto">{b.prompt}</span>
                        <span className="sh-what muted">{b.ideas} {b.ideas === 1 ? "idea" : "ideas"}</span>
                      </KindRow>
                    ))}
                </ul>
              )}
              {!kind && days.map((d) => (
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
                        <MeetingRow key={e.meeting.id} m={e.meeting} kind={kindOf.get(e.meeting.id)} onArchive={() => archive(`meeting:${e.meeting.id}`)} />
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
              deck={topicFilter ? null : deck}
              open={[...todos, ...questions].filter(matching)}
              closed={[...done, ...closedQuestions].filter(matching)}
              mentions={feed?.mentions ?? []}
              topicPicker={topicPicker}
              filtered={!!topicFilter}
              onArchive={(n) => archive(`${n.kind === "question" ? "question" : "todo"}:${n.id}`)}
              reload={load}
              openId={openTask}
              onOpen={showTask}
            />
          )}
          {tab === "decisions" && (
            <>
              <PointList
                kind="decided"
                notes={decisions.filter(matching)}
                topicPicker={topicPicker}
                empty={topicFilter ? "No decisions in this topic." : "No decisions yet."}
                onArchive={(id) => archive(`decision:${id}`)}
                onReplaced={(id, by, replaced) => void api.confirmReplaced(room.id, id, by, replaced).then(load, errorToast("Couldn't save that"))}
              />
              {!topicFilter && context.length > 0 && (
                <>
                  <p className="sh-group" title="What's true in this space that nobody had to choose">
                    Context · {context.length}
                  </p>
                  <ul className="sh-list">
                    {context.map((n) => (
                      <li key={n.id}>{n.text}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          {tab !== "chat" && (!(tab === "tasks" || tab === "decisions") || !topicFilter) && <ArchivedList
            rows={archived.filter((a) => TAB_KINDS[tab].includes(a.kind))}
            open={showArchived}
            onToggle={() => setShowArchived((v) => !v)}
            onRestore={restore}
          />}
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
        {openTask && (
          <TaskDrawer
            key={openTask}
            id={openTask}
            onOpen={showTask}
            onClose={closeTask}
            // A phone's rows carry only the title, so what the row's pills and icons do is offered here.
            acts={(n) => (
              <>
                {topicPicker(n)}
                {!n.doneAt && (
                  <button
                    type="button"
                    onClick={() =>
                      void api.setTask(room.id, n.id, { state: "dropped" }).then(() => {
                        closeTask();
                        load();
                        toast({ text: "Dropped", action: { label: "Undo", run: () => void api.setTask(room.id, n.id, { state: "open" }).then(load, errorToast("Couldn't undo it")) } });
                      }, errorToast("Couldn't drop it"))
                    }
                  >
                    Drop
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    closeTask();
                    archive(`${n.kind === "question" ? "question" : "todo"}:${n.id}`);
                  }}
                >
                  Archive
                </button>
              </>
            )}
            onMentionsChange={() => {
              load();
              api.spaces().then(setSpaces, () => {});
            }}
          />
        )}
        </div>
      </main>
    </SpacesShell>
  </PersonColors.Provider>
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

function MeetingRow({ m, kind, onArchive }: { m: SpaceFeed["meetings"][number]; kind?: { name: string; open: string; to: string }; onArchive: () => void }) {
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
          <span className="sh-who">{kind?.name ?? "Meeting"}</span>
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
      {kind && (
        <Link className="rp-pill" to={kind.to}>
          {kind.open}
        </Link>
      )}
      <ArchiveButton onClick={onArchive} />
    </li>
  );
}

type TaskNote = FollowUpNote & { from?: NoteFrom; answeredBy?: string };

/**
 * One list for everything still to do in the space: to-dos (Do) and open questions (Answer). Tasks
 * where a comment tags you come first, then work waiting on someone's look (a PR reported ready),
 * then the rest grouped by owner, yours first, then folded Done and Dropped. Anyone can tick a task
 * off, drop it or reopen it, with Undo.
 */
function TasksTab(props: {
  topicPicker: (n: Note) => React.ReactNode;
  filtered: boolean;
  roomId: string;
  me: string;
  /** What got done since the last meeting, as the next meeting's Kickoff card shows it. */
  deck: DoneDeck | null;
  open: TaskNote[];
  closed: TaskNote[];
  /** Comments that tag you and wait on you, newest first. */
  mentions: TaskMention[];
  onArchive: (n: Note) => void;
  reload: () => void;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const colorFor = usePersonColors();
  const [showDeck, setShowDeck] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const work = useWork(props.open.filter((n) => n.kind === "action").map((n) => n.id));
  // The comments that tag you, per task: newest first, so [0] is the latest.
  const tagged = new Map<string, TaskMention[]>();
  for (const m of props.mentions) tagged.set(m.noteId, [...(tagged.get(m.noteId) ?? []), m]);
  const mentioned = props.open.filter((n) => tagged.has(n.id)).sort((a, b) => tagged.get(b.id)![0].ts - tagged.get(a.id)![0].ts);
  const waiting = props.open.filter((n) => work[n.id]?.ready && !tagged.has(n.id));
  const groups = new Map<string, TaskNote[]>();
  for (const n of props.open.filter((x) => !work[x.id]?.ready && !tagged.has(x.id))) {
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
      openId={props.openId}
      onOpen={(n) => props.onOpen(n.id)}
      onToggle={(n, d) => move(n, d ? "done" : "open")}
      after={(n: TaskNote) => (
        <>
          {!closed && tagged.has(n.id) && <MentionPill mentions={tagged.get(n.id)!} />}
          {props.topicPicker(n)}
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
          {n.from && <span className="task-from"><FromChip from={n.from} /></span>}
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

  const deck = props.deck?.slides.length ? props.deck : null;
  return (
    <>
      {deck && (
        <button type="button" className="sh-done-since" onClick={() => setShowDeck(true)} title="See the pages the next meeting opens on">
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <strong>Done since {new Date(deck.sinceStartedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</strong>
          {deck.summary && <span className="sh-done-since-summary">{deck.summary}</span>}
          <span className="count">{deck.closed}</span>
          <ChevronIcon />
        </button>
      )}
      {showDeck && deck && <DonePop deck={deck} onClose={() => setShowDeck(false)} />}
      {!props.open.length && <p className="sh-card-empty">{props.filtered ? "No open tasks in this topic." : "Nothing open. New tasks come from meetings and what people save here."}</p>}
      {mentioned.length > 0 && (
        <div className="sh-task-group">
          <p className="sh-group mentioned" title="Someone tagged you in a comment. Reply on the task or dismiss it there.">
            Mentions you · {mentioned.length}
          </p>
          {list(mentioned)}
        </div>
      )}
      {waiting.length > 0 && (
        <div className="sh-task-group">
          <p className="sh-group waiting" title="A PR or other work is in and needs someone with a say to look">
            Waiting on you · {waiting.length}
          </p>
          {list(waiting)}
        </div>
      )}
      {owners.map((o) => (
        <div key={o || "nobody"} className="sh-task-group by-owner">
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

/** The done pages in a pop-up, paged like the Kickoff card the next meeting opens on. */
/** "@ Joe" after a task's text: who tagged you, with their comment in the pop-up. */
function MentionPill({ mentions }: { mentions: TaskMention[] }) {
  const [latest] = mentions;
  const who = [...new Set(mentions.map((m) => firstName(m.by.split(" via ")[0])))].join(", ");
  return (
    <span className="rc-pill-wrap">
      <span className="rc-pill task-mention" tabIndex={0} aria-label={`${who} mentioned you: “${latest.text}”`}>
        @ {who}
      </span>
      <span className="rc-pop" role="tooltip">
        <span className="rc-pop-crux">“{latest.text.length > 280 ? `${latest.text.slice(0, 279)}…` : latest.text}”</span>
        <span className="rc-pop-meta">
          {latest.by} · {fmtDate(latest.ts)} {fmtTime(latest.ts)}
          {mentions.length > 1 && ` · ${mentions.length} comments`}
        </span>
      </span>
    </span>
  );
}

function DonePop({ deck, onClose }: { deck: DoneDeck; onClose: () => void }) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // A screenshot open over the pages closes first.
      if (e.key === "Escape" && document.querySelectorAll('[role="dialog"][aria-modal="true"]').length < 2) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const none = () => {};
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog done-pop" role="dialog" aria-modal="true" aria-label="Done since the last meeting">
        <button className="icon-btn done-pop-close" aria-label="Close" title="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
        <Opener
          deck={deck}
          followUps={[]}
          meetingStartedAt={0}
          page={page}
          acts={{ onPage: setPage, onState: none, onUndoSaid: none, onClose, onOpen: none }}
          rewound
          label="Done"
        />
      </div>
    </div>
  );
}

/** Start talking, with the kinds of call the space can open behind the arrow beside it. */
function StartMenu(props: {
  label: string;
  review: ReviewView | null;
  designReview: DesignReviewSummary | null;
  /** Idea reviews waiting or in a call, each with its page. */
  ideaReviews: Array<{ id: string; title: string; slides: number; status: string; href: string }>;
  brainstorm: BrainstormSummary | null;
  designHref: string;
  onTalk: () => void;
  onReview: () => void;
  onBrainstorm: () => void;
  onSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const slides = props.review?.slides.length ?? 0;
  const dr = props.designReview;
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className="sh-start" ref={box}>
      <button className="primary sh-join" onClick={props.onTalk}>
        <MicIcon />
        {props.label}
      </button>
      <button className="primary sh-start-more" aria-label="Kinds of call" title="Kinds of call" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon size={11} />
      </button>
      {open && (
        <div className="rp-menu sh-start-menu" role="menu">
          <button type="button" role="menuitem" onClick={pick(props.onTalk)}>
            <strong>Just talk</strong>
          </button>
          <button type="button" role="menuitem" disabled={!slides} onClick={pick(props.onReview)}>
            <strong>Product review</strong>
            <span className="muted">{props.review?.status === "live" ? "on now" : slides ? `${slides} ${slides === 1 ? "slide" : "slides"}` : "nothing to show yet"}</span>
          </button>
          {dr ? (
            <Link role="menuitem" to={props.designHref} onClick={() => setOpen(false)}>
              <strong>Design review</strong>
              <span className="muted">{dr.live ? "on now" : `${dr.specs} ${dr.specs === 1 ? "spec" : "specs"}`}</span>
            </Link>
          ) : (
            <button type="button" role="menuitem" disabled>
              <strong>Design review</strong>
              <span className="muted">no spec waiting</span>
            </button>
          )}
          {props.ideaReviews.slice(0, 3).map((r) => (
            <Link key={r.id} role="menuitem" to={r.href} onClick={() => setOpen(false)}>
              <strong>Idea review</strong>
              <span className="muted xp-idea" dir="auto">
                {r.status === "live" ? "on now" : `${r.slides} ${r.slides === 1 ? "idea" : "ideas"}`} · {r.title}
              </span>
            </Link>
          ))}
          <button type="button" role="menuitem" onClick={pick(props.brainstorm && !props.brainstorm.design ? props.onTalk : props.onBrainstorm)}>
            <strong>Brainstorm</strong>
            {props.brainstorm && !props.brainstorm.design && <span className="muted">on now</span>}
          </button>
          <button type="button" role="menuitem" onClick={pick(props.brainstorm?.design ? props.onTalk : props.onSession)}>
            <strong>Design session</strong>
            {props.brainstorm?.design && <span className="muted">on now</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/** One sentence, a topic or a question, starts a brainstorm. */
export function BrainstormPop(props: { onStart: (prompt: string) => Promise<void>; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        className="dialog brain-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Brainstorm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!prompt.trim() || starting) return;
          setStarting(true);
          await props.onStart(prompt);
          setStarting(false);
        }}
      >
        <h2>Brainstorm</h2>
        <input autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A topic or a question to start from" aria-label="What the brainstorm is about" maxLength={160} dir="auto" />
        <div className="brain-pop-end">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!prompt.trim() || starting}>
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A design session can start blank, or from a sentence on what is being designed; without one the talk names it. It can start from notes or a
 *  diagram instead of a blank board, and its draft spec is saved on a to-do when the call ends. */
export function DesignSessionPop(props: { todos: Array<{ id: string; text: string }>; onStart: (prompt: string, seed: string, taskId: string | null) => Promise<void>; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState("");
  const [taskId, setTaskId] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        className="dialog brain-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Design session"
        onSubmit={async (e) => {
          e.preventDefault();
          if (starting) return;
          setStarting(true);
          await props.onStart(prompt, seed, taskId || null);
          setStarting(false);
        }}
      >
        <h2>Design session</h2>
        <input autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What you're designing (optional)" aria-label="What you're designing" maxLength={160} dir="auto" />
        <textarea
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          rows={5}
          placeholder={"Start from (optional): notes, or a diagram, one line each\nTrial: 14 days free\nTrial -> Paid plan: becomes"}
          aria-label="What to start from"
          maxLength={20000}
          dir="auto"
        />
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="Where the draft spec is saved">
          <option value="">Save the draft spec on a new to-do</option>
          {props.todos.map((t) => (
            <option key={t.id} value={t.id}>
              Save it on: {t.text.length > 70 ? `${t.text.slice(0, 69)}…` : t.text}
            </option>
          ))}
        </select>
        <div className="brain-pop-end">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={starting}>
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A review or brainstorm that ran, as a row that opens its page. */
function KindRow(props: { to: string; name: string; at: number | null; children: React.ReactNode }) {
  return (
    <li className="sh-row">
      <Link to={props.to} className="sh-row-link">
        <span className="sh-icon" aria-hidden>
          <MicIcon />
        </span>
        <span className="sh-row-text">
          <span className="sh-who">{props.name}</span>
          {props.children}
        </span>
        <time className="sh-time">{reviewDay(props.at)}</time>
      </Link>
    </li>
  );
}

/** The next product review's slides, and the button that starts the call on the first one. */
const reviewDay = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

function ReviewPop(props: { roomId: string; review: ReviewView; reviews: ReviewSummary[]; onStart: () => Promise<void>; onRemove: (slideId: string) => void; onClose: () => void }) {
  const { review } = props;
  const [starting, setStarting] = useState(false);
  // A slide's picture, bigger, over this pop-up. Escape closes the picture first.
  const [zoomed, setZoomed] = useState<{ url: string; alt: string } | null>(null);
  useEffect(() => {
    if (zoomed) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props.onClose, zoomed]);
  const live = review.status === "live";
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog review-pop" role="dialog" aria-modal="true" aria-label="Product review">
        <button className="icon-btn done-pop-close" aria-label="Close" title="Close" onClick={props.onClose}>
          <CloseIcon size={16} />
        </button>
        <div className="review-pop-head">
          <h2>Product review</h2>
          <Link className="rp-link" to={reviewHref(props.roomId, "next")}>
            Look through
          </Link>
          <button
            className="primary"
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              await props.onStart();
              setStarting(false);
            }}
          >
            {live ? "Join the review" : starting ? "Starting…" : "Start review"}
          </button>
        </div>
        <div className="review-grid">
          {review.slides.map((s, i) => (
            <div key={s.id} className="review-card">
              {s.shots[0] ? (
                <button type="button" className="review-card-pic" title="See it bigger" aria-label={`See "${s.title}" bigger`} onClick={() => setZoomed({ url: s.shots[0].url, alt: s.shots[0].caption ?? s.title })}>
                  <img src={s.shots[0].url} alt="" loading="lazy" />
                </button>
              ) : (
                <Link className="review-card-pic" to={reviewHref(props.roomId, "next", i + 1)} aria-label={`Open "${s.title}"`}>
                  No picture yet
                </Link>
              )}
              <strong dir="auto">{s.title}</strong>
              <span className="muted">{[s.owner, !s.addedBy || s.addedBy === "Stand" ? null : `added by ${s.addedBy.split(" via ").at(-1)}`].filter(Boolean).join(" · ")}</span>
              {!live && !s.id.startsWith("task:") && (
                <button className="icon-btn review-card-x" aria-label={`Take "${s.title}" off the review`} title="Take off the review" onClick={() => props.onRemove(s.id)}>
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        {props.reviews.length > 0 && (
          <div className="review-earlier">
            <span className="muted">Earlier</span>
            {props.reviews.map((r) => (
              <Link key={r.id} className="rp-pill" to={reviewHref(props.roomId, r.id)}>
                {reviewDay(r.startedAt)}
                <OutcomeCounts outcomes={r.outcomes} />
              </Link>
            ))}
          </div>
        )}
      </div>
      {zoomed && <ShotZoom url={zoomed.url} alt={zoomed.alt} onClose={() => setZoomed(null)} />}
    </div>
  );
}

/** A checked box, as a finished to-do shows. */
const DoneIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
    <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="3.5" fill="currentColor" />
    <path d="M3.8 7.2 6 9.3l4.2-4.6" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type TabKey = "tasks" | "chat" | "meetings" | "decisions";
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
  tasks: ["todo", "question"],
  chat: [],
  meetings: ["meeting", "snap", "jot"],
  decisions: ["decision"],
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
  { key: "tasks", label: "Tasks", icon: <TodoIcon size={14} /> },
  { key: "chat", label: "Chat", icon: <ChatIcon size={14} /> },
  { key: "meetings", label: "Meetings", icon: <MicIcon /> },
  { key: "decisions", label: "Decisions", icon: <DecidedIcon size={14} /> },
];

/** Decisions or open questions across the space's meetings, as the recap lists them. A decision a
 *  later one replaced stays, muted and last, so the change of mind is still on record. */
function PointList(props: {
  topicPicker?: (n: Note) => React.ReactNode;
  kind: "decided" | "question";
  notes: SpaceFeed["decided"];
  empty: string;
  onArchive: (id: string) => void;
  onReplaced?: (id: string, by: string, replaced: boolean) => void;
}) {
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
              {props.topicPicker?.(n)}
              {n.quote && <QuoteMark quote={n.quote} />}
              {n.from && <FromChip from={n.from} />}
              {n.replacedBy && <ReplacedChip by={n.replacedBy} />}
              {n.mayBeReplacedBy && props.onReplaced && <MaybeReplaced by={n.mayBeReplacedBy} onAnswer={(replaced) => props.onReplaced!(n.id, n.mayBeReplacedBy!.noteId, replaced)} />}
            </span>
          </span>
          <CopyForAgent kind={props.kind === "decided" ? "decision" : "question"} id={n.id} />
          <ArchiveButton onClick={() => props.onArchive(n.id)} />
        </li>
      ))}
    </ul>
  );
}

/** On a decision Stand thinks a later one replaced. It stands until someone says so. */
function MaybeReplaced(props: { by: ReplacedBy; onAnswer: (replaced: boolean) => void }) {
  return (
    <span className="sh-maybe-replaced">
      May be replaced by: {props.by.text}
      <button type="button" className="rc-pill" onClick={() => props.onAnswer(true)}>
        Replaced
      </button>
      <button type="button" className="rc-pill" onClick={() => props.onAnswer(false)}>
        Both stand
      </button>
    </span>
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
