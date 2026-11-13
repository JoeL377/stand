// The space's chat: what people write to each other between meetings. The thread is read here and
// kept up to date by the space's event stream; sending, editing and deleting are plain requests.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type CaughtLine, type ChatCall, type ChatCaught, type ChatEvent, type ChatMessage, type ChatReport, type ChatThread, STAND_AUTHOR, STAND_NAME } from "../shared/chat.ts";
import { Bell, BellOff, ListPlus, Reply, SmilePlus } from "lucide-react";
import { mentionedIn } from "../shared/mentions.ts";
import type { NotifyStatus } from "../shared/push.ts";
import { api } from "./api.ts";
import { mergeCaught, placeCaught, placeReports } from "./chatCaught.ts";
import { asMessage, restore, serial, unsaved, type PendingMessage } from "./chatPending.ts";
import { moveRead, placeReads } from "./chatReads.ts";
import { ChevronIcon, CloseIcon, EditIcon, SendIcon, TrashIcon } from "./icons.tsx";
import { Linkified } from "./Linkified.tsx";
import { MentionTextarea } from "./MentionTextarea.tsx";
import { Avatar } from "./Avatar.tsx";
import { errorToast, toast } from "./Toasts.tsx";
import { fmtTime, fmtDay, fmtFull } from "./util.ts";

const TEXT_MAX = 4000;
/** "Maya is typing" stays this long after their last key, and their page says so this often. */
const TYPING_SHOWN_MS = 5000;
const TYPING_EVERY_MS = 3000;
/** The emoji one click away. */
const QUICK = ["👍", "✅", "👀", "❤️", "😂", "🎉", "🙏"];
/** One page of messages, as the server gives them. A page this full may have older ones before it. */
const PAGE = 100;
/** Messages by one person this close together read as one block, under one name. */
const BLOCK_MS = 5 * 60_000;

export interface SpaceChatState {
  thread: ChatThread | null;
  error: string | null;
  /** Messages from other people after the last one you read. */
  unread: number;
  /** Of those, the ones that tag you with @Name. */
  mentions: number;
  /** This message tags you. */
  mentionsMe: (m: ChatMessage) => boolean;
  /** There may be messages before the oldest one loaded. */
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
  markRead: () => void;
  apply: (m: ChatMessage) => void;
  /** A line Stand caught that isn't one: it goes for everyone. */
  removeCaught: (line: CaughtLine) => Promise<void>;
  reload: () => void;
  /** What you sent that isn't saved yet, oldest first: sending, or failed and waiting for Retry. */
  pending: PendingMessage[];
  /** Shows the message at once and sends it. Sends go out one at a time, in order. */
  send: (text: string, replyTo?: string | null) => void;
  /** The other people writing in the box right now. */
  typing: string[];
  /** The answers Stand is writing now: what it is doing, and the words so far. */
  answering: Answering[];
  /** Says you are writing. Safe to call on every key: it goes out at most every few seconds. */
  typingNow: () => void;
  retry: (key: string) => void;
  discard: (key: string) => void;
}

/** An answer of Stand's on its way. */
export interface Answering {
  askId: string;
  status: string | null;
  text: string | null;
  at: number;
}
/** An answer that never arrives stops showing as on its way after this long. */
const ANSWERING_MAX_MS = 3 * 60_000;

/** A space's chat, loaded once and then fed by the space's event stream for as long as the page is open.
 *  onMention hears each new message that tags you, as it arrives. */
