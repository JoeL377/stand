// The views beside the call's board: the topic card, the map of what the talk came up with, its
// words, or a design session's diagram. Each person picks theirs; nothing else in the call changes.

import type { ReactNode } from "react";
import type { BrainstormView } from "../../shared/protocol.ts";
import { BrainMap } from "./BrainMap.tsx";
import { BrainWords } from "./BrainWords.tsx";
import { DesignBoard } from "./DesignBoard.tsx";

export type ViewTab = "card" | "map" | "words" | "diagram";

const PILLS: Array<{ key: ViewTab; label: string }> = [
  { key: "card", label: "Card" },
  { key: "map", label: "Map" },
  { key: "words", label: "Words" },
  { key: "diagram", label: "Diagram" },
];

export function ViewPane(props: {
  view: ViewTab;
  onView: (view: ViewTab) => void;
  /** Off while a review runs: the card only. */
  tabs: boolean;
  card: ReactNode;
  brainstorm: BrainstormView | null | undefined;
  onRemove?: (id: string) => void;
  onKeep?: (id: string) => void;
  onDrop?: (id: string) => void;
  onDraw?: () => void;
  onDrawDiagram?: () => void;
  onStop?: () => void;
}) {
  const live = props.brainstorm?.status === "live" ? props.brainstorm : null;
  const map = live && !live.design ? live : null;
  const diagram = live?.design ? live : null;
  const view = props.tabs ? props.view : "card";
  const drawing = (key: ViewTab) => (key === "map" && !!map) || (key === "diagram" && !!diagram);
  const stop = (what: string, kept: string) => () => {
    if (confirm(`Stop drawing the ${what}? The call goes on, and ${kept}.`)) props.onStop?.();
  };
  return (
    <div className="view-pane">
      {props.tabs && (
        <div className="view-bar">
          <span className="bp-views" role="group" aria-label="View">
            {PILLS.map((p) => (
              <button key={p.key} type="button" className={`rp-pill${view === p.key ? " on" : ""}`} aria-pressed={view === p.key} onClick={() => props.onView(p.key)}>
                {p.label}
                {drawing(p.key) && view !== p.key && <i className="view-dot" title={`A ${p.key} is being drawn`} aria-label={`A ${p.key} is being drawn`} />}
              </button>
            ))}
          </span>
          {props.onStop && view === "map" && map && (
            <button type="button" className="link muted view-stop" onClick={stop("map", "the map is kept on its page")} title="The map is kept on its page. The call goes on.">
              Stop drawing
            </button>
          )}
          {view === "diagram" && diagram && (
            <span className="view-what" dir="auto" title={diagram.prompt}>
              {diagram.prompt}
            </span>
          )}
          {props.onStop && view === "diagram" && diagram && (
            <button type="button" className="link muted view-stop" onClick={stop("diagram", "it is saved as a draft spec on a to-do")} title="The diagram is saved as a draft spec on a to-do. The call goes on.">
              Stop drawing
            </button>
          )}
        </div>
      )}
      {view === "map" ? (
        map ? (
          <BrainMap brainstorm={map} onRemove={props.onRemove} />
        ) : (
          <div className="view-empty">
            <p>No map in this call yet.</p>
            {props.onDraw && (
              <button type="button" className="primary" onClick={props.onDraw}>
                Draw a map
              </button>
            )}
            <p className="muted">Stand draws what is said from here on, while you talk.</p>
          </div>
        )
      ) : view === "words" ? (
        map ? (
          <BrainWords brainstorm={map} />
        ) : (
          <div className="view-empty">
            <p className="muted">No map in this call yet, so no words either.</p>
          </div>
        )
      ) : view === "diagram" ? (
        diagram ? (
          <DesignBoard brainstorm={diagram} onKeep={props.onKeep} onDrop={props.onDrop} />
        ) : (
          <div className="view-empty">
            <p>No diagram in this call yet.</p>
            {props.onDrawDiagram && (
              <button type="button" className="primary" onClick={props.onDrawDiagram}>
                Draw a diagram
              </button>
            )}
            <p className="muted">Stand draws the parts and how they relate from what is said, while you talk.</p>
          </div>
        )
      ) : (
        props.card
      )}
    </div>
  );
}
