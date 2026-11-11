// An idea on an idea review's slide (server/ideaReview.ts): what it is and where it came from in
// the brainstorm. What others built on it and what was caught on it then sit behind pills with
// counts, so the slide stays a name and a sentence; a tap opens one list in a pop-up. The same
// card is the slide in the call and on the review's page.

import { useEffect, useState } from "react";
import type { BrainCaught, IdeaSlideInfo } from "../../shared/protocol.ts";
import { CloseIcon, StarIcon } from "../icons.tsx";
import { useDismiss } from "../useDismiss.ts";
import { KIND } from "./BrainMap.tsx";

const KINDS = ["action", "decision", "question"] as const;
type Open = "points" | BrainCaught["kind"];

export function IdeaCard(props: { title: string; detail: string; idea: IdeaSlideInfo; className?: string }) {
  const { idea } = props;
  const [open, setOpen] = useState<Open | null>(null);
  // Another idea came on screen: its pop-up isn't this one's.
  useEffect(() => setOpen(null), [idea.nodeId]);
  const pop = useDismiss<HTMLDivElement>(!!open, () => setOpen(null));
  const of = (kind: BrainCaught["kind"]) => idea.caught.filter((c) => c.kind === kind);
  const heading = open === "points" ? "Discussion" : open ? KIND[open].label : "";
  return (
    <div className={`idea-card ${props.className ?? ""}`}>
      <div className="idea-from">
        {idea.starred && (
          <span className="idea-star" title="Starred">
            <StarIcon size={15} on />
          </span>
        )}
        {idea.direction && <span className="rp-pill" dir="auto">{idea.direction}</span>}
        {idea.by && <span className="muted">{idea.by}</span>}
      </div>
      <h2 dir="auto">{props.title}</h2>
      {props.detail && <p className="idea-detail" dir="auto">{props.detail}</p>}
      {(idea.caught.length > 0 || idea.points.length > 0) && (
        <div className="idea-pills">
          {idea.points.length > 0 && (
            <button type="button" className={`rp-pill${open === "points" ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open === "points"} onClick={() => setOpen(open === "points" ? null : "points")}>
              Discussion <span className="count">{idea.points.length}</span>
            </button>
          )}
          {KINDS.filter((k) => of(k).length > 0).map((k) => {
            const { Icon, label } = KIND[k];
            return (
              <button key={k} type="button" className={`rp-pill${open === k ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
                <i className={`brain-kind ${k}`}>
                  <Icon size={13} />
                </i>
                {label} <span className="count">{of(k).length}</span>
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <div className="idea-pop-back">
          <div className="idea-pop" role="dialog" aria-label={`${heading}: ${props.title}`} ref={pop}>
            <div className="idea-pop-head">
              <strong>{heading}</strong>
              <span className="muted" dir="auto">{props.title}</span>
              <button type="button" className="idea-pop-x" aria-label="Close" onClick={() => setOpen(null)}>
                <CloseIcon size={14} />
              </button>
            </div>
            <ul>
              {open === "points"
                ? idea.points.map((p, i) => (
                    <li key={i}>
                      <span dir="auto">{p.text}</span>
                      {p.by && <span className="muted"> · {p.by}</span>}
                    </li>
                  ))
                : of(open).map((c) => (
                    <li key={c.id} className={c.done ? "done" : undefined}>
                      <span dir="auto">{c.text}</span>
                      {c.owner && <span className="muted"> · {c.owner.split(" ")[0]}</span>}
                    </li>
                  ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
