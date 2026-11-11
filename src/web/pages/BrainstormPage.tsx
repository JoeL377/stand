// A brainstorm's own page: the sentence it started from and the map the talk drew around it.
// It stays here after the call, so anyone can come back, click through the circles and send the link.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { BrainstormSummary, BrainstormView } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { ChevronIcon } from "../icons.tsx";
import { BrainMap } from "../room/BrainMap.tsx";
import { useDismiss } from "../useDismiss.ts";
import { joinHref, spaceHref } from "./SpacesShell.tsx";

export const brainstormHref = (roomId: string, id: string) => `/s/${roomId}/brainstorm/${id}`;
const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
export const brainCount = (b: { directions: number; ideas: number }) => `${b.ideas} idea${b.ideas === 1 ? "" : "s"} in ${b.directions} direction${b.directions === 1 ? "" : "s"}`;

export function BrainstormPage() {
  const { roomId = "", brainstormId = "" } = useParams();
  const [data, setData] = useState<{ roomName: string; brainstorm: BrainstormView; brainstorms: BrainstormSummary[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setData(null);
    setFailed(false);
    api.brainstorm(roomId, brainstormId).then(setData, () => setFailed(true));
  }, [roomId, brainstormId]);

  if (failed) {
    return (
      <div className="rp rp-empty">
        <p>This brainstorm isn't here, or isn't yours to see.</p>
        <Link to={spaceHref(roomId)}>← Back to the space</Link>
      </div>
    );
  }
  if (!data) return <div className="rp rp-empty muted">Loading…</div>;
  const b = data.brainstorm;
  const live = b.status === "live";
  return (
    <div className="rp">
      <header className="rp-head">
        <Link className="rp-back" to={spaceHref(roomId)}>
          ← {data.roomName}
        </Link>
        <strong>Brainstorm</strong>
        <BrainstormPicker roomId={roomId} current={b} all={data.brainstorms} />
        <span className="muted bp-count">{brainCount({ directions: b.nodes.filter((n) => !n.parent).length, ideas: b.nodes.filter((n) => n.parent).length })}</span>
        <span className="rp-grow" />
        {live ? (
          <Link className="rp-link" to={joinHref(roomId)}>
            Join the brainstorm
          </Link>
        ) : (
          b.meetingId && (
            <Link className="rp-link" to={`/meetings/${b.meetingId}`}>
              Recap
            </Link>
          )
        )}
      </header>
      <BrainMap brainstorm={b} className="bp-map" />
    </div>
  );
}

export function BrainstormPicker(props: { roomId: string; current: { id: string; startedAt: number; status: string } | null; all: BrainstormSummary[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const label = props.label ?? (props.current ? (props.current.status === "live" ? "On now" : day(props.current.startedAt)) : "Earlier");
  if (props.all.length < (props.current ? 2 : 1)) return props.current ? <span className="rp-pill">{label}</span> : null;
  return (
    <div className="rp-picker" ref={box}>
      <button type="button" className="rp-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label} <ChevronIcon size={10} />
      </button>
      {open && (
        <div className="rp-menu bp-menu" role="menu">
          {props.all.map((x) => (
            <Link key={x.id} role="menuitem" to={brainstormHref(props.roomId, x.id)} className={props.current?.id === x.id ? "on" : undefined} onClick={() => setOpen(false)}>
              <span>{day(x.startedAt)}</span>
              <span className="bp-menu-prompt" dir="auto">{x.prompt}</span>
              <span className="muted">{x.ideas}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
