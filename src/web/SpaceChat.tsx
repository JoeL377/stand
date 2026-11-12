// The space's chat: what people write to each other between meetings. The thread is read here and
// kept up to date by the space's event stream; sending, editing and deleting are plain requests.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CaughtLine, ChatCaught, ChatEvent, ChatMessage, ChatThread } from "../shared/chat.ts";
import { mentionedIn } from "../shared/mentions.ts";
import { api } from "./api.ts";
import { mergeCaught, placeCaught } from "./chatCaught.ts";
import { asMessage, restore, serial, unsaved, type PendingMessage } from "./chatPending.ts";
import { CloseIcon, EditIcon, SendIcon, TrashIcon } from "./icons.tsx";
import { Linkified } from "./Linkified.tsx";
import { MentionTextarea } from "./MentionTextarea.tsx";
import { usePersonColors } from "./PersonColors.tsx";
import { Avatar } from "./room/Stage.tsx";
import { errorToast } from "./Toasts.tsx";
import { fmtTime } from "./util.ts";

const TEXT_MAX = 4000;
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
  send: (text: string) => void;
  retry: (key: string) => void;
  discard: (key: string) => void;
}

/** A space's chat, loaded once and then fed by the space's event stream for as long as the page is open.
 *  onMention hears each new message that tags you, as it arrives. */
export function useSpaceChat(roomId: string, me: string, onMention?: (m: ChatMessage) => void): SpaceChatState {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
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

  const people = thread?.people;
  const mentionsMe = useCallback((m: ChatMessage) => !m.deletedAt && m.authorId !== me && !!people && m.text.includes("@") && mentionedIn(m.text, people).includes(me), [people, me]);
  // The stream outlives a render: it reads these as they are now.
  const heard = useRef({ mentionsMe, onMention, known: new Set<string>() });
  heard.current.mentionsMe = mentionsMe;
  heard.current.onMention = onMention;

  const apply = useCallback((m: ChatMessage) => {
    setThread((t) => {
      if (!t || m.channelId !== t.channel.id) return t;
      const at = t.messages.findIndex((x) => x.id === m.id);
      const messages = at >= 0 ? t.messages.map((x) => (x.id === m.id ? m : x)) : [...t.messages, m].sort((a, b) => a.seq - b.seq);
      return { ...t, messages };
    });
  }, []);

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
      if (e.type === "message") {
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
  }, [roomId, reload, apply]);

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

  const queue = useRef(serial());
  const post = useCallback(
    (key: string, text: string) => {
      void queue.current(() => api.sendChat(roomId, { text, key })).then(apply, () =>
        setPending((list) => list.map((p) => (p.key === key ? { ...p, state: "failed" as const } : p))),
      );
    },
    [roomId, apply, setPending],
  );
  const send = useCallback(
    (text: string) => {
      const key = newKey();
      setPending((list) => [...list, { key, text, ts: Date.now(), state: "sending" }]);
      post(key, text);
    },
    [post, setPending],
  );
  const retry = useCallback(
    (key: string) => {
      const p = pending.find((x) => x.key === key);
      if (!p || p.state !== "failed") return;
      setPending((list) => list.map((x) => (x.key === key ? { ...x, state: "sending" as const } : x)));
      // The same key: if the first try was saved after all, the server gives that message back.
      post(key, p.text);
    },
    [pending, post, setPending],
  );
  const discard = useCallback((key: string) => setPending((list) => list.filter((p) => p.key !== key)), [setPending]);

  for (const m of thread?.messages ?? []) heard.current.known.add(m.id);
  const fresh = thread ? thread.messages.filter((m) => m.seq > thread.readUpTo && m.authorId !== me && !m.deletedAt) : [];
  const mentions = fresh.filter(mentionsMe).length;
  return { thread, error, unread: fresh.length, mentions, mentionsMe, hasOlder, loadOlder, markRead, apply, removeCaught, reload, pending, send, retry, discard };
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
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

