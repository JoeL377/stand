// The views beside the call's board: the topic card, or the sketch (Sketch.tsx), the one place Stand
// draws what the talk is working out, as a map or a diagram per subject. Each person picks theirs;
// nothing else in the call changes.

import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Image as ImageIcon, List as ListIcon, Square } from "lucide-react";
import { UNTITLED_DESIGN, type BrainstormSummary, type BrainstormView } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { CopyForAgent } from "../CopyForAgent.tsx";
import { brainstormHref } from "../pages/BrainstormPage.tsx";
import { errorToast } from "../Toasts.tsx";
import { SketchBoard, StyleChip, shownSubjects, subjectCount, type SketchActs } from "./Sketch.tsx";

export type ViewTab = "card" | "sketch";

/** A pane from before the sketch (a presenter on an older page, a saved view) is the sketch now. */
export const viewOf = (pane: string | undefined): ViewTab => (!pane || pane === "card" ? "card" : "sketch");

const PILLS: Array<{ key: ViewTab; label: string }> = [
  { key: "card", label: "Card" },
  { key: "sketch", label: "Sketch" },
];

export function ViewPane(props: {
  view: ViewTab;
  onView: (view: ViewTab) => void;
  /** Off while a review runs: the card only. */
  tabs: boolean;
  card: ReactNode;
  brainstorm: BrainstormView | null | undefined;
  /** The sketch that was just stopped in this call, for its wrap-up. */
  stopped?: BrainstormView | null;
  onWrapUpClose?: () => void;
  /** The other sketches of this call. */
  others: BrainstormSummary[];
  roomId: string;
  acts?: SketchActs;
  /** Opens the sketch: Stand draws from the last two minutes on. */
  onStart?: () => void;
  onStop?: () => void;
  /** The subject on this screen (null follows the talk), the presenter's until you pick your own. */
  subject: string | null;
  onSubject: (id: string | null) => void;
  /** The last line said in the call. */
  heard?: { speaker: string; text: string } | null;
  /** On a phone the sketch opens as a list, with the picture a tap away. */
  phone?: boolean;
}) {
  const [picked, setPicked] = useState<"picture" | "list" | null>(null);
  const as = picked ?? (props.phone ? "list" : "picture");
  const live = props.brainstorm?.status === "live" ? props.brainstorm : null;
  const view = props.tabs ? props.view : "card";
  return (
    <div className="view-pane">
      {props.tabs && (
        <div className="view-bar">
          <span className="bp-views" role="group" aria-label="View">
            {PILLS.map((p) => (
              <button key={p.key} type="button" className={`rp-pill${view === p.key ? " on" : ""}`} aria-pressed={view === p.key} onClick={() => props.onView(p.key)}>
                {p.label}
                {p.key === "sketch" && live && view !== "sketch" && <i className="view-dot" title="Stand is sketching" aria-label="Stand is sketching" />}
              </button>
            ))}
          </span>
          {view === "sketch" && live && !props.phone && (
            <span className="bp-views view-as" role="group" aria-label="Show the sketch as">
              <button type="button" className={`rp-pill${as === "picture" ? " on" : ""}`} aria-pressed={as === "picture"} onClick={() => setPicked("picture")}>
                Picture
              </button>
              <button type="button" className={`rp-pill${as === "list" ? " on" : ""}`} aria-pressed={as === "list"} onClick={() => setPicked("list")}>
                List
              </button>
            </span>
          )}
          <span className="rp-grow" />
          {/* A phone has room for one switch: it names the other way to see the sketch. */}
          {view === "sketch" && live && props.phone && (
            <button type="button" className="rp-pill view-flip" onClick={() => setPicked(as === "list" ? "picture" : "list")} title={as === "list" ? "See it drawn" : "Read it as a list"}>
              {as === "list" ? <ImageIcon size={13} aria-hidden /> : <ListIcon size={13} aria-hidden />}
              {as === "list" ? "Picture" : "List"}
            </button>
          )}
          {props.onStop && view === "sketch" && live && (
            <button type="button" className="rp-pill view-stop-btn" onClick={props.onStop} title="The sketch is kept on its page, and each diagram as a draft spec on a to-do. The call goes on.">
              <Square size={10} aria-hidden />
              {props.phone ? "Stop" : "Stop drawing"}
            </button>
          )}
          {view === "sketch" && live && !props.phone && (
            <a className="link muted view-stop" href={brainstormHref(props.roomId, live.id)} target="_blank" rel="noreferrer">
              Open its page
            </a>
          )}
        </div>
      )}
      {view !== "sketch" ? (
        props.card
      ) : live ? (
        <SketchBoard brainstorm={live} acts={props.acts} phone={props.phone} as={as} subject={props.subject} onSubject={props.onSubject} heard={props.heard} />
      ) : props.stopped ? (
        <WrapUp sketch={props.stopped} roomId={props.roomId} onClose={props.onWrapUpClose} onAgain={props.onStart} />
      ) : (
        <div className="view-empty">
          <p>Nothing sketched in this call yet.</p>
          {props.onStart && (
            <button type="button" className="primary" onClick={props.onStart}>
              Start sketching
            </button>
          )}
          <p className="muted">Stand draws what you're working out while you talk, starting from the last two minutes.</p>
          {props.others.length > 0 && (
            <div className="view-maps">
              <h4>Sketched in this call</h4>
              <ul>
                {props.others.map((b) => (
                  <li key={b.id}>
                    <a href={brainstormHref(props.roomId, b.id)} target="_blank" rel="noreferrer" dir="auto">
                      {(b.subjects?.length ? b.subjects.map((s) => s.title) : [b.prompt]).map((t) => (t === UNTITLED_DESIGN ? "This call" : t)).join(" · ")}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A sketch that was just stopped: what was kept, and the next step for each subject. A map goes to
 *  an idea review; a diagram is already a draft spec on a to-do, which an agent can take from there. */
function WrapUp(props: { sketch: BrainstormView; roomId: string; onClose?: () => void; onAgain?: () => void }) {
  const b = props.sketch;
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  useEffect(() => setReview(null), [b.id]);
  const shown = shownSubjects(b)
    .map((x) => ({ ...x, ...subjectCount(b, x.s, x.i) }))
    .filter((x) => x.n > 0);
  const ideas = shown.some((x) => x.s.style === "map");
  const setUp = async () => {
    setBusy(true);
    try {
      setReview((await api.setUpIdeaReview(props.roomId, b.id)).reviewId);
    } catch (err) {
      errorToast("Couldn't set up the idea review")(err);
    }
    setBusy(false);
  };
  return (
    <div className="view-empty sk-wrap">
      <div className="sk-wrap-card">
        <header>
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <strong>{shown.length ? "Sketch saved" : "Nothing was sketched"}</strong>
          <span className="rp-grow" />
          {props.onClose && (
            <button type="button" className="link muted" aria-label="Close" onClick={props.onClose}>
              ✕
            </button>
          )}
        </header>
        {shown.map(({ s, n, word }) => (
          <div key={s.id} className="sk-wrap-row">
            <StyleChip subject={s} />
            <span className="sk-wrap-name" dir="auto">
              {s.title}
            </span>
            <span className="muted">
              {n} {word}
            </span>
            <span className="rp-grow" />
            {s.style === "diagram" && s.taskId && (
              <>
                <Link className="rp-pill" to={`/ref/action/${s.taskId}`} target="_blank">
                  Draft spec
                </Link>
                <span title="Hand to an agent">
                  <CopyForAgent kind="action" id={s.taskId} label />
                </span>
              </>
            )}
          </div>
        ))}
        <footer>
          {ideas &&
            (review ? (
              <Link className="rp-pill" to={`/s/${props.roomId}/review/${review}`} target="_blank">
                Idea review is set up ↗
              </Link>
            ) : (
              <button type="button" className="primary" disabled={busy} onClick={() => void setUp()} title="A review with one slide per idea, the starred ones first">
                {busy ? "Setting up…" : "Review ideas"}
              </button>
            ))}
          {shown.length > 0 && (
            <a className="link" href={brainstormHref(props.roomId, b.id)} target="_blank" rel="noreferrer">
              Open its page
            </a>
          )}
          {props.onAgain && (
            <button type="button" className="link muted" onClick={props.onAgain}>
              Start a new sketch
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
