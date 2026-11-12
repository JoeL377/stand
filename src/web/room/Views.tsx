// The views beside the call's board: the topic card, the map of what the talk came up with, its
// words, or a design session's diagram. Each person picks theirs; nothing else in the call changes.

import { useState, type ReactNode } from "react";
import type { BrainstormSummary, BrainstormView } from "../../shared/protocol.ts";
import { brainstormHref } from "../pages/BrainstormPage.tsx";
import { BrainMap } from "./BrainMap.tsx";
import { BrainWords } from "./BrainWords.tsx";
import { BrainOutline } from "./BrainOutline.tsx";
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
  /** The other maps and diagrams of this call. */
  others: BrainstormSummary[];
  roomId: string;
  /** The board's thread on screen: the topic a map can be drawn of. */
  topic: { id: string; title: string } | null;
  onRemove?: (id: string) => void;
  onKeep?: (id: string) => void;
  onDrop?: (id: string) => void;
  onDraw?: () => void;
  onDrawDiagram?: () => void;
  onOpen?: () => void;
  onStop?: () => void;
  /** On a phone the map opens as a list, with the picture a tap away. */
  phone?: boolean;
}) {
  const [picture, setPicture] = useState(false);
  const live = props.brainstorm?.status === "live" ? props.brainstorm : null;
  const map = live && !live.design ? live : null;
  const diagram = live?.design ? live : null;
  const view = props.tabs ? props.view : "card";
  const drawing = (key: ViewTab) => (key === "map" && !!map) || (key === "diagram" && !!diagram);
  const maps = props.others.filter((b) => !b.design);
  const stopped = props.topic && maps.some((b) => b.threadId === props.topic!.id);
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
          {props.phone && view === "map" && map && (
            <span className="bp-views view-as" role="group" aria-label="Show the map as">
              <button type="button" className={`rp-pill${picture ? "" : " on"}`} aria-pressed={!picture} onClick={() => setPicture(false)}>
                List
              </button>
              <button type="button" className={`rp-pill${picture ? " on" : ""}`} aria-pressed={picture} onClick={() => setPicture(true)}>
                Picture
              </button>
            </span>
          )}
          {props.onStop && view === "map" && map && (
            <button type="button" className="link muted view-stop" onClick={stop("map", "the map is kept on its page")} title="The map is kept on its page. The call goes on.">
              Stop drawing
            </button>
          )}
          {view === "map" && map && (
            <a className="link muted view-stop" href={brainstormHref(props.roomId, map.id)} target="_blank" rel="noreferrer">
              Open its page
            </a>
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
          props.phone && !picture ? <BrainOutline brainstorm={map} /> : <BrainMap brainstorm={map} onRemove={props.onRemove} />
        ) : (
          <div className="view-empty">
            {props.topic ? (
              <>
                <p dir="auto">{stopped ? `The map of "${props.topic.title}" is stopped.` : `No map of "${props.topic.title}" yet.`}</p>
                {props.onOpen && (
                  <button type="button" className="primary" onClick={props.onOpen}>
                    {stopped ? "Continue the map of this topic" : "Draw the map of this topic"}
                  </button>
                )}
                <p className="muted">Stand reads what was said on this topic, and goes on while you talk.</p>
              </>
            ) : (
              <>
                <p>No map in this call yet.</p>
                {props.onDraw && (
                  <button type="button" className="primary" onClick={props.onDraw}>
                    Draw a map
                  </button>
                )}
                <p className="muted">Stand draws what is said from here on, while you talk.</p>
              </>
            )}
            {maps.length > 0 && (
              <div className="view-maps">
                <h4>Maps in this call</h4>
                <ul>
                  {maps.map((b) => (
                    <li key={b.id}>
                      <a href={brainstormHref(props.roomId, b.id)} target="_blank" rel="noreferrer" dir="auto">
                        {b.prompt}
                      </a>
                      <span className="muted">
                        {b.ideas} {b.ideas === 1 ? "idea" : "ideas"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
