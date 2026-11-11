// An idea on an idea review's slide (server/ideaReview.ts): what it is, where it came from in the
// brainstorm, what others built on it and what was caught on it then. The same card is the slide
// in the call and on the review's page.

import type { IdeaSlideInfo } from "../../shared/protocol.ts";
import { StarIcon } from "../icons.tsx";
import { KIND } from "./BrainMap.tsx";

export function IdeaCard(props: { title: string; detail: string; idea: IdeaSlideInfo; className?: string }) {
  const { idea } = props;
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
        <ul className="idea-more">
          {idea.caught.map((c) => {
            const { Icon } = KIND[c.kind];
            return (
              <li key={c.id} className="idea-caught">
                <i className={`brain-kind ${c.kind}`}>
                  <Icon size={13} />
                </i>
                <span dir="auto">{c.text}</span>
              </li>
            );
          })}
          {idea.points.map((p, k) => (
            <li key={k}>
              <span dir="auto">{p.text}</span>
              {p.by && <span className="muted"> · {p.by}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
