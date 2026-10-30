// Pilot: one person at a time drives ✦ Stand (server/pilot.ts). The pilot types on an answer card's box
// (or holds Ask Stand); everyone else sees who's piloting on that card's foot, with "Ask to pilot". The
// pilot gets a small pop-up over the controls, wherever they are in the meeting: Hand over or Not now,
// with a thin bar running down to when the seat goes over by itself. The seat changing hands says so
// in a toast to the two people it moved between, and the new pilot's box takes the cursor.
import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ClientMessage, Participant, PilotView } from "../../shared/protocol.ts";
import { colorFor, initials } from "../util.ts";
import { toast } from "../Toasts.tsx";

export interface PilotActs {
  view: PilotView | null;
  me: string;
  isHost: boolean;
  participants: Participant[];
  /** Missing while nothing can be asked (offline, the meeting ending). */
  send?: (m: ClientMessage) => boolean;
}

/** Opens an answer card with its box ready (the latest one, or a new question). */
export const PILOT_OPEN = "stand:pilot-open";
export const openPilotBox = () => window.dispatchEvent(new CustomEvent(PILOT_OPEN));

/** How often the pilot's box says they're still typing. */
const TYPING_EVERY_MS = 3_000;

const first = (name: string | null) => (name ?? "").split(/\s+/)[0];

export function seatOf(acts: PilotActs | undefined) {
  const v = acts?.view ?? null;
  const free = !v?.id;
  const mine = !!v?.id && v.id === acts?.me;
  const place = v ? v.requests.findIndex((r) => r.id === acts?.me) : -1;
  return { v, free, mine, place, name: first(v?.name ?? null) };
}

function Face({ id, name, size = 18 }: { id: string; name: string; size?: number }) {
  return (
    <span className="pilot-face" style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.48)), background: colorFor(id) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** A thin bar running down to when the seat goes over by itself. */
function Countdown({ from, at }: { from: number | null; at: number | null }) {
  if (from === null || at === null) return null;
  return (
    <span className="pilot-bar" aria-hidden>
      <Run key={at} from={from} at={at} />
    </span>
  );
}
/** Set once per deadline, so a re-render doesn't restart it; a later deadline (the pilot typed) starts it again. */
function Run({ from, at }: { from: number; at: number }) {
  const [style] = useState(() => {
    const left = Math.max(0, at - Date.now());
    return { "--pilot-from": `${(left / Math.max(1, at - from)) * 100}%`, animationDuration: `${left}ms` } as CSSProperties;
  });
  return <i style={style} />;
}