const newKey = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function SpaceChat(props: {
  roomId: string;
  me: { id: string; name: string };
  chat: SpaceChatState;
  onOpenTask?: (id: string) => void;
  /** Each rise puts the cursor in the box. */
  focus?: number;
}) {
  const { roomId, me, chat } = props;
  const { thread } = chat;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Where you had read to when the tab opened: the "New" line sits there, and stays while you read.
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
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

  const rows = useMemo(() => {
    const out: Array<{ m: ChatMessage; day: string | null; head: boolean; fresh: boolean; caught: CaughtLine[]; recap: ChatCaught | null; pending: PendingMessage["state"] | null }> = [];
    const placed = placeCaught(thread?.messages ?? [], thread?.caught ?? [], thread?.channel.openSessionId ?? null);
    const states = new Map(chat.pending.map((p) => [p.key, p.state]));
    const shown = thread ? [...thread.messages, ...chat.pending.map((p) => asMessage(p, me, thread.channel.id))] : [];
    let marked = false;
    for (const m of shown) {
      const prev = out.at(-1)?.m;
      const day = !prev || dayLabel(prev.ts) !== dayLabel(m.ts) ? dayLabel(m.ts) : null;
      const fresh = !marked && newFrom !== null && newFrom > 0 && m.seq > newFrom && m.authorId !== me.id;
      if (fresh) marked = true;
      // What Stand put under the last message breaks the block: the next one starts under its name again.
      const broken = !!prev && (placed.lines.has(prev.id) || placed.recaps.has(prev.id));
      out.push({
        m,
        day,
        fresh,
        head: !!day || fresh || broken || !prev || prev.authorId !== m.authorId || m.ts - prev.ts > BLOCK_MS,
        caught: placed.lines.get(m.id) ?? [],
        recap: placed.recaps.get(m.id) ?? null,
        pending: (m.sessionId === "" && m.key && states.get(m.key)) || null,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.messages, thread?.caught, thread?.channel.openSessionId, chat.pending, newFrom, me.id, me.name]);

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
  }, [rows]);

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
            Nothing here yet. Write to the people in this space between meetings: what you send stays here for them to read.
          </p>
        )}
        {rows.map(({ m, day, head, fresh, caught, recap, pending }) => (
          <MessageRow
            key={m.id}
            pending={pending}
            onRetry={() => m.key && chat.retry(m.key)}
            onDiscard={() => m.key && chat.discard(m.key)}
            m={m}
            day={day}
            head={head}
            fresh={fresh}
            mentionsMe={chat.mentionsMe(m)}
            caught={caught}
            recap={recap}
            onOpenTask={props.onOpenTask}
            onRemoveCaught={chat.removeCaught}
            mine={m.authorId === me.id}
            editing={editing === m.id}
            onEdit={(on) => setEditing(on ? m.id : null)}
            onChanged={chat.apply}
          />
        ))}
      </div>
      {below.length > 0 && (
        <button type="button" className={belowMentions ? "chat-jump mention" : "chat-jump"} onClick={toFoot}>
          <span aria-hidden>↓</span>
          {belowMentions ? `${belowMentions === 1 ? "A new message mentions" : `${belowMentions} new messages mention`} you` : `${below.length} new ${below.length === 1 ? "message" : "messages"}`}
        </button>
      )}
      <Composer
        focus={props.focus}
        roomId={roomId}
        people={thread.people.filter((p) => p.id !== me.id)}
        onSend={(text) => {
          follow(true);
          chat.send(text);
        }}
      />
    </div>
  );
}

