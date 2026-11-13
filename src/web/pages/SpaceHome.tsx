import { PersonColors, useColorRegistry, usePersonColors } from "../PersonColors.tsx";
// A space's own page, the one people open between meetings: what came into the space since
// last time (snaps and notes people saved, and meetings), and where the space stands
// (to-dos, decisions, open questions and the suggested agenda). Start talking, on the Meetings tab, turns it into the
// meeting. It shows captures but doesn't make them: snaps and notes come from the Stand bar.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import type { ArchivedKind, ArchivedRow, DoneDeck, FollowUp, Jot, Note, NoteFrom, QuestionSweep, ReplacedBy, ReviewSummary, ReviewView, Snap, SpaceFeed, SpaceSummary, TaskMention } from "../../shared/protocol.ts";
import { activeFirst, matchesProject, projectActivity, type Project } from "../../shared/projects.ts";
import { ProjectPicker } from "../ProjectPicker.tsx";
import { enter, leave, useEnterOnChange, useTabInk } from "../motion.ts";
import { OwnerPicker } from "../OwnerPicker.tsx";
import { MentionText } from "../Mentions.tsx";
import { partsTally, stateOf, withParts } from "../../shared/tasks.ts";
import { ClosedPill, SaidDonePill } from "../TaskMarks.tsx";
import { useWork, workKnown } from "../WorkLog.tsx";
import { api, type RoomInfo } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { FollowUpList, type FollowUpNote } from "../FollowUps.tsx";
import { FromChip, QuoteMark } from "../RecapChapters.tsx";
import { ArchiveIcon, CameraIcon, ChatIcon, ChevronIcon, CloseIcon, EditIcon, GripIcon, LinkIcon, MicIcon, PinIcon, TrashIcon } from "../icons.tsx";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { Avatar } from "../Avatar.tsx";
import { removeSnap } from "../Snaps.tsx";
import { AnswerForm, SweepPop, answeredToast } from "../Questions.tsx";
import { errorToast, toast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";
import { usePhone } from "../phone.ts";
import { fmtDate, fmtTime, fmtDay } from "../util.ts";
import { ModeNote } from "./RoomPage.tsx";
import { brainstormHref } from "./brainstormHref.ts";
import { VerdictCounts, designRecordHref, designReviewHref } from "./DesignReviewPage.tsx";
import { OutcomeCounts, reviewHref } from "./ReviewPage.tsx";
import { ShotZoom } from "../room/ReviewStage.tsx";
import type { DesignReviewRan, DesignReviewSummary } from "../../shared/designReview.ts";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { MOD } from "../shortcuts.ts";
import { SpacesShell } from "./SpacesShell.tsx";
import { TaskDrawer } from "../TaskDrawer.tsx";
import { ChatNotifyBell, SpaceChat, useSpaceChat } from "../SpaceChat.tsx";
import { Opener } from "../room/Opener.tsx";

type Entry =
  | { kind: "snap"; at: number; snap: Snap }
  | { kind: "jot"; at: number; jot: Jot }
  | { kind: "meeting"; at: number; meeting: SpaceFeed["meetings"][number] };

export function SpaceHome(props: { room: RoomInfo; onJoin: (opts?: { muted?: boolean }) => void; reload: () => void }) {
  const { room, reload } = props;
  const colorFor = useColorRegistry(room.id, room.people.map((p) => ({ id: p.name, name: p.name })));
  const { user, caps } = useAuth();
  // What this visit last read shows at once; the fresh read replaces it when it differs.
  const [spaces, setSpaces] = useState<SpaceSummary[] | null>(() => api.last.spaces());
  const [feed, setFeed] = useState<SpaceFeed | null>(() => api.last.feed(room.id));
  const [error, setError] = useState<string | null>(null);
  // On a wide screen chat is a column beside every tab (the dock); on a narrower one it is a tab.
  const wide = useWide();
  const [dockOpen, setDockOpen] = useState(() => {
    try {
      return localStorage.getItem(DOCK_KEY) === "1";
    } catch {
      return false;
    }
  });
  const showDock = (open: boolean) => {
    setDockOpen(open);
    try {
      localStorage.setItem(DOCK_KEY, open ? "1" : "0");
    } catch {}
  };
  // The chat column steps in from the right edge, and back out before it goes.
  const dockRef = useRef<HTMLElement>(null);
  const closeDock = () => void leave(dockRef.current, { x: 12 }, 120).then(() => showDock(false));
  // Each rise puts the cursor in the chat box.
  const [focusChat, setFocusChat] = useState(0);
  // On a wide screen the Projects tab's tools (Pinned, the sweep, its menu) sit in the tab row, not a row of their own.
  const [tabTools, setTabTools] = useState<HTMLSpanElement | null>(null);
  // Someone tags you in chat while it isn't on screen, or from another tab: a toast says so.
  const chatShown = useRef(false);
  const openChat = useRef(() => {});
  const chat = useSpaceChat(room.id, user.id, (m) => {
    if (chatShown.current && document.visibilityState === "visible") return;
    const said = m.text.length > 120 ? `${m.text.slice(0, 119)}…` : m.text;
    toast({ text: `${firstName(m.author)} mentioned you in chat: “${said}”`, action: { label: "Open chat", run: () => openChat.current() }, ms: 10_000 });
  });
  // The snap open big: one on its own, or a note's pictures with the note.
  const [viewing, setViewing] = useState<{ snaps: Snap[]; i: number; jot?: Jot } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // The task open in the drawer, in the URL so a link can open it.
  const [params, setParams] = useSearchParams();
  const openTask = params.get("task");
  // The same function for the life of the page (the router's setter changes with every URL), so the chat
  // thread, which is given it, isn't drawn again each time a project opens.
  const setParamsNow = useRef(setParams);
  setParamsNow.current = setParams;
  const showTask = useCallback((id: string) => setParamsNow.current((prev) => {
    const next = new URLSearchParams(prev); next.set("task", id); next.delete("view"); return next;
  }), []);
  const closeTask = useCallback(() => setParams((prev) => {
    const next = new URLSearchParams(prev); next.delete("task"); next.delete("view"); return next;
  }, { replace: true }), [setParams]);
  // ?project=<id> or ?project=none for Unassigned. Older ?topic= links show everything.
  const projectFilter = params.get("project") ?? "";
  const setParam = (key: string, value: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.delete("topic");
    if (value) next.set(key, value); else next.delete(key);
    return next;
  });
  const setProjectFilter = (value: string) => setParam("project", value);
  // The tab someone last looked at in this space; a new space opens on Tasks, and so does a link to a task.
  const [showReview, setShowReview] = useState(false);
  const [kind, setKind] = useState<"" | "review" | "design" | "brainstorm" | "session">("");
  // Nothing saved: Projects when the space has any, otherwise Tasks.
  const [picked, setTab] = useState<TabKey | "">(() => {
    if (openTask) return "projects";
    if (params.get("project")) return "projects";
    // An older link to "only mine" opens the Mine tab.
    if (params.get("mine") === "1") return "mine";
    try {
      const saved = localStorage.getItem(`stand.spaceTab.${room.id}`);
      // Tasks and Decisions are inside each project now: a saved one of those opens Projects.
      if (saved && TABS.some((t) => t.key === saved)) return saved as TabKey;
    } catch {}
    return "";
  });
  const pickTab = (key: TabKey) => {
    setTab(key);
    try {
      localStorage.setItem(`stand.spaceTab.${room.id}`, key);
    } catch {}
  };
  // A wide screen has no Chat tab: one saved from a narrower screen shows Tasks, with the dock open.
  const home: TabKey = "projects";
  const tab: TabKey = picked === "" || (wide && picked === "chat") ? home : picked;
  // Mine is its own tab: what is yours across every project, with what waits on you first.
  const mine = tab === "mine";
  const docked = wide && dockOpen;
  chatShown.current = wide ? dockOpen : tab === "chat";
  const pickedChat = useRef(picked === "chat");
  useEffect(() => {
    if (wide && pickedChat.current) showDock(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide]);
  pickedChat.current = picked === "chat";
  const toChat = () => {
    if (wide) showDock(true);
    else pickTab("chat");
    setFocusChat((n) => n + 1);
  };
  openChat.current = toChat;
  // ?chat=1, from a notification on the iPhone app: open on the chat.
  const chatLink = params.get("chat") === "1";
  useEffect(() => {
    if (!chatLink) return;
    openChat.current();
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("chat");
      return next;
    }, { replace: true });
  }, [chatLink, setParams]);
  // Command + J opens chat with the cursor in its box, and closes the dock again; typing in the box keeps it.
  const chatKey = useRef(() => {});
  chatKey.current = () => (docked ? closeDock() : toChat());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      chatKey.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The task drawer opens beside the dock when there is room for both.
  useEffect(() => {
    if (!docked) return;
    document.documentElement.dataset.chatDock = "";
    return () => {
      delete document.documentElement.dataset.chatDock;
    };
  }, [docked]);
  // The browser tab says how much is new in this space's chat, so it shows from another tab too.
  useEffect(() => {
    const was = document.title;
    if (chat.unread > 0) document.title = `(${chat.mentions > 0 ? "@" : chat.unread}) ${was.replace(/^\([^)]*\) /, "")}`;
    return () => {
      document.title = was;
    };
  }, [chat.unread, chat.mentions]);

  // "3 min ago" keeps moving while the page sits open: a refresh that brings nothing new no longer
  // draws the page, so this does, once a minute.
  const [, minute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => minute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const opened = useRef(false);
  const load = useCallback(() => {
    // The page that put this one up read the space a moment ago: the first load doesn't read it twice.
    if (opened.current) reload();
    opened.current = true;
    api.feed(room.id).then(
      (f) => {
        setFeed(f);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [room.id, reload]);

  // What Stand catches from the chat is the space's at once: the other tabs show it without waiting for the next poll.
  const caughtNow = chat.thread?.caught.map((c) => c.lines.map((l) => l.id).join(",")).join("|");
  const caughtBefore = useRef(caughtNow);
  useEffect(() => {
    if (caughtBefore.current !== undefined && caughtNow !== caughtBefore.current) load();
    caughtBefore.current = caughtNow;
  }, [caughtNow, load]);

  useEffect(() => {
    load();
    // The other spaces' marks in the nav (new chat, mentions) keep up too.
    const both = () => {
      load();
      api.spaces().then(setSpaces, () => {});
    };
    api.spaces().then(setSpaces, () => {});
    // What others save shows up while the page is open, and when you come back to it.
    const t = setInterval(both, 20_000);
    window.addEventListener("focus", both);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", both);
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
  // The archived rows this page offers to restore.
  const restorable = archived.filter((a) => a.kind in ARCHIVED_KIND);
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
  // A phone asks before it puts you in a call that is already going: who is there, what is on, mic or not.
  const phone = usePhone();
  const [prejoin, setPrejoin] = useState(false);
  const [headMore, setHeadMore] = useState(false);
  const headMoreBox = useDismiss<HTMLSpanElement>(headMore, () => setHeadMore(false));
  const onNow = !live
    ? ""
    : feed?.review?.status === "live"
      ? "Product review on now"
      : feed?.designReview?.live
        ? "Design review on now"
        : (feed?.ideaReviews ?? []).some((r) => r.status === "live")
          ? "Idea review on now"
          : (feed?.brainstorms ?? []).some((b) => b.status === "live")
            ? "Sketching now"
            : "Talking now";
  const talk = () => (phone && live && !wrapping ? setPrejoin(true) : props.onJoin());
  const members = spaces?.find((s) => s.id === room.id)?.people ?? [];
  // The people of the space with their pictures, for the faces on a project's card.
  const [crew, setCrew] = useState(() => api.last.members(room.id));
  useEffect(() => {
    api.members(room.id).then(setCrew, () => {});
  }, [room.id]);
  const pictured = useMemo(() => (crew?.members ?? []).map(({ name, picture }) => ({ name, picture })), [crew]);
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
    projects: (room.projects ?? []).filter((p) => !p.archived).length,
    // Chat counts what you haven't read, not what is there.
    chat: chat.unread,
    // Mine counts what is open and yours.
    mine: [...todos, ...questions].filter((n) => !!n.owner && firstName(n.owner) === firstName(user.name)).length,
  };
  const deck = feed?.doneDeck ?? null;
  // Where each to-do came from, for its pill: the meeting and the chapter, as its recap files it.
  const done = (room.doneFollowUps ?? []).filter((f) => !gone.has(`todo:${f.id}`));
  const closedQuestions = (feed?.closedQuestions ?? []).filter((n) => !gone.has(`question:${n.id}`));

  const projects = room.projects ?? [];
  const filtered = projectProblem(projects, projectFilter);
  const hasProjects = projects.some((p) => !p.archived);
  // The project whose page is open ("none" is Unassigned). A space with no projects is one page of everything.
  const pageOf = !hasProjects ? "none" : filtered ? "" : projectFilter;
  const inProject = (n: Note) => !hasProjects || matchesProject(n.project ?? null, pageOf);
  const shown = params.get("show");
  const show: ProjectShow = shown === "questions" || shown === "decisions" || shown === "done" ? shown : "tasks";
  const projectPicker = (n: Note, own?: boolean) => <ProjectPicker note={n} roomId={room.id} projects={projects} onSaved={load} own={own} />;

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

  // The open project's name, shown after "Projects" in the tab row as the way back.
  const crumb = tab === "projects" && hasProjects && !mine && pageOf ? (pageOf === "none" ? "Unassigned" : (projects.find((x) => x.id === pageOf)?.name ?? null)) : null;

  // Moving around the page: the line under the tabs slides to the one picked, and the panel
  // below comes in. Into a project it comes from the right, and back out to all projects from
  // the left; another tab only rises a few pixels. Data arriving never moves anything here.
  const tabsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useTabInk(tabsRef, `${tab}|${crumb ?? ""}`);
  const view = tab === "projects" && !mine ? `projects|${pageOf}` : tab;
  useEnterOnChange(panelRef, view, (was, now) => {
    const [a, from] = was.split("|");
    const [b, to] = now.split("|");
    if (a === "projects" && b === "projects") return from && !to ? { x: -12 } : { x: 12 };
    return { y: 4 };
  });
  // On Meetings, another kind (All, Product reviews, Brainstorms…) fades its list in; the pills and
  // the Start button stay put.
  const shownKind = useRef(kind);
  useLayoutEffect(() => {
    if (shownKind.current === kind) return;
    shownKind.current = kind;
    for (const el of panelRef.current?.children ?? []) if (!el.classList.contains("sh-meet-bar")) enter(el, {}, 140);
  }, [kind]);
  useEnterOnChange(dockRef, docked, (_, open) => (open ? { x: 12 } : null), 200);

  return (
  <PersonColors.Provider value={colorFor}>
    <SpacesShell spaces={spaces && spaces.map((s) => (s.id === room.id ? { ...s, unread: chat.unread, chatMentions: chat.mentions } : s))}>
      <main className={["sh-main", phone && live && !wrapping && "is-live", tab === "chat" && "on-chat"].filter(Boolean).join(" ")}>
        {/* A fixed top of the page: only the lists under it scroll. On a phone the page scrolls and only the tabs stay. */}
        <div className="sh-top">
        <header className="sh-head">
          <h1 title={room.purpose || undefined}>{room.name}</h1>
          <span className="sh-head-end">
            {/* A call that is on is the one thing here that asks to be acted on, on every tab. */}
            {live && (
              <button
                type="button"
                className={wrapping ? "sh-live wrapping" : "sh-live"}
                onClick={talk}
                title={wrapping ? "Nobody's in the meeting now. It ends by itself in about 2 minutes unless someone joins." : "Join the call"}
              >
                <span className="dot" />
                {wrapping ? "Wrapping up" : "Talking now"}
                <strong>Join</strong>
              </button>
            )}
            {/* Who is here, and everything about the space that isn't its work, behind the faces. */}
            <span className="sh-head-more" ref={headMoreBox}>
              <button
                type="button"
                className="sh-people"
                aria-label="People and invite"
                aria-haspopup="menu"
                aria-expanded={headMore}
                title={phone ? undefined : faces.map((f) => f.name).join(", ")}
                onClick={() => setHeadMore(!headMore)}
              >
                {!phone && faces.length > 0 ? (
                  <span className="sh-faces stack">
                    {faces.slice(0, 4).map((p, i) => (
                      <Avatar key={i} id={p.name} name={p.name} picture={p.picture} size={24} />
                    ))}
                    {faces.length > 4 && <span className="sh-faces-more">+{faces.length - 4}</span>}
                  </span>
                ) : (
                  "···"
                )}
              </button>
              {headMore && (
                <div className="rp-menu sh-head-menu" role="menu">
                  {room.purpose && <p className="muted">{room.purpose}</p>}
                  {faces.length > 0 && (
                    <ul className="sh-head-people">
                      {faces.map((p, i) => (
                        <li key={i}>
                          <Avatar id={p.name} name={p.name} picture={p.picture} size={20} />
                          {p.name}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" role="menuitem" onClick={copy}>
                    <LinkIcon />
                    {copied ? "Link copied" : "Copy invite link"}
                  </button>
                  {/* What was archived is out of the way here, not at the foot of every tab. */}
                  {restorable.length > 0 && (
                    <button type="button" role="menuitem" onClick={() => { setHeadMore(false); setShowArchived(true); }}>
                      <ArchiveIcon />
                      Archived
                      <span className="count">{restorable.length}</span>
                    </button>
                  )}
                  {phone && !live && (
                    <button type="button" role="menuitem" onClick={() => { setHeadMore(false); talk(); }}>
                      <MicIcon />
                      Start talking
                    </button>
                  )}
                  <ModeNote caps={caps} />
                </div>
              )}
            </span>
            {wide && (
              <button
                className={docked ? "sh-invite sh-chat-toggle on" : "sh-invite sh-chat-toggle"}
                aria-pressed={docked}
                aria-label="Chat"
                onClick={() => (docked ? closeDock() : toChat())}
                title={`${docked ? "Hide" : "Show"} chat (${CHAT_SHORTCUT})`}
              >
                <ChatIcon size={15} />
                {!docked && <ChatMarks unread={chat.unread} mentions={chat.mentions} />}
              </button>
            )}
          </span>
        </header>

        <div className="sh-tabs" role="tablist" aria-label="The space" ref={tabsRef}>
          {TABS.filter((t) => !(wide && t.key === "chat")).map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? `sh-tab ${t.key} on` : `sh-tab ${t.key}`}
              title={t.key === "projects" && crumb ? "All projects" : undefined}
              onClick={() => {
                // Projects again, from inside one project, goes back to all of them.
                if (t.key === "projects" && tab === "projects" && projectFilter) setProjectFilter("");
                pickTab(t.key);
              }}
            >
              {t.icon}
              {/* Inside a project the tab is the trail back: "Projects › its name". */}
              {t.key === "projects" && crumb && <span className="sh-crumb-back" aria-hidden><ChevronIcon size={11} /></span>}
              {t.label}
              {t.key === "chat" ? (
                <ChatMarks unread={chat.unread} mentions={chat.mentions} />
              ) : t.key === "projects" && crumb ? (
                <span className="sh-crumb" dir="auto" title={projects.find((x) => x.id === pageOf)?.goal ?? undefined}>
                  <ChevronIcon size={11} />
                  {crumb}
                </span>
              ) : (
                counts[t.key] > 0 && <span className="count">{counts[t.key]}</span>
              )}
            </button>
          ))}
          {!phone && (tab === "projects" || mine) && <span className="sh-tab-tools" ref={setTabTools} />}
          {tab === "chat" && <span className="sh-chat-bell"><ChatNotifyBell roomId={room.id} /></span>}
        </div>
        </div>
        {/* The lists scroll in here, under the header, which is a fixed part of the page. */}
        <div className={tab === "chat" ? "sh-body chat" : "sh-body"} onScroll={(e) => e.currentTarget.previousElementSibling?.classList.toggle("over", e.currentTarget.scrollTop > 2)}>

        {showReview && feed?.review && (
          <ReviewPop roomId={room.id} review={feed.review} reviews={reviews} onStart={startReview} onRemove={removeSlide} onClose={() => setShowReview(false)} />
        )}

        <section
          ref={panelRef}
          className={tab === "projects" || mine ? "sh-panel tasks projects" : `sh-panel ${tab}`}
          role="tabpanel"
          // The name column is as wide as the longest meeting name on the list, so short names keep their numbers close.
          style={tab === "meetings" ? ({ "--sh-mname": `${Math.max(10, ...meetings.map((m) => (m.title ?? kindOf.get(m.id)?.name ?? "Meeting").length)) * 0.56 + 1}em` } as React.CSSProperties) : undefined}
        >
          {tab === "chat" && <SpaceChat roomId={room.id} name={room.name} me={user} chat={chat} onOpenTask={showTask} focus={focusChat} />}
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
              {/* Starting a call lives with the calls: here, and on the mic beside the space's name in the sidebar. */}
              <div className="sh-meet-bar">
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
                <StartMenu
                  label={wrapping ? "Join" : live ? "Join them" : "Start talking"}
                  review={feed?.review ?? null}
                  designReview={feed?.designReview ?? null}
                  ideaReviews={(feed?.ideaReviews ?? []).filter((r) => r.status !== "done").map((r) => ({ ...r, href: reviewHref(room.id, r.id) }))}
                  designHref={designReviewHref(room.id)}
                  onTalk={talk}
                  onReview={() => setShowReview(true)}
                />
              </div>
              {kind && (
                <ul className="sh-rows">
                  {kind === "review" &&
                    reviews.map((r) => (
                      <KindRow key={r.id} to={reviewHref(room.id, r.id)} name="Product review" at={r.startedAt}>
                        <span className="sh-what" dir="auto">{reviewName(r.titles ?? [], r.slides)}</span>
                        <span className="sh-what sh-count muted">{r.slides} {r.slides === 1 ? "slide" : "slides"}</span>
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
                <div key={d.label} className={d.label === "Today" ? "sh-day today" : "sh-day"}>
                  {/* A phone has room for a short day only. */}
                  <h3>
                    <span className="sh-day-long">{d.label}</span>
                    <span className="sh-day-short">{d.label === "Today" ? d.label : fmtDay(d.entries[0].at)}</span>
                  </h3>
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

          {(tab === "projects" || mine) && (
            <TasksTab
              key={mine ? "mine" : "projects"}
              mode={mine ? "tasks" : "projects"}
              roomId={room.id}
              me={user.name}
              people={members}
              pictured={pictured}
              deck={null}
              sweep={feed?.questionSweep ?? null}
              open={[...todos, ...questions].filter(mine ? () => true : inProject)}
              closed={[...done, ...closedQuestions].filter(mine ? () => true : inProject)}
              all={[...todos, ...questions, ...done, ...closedQuestions]}
              mentions={feed?.mentions ?? []}
              projectPicker={projectPicker}
              projects={projects}
              projectFilter={mine ? "" : pageOf}
              solo={!hasProjects}
              loose={decisions.some((n) => !n.replacedBy && matchesProject(n.project ?? null, "none"))}
              onProject={(id) => {
                // A project opened from Mine shows on the Projects tab.
                if (mine) pickTab("projects");
                setProjectFilter(id);
              }}
              pinned={room.pinnedProjects ?? []}
              show={show}
              onShow={(v) => setParam("show", v === "tasks" ? "" : v)}
              decisionCount={decisions.filter((n) => !n.replacedBy && inProject(n)).length}
              decisions={
                <>
                  <PointList
                    kind="decided"
                    notes={decisions.filter(inProject)}
                    projectPicker={projectPicker}
                    empty="No decisions yet."
                    onArchive={(id) => archive(`decision:${id}`)}
                    onReplaced={(id, by, replaced) => void api.confirmReplaced(room.id, id, by, replaced).then(load, errorToast("Couldn't save that"))}
                  />
                  {pageOf === "none" && context.length > 0 && (
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
              }
              mine={mine}
              onMine={(on) => pickTab(on ? "mine" : "projects")}
              toolsIn={phone ? null : tabTools}
              onArchive={(n) => archive(`${n.kind === "question" ? "question" : "todo"}:${n.id}`)}
              reload={load}
              openId={openTask}
              onOpen={showTask}
            />
          )}

        </section>
        {showArchived && <ArchivedPop rows={restorable} onRestore={restore} onClose={() => setShowArchived(false)} />}
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
                {projectPicker(n)}
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
            onListChange={load}
          />
        )}
        </div>
        {phone && live && !wrapping && tab !== "chat" && !prejoin && (
          <div className="sh-joinbar">
            <span className="sh-live">
              <span className="dot" />
              {onNow}
            </span>
            <span className="sh-faces stack">
              {room.people.slice(0, 3).map((p, i) => (
                <Avatar key={i} id={p.name} name={p.name} picture={p.picture} size={24} />
              ))}
              {room.people.length > 3 && <span className="sh-faces-more">+{room.people.length - 3}</span>}
            </span>
            <button className="primary sh-join" onClick={() => setPrejoin(true)}>
              Join
            </button>
          </div>
        )}
        {prejoin && (
          <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPrejoin(false)}>
            <div className="sh-prejoin" role="dialog" aria-modal="true" aria-label="Join the call">
              <strong>{onNow}</strong>
              <ul className="sh-prejoin-people">
                {room.people.map((p, i) => (
                  <li key={i}>
                    <Avatar id={p.name} name={p.name} picture={p.picture} size={28} />
                    {p.name}
                  </li>
                ))}
              </ul>
              <div className="sh-prejoin-go">
                <button className="primary" onClick={() => props.onJoin()}>
                  <MicIcon />
                  Join
                </button>
                <button onClick={() => props.onJoin({ muted: true })}>Join muted</button>
              </div>
              <button className="link muted" onClick={() => setPrejoin(false)}>
                Not now
              </button>
            </div>
          </div>
        )}
      </main>
      {docked && (
        <aside className="sh-dock" aria-label="Chat" ref={dockRef}>
          <div className="sh-dock-head">
            <strong>Chat</strong>
            <ChatNotifyBell roomId={room.id} />
            <button className="icon-btn" aria-label="Close chat" title={`Close chat (${CHAT_SHORTCUT})`} onClick={closeDock}>
              <CloseIcon />
            </button>
          </div>
          <SpaceChat roomId={room.id} name={room.name} me={user} chat={chat} onOpenTask={showTask} focus={focusChat} />
        </aside>
      )}
    </SpacesShell>
  </PersonColors.Provider>
  );
}

/** A project filter from a link to a project that is gone: it filters nothing. */
function projectProblem(projects: Project[], filter: string) {
  return !!filter && filter !== "none" && !projects.some((p) => p.id === filter);
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
      <time className="sh-time">{fmtTime(snap.ts)}</time>
      <button className="sh-thumb" onClick={props.onOpen} aria-label="Open the snap">
        <img src={snap.url} alt="" loading="lazy" />
      </button>
      <span className="sh-row-text">
        <span className="sh-who">{who}</span>
        {snap.line ? (
          <span className="sh-what">{snap.line}</span>
        ) : snap.caption ? (
          <span className="sh-what agent">{snap.caption}</span>
        ) : (
          <span className="sh-what muted">Snap</span>
        )}
      </span>
      <ItemPill of={snap} room={props.room} onPick={props.onPick} />
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
      <time className="sh-time">{fmtTime(jot.ts)}</time>
      {snaps.length > 0 && (
        <button
          className="sh-thumb"
          onClick={props.onOpen}
          aria-label={snaps.length > 1 ? `Open its ${snaps.length} snaps` : "Open its snap"}
        >
          <img src={snaps[0].url} alt="" loading="lazy" />
          {snaps.length > 1 && <span className="sh-thumb-more">+{snaps.length - 1}</span>}
        </button>
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
            <MentionText text={jot.text} />
          </button>
        ) : (
          <span className="sh-what"><MentionText text={jot.text} /></span>
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

/**
 * A meeting, on the same lines as every other row: when, what kind and how long, then what came out
 * of it in three columns that line up down the list (to-dos, open questions, decisions), then the
 * page it left behind. No mark of its own: its name says what kind it was.
 */
function MeetingRow({ m, kind, onArchive }: { m: SpaceFeed["meetings"][number]; kind?: { name: string; open: string; to: string }; onArchive: () => void }) {
  const minutes = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  // In the tabs' order and colors. A kind with nothing keeps its column, empty.
  const counts = [
    { n: m.todos, kind: "todo", Icon: TodoIcon, label: plural(m.todos, "to-do") },
    { n: m.open, kind: "question", Icon: QuestionIcon, label: plural(m.open, "open question") },
    { n: m.decided, kind: "decided", Icon: DecidedIcon, label: plural(m.decided, "decision") },
  ];
  return (
    <li className="sh-row">
      <Link to={`/meetings/${m.id}`} className="sh-row-link" title={m.summary ?? undefined}>
        <time className="sh-time">{fmtTime(m.endedAt)}</time>
        <span className="sh-row-text">
          <span className="sh-who sh-mname">{m.title ?? kind?.name ?? "Meeting"}</span>
          <span className="sh-what sh-len muted">{minutes} min</span>
        </span>
        <span className="sh-counts">
          {counts.map(({ n, kind, Icon, label }) =>
            n > 0 ? (
              <span key={kind} className={`sh-count ${kind}`} title={label} aria-label={label}>
                <Icon size={13} />
                {n}
              </span>
            ) : (
              <span key={kind} className="sh-count" aria-hidden />
            ),
          )}
        </span>
      </Link>
      <span className="sh-end">
        {kind && (
          <Link className="rp-pill" to={kind.to}>
            {kind.open}
          </Link>
        )}
      </span>
      <ArchiveButton onClick={onArchive} />
    </li>
  );
}

type TaskNote = FollowUpNote & { from?: NoteFrom; answeredBy?: string };

/**
 * Everything still to do in the space, by project. The first view is the projects themselves, a row
 * each: what is moving, who is on it and how far along it is, under the tasks that wait on you (a
 * comment that tags you, a PR reported ready). A row opens that project's own view: its to-dos (Do)
 * and open questions (Answer) by where they stand, then its folded Done and Dropped. A space with no
 * projects is one plain list. Anyone can tick a task
 * off, drop it or reopen it, with Undo. An open question takes an answer under its line, and the
 * sweep closes the ones Stand proposed and someone confirms (Questions.tsx).
 */
function TasksTab(props: {
  /** Projects: the projects as cards, and one project's page. Tasks: every task in one list, by person. */
  mode: "projects" | "tasks";
  projectPicker: (n: Note, own?: boolean) => React.ReactNode;
  projects: Project[];
  /** "" for all, "none" for Unassigned, or one project's id. */
  projectFilter: string;
  /** Opens one project's view ("none" for Unassigned), or goes back to the list of projects (""). */
  onProject: (filter: string) => void;
  /** The projects the person looking pinned: theirs alone, first on the list and open. */
  pinned: string[];
  /** How many kept decisions each project has, by id: the project's view links to them. */
  /** The decisions of the project whose page is open, as their list. */
  decisions: React.ReactNode;
  decisionCount: number;
  /** Which kind a project's page lists, and how to change it. */
  show: ProjectShow;
  onShow: (show: ProjectShow) => void;
  /** A space with no projects: one page of everything, with no project line over it. */
  solo: boolean;
  /** There are decisions in no project, so Unassigned has something to show even with no open work. */
  loose: boolean;
  /** Only the tasks of the person looking (?mine=1). */
  mine: boolean;
  onMine: (on: boolean) => void;
  /** Where its tools go instead of a row above the list: the tab row, on a wide screen. */
  toolsIn?: HTMLElement | null;
  roomId: string;
  me: string;
  /** The space's people, by name: who a to-do can be given to. */
  people: string[];
  /** The same people with their pictures, where they have one. */
  pictured: Array<{ name: string; picture: string | null }>;
  /** What got done since the last meeting, as the next meeting's Kickoff card shows it. */
  deck: DoneDeck | null;
  /** The open questions Stand's last sweep proposes to close. */
  sweep: QuestionSweep | null;
  open: TaskNote[];
  closed: TaskNote[];
  /** Every task of the space, whatever the filters: where a part finds its parent, and a parent its parts. */
  all: TaskNote[];
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
  // On a wide screen an open project's Tasks / Questions / Decisions / Done pills sit in its own row,
  // before its counts, so the page has one rule under the tabs and no second one.
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  // Another pill brings its list in with a quick fade; the pills themselves stay put.
  const pageRef = useRef<HTMLElement>(null);
  const shown = useRef(props.show);
  useLayoutEffect(() => {
    if (shown.current === props.show) return;
    shown.current = props.show;
    for (const el of pageRef.current?.children ?? []) if (!el.classList.contains("pj-views")) enter(el, {}, 140);
  }, [props.show]);
  const [adding, setAdding] = useState(false);
  const phone = usePhone();
  // Your own pins. A click shows at once and saves behind it.
  const [pins, setPins] = useState(() => new Set(props.pinned));
  useEffect(() => setPins(new Set(props.pinned)), [props.pinned.join()]);
  const togglePin = (id: string) => {
    const on = !pins.has(id);
    setPins((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    api.pinProject(props.roomId, id, on).then(props.reload, (err) => {
      setPins(new Set(props.pinned));
      errorToast(on ? "Couldn't pin it" : "Couldn't unpin it")(err);
    });
  };
  // What this browser remembers of the list: the projects someone opened or shut by hand (a pinned
  // one starts open, the others shut), and whether only the pinned ones show.
  const viewKey = `stand.projectView.${props.roomId}`;
  const [view, setView] = useState<{ open: Record<string, boolean>; onlyPinned: boolean }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(viewKey) ?? "{}");
      return { open: saved.open ?? {}, onlyPinned: saved.onlyPinned === true };
    } catch {
      return { open: {}, onlyPinned: false };
    }
  });
  const saveView = (next: typeof view) => {
    setView(next);
    try {
      localStorage.setItem(viewKey, JSON.stringify(next));
    } catch {}
  };
  const onlyPinned = view.onlyPinned && pins.size > 0;
  // The tasks that wait on you sit behind a pill, so the projects come first.
  // The open question someone is writing an answer to.
  const [answering, setAnswering] = useState<string | null>(null);
  // The sweep someone has open, as it was when they opened it.
  const [sweeping, setSweeping] = useState<QuestionSweep | null>(null);
  const { sweep } = props;
  const asked = props.open.filter((n) => n.kind === "question").length;
  const me = firstName(props.me);
  const isMine = (n: Note) => !!n.owner && firstName(n.owner) === me;
  const open = props.mine ? props.open.filter(isMine) : props.open;
  const closed = props.mine ? props.closed.filter(isMine) : props.closed;
  const workIds = open.filter((n) => n.kind === "action").map((n) => n.id);
  const work = useWork(workIds);
  // The cards are ordered by who is working on what, which is read after the page is up. On the first
  // look of a visit they wait for it (under a second at most), so they are drawn once, in their final order.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 800);
    return () => clearTimeout(t);
  }, []);
  const settled = waited || workKnown(workIds);
  // The comments that tag you, per task: newest first, so [0] is the latest.
  const tagged = new Map<string, TaskMention[]>();
  for (const m of props.mentions) tagged.set(m.noteId, [...(tagged.get(m.noteId) ?? []), m]);
  const mentioned = open.filter((n) => tagged.has(n.id)).sort((a, b) => tagged.get(b.id)![0].ts - tagged.get(a.id)![0].ts);
  const waiting = open.filter((n) => work[n.id]?.ready && !tagged.has(n.id));
  const rest = open.filter((x) => !work[x.id]?.ready && !tagged.has(x.id));
  // How the sections are ordered, kept in this browser: by what is going on, or the team's order.
  const sortKey = `stand.projectSort.${props.roomId}`;
  const [sort, setSort] = useState<"active" | "team">(() => {
    try {
      return localStorage.getItem(sortKey) === "team" ? "team" : "active";
    } catch {
      return "active";
    }
  });
  const pickSort = (value: "active" | "team") => {
    setSort(value);
    try {
      localStorage.setItem(sortKey, value);
    } catch {}
  };
  // The space's one order of projects, most important first. A move shows at once and saves behind it.
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => setOrder(null), [props.projects]);
  const projects = order ? order.map((id) => props.projects.find((p) => p.id === id)).filter((p): p is Project => !!p) : props.projects;
  const moveProject = (id: string, to: number) => {
    const ids = projects.map((p) => p.id).filter((x) => x !== id);
    const at = Math.max(0, Math.min(to, ids.length));
    if (projects[at]?.id === id) return;
    ids.splice(at, 0, id);
    setOrder(ids);
    api.updateProject(props.roomId, id, { position: at }).then(props.reload, (err) => {
      setOrder(null);
      errorToast("Couldn't move the project")(err);
    });
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const dropOn = (target: string, after: boolean) => {
    if (!dragging || dragging === target) return;
    const ids = projects.map((p) => p.id).filter((x) => x !== dragging);
    moveProject(dragging, ids.indexOf(target) + (after ? 1 : 0));
  };
  // One row per project, in the list's order; then Unassigned. A project with nothing open stays
  // until someone archives it, and an archived one shows only while something open is in it.
  const known = (id: string | null | undefined) => (id && projects.some((p) => p.id === id) ? id : "");
  const group = (notes: TaskNote[]) => {
    const out = new Map<string, TaskNote[]>();
    for (const n of notes) out.set(known(n.project), [...(out.get(known(n.project)) ?? []), n]);
    return out;
  };
  const openIn = group(open);
  const doneIn = group(closed.filter((n) => stateOf(n) !== "dropped"));
  const readyIn = group(waiting);
  const inView = projects.filter((p) => (!p.archived || openIn.has(p.id)) && (!props.mine || openIn.has(p.id)));
  // Active first: projects with work in progress, then where the newest to-dos are. Team order: the list's own.
  const activity = projectActivity(
    open
      .filter((n) => n.kind === "action")
      .map((n) => ({ project: n.project, ts: n.ts, inProgress: stateOf(n, work[n.id]) === "doing", reportedAt: work[n.id]?.log[0]?.ts })),
  );
  const ordered = sort === "active" ? activeFirst(inView, activity) : inView;
  const holding: React.CSSProperties | undefined = sort === "active" && !settled ? { opacity: 0 } : undefined;
  // Your pinned projects first, then the others; or the pinned ones alone.
  const sections = [...ordered.filter((p) => pins.has(p.id)), ...(onlyPinned ? [] : ordered.filter((p) => !pins.has(p.id)))];
  const firstUnpinned = pins.size > 0 ? sections.find((p) => !pins.has(p.id))?.id : undefined;
  // One project's view, the list of projects, or with no projects at all one plain list.
  const plain = props.mode === "tasks";
  const viewing = plain ? null : props.projectFilter === "none" ? "" : props.projectFilter || null;
  const canSort = !plain && viewing === null && sections.length > 1;
  const canOrder = canSort && sort === "team";
  /** Up or down past the next project in view. */
  const nudge = (id: string, dir: -1 | 1) => {
    const next = sections[sections.findIndex((p) => p.id === id) + dir];
    if (!next) return;
    const ids = projects.map((p) => p.id).filter((x) => x !== id);
    moveProject(id, ids.indexOf(next.id) + (dir > 0 ? 1 : 0));
  };
  const unassigned = openIn.get("") ?? [];
  const done = closed.filter((n) => stateOf(n) !== "dropped");
  const dropped = closed.filter((n) => stateOf(n) === "dropped");
  const nameOf = (id: string | null | undefined) => props.projects.find((p) => p.id === id)?.name ?? null;
  const byId = new Map(props.all.map((n) => [n.id, n]));
  const parts = partsTally(props.all);
  /** The to-do a task is a part of, when the space still has it. */
  const partOf = (n: TaskNote) => (n.parentId && n.parentId !== n.id ? byId.get(n.parentId) : undefined);
  // A to-do's parts stay folded under it until its parts pill is clicked.
  const [partsOpen, setPartsOpen] = useState<Set<string>>(() => new Set());
  const toggleParts = (id: string) =>
    setPartsOpen((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const partFolded = (n: TaskNote) => {
    const seen = new Set<string>();
    for (let p = partOf(n); p && !seen.has(p.id); p = partOf(p)) {
      if (!partsOpen.has(p.id)) return true;
      seen.add(p.id);
    }
    return false;
  };

  const move = (n: Note, state: "done" | "dropped" | "open") =>
    api.setTask(props.roomId, n.id, { state }).then(
      (saved) => {
        props.reload();
        if (state !== "open")
          toast({
            text: state === "dropped" ? "Dropped" : n.kind === "question" ? "Closed without an answer" : "Done",
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

  /** Who owns a row, as their face: it takes less of the row than a name, and the name is its tooltip. */
  const face = (n: TaskNote) =>
    n.owner ? (
      <span className="row-face" title={`${n.owner}${n.doneAt && n.doneBy ? ` · ${n.state === "dropped" ? "dropped" : "done"} by ${n.doneBy}` : ""}`}>
        <Avatar id={n.owner} name={n.owner} picture={props.pictured.find((x) => x.name === n.owner || firstName(x.name) === firstName(n.owner!))?.picture ?? null} size={20} />
        <span className="rc-name">{firstName(n.owner)}</span>
      </span>
    ) : (
      <span className="rc-face none" title={n.kind === "question" ? "Anyone" : "Unassigned"}>
        ?
      </span>
    );
  // `section` is the project the rows sit under ("" for Unassigned); undefined outside a project section.
  // A row under its own project doesn't repeat the project's name: it shows, with the date, on hover.
  // `under` is the rows that sit below their parent. A part anywhere else names its parent instead.
  const list = (notes: TaskNote[], closed = false, section?: string, under?: Set<string>) => (
    <FollowUpList
      oneLine
      stateInBox
      notes={notes}
      openId={props.openId}
      onOpen={(n) => props.onOpen(n.id)}
      onToggle={(n, d) => move(n, d ? "done" : "open")}
      rowClass={(n) => (under?.has(n.id) ? (partFolded(n) ? "part folded" : "part") : undefined)}
      below={(n) =>
        !closed &&
        answering === n.id && (
          <AnswerForm
            roomId={props.roomId}
            note={n}
            onCancel={() => setAnswering(null)}
            onDone={(done) => {
              setAnswering(null);
              props.reload();
              answeredToast(props.roomId, done, props.reload);
            }}
          />
        )
      }
      after={(n: TaskNote) => (
        <>
          {!closed && tagged.has(n.id) && <MentionPill mentions={tagged.get(n.id)!} />}
          {parts.has(n.id) && <PartsPill {...parts.get(n.id)!} open={under ? partsOpen.has(n.id) : undefined} onToggle={() => toggleParts(n.id)} />}
          {!under?.has(n.id) && partOf(n) && (
            <button type="button" className="task-part-of" title={`Part of: ${partOf(n)!.text}`} onClick={() => props.onOpen(partOf(n)!.id)}>
              Part of: {partOf(n)!.text}
            </button>
          )}
          {!quietProject(n, section) && props.projectPicker(n, section !== undefined && section !== "" && n.project === section)}
          {n.kind === "question" &&
            (closed ? (
              !n.answeredBy && <span className="task-verb">Answer</span>
            ) : (
              <button
                type="button"
                className="task-verb task-answer"
                aria-expanded={answering === n.id}
                title="Write the answer. Stand keeps it as a decision and closes the question."
                onClick={() => setAnswering(answering === n.id ? null : n.id)}
              >
                Answer
              </button>
            ))}
          {n.saidDone && !n.doneAt && <SaidDonePill quote={n.saidDone} onUndo={() => notSaid(n)} />}
          
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
        </>
      )}
      noCopy
      tail={(n: TaskNote) => (
        <>
          {/* The row is its box, its title and its owner. What can be done to it waits behind one button;
              where it came from and its project are in the task itself, a click away. */}
          <RowMore>
            {!closed && (
              <button type="button" role="menuitem" onClick={() => void move(n, "dropped")}>
                <CloseIcon />
                Drop
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => props.onArchive(n)}>
              <ArchiveIcon />
              Archive
            </button>
            <CopyForAgent kind={n.kind === "question" ? "question" : "action"} id={n.id} label />
          </RowMore>
          {/* On Mine every row is yours, so your own face says nothing there; someone else's still shows. */}
          {props.mine && isMine(n) ? null : n.kind === "action" ? (
            <OwnerPicker note={n} roomId={props.roomId} people={props.people} me={props.me} onSaved={props.reload}>
              {face(n)}
            </OwnerPicker>
          ) : (
            face(n)
          )}
        </>
      )}
    />
  );

  /** The project pill moves off the row (to its hover line) when the row sits under that same project,
   *  or has none yet. A project Stand only suggests stays, since it asks to be confirmed. */
  const quietProject = (n: TaskNote, section: string | undefined) =>
    !n.projectSuggested && (!n.project || (section !== undefined && (n.project === section || (section === "" && !projects.some((p) => p.id === n.project)))));

  /** Open tasks by who has them: you first, then the others by how many they have, then nobody. */
  const ownerGroups = (notes: TaskNote[]) => {
    const groups = new Map<string, TaskNote[]>();
    for (const n of notes) {
      const k = n.owner ? firstName(n.owner) : "";
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
    const rank = (k: string) => (k === me ? 0 : k === "" ? 2 : 1);
    const owners = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
    return owners.map((o) => ({ key: o, notes: groups.get(o)! }));
  };
  /** Rows grouped by who has them; the row's own face says who, so a small gap stands in for a
   *  heading per person. A to-do's parts stay under it, in its owner's group. */
  type Family = { note: TaskNote; parts: TaskNote[] };
  const byOwner = (families: Family[], section: string) => {
    const partsOf = new Map(families.map((f) => [f.note.id, f.parts]));
    const under = new Set(families.flatMap((f) => f.parts.map((p) => p.id)));
    return ownerGroups(families.map((f) => f.note)).map((g) => (
      <div key={g.key || "nobody"} className="sh-task-group by-owner">
        {list(
          g.notes.flatMap((n) => [n, ...(partsOf.get(n.id) ?? [])]),
          false,
          section,
          under,
        )}
      </div>
    ));
  };
  /** A project's open work by where it stands: what someone is on, what waits, what is still asked. */
  const byState = (notes: TaskNote[], section: string) => {
    const families = withParts(notes);
    const ready = (f: Family) => !!work[f.note.id]?.ready;
    const doing = (f: Family) => f.note.kind === "action" && !ready(f) && stateOf(f.note, work[f.note.id]) === "doing";
    // One list of to-dos, furthest along first: a row's own pill says where it stands, so no heading per state.
    const todo = (f: Family) => f.note.kind === "action";
    const fs = [...families.filter(ready), ...families.filter(doing), ...families.filter((f) => todo(f) && !ready(f) && !doing(f)), ...families.filter((f) => !todo(f))];
    if (!fs.length) return null;
    return (
      <div className="sh-task-group pj-state to-dos">
        {list(fs.flatMap((f) => [f.note, ...f.parts]), false, section, new Set(fs.flatMap((f) => f.parts.map((p) => p.id))))}
      </div>
    );
  };
  /** Who has a project's open work, as their faces: a picture where they have one, else their initials
   *  on their own colour. The counts are in each face's tooltip. */
  const ownerFaces = (notes: TaskNote[]) => {
    const groups = ownerGroups(notes).filter((g) => g.key);
    const person = (owner: string) => props.pictured.find((m) => m.name === owner) ?? props.pictured.find((m) => firstName(m.name) === firstName(owner));
    return (
      <span className="pj-faces">
        {groups.slice(0, 5).map((g) => {
          const owner = g.notes[0].owner!;
          const who = person(owner);
          return (
            <span key={g.key} className="pj-face" title={`${g.key === me ? "You" : (who?.name ?? owner)} · ${g.notes.length}`}>
              <Avatar id={who?.name ?? owner} name={who?.name ?? owner} picture={who?.picture} size={22} />
            </span>
          );
        })}
        {groups.length > 5 && <span className="pj-faces-more">+{groups.length - 5}</span>}
      </span>
    );
  };
  /** What a project's line shows, from the tasks in view. */
  const lineOf = (id: string) => ({
    open: openIn.get(id)?.length ?? 0,
    done: doneIn.get(id)?.length ?? 0,
    ready: readyIn.get(id)?.length ?? 0,
    inProgress: doingIn(id).length,
    owners: openIn.has(id) && ownerFaces(openIn.get(id)!),
  });
  /** What someone is on now in a project, the latest report first. */
  const doingIn = (id: string) =>
    (openIn.get(id) ?? [])
      .filter((n) => n.kind === "action" && !work[n.id]?.ready && stateOf(n, work[n.id]) === "doing")
      .sort((a, b) => (work[b.id]?.log[0]?.ts ?? b.ts) - (work[a.id]?.log[0]?.ts ?? a.ts));
  /** The row's answer to "what is being worked on": the newest of them, by name, with who has it. */
  const nowOf = (id: string) => {
    const [first, ...more] = doingIn(id);
    return first ? { text: first.text, face: face(first), more: more.length, onOpen: () => props.onOpen(first.id) } : undefined;
  };

  const grid = !phone;
  /** One project in the list: a card on a wide screen, a row that opens in place on a phone. */
  const projectSection = (p: Project) => {
    const i = sections.indexOf(p);
    const drop = dropAt?.id === p.id && dragging !== p.id ? (dropAt.after ? " drop-after" : " drop-before") : "";
    return (
      <section
        key={p.id}
        aria-label={p.name}
        className={`sh-project${!grid && p.id === firstUnpinned ? " after-pins" : ""}${dragging === p.id ? " dragging" : ""}${drop}`}
        onDragOver={
          dragging
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const box = e.currentTarget.getBoundingClientRect();
                // Cards sit side by side, rows one under the other.
                const after = grid ? e.clientX > box.left + box.width / 2 : e.clientY > box.top + box.height / 2;
                if (dropAt?.id !== p.id || dropAt.after !== after) setDropAt({ id: p.id, after });
              }
            : undefined
        }
        onDrop={
          dragging
            ? (e) => {
                e.preventDefault();
                if (dropAt) dropOn(dropAt.id, dropAt.after);
                setDragging(null);
                setDropAt(null);
              }
            : undefined
        }
      >
        <ProjectLine
          project={p}
          {...lineOf(p.id)}
          card={grid}
          now={nowOf(p.id)}
          pinned={pins.has(p.id)}
          onPin={() => togglePin(p.id)}
          onOpen={() => props.onProject(p.id)}
          roomId={props.roomId}
          reload={props.reload}
          order={
            canOrder
              ? {
                  onUp: i > 0 ? () => nudge(p.id, -1) : undefined,
                  onDown: i < sections.length - 1 ? () => nudge(p.id, 1) : undefined,
                  onDragStart: () => setDragging(p.id),
                  onDragEnd: () => (setDragging(null), setDropAt(null)),
                }
              : undefined
          }
        />
      </section>
    );
  };

  const fold = (label: string, n: number, open: boolean, toggle: () => void, icon: React.ReactNode) =>
    n > 0 && (
      <button className="sh-done-toggle" aria-expanded={open} onClick={toggle}>
        <ChevronIcon />
        {icon}
        {label}
        <span className="count">{n}</span>
      </button>
    );

  const forYou = mentioned.length + waiting.length;
  const addProject = (
    <button type="button" className="pj-add" onClick={() => setAdding(true)}>
      + Project
    </button>
  );
  const projectForm = (
    <ProjectForm
      label="New project"
      submit="Add"
      onCancel={() => setAdding(false)}
      onSave={async (name, goal) => {
        await api.createProject(props.roomId, { name, goal: goal || undefined });
        setAdding(false);
        props.reload();
      }}
    />
  );
  // On the cards a new project starts as a faint card of its own, the last one in the grid: a click
  // turns it into the form, in the place the project will take.
  const ghost = grid && !plain && viewing === null && !onlyPinned && !props.mine;
  const pills = (
    <>
      {!plain && viewing === null && pins.size > 0 && (
        <button type="button" className={onlyPinned ? "rp-pill on" : "rp-pill"} aria-pressed={onlyPinned} onClick={() => saveView({ ...view, onlyPinned: !onlyPinned })} title="Only the projects you pinned">
          Pinned
        </button>
      )}
    </>
  );
  const sweepButton = !plain && (viewing === null || props.solo) && sweep && (
    <button
      type="button"
      className="rp-pill desk-only"
      onClick={() => setSweeping(sweep)}
      title={`Stand thinks ${sweep.proposals.length === 1 ? "1 open question is" : `${sweep.proposals.length} open questions are`} settled or no longer ${sweep.proposals.length === 1 ? "matters" : "matter"}. Nothing closes until you confirm.`}
    >
      Sweep<span className="sh-sweep-long"> questions</span>
      <span className="count">{sweep.proposals.length}</span>
    </button>
  );
  const deck = props.deck?.slides.length ? props.deck : null;
  const filterName = props.projectFilter === "none" ? "Unassigned" : nameOf(props.projectFilter);
  return (
    <>
      {deck && (
        <button type="button" className="sh-done-since" onClick={() => setShowDeck(true)} title="See the pages the next meeting opens on">
          <strong>Done since {fmtDay(deck.sinceStartedAt)}</strong>
          {deck.summary && <span className="sh-done-since-summary">{deck.summary}</span>}
          <span className="count">{deck.closed}</span>
          <ChevronIcon />
        </button>
      )}
      {showDeck && deck && <DonePop deck={deck} onClose={() => setShowDeck(false)} />}
      {sweeping && <SweepPop roomId={props.roomId} count={asked} sweep={sweeping} onClose={() => setSweeping(null)} onClosed={props.reload} />}
      {props.toolsIn
        ? createPortal(
            <>
              {pills}
              {sweepButton}
              {canSort && <TaskMenu sort={sort} onSort={pickSort} />}
            </>,
            props.toolsIn,
          )
        : !adding && (
            <div className="sh-task-tools">
              {pills}
              {canSort && (
                <label className="sh-project-sort" title={sort === "active" ? "Projects with work in progress first, then the ones with the newest to-dos" : "The team's order, most important first. Drag a project to change it."}>
                  <select aria-label="Project order" value={sort} onChange={(e) => pickSort(e.target.value === "team" ? "team" : "active")}>
                    <option value="active">Active first</option>
                    <option value="team">Team order</option>
                  </select>
                </label>
              )}
            </div>
          )}
      {adding && !ghost && <div className="sh-task-tools">{projectForm}</div>}
      {viewing !== null && !plain && !props.solo && (
        <ProjectLine
          head
          slot={phone ? undefined : setHeadSlot}
          project={viewing ? (projects.find((p) => p.id === viewing) ?? null) : null}
          {...lineOf(viewing)}
          onOpen={() => props.onProject("")}
          roomId={props.roomId}
          reload={props.reload}
        />
      )}
      {!open.length && plain && (
        <p className="sh-card-empty">
          {props.mine ? "Nothing open is yours." : filterName ? `No open tasks in ${filterName}.` : "Nothing open. New tasks come from meetings and what people save here."}
        </p>
      )}
      {forYou > 0 && plain && (
        <div className="sh-task-group for-you">
          <p
            className="sh-group waiting"
            title={[
              mentioned.length > 0 && `${mentioned.length} where someone tagged you in a comment (the @ pill): reply on the task or dismiss it there`,
              waiting.length > 0 && `${waiting.length} ready to ship: a PR or other work is in and needs someone with a say to look`,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            For you · {forYou}
          </p>
          {list([...mentioned, ...waiting])}
        </div>
      )}
      {plain ? (
        <>
          {byOwner(withParts(rest), "")}
        </>
      ) : viewing !== null ? (
        (() => {
          // A project's page lists one kind at a time: its to-dos, its open questions or its decisions.
          const todos = open.filter((n) => n.kind === "action");
          const asked = open.filter((n) => n.kind !== "action");
          const closedOf = (kind: "action" | "question") => ({ done: done.filter((n) => (n.kind === "action") === (kind === "action")), dropped: dropped.filter((n) => (n.kind === "action") === (kind === "action")) });
          const folds = (kind: "action" | "question") => {
            const c = closedOf(kind);
            return (
              <>
                {c.done.length > 0 && (
                  <div className={showDone ? "sh-done open" : "sh-done"}>
                    {fold(kind === "action" ? "Done" : "Answered", c.done.length, showDone, () => setShowDone((v) => !v), <DoneIcon />)}
                    {showDone && list(c.done, true)}
                  </div>
                )}
                {c.dropped.length > 0 && (
                  <div className={showDropped ? "sh-done open" : "sh-done"}>
                    {fold("Dropped", c.dropped.length, showDropped, () => setShowDropped((v) => !v), <CloseIcon size={13} />)}
                    {showDropped && list(c.dropped, true)}
                  </div>
                )}
              </>
            );
          };
          const views: Array<{ key: ProjectShow; label: string; n: number; icon: React.ReactNode }> = [
            { key: "tasks", label: "Tasks", n: withParts(todos).length, icon: <TodoIcon size={13} /> },
            { key: "questions", label: "Questions", n: asked.length, icon: <QuestionIcon size={13} /> },
            { key: "decisions", label: "Decisions", n: props.decisionCount, icon: <DecidedIcon size={13} /> },
            // Finished to-dos are their own last view, so Tasks is only what is still open.
            { key: "done", label: "Done", n: closedOf("action").done.length, icon: <DoneIcon /> },
          ];
          return (
            <section ref={pageRef} className="sh-project open pj-page" aria-label={props.solo ? "Everything" : viewing ? (nameOf(viewing) ?? "Project") : "Unassigned"}>
              {(() => {
                const pills = (
                  <div className="pj-views" role="tablist" aria-label="What to show">
                    {views.map((v) => (
                      <button key={v.key} type="button" role="tab" aria-selected={props.show === v.key} className={props.show === v.key ? "pj-view on" : "pj-view"} onClick={() => props.onShow(v.key)}>
                        {v.icon}
                        {v.label}
                        {v.n > 0 && <span className="count">{v.n}</span>}
                      </button>
                    ))}
                  </div>
                );
                return !phone && !props.solo && headSlot ? createPortal(pills, headSlot) : pills;
              })()}
              {props.show === "tasks" && (
                <>
                  {todos.length > 0 ? byState(todos, viewing) : <p className="sh-card-empty">No open to-dos.</p>}
                </>
              )}
              {props.show === "done" &&
                (() => {
                  const c = closedOf("action");
                  return (
                    <>
                      {c.done.length > 0 ? <div className="sh-task-group pj-state done">{list(c.done, true)}</div> : <p className="sh-card-empty">Nothing done yet.</p>}
                      {c.dropped.length > 0 && (
                        <div className={showDropped ? "sh-done open" : "sh-done"}>
                          {fold("Dropped", c.dropped.length, showDropped, () => setShowDropped((v) => !v), <CloseIcon size={13} />)}
                          {showDropped && list(c.dropped, true)}
                        </div>
                      )}
                    </>
                  );
                })()}
              {props.show === "questions" && (
                <>
                  {asked.length > 0 ? <div className="sh-task-group pj-state questions">{list(asked, false, viewing)}</div> : <p className="sh-card-empty">No open questions.</p>}
                  {folds("question")}
                </>
              )}
              {props.show === "decisions" && <div className="pj-decisions">{props.decisions}</div>}
              {props.solo && !adding && addProject}
            </section>
          );
        })()
      ) : (
        <>
          {/* A wide screen has the projects as cards, your pinned ones in a first group; a phone has rows that open in place. */}
          {grid && pins.size > 0 && <div className="pj-grid pinned" style={holding}>{sections.filter((p) => pins.has(p.id)).map(projectSection)}</div>}
          <div className={grid ? "pj-grid" : "pj-list"} style={holding}>
            {sections.filter((p) => !grid || !pins.has(p.id)).map(projectSection)}
            {(unassigned.length > 0 || props.loose) && !onlyPinned && (
              <section className={`sh-project unassigned`} aria-label="Unassigned">
                <ProjectLine
                  project={null}
                  {...lineOf("")}
                  card={grid}
                  now={nowOf("")}
                  onOpen={() => props.onProject("none")}
                  roomId={props.roomId}
                  reload={props.reload}
                />
              </section>
            )}
            {ghost && (
              <section className={adding ? "sh-project pj-ghost adding" : "sh-project pj-ghost"}>
                {adding ? (
                  projectForm
                ) : (
                  <button type="button" className="pj-ghost-add" onClick={() => setAdding(true)}>
                    + New project
                  </button>
                )}
              </section>
            )}
            {!grid && !adding && !onlyPinned && !props.mine && addProject}
          </div>
        </>
      )}
      {done.length > 0 && plain && (
        <div className={showDone ? "sh-done open" : "sh-done"}>
          {fold("Done", done.length, showDone, () => setShowDone((v) => !v), <DoneIcon />)}
          {showDone && list(done, true)}
        </div>
      )}
      {dropped.length > 0 && plain && (
        <div className={showDropped ? "sh-done open" : "sh-done"}>
          {fold("Dropped", dropped.length, showDropped, () => setShowDropped((v) => !v), <CloseIcon size={13} />)}
          {showDropped && list(dropped, true)}
        </div>
      )}
    </>
  );
}

/** The order of the projects, in a menu at the end of the tab row. */
function TaskMenu(props: { sort: "active" | "team"; onSort: (sort: "active" | "team") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const pick = (run: () => void) => () => (setOpen(false), run());
  return (
    <span className="sh-project-menu sh-task-menu" ref={ref}>
      <button type="button" className="sh-project-more" aria-label="Project order" aria-haspopup="menu" aria-expanded={open} title="Project order" onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <span className="sh-menu" role="menu">
          <button role="menuitemradio" aria-checked={props.sort === "active"} className={props.sort === "active" ? "on" : undefined} title="Projects with work in progress first, then the ones with the newest to-dos" onClick={pick(() => props.onSort("active"))}>
                Active projects first
              </button>
              <button role="menuitemradio" aria-checked={props.sort === "team"} className={props.sort === "team" ? "on" : undefined} title="The team's order, most important first. Drag a project to change it." onClick={pick(() => props.onSort("team"))}>
                Team order
              </button>
        </span>
      )}
    </span>
  );
}

/** One project on one line. In the list of projects it is a row that opens the project; as `head` it
 *  tops the project's own view, with the way back. Either way it reads across the same: the name and
 *  goal, what is moving (in progress, ready to ship), who is on it, how much of it is done, and what
 *  is still open. Its menu has Move up, Move down, Rename, Edit goal, Archive and Delete.
 *  `project` null is Unassigned: the tasks no project has yet. */
function ProjectLine(props: {
  project: Project | null;
  head?: boolean;
  /** On an open project's row: where its view pills go, in place of the name the tab row's trail already shows. */
  slot?: (el: HTMLElement | null) => void;
  open: number;
  done: number;
  /** Open to-dos in it that someone is on now. */
  inProgress: number;
  /** Open to-dos whose work is in and waits to ship. */
  ready: number;
  /** Who has its open work, as faces. */
  owners?: React.ReactNode;
  /** Kept decisions in it, linked from its own view. */
  decisions?: number;
  onDecisions?: () => void;
  /** What someone is on now, on a row: the newest in-progress to-do, and how many more there are. */
  now?: { text: string; face: React.ReactNode; more: number; onOpen: () => void };
  /** A card on a wide screen: the goal under the name. */
  card?: boolean;
  /** A row: its tasks are open under it. */
  expanded?: boolean;
  /** Your own pin on it. */
  pinned?: boolean;
  onPin?: () => void;
  /** The row opens the project under it; the head goes back to the list. */
  onOpen: () => void;
  /** Opens the project's own view from a row. */
  onAlone?: () => void;
  roomId: string;
  reload: () => void;
  /** Left out when the order can't change here: one project in view, a filter on, or Active first. */
  order?: { onUp?: () => void; onDown?: () => void; onDragStart: () => void; onDragEnd: () => void };
}) {
  const { project: p, order, head, card } = props;
  const idle = !head && !props.now && props.ready === 0;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<"name" | "goal" | null>(null);
  const ref = useDismiss<HTMLSpanElement>(menu, () => setMenu(false));
  const change = (what: string, run: () => Promise<unknown>, leave = false) => {
    setMenu(false);
    run().then(() => (leave && head ? props.onOpen() : props.reload()), errorToast(`Couldn't ${what}`));
  };
  if (editing && p)
    return (
      <div className="pj-line editing">
        <ProjectForm
          label={editing === "name" ? "Rename project" : "Project goal"}
          submit="Save"
          name={p.name}
          goal={p.goal ?? ""}
          only={editing}
          onCancel={() => setEditing(null)}
          onSave={async (name, goal) => {
            await api.updateProject(props.roomId, p.id, editing === "name" ? { name } : { goal: goal || null });
            setEditing(null);
            props.reload();
          }}
        />
      </div>
    );
  const name = p?.name ?? "Unassigned";
  const total = props.open + props.done;
  const tally = `${props.done} done · ${props.open} open`;
  const onRow = (e: React.MouseEvent<HTMLElement>) => {
    if (head || (e.target as HTMLElement).closest("button, a, input, select, [role=menu], .sh-project-grip")) return;
    props.onOpen();
  };
  return (
    <div className={`pj-line${head ? " head" : ""}${card ? " card" : ""}${p ? "" : " unassigned"}${idle ? " idle" : ""}`} onClick={onRow}>
      {order && (
        <span
          className="sh-project-grip"
          draggable
          title="Drag to change the order"
          aria-hidden
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", name);
            const row = e.currentTarget.closest(".sh-project");
            if (row) e.dataTransfer.setDragImage(row, 12, 12);
            order.onDragStart();
          }}
          onDragEnd={order.onDragEnd}
        >
          <GripIcon />
        </span>
      )}
      {head && props.slot && <span className="pj-head-slot" ref={props.slot} />}
      <span className="pj-title">
        {head ? (
          <strong className="pj-name">{name}</strong>
        ) : (
          <button type="button" className="pj-name" aria-expanded={card ? undefined : !!props.expanded} onClick={props.onOpen} title={p?.goal ?? undefined}>
            {!card && <ChevronIcon />}
            {name}
          </button>
        )}
        {p?.archived && <span className="muted small">Archived</span>}
        {!head && !card && props.now ? (
          <span className="pj-now">
            <button type="button" className="pj-now-task" onClick={props.now.onOpen} title={`In progress: ${props.now.text}`}>
              {props.now.text}
            </button>
            {props.now.face}
            {props.now.more > 0 && (
              <span className="pj-now-more" title={`${props.now.more} more in progress`}>
                +{props.now.more}
              </span>
            )}
          </span>
        ) : (
          p?.goal && (
            <span className="pj-goal" title={p.goal}>
              {p.goal}
            </span>
          )
        )}
      </span>
      <span className="pj-moving">
        {props.inProgress > 0 && (
          <span className={head ? "pj-live" : "pj-live row"} title={`${props.inProgress} in progress: someone is on ${props.inProgress === 1 ? "it" : "them"} now`}>
            {props.inProgress}
            <span className="pj-word"> in progress</span>
          </span>
        )}
        {props.ready > 0 && (
          <span className="pj-ready" title={`${props.ready} ready to ship: the work is in and waits for a look`}>
            {props.ready}
            <span className="pj-word"> ready</span>
          </span>
        )}
      </span>
      {head && props.decisions! > 0 && (
        <button type="button" className="rp-pill pj-decisions" onClick={props.onDecisions} title="This project's decisions">
          Decisions<span className="count">{props.decisions}</span>
        </button>
      )}
      {props.owners || <span className="pj-faces" />}
      <span className="pj-meter" role="img" aria-label={tally} title={tally}>
        <span style={{ width: total ? `${Math.round((props.done / total) * 100)}%` : 0 }} />
      </span>
      <span className="pj-open" title={tally}>
        {props.open}
        <span className="pj-word"> open</span>
      </span>
      {!head && !props.onPin && <span className="pj-pin none" aria-hidden />}
      {props.onPin && (
        <button type="button" className={props.pinned ? "pj-pin on" : "pj-pin"} aria-pressed={!!props.pinned} aria-label={props.pinned ? `Unpin ${name}` : `Pin ${name}`} title={props.pinned ? "Unpin" : "Pin: keep it first on your list, and open"} onClick={props.onPin}>
          <PinIcon />
        </button>
      )}
      <span className="sh-project-menu pj-menu" ref={ref}>
        {p && (
          <button type="button" className="sh-project-more" aria-label={`${p.name}: more`} aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            ⋯
          </button>
        )}
        {menu && p && (
          <span className="sh-menu" role="menu">
            {order && (
              <>
                <button role="menuitem" disabled={!order.onUp} onClick={() => (setMenu(false), order.onUp?.())}>
                  Move up
                </button>
                <button role="menuitem" disabled={!order.onDown} onClick={() => (setMenu(false), order.onDown?.())}>
                  Move down
                </button>
              </>
            )}
            {props.onAlone && (
              <button role="menuitem" onClick={() => (setMenu(false), props.onAlone!())}>
                Open on its own
              </button>
            )}
            <button role="menuitem" onClick={() => (setMenu(false), setEditing("name"))}>
              Rename
            </button>
            <button role="menuitem" onClick={() => (setMenu(false), setEditing("goal"))}>
              Edit goal
            </button>
            {p.archived ? (
              <button role="menuitem" onClick={() => change("bring it back", () => api.updateProject(props.roomId, p.id, { archived: false }))}>
                Unarchive
              </button>
            ) : (
              <button
                role="menuitem"
                disabled={p.openTodos > 0}
                title={p.openTodos > 0 ? "Close or move its open to-dos first" : undefined}
                onClick={() => change("archive it", () => api.updateProject(props.roomId, p.id, { archived: true }))}
              >
                Archive
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                if (window.confirm(`Delete the project ${p.name}? Its tasks stay, and go back to their agenda item's project or to Unassigned.`))
                  change("delete it", () => api.deleteProject(props.roomId, p.id), true);
              }}
            >
              Delete
            </button>
          </span>
        )}
      </span>
    </div>
  );
}

/** A project's name and goal line, for a new project or a change to one. */
function ProjectForm(props: {
  label: string;
  submit: string;
  name?: string;
  goal?: string;
  only?: "name" | "goal";
  onSave: (name: string, goal: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.name ?? "");
  const [goal, setGoal] = useState(props.goal ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (saving || (props.only !== "goal" && !name.trim())) return;
    setSaving(true);
    setError("");
    try {
      await props.onSave(name.trim(), goal.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };
  return (
    <form
      className="sh-project-form"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
      }}
    >
      {props.only !== "goal" && (
        <input autoFocus aria-label="Project name" placeholder="Project name" maxLength={80} value={name} disabled={saving} onChange={(e) => setName(e.target.value)} />
      )}
      {props.only !== "name" && (
        <input autoFocus={props.only === "goal"} aria-label="Goal" placeholder="Goal, in one line (optional)" maxLength={200} value={goal} disabled={saving} onChange={(e) => setGoal(e.target.value)} />
      )}
      <button type="submit" disabled={saving || (props.only !== "goal" && !name.trim())}>
        {saving ? "Saving…" : props.submit}
      </button>
      <button type="button" className="link" onClick={props.onCancel}>
        Cancel
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
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
        <span className="rc-pop-crux">“<MentionText text={latest.text.length > 280 ? `${latest.text.slice(0, 279)}…` : latest.text} />”</span>
        <span className="rc-pop-meta">
          {latest.by} · {fmtDate(latest.ts)} {fmtTime(latest.ts)}
          {mentions.length > 1 && ` · ${mentions.length} comments`}
        </span>
      </span>
    </span>
  );
}

/** "1/3 parts" after a to-do's text: how many of its parts are done. */
function PartsPill({ done, total, open, onToggle }: { done: number; total: number; open?: boolean; onToggle?: () => void }) {
  const label = `${done} of ${total} ${total === 1 ? "part" : "parts"} done`;
  // Under its to-do the pill opens and closes the parts. A phone shows only the count.
  if (open !== undefined)
    return (
      <button type="button" className={open ? "rc-pill task-parts fold open" : "rc-pill task-parts fold"} aria-expanded={open} aria-label={`${label}. ${open ? "Hide" : "Show"} them`} onClick={onToggle}>
        {done}/{total}
        <span className="wide-only"> {total === 1 ? "part" : "parts"}</span>
      </button>
    );
  return (
    <span className="rc-pill task-parts" title={label} aria-label={label}>
      {done}/{total} {total === 1 ? "part" : "parts"}
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
  designHref: string;
  onTalk: () => void;
  onReview: () => void;
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
      <button className="primary sh-join" aria-label={props.label} onClick={props.onTalk}>
        <MicIcon />
        <span className="sh-join-label">{props.label}</span>
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
/** A product review has no name of its own: its first slides say which one it is. */
const reviewName = (titles: Array<string | null | undefined>, slides: number) => {
  const shown = titles.map((t) => (t ?? "").trim()).filter(Boolean).slice(0, 3);
  return shown.join(" · ") + (slides > shown.length && shown.length ? ` +${slides - shown.length}` : "");
};

function KindRow(props: { to: string; name: string; at: number | null; children: React.ReactNode }) {
  return (
    <li className="sh-row">
      <Link to={props.to} className="sh-row-link">
        <time className="sh-time">{reviewDay(props.at)}</time>
        <span className="sh-row-text">
          <span className="sh-who">{props.name}</span>
          {props.children}
        </span>
      </Link>
    </li>
  );
}

/** The next product review's slides, and the button that starts the call on the first one. */
const reviewDay = (ts: number | null) => (ts ? fmtDay(ts) : "");

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

type TabKey = "projects" | "chat" | "meetings" | "mine";
/** What a project's page lists: one kind at a time. */
type ProjectShow = "tasks" | "questions" | "decisions" | "done";
/** The space's tabs, in the order people look at them. */
/** A row's "···": what can be done to it, in a small menu, so the row itself stays quiet. */
function RowMore(props: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span className={open ? "row-more open" : "row-more"} ref={ref}>
      <button type="button" className="row-more-btn" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <circle cx="3" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="13" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        // A choice shuts the menu; Copy for agent stays a moment so its "Copied" can be read.
        <div className="rp-menu row-menu" role="menu" onClick={(e) => setTimeout(() => setOpen(false), (e.target as HTMLElement).closest(".cfa") ? 1200 : 0)}>
          {props.children}
        </div>
      )}
    </span>
  );
}

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

/** The kinds of archived row the space page offers to restore, with the word shown beside each. */
const ARCHIVED_KIND: Partial<Record<ArchivedKind, string>> = { todo: "To-do", question: "Question", decision: "Decision", meeting: "Meeting", snap: "Snap", jot: "Note" };

/** Everything archived in the space, each with Restore. It opens from the menu behind the faces. */
function ArchivedPop(props: { rows: ArchivedRow[]; onRestore: (ref: string) => void; onClose: () => void }) {
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog archived-pop" role="dialog" aria-modal="true" aria-label="Archived">
        <header>
          <h2>Archived</h2>
          <button className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        {props.rows.length === 0 ? (
          <p className="muted">Nothing is archived.</p>
        ) : (
          <ul className="sh-archived">
            {props.rows.map((a) => (
              <li key={a.ref}>
                <span className="sh-archived-kind">{ARCHIVED_KIND[a.kind] ?? ""}</span>
                <span className="sh-archived-title" title={a.title}>{a.kind === "meeting" ? fmtDate(a.ts) : a.title}</span>
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
    </div>
  );
}

/** The Chat tab's marks: how many messages are new, and an @ when any of them tags you. */
function ChatMarks({ unread, mentions }: { unread: number; mentions: number }) {
  if (!unread) return null;
  const label = `${unread} new ${unread === 1 ? "message" : "messages"}${mentions ? `, ${mentions} ${mentions === 1 ? "mentions" : "mention"} you` : ""}`;
  return (
    <span className="chat-marks" title={label}>
      <span className="count fresh">{unread}</span>
      {mentions > 0 && (
        <>
          <span className="sr-only">({mentions} {mentions === 1 ? "mentions" : "mention"} you)</span>
          <span className="count mention" aria-hidden>
            @
          </span>
        </>
      )}
    </span>
  );
}

const IS_MAC = /Mac/.test(navigator.platform);
const CHAT_SHORTCUT = `${MOD.cmd} + J`;
const DOCK_KEY = "stand.chatDock";
/** From this width chat is a column beside the tabs. Keep in step with .sh-dock in styles.css. */
const DOCK_FROM = "(min-width: 1200px)";

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(DOCK_FROM).matches);
  useEffect(() => {
    const mq = window.matchMedia(DOCK_FROM);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

const ProjectsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="2.5" width="5" height="5" rx="1.2" />
    <rect x="9" y="2.5" width="5" height="5" rx="1.2" />
    <rect x="2" y="9" width="5" height="5" rx="1.2" />
    <rect x="9" y="9" width="5" height="5" rx="1.2" />
  </svg>
);

const TABS: Array<{ key: TabKey; label: string; icon?: React.ReactNode }> = [
  { key: "projects", label: "Projects", icon: <ProjectsIcon /> },
  { key: "chat", label: "Chat", icon: <ChatIcon size={14} /> },
  { key: "meetings", label: "Meetings", icon: <MicIcon /> },
  { key: "mine", label: "Mine" },
];

/** Decisions or open questions across the space's meetings, as the recap lists them. A decision a
 *  later one replaced stays, muted and last, so the change of mind is still on record. */
function PointList(props: {
  projectPicker?: (n: Note) => React.ReactNode;
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
              {n.projectSuggested && props.projectPicker?.(n)}
              {/* Its project, quote, date and the question it answers wait for a hover. */}
              <span className="pt-quiet">
              {!n.projectSuggested && props.projectPicker?.(n)}
              {n.quote && <QuoteMark quote={n.quote} />}
              {n.from && <FromChip from={n.from} />}
              {n.answers && (
                <span className="rc-pill-wrap">
                  <span className="rc-pill" tabIndex={0} aria-label={`Answers: ${n.answers}`}>
                    Answer
                  </span>
                  <span className="rc-pop" role="tooltip">
                    <span className="rc-pop-meta">Answers the question</span>
                    <span className="rc-pop-crux">{n.answers}</span>
                  </span>
                </span>
              )}
              </span>
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
  const day = fmtDay(by.startedAt);
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
          <p className="sh-view-line sh-view-note"><MentionText text={of.jot.text} /></p>
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
        {snap.caption && <p className="sh-view-caption">{snap.caption}</p>}
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