/** The card head's pill: who's piloting. The pilot opens it to hand over or leave the seat; the host, to take it. */
export function PilotPill({ acts }: { acts: PilotActs }) {
  const { v, free, mine, name } = seatOf(acts);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const send = acts.send;
  const canMenu = !!send && (mine || (acts.isHost && !free));
  const others = acts.participants.filter((p) => p.id !== acts.me);
  const act = (m: ClientMessage) => {
    setOpen(false);
    send?.(m);
  };
  const label = free ? "No pilot" : `${mine ? "You" : name} · ${v!.away ? "away" : v!.idle ? "idle" : "Pilot"}`;
  return (
    <span className="pilot-pill-wrap" ref={ref}>
      <button type="button" className={["pilot-pill", free && "free", mine && "mine"].filter(Boolean).join(" ")} onClick={() => canMenu && setOpen((o) => !o)} aria-haspopup={canMenu ? "menu" : undefined} aria-expanded={canMenu ? open : undefined} disabled={!canMenu}>
        {!free && <Face id={v!.id!} name={v!.name ?? ""} />}
        {label}
      </button>
      {open && (
        <span className="pilot-menu" role="menu">
          {mine ? (
            <>
              {others.length > 0 && <span className="pilot-menu-label">Hand over to</span>}
              {others.map((p) => (
                <button key={p.id} type="button" role="menuitem" onClick={() => act({ type: "pilot.give", participantId: p.id })}>
                  <Face id={p.id} name={p.name} />
                  {p.name}
                </button>
              ))}
              <button type="button" role="menuitem" className="pilot-menu-leave" onClick={() => act({ type: "pilot.give", participantId: null })}>
                Leave the seat
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={() => act({ type: "pilot.take" })}>
              Take the seat
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/** The foot of an answer card: the pilot's box (also anyone's while the seat is free), or who's piloting
 *  with Ask to pilot. follows: the answer a question here follows up; null on a new card. */
export function PilotFoot({ acts, follows, onAsked, focus }: { acts: PilotActs; follows: string | null; onAsked?: () => void; focus?: boolean }) {
  const { mine, free } = seatOf(acts);
  if (!acts.send) return null;
  return mine || free ? <AskBox acts={acts} follows={follows} onAsked={onAsked} focus={focus} /> : <WatchLine acts={acts} />;
}

function AskBox({ acts, follows, onAsked, focus }: { acts: PilotActs; follows: string | null; onAsked?: () => void; focus?: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const typedAt = useRef(0);
  const { v, mine } = seatOf(acts);
  // The seat just came to you (or the card opened for asking): the cursor goes in the box.
  const handedAt = v?.last?.toId === acts.me && v.last.how !== "free" ? v.last.at : 0;
  useEffect(() => {
    if (focus || (handedAt && (v?.now ?? 0) - handedAt < 5_000)) ref.current?.focus({ preventScroll: true });
  }, [handedAt, focus]);
  // Grows with what's typed, up to a few lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  const typing = (on: boolean) => {
    if (!mine) return;
    if (on && Date.now() - typedAt.current < TYPING_EVERY_MS) return;
    typedAt.current = on ? Date.now() : 0;
    acts.send?.({ type: "pilot.typing", on });
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || !acts.send?.({ type: "agent.ask.text", text: q, follows })) return;
    setText("");
    typedAt.current = 0;
    onAsked?.();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form className="ask-box" onSubmit={submit}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={follows ? "Follow up" : "Ask Stand"}
        aria-label={follows ? "Follow up with Stand" : "Ask Stand"}
        maxLength={1000}
        onChange={(e) => {
          setText(e.target.value);
          typing(!!e.target.value.trim());
        }}
        onBlur={() => typedAt.current && typing(false)}
        onKeyDown={onKey}
      />
      <button type="submit" className="ask-box-send" disabled={!text.trim()} aria-label="Ask">
        ↑
      </button>
    </form>
  );
}

/** Who's piloting, for everyone else, with the way to take over. */
function WatchLine({ acts }: { acts: PilotActs }) {
  const { v, place, name } = seatOf(acts);
  if (!v?.id) return null;
  const send = acts.send!;
  const quick = v.idle || v.away;
  const status = v.typing ? (
    <span className="ask-shimmer">{name} is typing…</span>
  ) : v.away ? (
    `${name} dropped off`
  ) : v.idle ? (
    `${name} is piloting · idle`
  ) : (
    `${name} is piloting`
  );
  return (
    <div className="pilot-watch">
      <Face id={v.id} name={v.name ?? ""} size={20} />
      <span className="pilot-watch-status">{status}</span>
      {place === 0 ? (
        <span className="pilot-asked">
          <span className="pilot-asked-text">Asked {name}</span>
          <Countdown from={v.handFrom} at={v.handAt} />
          <button type="button" className="pilot-link" onClick={() => send({ type: "pilot.cancel" })}>
            Cancel
          </button>
        </span>
      ) : place > 0 ? (
        <span className="pilot-asked">
          <span className="pilot-asked-text">In line · {place + 1}</span>
          <button type="button" className="pilot-link" onClick={() => send({ type: "pilot.cancel" })}>
            Cancel
          </button>
        </span>
      ) : quick ? (
        // An idle or dropped pilot's seat comes at once.
        <button type="button" className="pilot-ask" onClick={() => send({ type: "pilot.request" })}>
          Take over
        </button>
      ) : (
        <button type="button" className="pilot-ask" onClick={() => send({ type: "pilot.request" })}>
          Ask to pilot
        </button>
      )}
    </div>
  );
}

/** The pilot's pop-up when someone asks to take over: over the controls, wherever they are in the meeting. */
export function PilotRequest({ acts }: { acts: PilotActs }) {
  const { v, mine } = seatOf(acts);
  const front = v?.requests[0];
  if (!mine || !front || !acts.send) return null;
  const more = v!.requests.length - 1;
  return (
    <div className="pilot-request" role="alertdialog" aria-label={`${front.name} wants to pilot Stand`}>
      <div className="pilot-request-who">
        <Face id={front.id} name={front.name} size={22} />
        <span>
          <b>{first(front.name)}</b> wants to pilot
        </span>
        {more > 0 && <span className="pilot-more">+{more}</span>}
      </div>
      <Countdown from={v!.handFrom} at={v!.handAt} />
      <div className="pilot-request-acts">
        <button type="button" onClick={() => acts.send!({ type: "pilot.answer", yes: false })}>
          Not now
        </button>
        <button type="button" className="primary" onClick={() => acts.send!({ type: "pilot.answer", yes: true })} autoFocus>
          Hand over
        </button>
      </div>
    </div>
  );
}

/** Toasts when the seat moves between you and someone else, and when the pilot says not now. */
export function usePilotNotices(acts: PilotActs) {
  const v = acts.view;
  const lastAt = v?.last?.at ?? 0;
  const declinedAt = v?.declined?.at ?? 0;
  const seen = useRef({ last: lastAt, declined: declinedAt });
  useEffect(() => {
    const s = seen.current;
    if (!v || lastAt <= s.last) return;
    s.last = lastAt;
    const l = v.last!;
    if (v.now - l.at > 10_000) return;
    // Taking a free seat or the host taking it, you did yourself: nothing to say.
    if (l.toId === acts.me && l.how !== "free" && l.how !== "took") {
      const from = l.how === "gave" ? `${first(l.from)} handed you Stand` : "You're piloting Stand";
      toast({ text: from, action: { label: "Ask", run: openPilotBox }, ms: 6_000 });
    } else if (l.fromId === acts.me && l.toId && l.toId !== acts.me && l.how !== "gave") {
      toast({ text: l.how === "took" ? `${first(l.to)} took the seat` : `${first(l.to)} is piloting now` });
    }
  }, [lastAt]);
  useEffect(() => {
    const s = seen.current;
    if (!v?.declined || declinedAt <= s.declined) return;
    s.declined = declinedAt;
    if (v.declined.id === acts.me) toast({ text: `${first(v.declined.by)} is still asking` });
  }, [declinedAt]);
}