function MessageRow(props: {
  m: ChatMessage;
  /** Not saved yet: on its way, or failed and waiting for Retry. */
  pending: PendingMessage["state"] | null;
  onRetry: () => void;
  onDiscard: () => void;
  day: string | null;
  head: boolean;
  fresh: boolean;
  mentionsMe: boolean;
  caught: CaughtLine[];
  recap: ChatCaught | null;
  onOpenTask?: (id: string) => void;
  onRemoveCaught: (line: CaughtLine) => Promise<void>;
  mine: boolean;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onChanged: (m: ChatMessage) => void;
}) {
  const { m, mine } = props;
  const colorFor = usePersonColors();
  const [draft, setDraft] = useState(m.text);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (props.editing) setDraft(m.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editing]);

  const save = async () => {
    const text = draft.trim();
    if (!text || text === m.text) return props.onEdit(false);
    setSaving(true);
    try {
      props.onChanged(await api.editChat(m.id, text));
      props.onEdit(false);
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
      {props.day && (
        <div className="chat-day" role="separator">
          <span>{props.day}</span>
        </div>
      )}
      {props.fresh && (
        <div className="chat-day new" role="separator">
          <span>New</span>
        </div>
      )}
      <div
        className={`chat-msg${props.head ? " head" : ""}${m.deletedAt ? " deleted" : ""}${props.mentionsMe ? " mentions-you" : ""}${props.pending ? ` ${props.pending === "failed" ? "failed" : "pending"}` : ""}`}
        data-seq={props.pending ? undefined : m.seq}
      >
        <div className="chat-msg-side">
          {props.head ? <Avatar id={m.author} name={m.author} size={28} /> : <span className="chat-msg-time">{fmtTime(m.ts).replace(/\s?[AP]M$/i, "")}</span>}
        </div>
        <div className="chat-msg-body">
          {props.head && (
            <div className="chat-msg-head">
              <span className="chat-msg-who" style={{ color: colorFor(m.author) }}>
                {m.author}
              </span>
              <span className="chat-msg-at">{fmtTime(m.ts)}</span>
            </div>
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
                  if (e.key === "Escape") props.onEdit(false);
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
              <span className="chat-edit-foot">
                <button type="button" className="link" onClick={() => props.onEdit(false)}>
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
          {props.pending === "sending" && <span className="sr-only">Sending</span>}
          {props.pending === "failed" && (
            <p className="chat-msg-unsent" role="status">
              Not sent.{" "}
              <button type="button" className="link" onClick={props.onRetry}>
                Retry
              </button>{" "}
              ·{" "}
              <button type="button" className="link" onClick={props.onDiscard}>
                Delete
              </button>
            </p>
          )}
        </div>
        {mine && !props.pending && !m.deletedAt && !props.editing && (
          <span className="chat-msg-tools">
            <button className="icon-btn" aria-label="Change your message" title="Change" onClick={() => props.onEdit(true)}>
              <EditIcon />
            </button>
            <button className="icon-btn" aria-label="Delete your message" title="Delete" onClick={remove}>
              <TrashIcon />
            </button>
          </span>
        )}
      </div>
      {props.caught.map((line) => (
        <CaughtRow key={line.id} line={line} onOpen={props.onOpenTask} onRemove={props.onRemoveCaught} />
      ))}
      {props.recap && <SessionRecap caught={props.recap} />}
    </>
  );
}

/** The meeting transcript's words for the same thing (room/SidePanel.tsx CaptureRow). */
const CAUGHT_LABEL: Record<CaughtLine["kind"], string> = { action: "Added to Todo!", decision: "Added to Decided!", question: "Added to Open questions!" };
const CAUGHT_NAME: Record<CaughtLine["kind"], string> = { action: "to-do", decision: "decision", question: "open question" };

/** A to-do, open question or decision Stand caught, under the message it came from. */
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
  const text = (
    <>
      <Linkified text={line.text} />
      {line.owner && <span className="chat-caught-owner"> · {line.owner}</span>}
    </>
  );
  return (
    <div className={`chat-caught ${line.kind}${line.closed ? " closed" : ""}`} role="note" data-caught={line.id}>
      <span className="agent-mark" aria-hidden>
        ✦
      </span>
      <div className="chat-caught-body">
        <strong className="chat-caught-label">{CAUGHT_LABEL[line.kind]}</strong>
        {opens ? (
          <button type="button" className="link chat-caught-text" onClick={() => props.onOpen!(line.id)}>
            {text}
          </button>
        ) : (
          <span className="chat-caught-text">{text}</span>
        )}
      </div>
      <button type="button" className="icon-btn chat-caught-remove" disabled={removing} aria-label={`Remove this ${CAUGHT_NAME[line.kind]}`} title="Not one: remove it" onClick={remove}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

/** What a stretch of chat was about, after its last message, once it has closed. */
function SessionRecap({ caught }: { caught: ChatCaught }) {
  return (
    <div className="chat-recap" role="note">
      <div className="chat-recap-head">
        <span className="agent-mark" aria-hidden>
          ✦
        </span>
        <strong>What this was about</strong>
      </div>
      {caught.summary && <p className="chat-recap-summary">{caught.summary}</p>}
      {caught.topics.length > 0 && (
        <ul className="chat-recap-topics">
          {caught.topics.map((t) => (
            <li key={t.id}>{t.topic}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The box at the foot of the thread. Enter sends, and Shift+Enter makes a new line. */
function Composer(props: { roomId: string; people: Array<{ id: string; name: string }>; onSend: (text: string) => void; focus?: number }) {
  const draftKey = `stand.chatDraft.${props.roomId}`;
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (props.focus) form.current?.querySelector("textarea")?.focus();
  }, [props.focus]);
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const keep = (value: string) => {
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
      <MentionTextarea
        aria-label="Write to the space"
        placeholder="Write to the space… Type @ for a name"
        rows={1}
        value={text}
        maxLength={TEXT_MAX}
        people={props.people}
        onChange={keep}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button type="submit" className="chat-send" aria-label="Send" disabled={!text.trim()}>
        <SendIcon />
      </button>
    </form>
  );
}