export function useSpaceChat(roomId: string, me: string, onMention?: (m: ChatMessage) => void): SpaceChatState {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  // Who is writing, and until when to believe it.
  const [writers, setWriters] = useState<Array<{ id: string; name: string; until: number }>>([]);
  const [answeringAll, setAnswering] = useState<Answering[]>([]);
  const answering = useMemo(() => answeringAll.filter((a) => Date.now() - a.at < ANSWERING_MAX_MS), [answeringAll]);
  // Kept by space, so what one space didn't send never shows in another.
  const unsentKey = `stand.chatUnsent.${roomId}`;
  const [unsent, setUnsent] = useState<{ roomId: string; list: PendingMessage[] }>(() => ({ roomId, list: restore(readSession(unsentKey)) }));
  const setPending = useCallback(
    (f: (list: PendingMessage[]) => PendingMessage[]) =>
      setUnsent((u) => {
        if (u.roomId !== roomId) return u;
        const list = f(u.list);
        return list === u.list ? u : { roomId, list };
      }),
    [roomId],
  );
  useEffect(() => {
    setUnsent((u) => (u.roomId === roomId ? u : { roomId, list: restore(readSession(unsentKey)) }));
  }, [roomId, unsentKey]);
  // A reload brings back what wasn't saved, to send again by hand.
  useEffect(() => {
    if (unsent.roomId !== roomId) return;
    try {
      if (unsent.list.length) sessionStorage.setItem(unsentKey, JSON.stringify(unsent.list));
      else sessionStorage.removeItem(unsentKey);
    } catch {}
  }, [unsent, roomId, unsentKey]);
  // The saved message takes the place of the pending one, from the send's answer or from the stream.
  // It goes from the list once the effect runs; until then this render leaves it out already.
  const messages = thread?.messages;
  useEffect(() => {
    if (messages) setPending((list) => unsaved(list, messages));
  }, [messages, setPending]);
  const pending = useMemo(() => unsaved(unsent.roomId === roomId ? unsent.list : [], messages ?? []), [unsent, roomId, messages]);

  const threadRef = useRef(thread);
  threadRef.current = thread;
  const people = thread?.people;
  const mentionsMe = useCallback((m: ChatMessage) => !m.deletedAt && m.authorId !== me && !!people && m.text.includes("@") && mentionedIn(m.text, people).includes(me), [people, me]);
  // The stream outlives a render: it reads these as they are now.
  const heard = useRef({ mentionsMe, onMention, known: new Set<string>() });
  heard.current.mentionsMe = mentionsMe;
  heard.current.onMention = onMention;

  const apply = useCallback(
    (m: ChatMessage) => {
      setThread((t) => {
        if (!t || m.channelId !== t.channel.id) return t;
        const at = t.messages.findIndex((x) => x.id === m.id);
        const messages = at >= 0 ? t.messages.map((x) => (x.id === m.id ? m : x)) : [...t.messages, m].sort((a, b) => a.seq - b.seq);
        // Whoever writes in Stand's own chat has read up to what they wrote.
        const reads = m.authorId !== me && m.authorId !== STAND_AUTHOR && t.channel.source === "stand" ? moveRead(t.reads, { userId: m.authorId, name: m.author, upTo: m.seq }) : t.reads;
        return { ...t, messages, reads };
      });
    },
    [me],
  );

  // The channel whose first page is in: a later reload only adds to it.
  const loadedFor = useRef<string | null>(null);
  const reload = useCallback(() => {
    api.chat(roomId).then(
      (fresh) => {
        setError(null);
        if (loadedFor.current !== fresh.channel.id) {
          loadedFor.current = fresh.channel.id;
          setHasOlder(fresh.messages.length >= PAGE);
          setThread(fresh);
          return;
        }
        // Older pages read before stay: a reload brings the newest page as it is now.
        setThread((t) => {
          if (!t) return fresh;
          const ids = new Set(fresh.messages.map((m) => m.id));
          const oldest = fresh.messages[0]?.seq ?? Infinity;
          return {
            ...fresh,
            messages: [...t.messages.filter((m) => !ids.has(m.id) && m.seq < oldest), ...fresh.messages],
            caught: mergeCaught(t.caught, fresh.caught),
            reports: fresh.reports,
            calls: fresh.calls,
            readUpTo: Math.max(t.readUpTo, fresh.readUpTo),
          };
        });
      },
      (e: Error) => setError(e.message),
    );
  }, [roomId]);

  useEffect(() => {
    loadedFor.current = null;
    setThread(null);
    reload();
    const stream = new EventSource(`/api/rooms/${roomId}/events`);
    let dropped = false;
    stream.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as ChatEvent;
      if (e.type === "typing") {
        if (e.userId !== me) setWriters((w) => [...w.filter((x) => x.id !== e.userId), { id: e.userId, name: e.name, until: Date.now() + TYPING_SHOWN_MS }]);
      } else if (e.type === "answering") {
        setAnswering((a) => [...a.filter((x) => x.askId !== e.askId), ...(e.done ? [] : [{ askId: e.askId, status: e.status, text: e.text, at: Date.now() }])]);
      } else if (e.type === "reports") {
        const since = threadRef.current?.messages[0]?.ts;
        if (since !== undefined) api.chatReports(roomId, since).then((reports) => setThread((t) => t && { ...t, reports }), () => {});
      } else if (e.type === "message") {
        // Stand's answer has arrived: its draft goes.
        if (e.message.authorId === STAND_AUTHOR && e.message.replyTo) setAnswering((a) => a.filter((x) => x.askId !== e.message.replyTo));
        // What they were writing has arrived.
        setWriters((w) => (w.some((x) => x.id === e.message.authorId) ? w.filter((x) => x.id !== e.message.authorId) : w));
        const h = heard.current;
        // Only a message seen for the first time: an edit that adds you doesn't call out again.
        if (!h.known.has(e.message.id) && h.mentionsMe(e.message)) h.onMention?.(e.message);
        h.known.add(e.message.id);
        apply(e.message);
      }
      // A session opened or closed: what ends a closed one shows once it has.
      else if (e.type === "session")
        setThread((t) =>
          t && t.channel.id === e.channelId
            ? { ...t, channel: { ...t.channel, openSessionId: e.open ? e.sessionId : t.channel.openSessionId === e.sessionId ? null : t.channel.openSessionId } }
            : t,
        );
      // Stand caught something, or someone removed a line: that session is read again.
      else if (e.type === "notes")
        api.chatCaught(e.sessionId).then(
          (c) => setThread((t) => (t && t.channel.id === e.channelId ? { ...t, caught: mergeCaught(t.caught, [c]) } : t)),
          () => {},
        );
      // Someone else read further: their mark moves down.
      else if (e.type === "read" && e.userId !== me) setThread((t) => (t && t.channel.id === e.channelId ? { ...t, reads: moveRead(t.reads, { userId: e.userId, name: e.name, upTo: e.upTo }) } : t));
    };
    // The browser connects again by itself. What was sent meanwhile is read then.
    stream.onerror = () => {
      dropped = true;
    };
    stream.onopen = () => {
      if (dropped) reload();
      dropped = false;
    };
    return () => stream.close();
  }, [roomId, me, reload, apply]);

  const loadOlder = useCallback(async () => {
    const first = thread?.messages[0];
    if (!thread || !first) return;
    const older = await api.chatMessages(thread.channel.id, { before: first.seq });
    setHasOlder(older.messages.length >= PAGE);
    setThread((t) => t && { ...t, messages: [...older.messages.filter((m) => !t.messages.some((x) => x.id === m.id)), ...t.messages], caught: mergeCaught(older.caught, t.caught) });
  }, [thread]);

  const removeCaught = useCallback(async (line: CaughtLine) => {
    await api.removeCaught(line.id);
    setThread((t) => t && { ...t, caught: t.caught.map((c) => ({ ...c, lines: c.lines.filter((l) => l.id !== line.id) })) });
  }, []);

  const last = thread?.messages.at(-1)?.seq ?? 0;
  const channelId = thread?.channel.id;
  const readUpTo = thread?.readUpTo ?? 0;
  const markRead = useCallback(() => {
    if (!channelId || last <= readUpTo) return;
    setThread((t) => t && { ...t, readUpTo: Math.max(t.readUpTo, last) });
    api.readChat(channelId, last).catch(() => {});
  }, [channelId, last, readUpTo]);

  // A writer who stopped drops off when their time is up.
  useEffect(() => {
    if (!writers.length) return;
    const t = setTimeout(() => setWriters((w) => w.filter((x) => x.until > Date.now())), Math.max(200, Math.min(...writers.map((x) => x.until)) - Date.now()));
    return () => clearTimeout(t);
  }, [writers]);
  const lastTyping = useRef(0);
  const typingNow = useCallback(() => {
    if (Date.now() - lastTyping.current < TYPING_EVERY_MS) return;
    lastTyping.current = Date.now();
    api.chatTyping(roomId).catch(() => {});
  }, [roomId]);

  const queue = useRef(serial());
  const post = useCallback(
    (key: string, text: string, replyTo?: string | null) => {
      void queue.current(() => api.sendChat(roomId, { text, key, replyTo: replyTo ?? undefined })).then(apply, () =>
        setPending((list) => list.map((p) => (p.key === key ? { ...p, state: "failed" as const } : p))),
      );
    },
    [roomId, apply, setPending],
  );
  const send = useCallback(
    (text: string, replyTo?: string | null) => {
      const key = newKey();
      setPending((list) => [...list, { key, text, ts: Date.now(), state: "sending", replyTo: replyTo ?? null }]);
      lastTyping.current = 0;
      post(key, text, replyTo);
    },
    [post, setPending],
  );
  const retry = useCallback(
    (key: string) => {
      const p = pending.find((x) => x.key === key);
      if (!p || p.state !== "failed") return;
      setPending((list) => list.map((x) => (x.key === key ? { ...x, state: "sending" as const } : x)));
      // The same key: if the first try was saved after all, the server gives that message back.
      post(key, p.text, p.replyTo);
    },
    [pending, post, setPending],
  );
  const discard = useCallback((key: string) => setPending((list) => list.filter((p) => p.key !== key)), [setPending]);

  for (const m of thread?.messages ?? []) heard.current.known.add(m.id);
  const fresh = thread ? thread.messages.filter((m) => m.seq > thread.readUpTo && m.authorId !== me && !m.deletedAt) : [];
  const mentions = fresh.filter(mentionsMe).length;
  const typing = useMemo(() => writers.map((w) => w.name), [writers]);
  const unread = fresh.length;
  // The same object until something in it changes, so the thread isn't drawn again when the page around it is.
  return useMemo(
    () => ({ thread, error, unread, mentions, mentionsMe, hasOlder, loadOlder, markRead, apply, removeCaught, reload, pending, send, retry, discard, typing, typingNow, answering }),
    [thread, error, unread, mentions, mentionsMe, hasOlder, loadOlder, markRead, apply, removeCaught, reload, pending, send, retry, discard, typing, typingNow, answering],
  );
}

