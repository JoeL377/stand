import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Participant } from "../../shared/protocol.ts";
import type { Interim } from "./useRoomSocket.ts";
import { useDismiss } from "../useDismiss.ts";
import { ShareIcon } from "../icons.tsx";
import { Avatar } from "./Stage.tsx";

/** How many faces the top bar shows before "+N". */
const SHOWN = 5;
/** A talker stays named this long after they stop, so short pauses don't flicker the pill. */
const LINGER_MS = 1200;

/** Who's in the room, in the top bar: a row of small faces, a green pill naming whoever is
 *  talking, and the full list (host, sharing, not recorded, Make host) a click away. */
export function People(props: {
  participants: Participant[];
  participantId: string;
  speaking: Set<string>;
  interims: Record<string, Interim>;
  canSteer: boolean;
  offline?: boolean;
  send: (m: ClientMessage) => boolean;
}) {
  const { participants, participantId } = props;
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const talking = useLinger(new Set([...props.speaking, ...Object.keys(props.interims)]));
  // The demo's scripted speakers aren't in the room; they show while they talk.
  const ghosts: Participant[] = Object.values(props.interims)
    .filter((i) => !participants.some((p) => p.id === i.speakerId))
    .map((i) => ({ id: i.speakerId, name: i.speakerName }) as Participant);
  const everyone = [...participants, ...ghosts];
  const talkers = everyone.filter((p) => talking.has(p.id));
  const first = (p: Participant) => (p.id === participantId ? "You" : p.name.split(" ")[0]);
  // Your own "Not recording" pill already sits on the left of the bar.
  const unheard = participants.filter((p) => p.notRecording && p.id !== participantId);
  const shown = everyone.slice(0, SHOWN);

  return (
    <span className="pop-wrap people-top" ref={ref}>
      <button
        className="people-btn"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`In the room: ${everyone.map((p) => p.name).join(", ")}`}
      >
        <span className="people-stack">
          {shown.map((p) => (
            <span
              key={p.id}
              className={[
                "people-face",
                talking.has(p.id) && "talking",
                p.notRecording && "unheard",
                p.isSharing && "sharing",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <Avatar id={p.id} name={p.name} picture={p.picture} size={24} />
            </span>
          ))}
          {everyone.length > SHOWN && <span className="people-more">+{everyone.length - SHOWN}</span>}
        </span>
        {talkers.length > 0 && (
          <span className="people-talking">
            <span className="people-talking-names">{talkers.slice(0, 2).map(first).join(", ")}{talkers.length > 2 ? ` +${talkers.length - 2}` : ""}</span>
            <Bars />
          </span>
        )}
        {/* A crossed-out mic would read as muted; this says what it means. */}
        {unheard.length > 0 && (
          <span className="people-unheard" title={`What ${unheard.map((p) => p.name.split(" ")[0]).join(" and ")} say${unheard.length === 1 ? "s" : ""} isn't in the notes: their browser can't transcribe it.`}>
            {unheard.length === 1 ? `${first(unheard[0])} not recorded` : `${unheard.length} not recorded`}
          </span>
        )}
      </button>
      {open && (
        <div className="add-menu people-pop" role="dialog" aria-label="In the room">
          <div className="people-pop-head">In the room · {everyone.length}</div>
          {everyone.map((p) => (
            <PersonRow
              key={p.id}
              p={p}
              me={p.id === participantId}
              demo={ghosts.includes(p)}
              talking={talking.has(p.id)}
              onMakeHost={
                props.canSteer && !props.offline && p.id !== participantId && !ghosts.includes(p)
                  ? () => props.send({ type: "host.give", participantId: p.id })
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </span>
  );
}

function PersonRow(props: { p: Participant; me: boolean; demo: boolean; talking: boolean; onMakeHost?: () => void }) {
  const { p, onMakeHost } = props;
  // Handing over hosting takes a second click, so a stray one doesn't give the meeting away.
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <div className={props.talking ? "people-row talking" : "people-row"}>
      <Avatar id={p.id} name={p.name} picture={p.picture} size={26} />
      <span className="people-row-name" title={p.name}>
        {p.name}
        {props.me && <span className="muted"> (you)</span>}
      </span>
      {props.talking && <Bars />}
      {p.isSharing && (
        <span className="people-tag green" title={`${p.name} is sharing their screen`}>
          <ShareIcon /> Sharing
        </span>
      )}
      {p.notRecording && (
        <span className="people-tag red" title={`What ${p.name.split(" ")[0]} says isn't in the notes: their browser can't transcribe it.`}>
          Not recorded
        </span>
      )}
      {p.isHost && <span className="people-tag">Host</span>}
      {props.demo && <span className="people-tag">Demo</span>}
      {onMakeHost &&
        (confirm ? (
          <span className="people-act confirm">
            <button className="link" onClick={onMakeHost} title={`${p.name.split(" ")[0]} will choose the item everyone talks about`}>
              Hand over
            </button>
            <button className="link muted" onClick={() => setConfirm(false)} aria-label="Cancel">
              ✕
            </button>
          </span>
        ) : (
          <button className="link people-act" onClick={() => setConfirm(true)} title={`Let ${p.name} drive the meeting`}>
            Make host
          </button>
        ))}
    </div>
  );
}

/** Three bars that bounce while someone talks. */
function Bars() {
  return (
    <span className="talk-bars" aria-label="talking" role="img">
      <i />
      <i />
      <i />
    </span>
  );
}

/** The set of ids, with each one kept for LINGER_MS after it drops out. */
function useLinger(ids: Set<string>) {
  const last = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  const now = Date.now();
  for (const id of ids) last.current.set(id, now);
  const out = new Set<string>();
  let next = Infinity;
  for (const [id, t] of last.current) {
    if (now - t < LINGER_MS) {
      out.add(id);
      if (!ids.has(id)) next = Math.min(next, t + LINGER_MS - now);
    } else last.current.delete(id);
  }
  // Wake up once the oldest lingerer is due to go.
  useEffect(() => {
    if (next === Infinity) return;
    const t = setTimeout(() => tick((n) => n + 1), next + 20);
    return () => clearTimeout(t);
  });
  return out;
}
