// A sketch's own page: its subjects, each as the map or the diagram the talk drew of it.
// It stays here after the call, so anyone can come back, click through the circles and send the link.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { usePhone } from "../phone.ts";
import type { BrainstormSummary, BrainstormView } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { ChevronIcon } from "../icons.tsx";
import { subjectNodes } from "../../shared/protocol.ts";
import { SketchBoard, subjectsOf } from "../room/Sketch.tsx";
import { useDismiss } from "../useDismiss.ts";
import { BrainIdeas } from "./BrainIdeas.tsx";
import { errorToast } from "../Toasts.tsx";
import { joinHref, spaceHref } from "./SpacesShell.tsx";

export const brainstormHref = (roomId: string, id: string) => `/s/${roomId}/brainstorm/${id}`;
const day = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
export const brainCount = (b: { directions: number; ideas: number }) => `${b.ideas} idea${b.ideas === 1 ? "" : "s"} in ${b.directions} direction${b.directions === 1 ? "" : "s"}`;

export const designCount = (d: { boxes: number; arrows: number }) => `${d.boxes} part${d.boxes === 1 ? "" : "s"}, ${d.arrows} arrow${d.arrows === 1 ? "" : "s"}`;

export function BrainstormPage() {
  const { roomId = "", brainstormId = "" } = useParams();
  const [data, setData] = useState<{ roomName: string; brainstorm: BrainstormView; brainstorms: BrainstormSummary[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [settingUp, setSettingUp] = useState(false);
  // A phone opens on the list of ideas: the map fits the whole picture into the screen's width.
  const phone = usePhone();
  const view = params.get("view") ?? (phone ? "list" : "picture");
  const [subject, setSubject] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setFailed(false);
    api.brainstorm(roomId, brainstormId).then(setData, () => setFailed(true));
  }, [roomId, brainstormId]);

  if (failed) {
    return (
      <div className="rp rp-empty">
        <p>This sketch isn't here, or isn't yours to see.</p>
        <Link to={spaceHref(roomId)}>← Back to the space</Link>
      </div>
    );
  }
  if (!data) return <div className="rp rp-empty muted">Loading…</div>;
  const b = data.brainstorm;
  const live = b.status === "live";
  // The ideas are the circles of the subjects drawn as maps; a diagram's parts are not ideas.
  const subjects = subjectsOf(b);
  const hidden = new Set(subjects.flatMap((s, i) => (s.style === "diagram" ? subjectNodes(b.nodes, s, i === 0).map((n) => n.id) : [])));
  const maps = { ...b, nodes: b.nodes.filter((n) => !hidden.has(n.id)) };
  const hasIdeas = maps.nodes.some((n) => n.parent);
  const ideas = (view === "ideas" || view === "words") && hasIdeas;
  const list = !ideas && (view === "list" || view === "map");
  const parts = subjects.reduce((n, s) => n + (s.style === "diagram" ? (s.diagram?.boxes.filter((x) => !x.suggested).length ?? 0) : 0), 0);
  const count = [hasIdeas ? brainCount({ directions: maps.nodes.filter((n) => !n.parent).length, ideas: maps.nodes.filter((n) => n.parent).length }) : "", parts ? `${parts} part${parts === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const star = (idea: string, on: boolean) => {
    // Shown at once; the server's answer is what stays.
    setData({ ...data, brainstorm: { ...b, starred: on ? [...(b.starred ?? []), idea] : (b.starred ?? []).filter((x) => x !== idea) } });
    api.starIdea(roomId, b.id, idea, on).then(
      (r) => setData((d) => d && { ...d, brainstorm: { ...d.brainstorm, starred: r.brainstorm.starred } }),
      () => setData((d) => d && { ...d, brainstorm: { ...d.brainstorm, starred: b.starred } }),
    );
  };
  return (
    <div className="rp bp">
      <header className="rp-head">
        <Link className="rp-back" to={spaceHref(roomId)}>
          ← {data.roomName}
        </Link>
        <strong>Sketch</strong>
        <BrainstormPicker roomId={roomId} current={b} all={data.brainstorms} />
        <span className="muted bp-count">{count}</span>
        <span className="bp-views" role="group" aria-label="View">
          <button type="button" className={`rp-pill${!ideas && !list ? " on" : ""}`} aria-pressed={!ideas && !list} onClick={() => setParams(phone ? { view: "picture" } : {}, { replace: true })}>
            Picture
          </button>
          <button type="button" className={`rp-pill${list ? " on" : ""}`} aria-pressed={list} onClick={() => setParams(phone ? {} : { view: "list" }, { replace: true })}>
            List
          </button>
          {hasIdeas && (
            <button type="button" className={`rp-pill${ideas ? " on" : ""}`} aria-pressed={ideas} onClick={() => setParams({ view: "ideas" }, { replace: true })} title="Star the ideas worth coming back to">
              Ideas
            </button>
          )}
        </span>
        <span className="rp-grow" />
        {!live && hasIdeas && (
          <button
            type="button"
            className="rp-link"
            disabled={settingUp}
            title={b.ideaReview?.status === "done" ? "How the review ended each idea" : "A review call with one slide per idea, the starred ones first"}
            onClick={async () => {
              // A review that ran or is running is opened; one that hasn't started is rebuilt from the map as it is now.
              const reviewUrl = (id: string) => `/s/${roomId}/review/${id}`;
              if (b.ideaReview && b.ideaReview.status !== "draft") return navigate(reviewUrl(b.ideaReview.id));
              setSettingUp(true);
              try {
                navigate(reviewUrl((await api.setUpIdeaReview(roomId, b.id)).reviewId));
              } catch (err) {
                errorToast("Couldn't set up the idea review")(err);
                setSettingUp(false);
              }
            }}
          >
            {b.ideaReview?.status === "done" ? "Idea review" : b.ideaReview?.status === "live" ? "Idea review on now" : "Review ideas"}
          </button>
        )}
        {live ? (
          <Link className="rp-link" to={joinHref(roomId)}>
            Join the call
          </Link>
        ) : (
          b.meetingId && (
            <Link className="rp-link" to={`/meetings/${b.meetingId}`}>
              Recap
            </Link>
          )
        )}
      </header>
      {ideas ? (
        <BrainIdeas brainstorm={maps} onStar={star} />
      ) : (
        <SketchBoard brainstorm={b} phone={phone} as={list ? "list" : "picture"} subject={subject} onSubject={setSubject} className="bp-map" />
      )}
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