const readSession = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const dayLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return (d.getFullYear() === today.getFullYear() ? LONG_DAY : LONG_DAY_YEAR).format(d);
};
// Made once: a thread asks for a day label twice per message.
const LONG_DAY = new Intl.DateTimeFormat([], { weekday: "long", month: "short", day: "numeric" });
const LONG_DAY_YEAR = new Intl.DateTimeFormat([], { weekday: "long", month: "short", day: "numeric", year: "numeric" });
/** One empty list for every row with nothing under it, so a row with nothing new is the same row. */
const NONE: never[] = [];

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
/** "4:46", without AM or PM: the day line above says which day, and the full time is the title. */
const shortTime = (ts: number) => fmtTime(ts).replace(/\s?[AP]M$/i, "");

const newKey = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Drawn again only when the thread or what it was given changes, not each time the page around it is. */
export const SpaceChat = memo(SpaceChatThread);

function SpaceChatThread(props: {
  roomId: string;
  me: { id: string; name: string };
  chat: SpaceChatState;
  onOpenTask?: (id: string) => void;
  /** Each rise puts the cursor in the box. */
  focus?: number;
  /** The space's name, for the box. */
  name?: string;
}) {
  const { roomId, me, chat } = props;
  const { thread } = chat;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Where you had read to when the tab opened: the "New" line sits there, and stays while you read.
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // On a touch screen a message of yours shows its tools once you tap it.
  const [picked, setPicked] = useState<string | null>(null);
  // The message the next one answers, shown above the box until it is sent or dropped.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The newest message you had in view when you scrolled up from the foot; null while you're at it.
  const [awayAt, setAwayAt] = useState<number | null>(null);
  const loaded = !!thread;
  useEffect(() => {
    // Only when the thread first arrives.
    if (loaded) setNewFrom((v) => v ?? thread.readUpTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Reading: with the tab in front, everything shown has been read.
  const last = thread?.messages.at(-1)?.seq ?? 0;
  const { markRead } = chat;
  useEffect(() => {
    const read = () => document.visibilityState === "visible" && markRead();
    read();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
    };
  }, [last, markRead]);

  const lastRef = useRef(last);
  lastRef.current = last;
  const follow = (atFoot: boolean) => {
    stick.current = atFoot;
    setAwayAt((v) => (atFoot ? null : (v ?? lastRef.current)));
  };
  // What came in under the fold since you scrolled up, for the pill that takes you down to it.
  const below = awayAt === null ? [] : (thread?.messages ?? []).filter((m) => m.seq > awayAt && m.authorId !== me.id && !m.deletedAt);
  const belowMentions = below.filter(chat.mentionsMe).length;
  const toFoot = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    if (!el || el.scrollHeight <= el.clientHeight) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    follow(true);
  };

  // A first name reads faster than a full one; two people who share it keep their full names.
  const shortName = useMemo(() => {
    const firsts = new Map<string, number>();
    for (const p of thread?.people ?? []) firsts.set(first(p.name), (firsts.get(first(p.name)) ?? 0) + 1);
    return (name: string) => ((firsts.get(first(name)) ?? 0) > 1 ? name : first(name));
  }, [thread?.people]);

  const byId = useMemo(() => new Map((thread?.messages ?? []).map((m) => [m.id, m])), [thread?.messages]);
  const replying = replyingTo ? (byId.get(replyingTo) ?? null) : null;
  // A quote takes you to the message it answers, when that one is on the page.
  const showMessage = (seq: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  };

  const rows = useMemo(() => {
    const out: Array<{ m: ChatMessage; day: string | null; head: boolean; fresh: boolean; caught: CaughtLine[]; recap: ChatCaught | null; reports: ChatReport[]; calls: ChatCall[]; pending: PendingMessage["state"] | null; readBy: string[] }> = [];
    const called = placeReports(thread?.messages ?? [], thread?.calls ?? []);
    const reported = placeReports(thread?.messages ?? [], thread?.reports ?? []);
    const placed = placeCaught(thread?.messages ?? [], thread?.caught ?? [], thread?.channel.openSessionId ?? null);
    const reads = placeReads(thread?.messages ?? [], thread?.reads ?? []);
    const states = new Map(chat.pending.map((p) => [p.key, p.state]));
    const shown = thread ? [...thread.messages, ...chat.pending.map((p) => asMessage(p, me, thread.channel.id))] : [];
    let marked = false;
    for (const m of shown) {
      const prev = out.at(-1)?.m;
      const day = !prev || dayLabel(prev.ts) !== dayLabel(m.ts) ? dayLabel(m.ts) : null;
      const fresh = !marked && newFrom !== null && newFrom > 0 && m.seq > newFrom && m.authorId !== me.id;
      if (fresh) marked = true;
      // What Stand put under the last message breaks the block: the next one starts under its name again.
      const broken = !!prev && (placed.lines.has(prev.id) || placed.recaps.has(prev.id) || reported.has(prev.id) || called.has(prev.id));
      out.push({
        m,
        day,
        fresh,
        head: !!day || fresh || broken || !prev || prev.authorId !== m.authorId || m.ts - prev.ts > BLOCK_MS,
        caught: placed.lines.get(m.id) ?? NONE,
        recap: placed.recaps.get(m.id) ?? null,
        reports: reported.get(m.id) ?? NONE,
        calls: called.get(m.id) ?? NONE,
        pending: (m.sessionId === "" && m.key && states.get(m.key)) || null,
        readBy: reads.get(m.id) ?? NONE,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.messages, thread?.caught, thread?.reports, thread?.calls, thread?.reads, thread?.channel.openSessionId, chat.pending, newFrom, me.id, me.name]);

  // The newest message stays in view, unless you scrolled up to read older ones. The thread scrolls
  // on a wide screen and the page on a phone, so both are kept.
  useEffect(() => {
    const onScroll = () => {
      // Only on a phone, where the page scrolls and the thread doesn't.
      const el = scroller.current;
      if (el && el.scrollHeight > el.clientHeight) return;
      follow(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 60);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    if (el.scrollHeight <= el.clientHeight) window.scrollTo(0, document.documentElement.scrollHeight);
  }, [rows, chat.answering]);

  // One function each for every row, reading what is current when it runs: a row whose message
  // hasn't changed is then left alone when another message arrives or someone starts typing.
  const now = useRef({ chat, showMessage });
  now.current = { chat, showMessage };
  const onRetry = useCallback((m: ChatMessage) => void (m.key && now.current.chat.retry(m.key)), []);
  const onDiscard = useCallback((m: ChatMessage) => void (m.key && now.current.chat.discard(m.key)), []);
  const onReply = useCallback((m: ChatMessage) => {
    setReplyingTo(m.id);
    setPicked(null);
  }, []);
  const onPick = useCallback((m: ChatMessage) => setPicked((v) => (v === m.id ? null : m.id)), []);
  const onEdit = useCallback((m: ChatMessage, on: boolean) => setEditing(on ? m.id : null), []);
  const onShowQuoted = useCallback((seq: number) => now.current.showMessage(seq), []);

  const older = async () => {
    const el = scroller.current;
    const before = [el?.scrollHeight ?? 0, document.documentElement.scrollHeight];
    setLoadingOlder(true);
    try {
      await chat.loadOlder();
      // The message you were looking at stays where it was.
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before[0];
        window.scrollBy(0, document.documentElement.scrollHeight - before[1]);
      });
    } catch (err) {
      errorToast("Couldn't load earlier messages")(err);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (!thread)
    return chat.error ? (
      <p className="error">
        {chat.error}{" "}
        <button className="link" onClick={chat.reload}>
          Try again
        </button>
      </p>
    ) : (
      <p className="muted">Loading…</p>
    );

  return (
    <div className="space-chat">
      <div
        className="chat-thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {chat.hasOlder && (
          <button className="link chat-older" disabled={loadingOlder} onClick={older}>
            {loadingOlder ? "Loading…" : "Show earlier messages"}
          </button>
        )}
        {rows.length === 0 && (
          <p className="sh-card-empty chat-empty">
            Nothing here yet.
          </p>
        )}
        {rows.map(({ m, day, head, fresh, caught, recap, reports, calls, pending, readBy }, i) => (
          <MessageRow
            key={m.id}
            pending={pending}
            readBy={readBy}
            onRetry={onRetry}
            onDiscard={onDiscard}
            m={m}
            name={shortName(m.author)}
            meId={me.id}
            // An answer right under what it answers needs no quote.
            showQuote={!!m.replyTo && rows[i - 1]?.m.id !== m.replyTo}
            quoted={m.replyTo ? (byId.get(m.replyTo) ?? null) : null}
            quotedName={m.replyTo && byId.get(m.replyTo) ? shortName(byId.get(m.replyTo)!.author) : null}
            onShowQuoted={onShowQuoted}
            onReply={onReply}
            day={day}
            head={head}
            fresh={fresh}
            mentionsMe={chat.mentionsMe(m)}
            caught={caught}
            recap={recap}
            reports={reports}
            calls={calls}
            onOpenTask={props.onOpenTask}
            onRemoveCaught={chat.removeCaught}
            mine={m.authorId === me.id}
            editing={editing === m.id}
            picked={picked === m.id}
            onPick={onPick}
            onEdit={onEdit}
            onChanged={chat.apply}
          />
        ))}
        {chat.answering.map((a) => (
          <div key={a.askId} className="chat-msg head answering" role="status">
            <div className="chat-msg-side">
              <Avatar id={STAND_NAME} name={STAND_NAME} size={24} />
            </div>
            <div className="chat-msg-body">
              <div className="chat-msg-head">
                <span className="chat-msg-who">{STAND_NAME}</span>
                {a.status && <span className="chat-answering-status">{a.status}</span>}
              </div>
              {a.text && <p className="chat-msg-text">{a.text}</p>}
            </div>
          </div>
        ))}
      </div>
      {below.length > 0 && (
        <button type="button" className={belowMentions ? "chat-jump mention" : "chat-jump"} onClick={toFoot}>
          <span aria-hidden>↓</span>
          {belowMentions ? `${belowMentions === 1 ? "A new message mentions" : `${belowMentions} new messages mention`} you` : `${below.length} new ${below.length === 1 ? "message" : "messages"}`}
        </button>
      )}
      {chat.typing.length > 0 && (
        <p className="chat-typing" role="status">
          {typingLine(chat.typing.map(shortName))}
        </p>
      )}
      <Composer
        focus={props.focus}
        focusKey={replyingTo}
        name={props.name}
        roomId={roomId}
        people={[{ id: STAND_AUTHOR, name: STAND_NAME }, ...thread.people.filter((p) => p.id !== me.id)]}
        replying={replying && !replying.deletedAt ? { name: shortName(replying.author), text: replying.text } : null}
        onCancelReply={() => setReplyingTo(null)}
        onTyping={chat.typingNow}
        onSend={(text) => {
          follow(true);
          chat.send(text, replying && !replying.deletedAt ? replying.id : undefined);
          setReplyingTo(null);
        }}
      />
    </div>
  );
}

const MessageRow = memo(MessageRowView);

function MessageRowView(props: {
  m: ChatMessage;
  /** The author's name as the thread shows it. */
  name: string;
  meId: string;
  /** The message this one answers, when it is on the page. */
  showQuote: boolean;
  quoted: ChatMessage | null;
  quotedName: string | null;
  onShowQuoted: (seq: number) => void;
  onReply: (m: ChatMessage) => void;
  /** Not saved yet: on its way, or failed and waiting for Retry. */
  pending: PendingMessage["state"] | null;
  /** The other people whose reading stops at this message. */
  readBy: string[];
  onRetry: (m: ChatMessage) => void;
  onDiscard: (m: ChatMessage) => void;
  day: string | null;
  head: boolean;
  fresh: boolean;
  mentionsMe: boolean;
  caught: CaughtLine[];
  recap: ChatCaught | null;
  reports: ChatReport[];
  calls: ChatCall[];
  onOpenTask?: (id: string) => void;
  onRemoveCaught: (line: CaughtLine) => Promise<void>;
  mine: boolean;
  editing: boolean;
  picked: boolean;
  onPick: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage, on: boolean) => void;
  onChanged: (m: ChatMessage) => void;
}) {
  const { m, mine } = props;
  const [draft, setDraft] = useState(m.text);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const react = (emoji: string) => {
    setChoosing(false);
    api.reactChat(m.id, emoji).then(props.onChanged, errorToast("Couldn't add the reaction"));
  };
  const toTodo = () => {
    api.chatToTodo(m.id).then((t) => {
      const open = props.onOpenTask;
      toast({ text: "Added to Tasks", ...(open ? { action: { label: "Open", run: () => open(t.id) } } : {}) });
    }, errorToast("Couldn't make the to-do"));
  };
  useEffect(() => {
    if (props.editing) setDraft(m.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editing]);

  const save = async () => {
    const text = draft.trim();
    if (!text || text === m.text) return props.onEdit(m, false);
    setSaving(true);
    try {
      props.onChanged(await api.editChat(m.id, text));
      props.onEdit(m, false);
    } catch (err) {
      errorToast("Couldn't save the change")(err);
    } finally {
      setSaving(false);
    }
  };
  const remove = () => {
    if (!confirm("Delete this message for everyone?")) return;
    api.deleteChat(m.id).then(props.onChanged, errorToast("Couldn't delete the message"));
  };

  return (
    <>
      {(props.day || props.fresh) && (
        <div className={props.fresh ? "chat-day new" : "chat-day"} role="separator">
          <span>{[props.day, props.fresh && "New"].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      <div
        className={`chat-msg${props.head ? " head" : ""}${m.deletedAt ? " deleted" : ""}${props.mentionsMe ? " mentions-you" : ""}${props.pending ? ` ${props.pending === "failed" ? "failed" : "pending"}` : ""}${props.picked ? " picked" : ""}`}
        data-seq={props.pending ? undefined : m.seq}
        onClick={!props.pending && !m.deletedAt && !props.editing ? (e) => !(e.target as HTMLElement).closest("a, button, textarea") && props.onPick(m) : undefined}
        onMouseLeave={() => setChoosing(false)}
      >
        <div className="chat-msg-side">
          {props.head ? <Avatar id={m.author} name={m.author} size={24} /> : <span className="chat-msg-time">{shortTime(m.ts)}</span>}
        </div>
        <div className="chat-msg-body">
          {props.head && (
            <div className="chat-msg-head">
              <span className="chat-msg-who" title={m.author}>
                {props.name}
              </span>
              <span className="chat-msg-at" title={fmtFull(m.ts)}>
                {shortTime(m.ts)}
              </span>
            </div>
          )}
          {props.showQuote && !m.deletedAt && (
            <button type="button" className="chat-quote" disabled={!props.quoted} onClick={() => props.quoted && props.onShowQuoted(props.quoted.seq)}>
              {props.quoted ? (
                <>
                  <b>{props.quotedName}</b>
                  <span>{props.quoted.deletedAt ? "Message deleted" : props.quoted.text}</span>
                </>
              ) : (
                <span>An earlier message</span>
              )}
            </button>
          )}
          {m.deletedAt ? (
            <p className="chat-msg-text">Message deleted</p>
          ) : props.editing ? (
            <form
              className="chat-edit"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <textarea
                autoFocus
                aria-label="Change your message"
                value={draft}
                maxLength={TEXT_MAX}
                readOnly={saving}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") props.onEdit(m, false);
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
              <span className="chat-edit-foot">
                <button type="button" className="link" onClick={() => props.onEdit(m, false)}>
                  Cancel
                </button>
                <button type="submit" disabled={saving || !draft.trim()}>
                  Save
                </button>
              </span>
            </form>
          ) : (
            <p className="chat-msg-text">
              <Linkified text={m.text} />
              {m.editedAt && <span className="chat-msg-edited"> (edited)</span>}
            </p>
          )}
          {!m.deletedAt && m.answer && <AnswerFoot m={m} onTodo={toTodo} onOpenTask={props.onOpenTask} />}
          {!m.deletedAt && m.reactions.length > 0 && (
            <div className="chat-reacts">
              {m.reactions.map((r) => {
                const on = r.by.some((p) => p.id === props.meId);
                return (
                  <button key={r.emoji} type="button" className={on ? "chat-react on" : "chat-react"} aria-pressed={on} title={r.by.map((p) => p.name).join(", ")} onClick={() => react(r.emoji)}>
                    <span aria-hidden>{r.emoji}</span>
                    <span className="sr-only">{r.emoji} </span>
                    {r.by.length}
                  </button>
                );
              })}
            </div>
          )}
          {props.pending === "sending" && <span className="sr-only">Sending</span>}
          {props.pending === "failed" && (
            <p className="chat-msg-unsent" role="status">
              Not sent.{" "}
              <button type="button" className="link" onClick={() => props.onRetry(m)}>
                Retry
              </button>{" "}
              ·{" "}
              <button type="button" className="link" onClick={() => props.onDiscard(m)}>
                Delete
              </button>
            </p>
          )}
        </div>
        {!props.pending && !m.deletedAt && !props.editing && (
          <span className={choosing ? "chat-msg-tools choosing" : "chat-msg-tools"}>
            {choosing ? (
              QUICK.map((e) => (
                <button key={e} className="icon-btn chat-emoji" aria-label={`React with ${e}`} onClick={() => react(e)}>
                  {e}
                </button>
              ))
            ) : (
              <>
                <button className="icon-btn" aria-label="React" title="React" onClick={() => setChoosing(true)}>
                  <SmilePlus size={15} />
                </button>
                <button className="icon-btn" aria-label="Reply" title="Reply" onClick={() => props.onReply(m)}>
                  <Reply size={15} />
                </button>
                {!m.answer && (
                  <button className="icon-btn" aria-label="Make a to-do" title="Make a to-do" onClick={toTodo}>
                    <ListPlus size={15} />
                  </button>
                )}
              </>
            )}
            {mine && !choosing && (
              <>
            <button className="icon-btn" aria-label="Change your message" title="Change" onClick={() => props.onEdit(m, true)}>
              <EditIcon />
            </button>
            <button className="icon-btn" aria-label="Delete your message" title="Delete" onClick={remove}>
              <TrashIcon />
            </button>
              </>
            )}
          </span>
        )}
      </div>
      {props.caught.length > 0 && (
        <div className="chat-caughts">
          {props.caught.map((line) => (
            <CaughtRow key={line.id} line={line} onOpen={props.onOpenTask} onRemove={props.onRemoveCaught} />
          ))}
        </div>
      )}
      {props.reports.length > 0 && (
        <div className="chat-caughts">
          {props.reports.map((r) => (
            <div key={r.id} className={`chat-caught report ${r.status}`}>
              <button type="button" className="chat-caught-open" title={`${r.by}: ${r.text}`} onClick={() => props.onOpenTask?.(r.taskId)}>
                <span className="chat-caught-label">{REPORT_LABEL[r.status]}</span>
                <span className="chat-caught-text">{r.task || r.text}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {props.recap && <SessionRecap caught={props.recap} />}
      {props.calls.map((c) => (
        <div key={c.id} className="chat-recap">
          <a className="chat-recap-head" href={`/meetings/${c.id}`} title="Open the call's recap, with its chat">
            <strong>Call</strong>
            <span>
              · {c.messages} {c.messages === 1 ? "message" : "messages"} in its chat · {shortTime(c.ts)}
            </span>
            <ChevronIcon />
          </a>
        </div>
      ))}
      {props.readBy.length > 0 && <ReadMarks names={props.readBy} />}
    </>
  );
}

const REPORT_LABEL: Record<ChatReport["status"], string> = { ready: "Ready", done: "Done", blocked: "Blocked", needs_decision: "Needs you" };

/** Under an answer of Stand's: what it leaned on, and the next step it suggests. */
function AnswerFoot({ m, onTodo, onOpenTask }: { m: ChatMessage; onTodo: () => void; onOpenTask?: (id: string) => void }) {
  const a = m.answer!;
  if (!a.sources.length && !a.fromSpace.length && !a.todo) return null;
  return (
    <div className="chat-answer-foot">
      {a.fromSpace.map((f, i) => (
        <p key={i} className="chat-answer-line">
          <span className="chat-answer-label">{fmtDay(f.when)}</span>
          <span>{f.text}</span>
        </p>
      ))}
      {a.sources.length > 0 && (
        <p className="chat-answer-line">
          {a.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.url}>
              {s.title}
            </a>
          ))}
        </p>
      )}
      {a.todo && (
        <p className="chat-answer-line">
          <span className="chat-caught-label">To-do</span>
          <span>{a.todo}</span>
          {a.todoId ? (
            <button type="button" className="link" onClick={() => onOpenTask?.(a.todoId!)}>
              Open
            </button>
          ) : (
            <button type="button" className="link" onClick={onTodo}>
              Add
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** "Maya is typing", for one, two or a crowd. */
export function typingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return "Several people are typing";
}

/** Who has read up to a message and no further, as small faces at its right. */
function ReadMarks({ names }: { names: string[] }) {
  const label = `Read up to here by ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
  return (
    <div className="chat-reads" title={label}>
      <span className="sr-only">{label}</span>
      {names.map((name) => (
        <Avatar key={name} id={name} name={name} size={18} />
      ))}
    </div>
  );
}

/** The Tasks tab's words for each kind. */
const CAUGHT_LABEL: Record<CaughtLine["kind"], string> = { action: "To-do", decision: "Decided", question: "Open" };
const CAUGHT_NAME: Record<CaughtLine["kind"], string> = { action: "to-do", decision: "decision", question: "open question" };

/** A to-do, open question or decision Stand caught, as one chip under the message it came from. */
function CaughtRow(props: { line: CaughtLine; onOpen?: (id: string) => void; onRemove: (line: CaughtLine) => Promise<void> }) {
  const { line } = props;
  const [removing, setRemoving] = useState(false);
  // A to-do or a question opens as a task. A decision has no page of its own.
  const opens = line.kind !== "decision" && props.onOpen;
  const remove = () => {
    if (!confirm(`Remove this ${CAUGHT_NAME[line.kind]}? Stand won't add it again from this stretch of chat.`)) return;
    setRemoving(true);
    props.onRemove(line).catch((err) => {
      setRemoving(false);
      errorToast("Couldn't remove it")(err);
    });
  };
  const said = `${CAUGHT_LABEL[line.kind]}: ${line.text}${line.owner ? ` · ${line.owner}` : ""}`;
  const inner = (
    <>
      <strong className="chat-caught-label">{CAUGHT_LABEL[line.kind]}</strong>
      <span className="chat-caught-text">{line.text}</span>
    </>
  );
  return (
    <div className={`chat-caught ${line.kind}${line.closed ? " closed" : ""}`} role="note" data-caught={line.id} title={said}>
      {opens ? (
        <button type="button" className="chat-caught-open" aria-label={said} onClick={() => props.onOpen!(line.id)}>
          {inner}
        </button>
      ) : (
        <span className="chat-caught-open">{inner}</span>
      )}
      {line.owner && <Avatar id={line.owner} name={line.owner} size={16} />}
      <button type="button" className="chat-caught-remove" disabled={removing} aria-label={`Remove this ${CAUGHT_NAME[line.kind]}`} title="Not one: remove it" onClick={remove}>
        <CloseIcon size={10} />
      </button>
    </div>
  );
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a stretch of chat was about, after its last message, once it has closed: one line that opens to the summary. */
function SessionRecap({ caught }: { caught: ChatCaught }) {
  const [open, setOpen] = useState(false);
  const n = (k: CaughtLine["kind"]) => caught.lines.filter((l) => l.kind === k).length;
  const counts = [n("action") && counted(n("action"), "to-do", "to-dos"), n("decision") && `${n("decision")} decided`, n("question") && `${n("question")} open`].filter(Boolean);
  const title = caught.topics[0]?.topic ?? "Summary";
  const more = caught.topics.slice(1);
  if (!caught.summary && !caught.topics.length) return null;
  return (
    <div className={open ? "chat-recap open" : "chat-recap"} role="note">
      <button type="button" className="chat-recap-head" aria-expanded={open} disabled={!caught.summary && !more.length} onClick={() => setOpen((o) => !o)}>
        <strong>{title}</strong>
        {more.length > 0 && <span className="chat-recap-n">+{more.length}</span>}
        {counts.length > 0 && <span className="chat-recap-n">· {counts.join(" · ")}</span>}
        {(caught.summary || more.length > 0) && <ChevronIcon />}
      </button>
      {open && caught.summary && <p className="chat-recap-summary">{caught.summary}</p>}
      {open && more.length > 0 && (
        <ul className="chat-recap-topics">
          {more.map((t) => (
            <li key={t.id}>{t.topic}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The box at the foot of the thread. Enter sends, and Shift+Enter makes a new line. */
function Composer(props: {
  roomId: string;
  people: Array<{ id: string; name: string }>;
  onSend: (text: string) => void;
  focus?: number;
  /** Changes when the box should take the keys again, as when a reply starts. */
  focusKey?: string | null;
  name?: string;
  replying?: { name: string; text: string } | null;
  onCancelReply?: () => void;
  onTyping?: () => void;
}) {
  const draftKey = `stand.chatDraft.${props.roomId}`;
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (props.focus || props.focusKey) form.current?.querySelector("textarea")?.focus();
  }, [props.focus, props.focusKey]);
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const keep = (value: string) => {
    if (value.trim() && value !== text) props.onTyping?.();
    setText(value);
    try {
      sessionStorage.setItem(draftKey, value);
    } catch {}
  };
  // The box clears at once: the message shows in the thread while it is saved (useSpaceChat's send).
  const send = () => {
    const t = text.trim();
    if (!t) return;
    props.onSend(t);
    keep("");
  };
  return (
    <form
      ref={form}
      className="chat-compose"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {props.replying && (
        <p className="chat-replying">
          <span>
            Replying to <b>{props.replying.name}</b> {props.replying.text}
          </span>
          <button type="button" className="icon-btn" aria-label="Don't reply" title="Don't reply" onClick={props.onCancelReply}>
            <CloseIcon />
          </button>
        </p>
      )}
      <MentionTextarea
        aria-label="Write to the space"
        placeholder={props.name ? `Message ${props.name}` : "Message the space"}
        rows={1}
        value={text}
        maxLength={TEXT_MAX}
        people={props.people}
        onChange={keep}
        onKeyDown={(e) => {
          if (e.key === "Escape" && props.replying) props.onCancelReply?.();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
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

/** For people with the iPhone app: whether this space's chat notifies them of every message or only
 *  @mentions and replies. Hidden for everyone else, since nothing reaches them either way. */
export function ChatNotifyBell(props: { roomId: string }) {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  useEffect(() => {
    let live = true;
    api.notify(props.roomId).then((s) => live && setStatus(s), () => {});
    return () => {
      live = false;
    };
  }, [props.roomId]);
  if (!status?.devices) return null;
  const all = status.level === "all";
  const flip = () => {
    const level = all ? "mentions" : "all";
    setStatus({ ...status, level });
    api.setNotify(props.roomId, level).then(setStatus, () => setStatus(status));
  };
  return (
    <button
      type="button"
      className={all ? "icon-btn chat-bell" : "icon-btn chat-bell muted"}
      aria-pressed={!all}
      aria-label={all ? "Notifying you of every message. Switch to @mentions only" : "Notifying you of @mentions only. Switch to every message"}
      title={all ? "Every message notifies your phone. Click for @mentions only" : "Only @mentions and replies notify your phone. Click for every message"}
      onClick={flip}
    >
      {all ? <Bell size={14} aria-hidden /> : <BellOff size={14} aria-hidden />}
    </button>
  );
}
