// What a call's board shows before the talk has a topic: up to four things to start with, each one
// click. A review that has something waiting, the space's projects in the team's order, and the
// check-in on what's still open from earlier, which used to take the whole first view on its own.
// The first topic card replaces them; everything here stays in reach on the call's bar and card list.

import { useEffect, useState, type ReactNode } from "react";
import { FolderOpen, ListChecks, Presentation } from "lucide-react";
import type { SpaceFeed } from "../../shared/protocol.ts";
import type { Project } from "../../shared/projects.ts";
import { api } from "../api.ts";
import { errorToast } from "../Toasts.tsx";

const MOST = 4;

type Start = { key: string; kind: string; icon: ReactNode; title: string; meta: string; run: () => void };

export function StartCards(props: {
  roomId: string;
  /** To-dos carried from earlier meetings that nobody has answered on in this one. */
  toCheck: number;
  /** Puts the check-in on everyone's board. */
  onCheckIn?: () => void;
  /** Opens a project on everyone's board; whoever steers the call. */
  onProject?: (projectId: string) => void;
  /** Someone else presents: ask first. */
  mayStart?: () => boolean;
}) {
  const { roomId } = props;
  const [feed, setFeed] = useState<SpaceFeed | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api.feed(roomId).then((f) => active && setFeed(f), () => {});
    api.projects(roomId).then((all) => active && setProjects(all.filter((p) => !p.archived && p.openTodos > 0)), () => {});
    return () => {
      active = false;
    };
  }, [roomId]);

  const review = (what: string, start: () => Promise<unknown>) => () => {
    if (busy || (props.mayStart && !props.mayStart())) return;
    setBusy(true);
    start()
      .catch(errorToast(`Couldn't start the ${what}`))
      .finally(() => setBusy(false));
  };
  const n = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
  const slides = feed?.review?.slides.length ?? 0;
  const specs = feed?.designReview?.specs ?? 0;
  const reviewIcon = <Presentation size={15} aria-hidden />;
  const reviews: Start[] = [
    ...(slides ? [{ key: "review", kind: "Review", icon: reviewIcon, title: "Product review", meta: n(slides, "slide"), run: review("product review", () => api.startReview(roomId)) }] : []),
    ...(specs ? [{ key: "design", kind: "Review", icon: reviewIcon, title: "Design review", meta: n(specs, "spec"), run: review("design review", () => api.startDesignReview(roomId)) }] : []),
  ];
  const checkIn: Start[] =
    props.toCheck && props.onCheckIn
      ? [{ key: "checkin", kind: "Check-in", icon: <ListChecks size={15} aria-hidden />, title: "Still open from earlier", meta: n(props.toCheck, "to-do"), run: props.onCheckIn }]
      : [];
  const room = MOST - reviews.length - checkIn.length;
  const open: Start[] = props.onProject
    ? projects.slice(0, Math.max(0, room)).map((p) => ({ key: p.id, kind: "Project", icon: <FolderOpen size={15} aria-hidden />, title: p.name, meta: `${p.openTodos} open`, run: () => props.onProject!(p.id) }))
    : [];
  const cards = [...reviews, ...open, ...checkIn].slice(0, MOST);
  if (!cards.length) return null;
  return (
    <div className="start-cards" role="group" aria-label="Start with">
      {cards.map((c) => (
        <button key={c.key} type="button" className="start-card" disabled={busy} onClick={c.run}>
          <span className="start-kind">
            {c.icon}
            {c.kind}
          </span>
          <strong dir="auto">{c.title}</strong>
          <span className="start-meta">{c.meta}</span>
        </button>
      ))}
    </div>
  );
}
