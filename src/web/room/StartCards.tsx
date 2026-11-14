// What a call's board shows before the talk has a topic: up to four things to start with. One "Open
// project" card that lists the space's projects to pick from, "Start brainstorm" (the sketch), a
// review that has something waiting, and the check-in on what's still open from earlier, which used
// to take the whole first view on its own.
// The first topic card replaces them; everything here stays in reach on the call's bar and card list.

import { useEffect, useState, type ReactNode } from "react";
import { FolderOpen, Lightbulb, ListChecks, Presentation } from "lucide-react";
import type { SpaceFeed } from "../../shared/protocol.ts";
import type { Project } from "../../shared/projects.ts";
import { api } from "../api.ts";
import { errorToast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";

const MOST = 4;

type Start = { key: string; icon: ReactNode; title: string; meta: string; run: () => void; menu?: boolean };

export function StartCards(props: {
  roomId: string;
  /** To-dos carried from earlier meetings that nobody has answered on in this one. */
  toCheck: number;
  /** Puts the check-in on everyone's board. */
  onCheckIn?: () => void;
  /** Opens a project on everyone's board; whoever steers the call. */
  onProject?: (projectId: string) => void;
  /** Opens the sketch: Stand draws what the talk is working out. */
  onBrainstorm?: () => void;
  /** Someone else presents: ask first. */
  mayStart?: () => boolean;
}) {
  const { roomId } = props;
  const [feed, setFeed] = useState<SpaceFeed | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const picker = useDismiss<HTMLDivElement>(picking, () => setPicking(false));
  useEffect(() => {
    let active = true;
    api.feed(roomId).then((f) => active && setFeed(f), () => {});
    api.projects(roomId).then((all) => active && setProjects(all.filter((p) => !p.archived)), () => {});
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
  const cards: Start[] = [
    ...(props.onProject && projects.length ? [{ key: "project", icon: <FolderOpen size={15} aria-hidden />, title: "Open project", meta: n(projects.length, "project"), run: () => setPicking((v) => !v), menu: true }] : []),
    ...(props.onBrainstorm ? [{ key: "brainstorm", icon: <Lightbulb size={15} aria-hidden />, title: "Start brainstorm", meta: "Stand sketches as you talk", run: props.onBrainstorm }] : []),
    ...(specs ? [{ key: "design", icon: reviewIcon, title: "Design review", meta: n(specs, "spec"), run: review("design review", () => api.startDesignReview(roomId)) }] : []),
    ...(slides ? [{ key: "review", icon: reviewIcon, title: "Product review", meta: n(slides, "slide"), run: review("product review", () => api.startReview(roomId)) }] : []),
    ...(props.toCheck && props.onCheckIn ? [{ key: "checkin", icon: <ListChecks size={15} aria-hidden />, title: "Still open from earlier", meta: n(props.toCheck, "to-do"), run: props.onCheckIn }] : []),
  ].slice(0, MOST);
  if (!cards.length) return null;
  return (
    <div className="start-cards" role="group" aria-label="Start with">
      {cards.map((c) => {
        const card = (
          <button key={c.key} type="button" className={c.menu && picking ? "start-card on" : "start-card"} disabled={busy} aria-haspopup={c.menu ? "menu" : undefined} aria-expanded={c.menu ? picking : undefined} onClick={c.run}>
            <span className="start-kind">{c.icon}</span>
            <strong>{c.title}</strong>
            <span className="start-meta">{c.meta}</span>
          </button>
        );
        if (!c.menu) return card;
        return (
          <div key={c.key} className="start-pick" ref={picker}>
            {card}
            {picking && (
              <div className="rp-menu sh-start-menu pc-menu start-menu" role="menu">
                {projects.map((p) => (
                  <button key={p.id} type="button" role="menuitem" onClick={() => (setPicking(false), props.onProject!(p.id))}>
                    <strong dir="auto">{p.name}</strong>
                    <span className="muted">{p.openTodos} open</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
