// A design session's diagram (server/designSession.ts): boxes for the things being designed and
// labelled arrows for how they relate. A box has a kind (a person, a screen, a data store…) that
// gives it a mark and a shape, and boxes that belong together sit in a group with a caption. Each
// box shows its one line description, and what was said about it as notes under it; the Text pill
// hides both. What Stand hears joins the diagram at once (one from before that rule may still show
// dashed, with Keep and Drop). A click on a box or an arrow opens what's behind it, on your screen only.
// Context a session was given (MCP start_design_session) sits behind a Context button. In the call
// it grows as the team talks; on the session's page it is the record.
//
// React Flow draws it (pan, pinch, the boxes as components) and ELK places it (designLayout.ts).

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, Controls, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewport, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { AppWindow, CircleArrowRight, Database, FileText, Server, Split, Target, TriangleAlert, User } from "lucide-react";
import type { BrainCaught, BrainstormView, DesignArrow, DesignBox, DesignGroup, DesignKind } from "../../shared/protocol.ts";
import { CaughtMarks, EditRow, Face, KINDS, clock } from "./BrainMap.tsx";
import { Markdown } from "../Markdown.tsx";
import { NOTES_SHOWN, fitView, layoutDiagram, type Laid } from "./designLayout.ts";

/** What each kind of box is called, and its mark. A plain thing has neither. */
const SORT: Record<DesignKind, { label: string; Icon: typeof User | null }> = {
  thing: { label: "Part", Icon: null },
  person: { label: "Person", Icon: User },
  goal: { label: "Goal", Icon: Target },
  problem: { label: "Problem", Icon: TriangleAlert },
  document: { label: "Document", Icon: FileText },
  screen: { label: "Screen", Icon: AppWindow },
  store: { label: "Data", Icon: Database },
  service: { label: "Service", Icon: Server },
  step: { label: "Step", Icon: CircleArrowRight },
  decision: { label: "Decision", Icon: Split },
};

/** What the boxes and arrows need from the board. */
const Board = createContext<{ text: boolean; only?: BrainCaught["kind"] | null; openId: string | null; pick: (id: string) => void; onKeep?: (id: string) => void; onDrop?: (id: string) => void }>({ text: true, openId: null, pick: () => {} });

type BoxNodeT = Node<{ box: DesignBox; body: number }, "box">;
type GroupNodeT = Node<{ group: DesignGroup }, "frame">;
type RelEdgeT = Edge<{ arrow: DesignArrow; path: string; x: number; y: number; from: string; to: string }, "rel">;

function BoxNode({ data }: NodeProps<BoxNodeT>) {
  const { box, body } = data;
  const board = useContext(Board);
  const { label, Icon } = SORT[box.kind ?? "thing"] ?? SORT.thing;
  const act = (fn: ((id: string) => void) | undefined) => (e: React.MouseEvent) => (e.stopPropagation(), fn?.(box.id));
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="design-handle" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="design-handle" />
      <div
        role="button"
        tabIndex={0}
        className={`design-box kind-${box.kind ?? "thing"}${box.suggested ? " suggested" : ""}${board.openId === box.id ? " on" : ""}${board.only && !box.caught.some((c) => c.kind === board.only) ? " dim" : ""}`}
        style={{ height: body }}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), board.pick(box.id))}
      >
        <span className="design-name">
          {Icon && (
            <i className="design-kind" title={label}>
              <Icon aria-label={label} />
            </i>
          )}
          <strong dir="auto">{box.label}</strong>
        </span>
        {board.text && box.detail && (
          <span className="design-detail" dir="auto">
            {box.detail}
          </span>
        )}
        {(box.caught.length > 0 || (!board.text && box.points.length > 0)) && (
          <span className="brain-marks">
            {!board.text && box.points.length > 0 && (
              <i className="brain-badge" title={`${box.points.length} said about it`}>
                {box.points.length}
              </i>
            )}
            {KINDS.map((k) => {
              const n = box.caught.filter((c) => c.kind === k.kind).length;
              return n ? (
                <i key={k.kind} className={`brain-kind ${k.kind}`} title={`${n} ${n === 1 ? k.one : k.many.toLowerCase()}`}>
                  <k.Icon />
                  {n > 1 && n}
                </i>
              ) : null;
            })}
          </span>
        )}
        {box.suggested && board.onKeep && (
          <span className="design-ask nodrag nopan">
            <button type="button" className="design-yes" onClick={act(board.onKeep)}>
              Keep
            </button>
            <button type="button" className="design-no" onClick={act(board.onDrop)}>
              Drop
            </button>
          </span>
        )}
      </div>
      {board.text && box.points.length > 0 && (
        <ul className="design-notes">
          {box.points.slice(0, NOTES_SHOWN).map((p, i) => (
            <li key={i} dir="auto">
              {p.text}
            </li>
          ))}
          {box.points.length > NOTES_SHOWN && <li className="more">+{box.points.length - NOTES_SHOWN} more</li>}
        </ul>
      )}
    </>
  );
}

function GroupNode({ data }: NodeProps<GroupNodeT>) {
  const board = useContext(Board);
  return (
    <div className="design-group">
      <strong dir="auto">{data.group.label}</strong>
      {board.text && data.group.detail && <span dir="auto">{data.group.detail}</span>}
    </div>
  );
}

function RelEdge({ id, data }: EdgeProps<RelEdgeT>) {
  const board = useContext(Board);
  if (!data) return null;
  const { arrow } = data;
  const on = board.openId === arrow.id || board.openId === arrow.from || board.openId === arrow.to;
  const act = (fn: ((id: string) => void) | undefined) => (e: React.MouseEvent) => (e.stopPropagation(), fn?.(arrow.id));
  return (
    <>
      <BaseEdge id={id} path={data.path} interactionWidth={0} className={`design-line${arrow.suggested ? " suggested" : ""}${on ? " on" : ""}`} markerEnd={`url(#design-tip${on ? "-on" : arrow.suggested ? "-suggested" : ""})`} />
      <EdgeLabelRenderer>
        <span className={`design-rel nodrag nopan${arrow.suggested ? " suggested" : ""}${board.openId === arrow.id ? " on" : ""}`} style={{ left: data.x, top: data.y }}>
          <button type="button" onClick={(e) => (e.stopPropagation(), board.pick(arrow.id))} title={`${data.from} ${arrow.label || "relates to"} ${data.to}`}>
            {arrow.label || "relates to"}
          </button>
          {arrow.suggested && board.onKeep && (
            <>
              <button type="button" className="design-yes" aria-label="Keep this arrow" title="Keep" onClick={act(board.onKeep)}>
                ✓
              </button>
              <button type="button" className="design-no" aria-label="Drop this arrow" title="Drop" onClick={act(board.onDrop)}>
                ✕
              </button>
            </>
          )}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { box: BoxNode, frame: GroupNode };
const edgeTypes = { rel: RelEdge };

/** Brings the whole diagram back into view when it is laid out again or the board changes size. */
function Fit({ laid, size, tall, inset = 0 }: { laid: Laid; size: { w: number; h: number }; tall: boolean; inset?: number }) {
  const flow = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (!size.w || !size.h) return;
    void flow.setViewport(fitInside(laid, size, tall, inset), { duration: first.current ? 0 : 300 });
    first.current = false;
  }, [laid, size.w, size.h, tall]);
  return null;
}

/** The fit, with room left around the drawing so it does not touch the board's edge. */
function fitInside(laid: Laid, size: { w: number; h: number }, tall: boolean, inset: number) {
  if (!inset) return fitView(laid, size, tall);
  const v = fitView(laid, { w: Math.max(1, size.w - inset * 2), h: Math.max(1, size.h - inset * 2) }, tall);
  return { ...v, x: v.x + inset, y: v.y + inset };
}

/** The same zoom control as the map's: out, the size (a click fits it all), in. */
function Zoom({ laid, size, tall, inset }: { laid: Laid; size: { w: number; h: number }; tall: boolean; inset: number }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="brain-zoom" role="group" aria-label="Zoom" onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => void flow.zoomOut({ duration: 200 })}>
        −
      </button>
      <button type="button" className="brain-zoom-pct" title="See it all" onClick={() => void flow.setViewport(fitInside(laid, size, tall, inset), { duration: 300 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => void flow.zoomIn({ duration: 200 })}>
        +
      </button>
    </div>
  );
}

const TEXT_KEY = "stand.design.text";
const savedText = (): boolean | null => {
  try {
    const v = localStorage.getItem(TEXT_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
};

export function DesignBoard(props: {
  brainstorm: BrainstormView;
  onKeep?: (id: string) => void;
  onDrop?: (id: string) => void;
  /** On a sketch: a box or an arrow can be renamed. */
  onRename?: (id: string, label: string) => void;
  /** On a sketch the subject's name and the listening mark sit above the board, so the board leaves them out. */
  bare?: boolean;
  /** The kind picked on the sketch: boxes that caught none of it dim. */
  only?: BrainCaught["kind"] | null;
  className?: string;
}) {
  const { brainstorm } = props;
  const design = brainstorm.design ?? { boxes: [], arrows: [] };
  const { boxes, arrows } = design;
  const groups = design.groups ?? [];
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tall = size.w > 0 && size.w < 620;
  // Descriptions and notes show unless you turned them off; a phone starts without them.
  // The sketch has no switch for it: wide shows them, narrow does not.
  const [textPick, setTextPick] = useState<boolean | null>(savedText);
  const text = props.bare ? !tall : (textPick ?? !tall);
  const hasText = boxes.some((b) => b.detail || b.points.length) || groups.some((g) => g.detail);
  const setText = (v: boolean) => {
    setTextPick(v);
    try {
      localStorage.setItem(TEXT_KEY, v ? "1" : "0");
    } catch {
      // Private windows: the choice lasts for this visit.
    }
  };

  // Laid out again only when what's on the diagram changes, not on every broadcast.
  const key = JSON.stringify([boxes.map((b) => [b.id, b.label, b.detail, b.kind, b.group, b.points.map((p) => p.text), b.caught.length, !!b.suggested]), arrows.map((a) => [a.id, a.from, a.to, a.label, !!a.suggested]), groups, tall, text]);
  const [laid, setLaid] = useState<Laid | null>(null);
  useEffect(() => {
    if (!size.w || !boxes.length) return;
    let current = true;
    void layoutDiagram(design, { tall, text })
      .then((l) => current && setLaid(l))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [key, size.w > 0]);

  const [openId, setOpenId] = useState<string | null>(null);
  const context = brainstorm.context ?? [];
  const [showContext, setShowContext] = useState(false);
  const [piece, setPiece] = useState<string | null>(null);
  const shownPiece = context.find((c) => c.id === piece) ?? context[0] ?? null;
  const openBox = boxes.find((b) => b.id === openId) ?? null;
  const openArrow = arrows.find((a) => a.id === openId) ?? null;
  useEffect(() => {
    if (!openId && !showContext) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && (setOpenId(null), setShowContext(false));
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openId, showContext]);
  const pick = (id: string) => (setShowContext(false), setOpenId((cur) => (cur === id ? null : id)));

  const name = (id: string) => boxes.find((b) => b.id === id)?.label ?? "";
  const waiting = boxes.filter((b) => b.suggested).length + arrows.filter((a) => a.suggested).length;
  const live = brainstorm.status === "live";

  // The places come from the last layout; what each box says comes from the diagram as it is now.
  const nodes = useMemo<Array<BoxNodeT | GroupNodeT>>(() => {
    if (!laid) return [];
    const frames = laid.groups.flatMap((g): GroupNodeT[] => {
      const group = groups.find((x) => x.id === g.group.id);
      return group ? [{ id: g.group.id, type: "frame", position: { x: g.x, y: g.y }, width: g.w, height: g.h, data: { group }, zIndex: -1, selectable: false, focusable: false, className: "design-frame-node" }] : [];
    });
    const parts = laid.boxes.flatMap((p): BoxNodeT[] => {
      const box = boxes.find((b) => b.id === p.box.id);
      return box ? [{ id: box.id, type: "box", position: { x: p.x, y: p.y }, width: p.w, height: p.h, data: { box, body: p.body }, zIndex: 1 }] : [];
    });
    return [...frames, ...parts];
  }, [laid, brainstorm.design]);
  const edges = useMemo<RelEdgeT[]>(() => {
    if (!laid) return [];
    return laid.arrows.flatMap((p): RelEdgeT[] => {
      const arrow = arrows.find((a) => a.id === p.arrow.id);
      return arrow ? [{ id: arrow.id, type: "rel", source: arrow.from, target: arrow.to, data: { arrow, path: p.path, x: p.x, y: p.y, from: name(arrow.from), to: name(arrow.to) }, focusable: false }] : [];
    });
  }, [laid, brainstorm.design]);
  const openAt = laid?.boxes.find((p) => p.box.id === openId)?.x ?? laid?.arrows.find((p) => p.arrow.id === openId)?.x ?? 0;
  // On the sketch the drawing keeps a margin from the board's edge.
  const inset = props.bare ? (tall ? 12 : 40) : 0;
  const view = laid && size.w ? fitInside(laid, size, tall, inset) : null;
  const board = useMemo(() => ({ text, only: props.only, openId, pick, onKeep: props.onKeep, onDrop: props.onDrop }), [text, props.only, openId, props.onKeep, props.onDrop]);

  return (
    <div className={`brain design${tall ? " narrow" : ""}${props.bare ? " bare" : ""}${props.className ? ` ${props.className}` : ""}`} onClick={() => (setOpenId(null), setShowContext(false))}>
      <div className="design-top">
        {!props.bare && (
          <span className="design-what" dir="auto" title={brainstorm.prompt}>
            {brainstorm.prompt}
          </span>
        )}
        {context.length > 0 && (
          <button type="button" className={`design-context${showContext ? " on" : ""}`} onClick={(e) => (e.stopPropagation(), setOpenId(null), setShowContext((v) => !v))}>
            Context <i>{context.length}</i>
          </button>
        )}
        {hasText && !props.bare && (
          <button type="button" className={`design-context design-text${text ? " on" : ""}`} aria-pressed={text} title={text ? "Hide descriptions and notes" : "Show descriptions and notes"} onClick={(e) => (e.stopPropagation(), setText(!text))}>
            Text
          </button>
        )}
        {waiting > 0 && <span className="design-waiting">{waiting} {live ? "suggested" : "left as suggestions"}</span>}
        {props.bare ? null : brainstorm.busy ? (
          <span className="design-busy">Listening…</span>
        ) : (
          live && brainstorm.heard === "failed" && <span className="design-busy trouble">Stand couldn't read the talk just now</span>
        )}
      </div>
      <div className="design-frame" ref={frame}>
        {boxes.length === 0 ? (
          <p className="design-empty muted">
            {!live
              ? "Nothing was put on this diagram."
              : brainstorm.heard === "failed"
                ? "Stand couldn't read the talk just now. It tries again as you talk."
                : brainstorm.heard === "nothing"
                  ? "Stand is listening, and hasn't heard the parts of a design yet. Say what the parts are and how they connect."
                  : "Start talking it through. What Stand hears joins the diagram as you go."}
          </p>
        ) : (
          laid && (
            <Board.Provider value={board}>
              <svg className="design-defs" aria-hidden>
                <defs>
                  {["", "-suggested", "-on"].map((k) => (
                    <marker key={k} id={`design-tip${k}`} className={`design-tip${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L10,5 L0,10 z" />
                    </marker>
                  ))}
                </defs>
              </svg>
              <ReactFlowProvider>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  defaultViewport={view ?? undefined}
                  minZoom={0.3}
                  maxZoom={1.6}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  zoomOnScroll={false}
                  zoomOnDoubleClick={false}
                  preventScrolling={false}
                  onNodeClick={(e, n) => n.type === "box" && (e.stopPropagation(), pick(n.id))}
                  aria-label="Design diagram"
                >
                  <Fit laid={laid} size={size} tall={tall} inset={inset} />
                  {props.bare && !tall && <Zoom laid={laid} size={size} tall={tall} inset={inset} />}
                  {!props.bare && !tall && <Controls showInteractive={false} position="bottom-left" fitViewOptions={{ padding: 0.04, maxZoom: 1.15 }} />}
                </ReactFlow>
              </ReactFlowProvider>
            </Board.Provider>
          )
        )}
      </div>
      {showContext && shownPiece && (
        <aside className="brain-card design-context-card left" role="dialog" aria-label="Context" onClick={(e) => e.stopPropagation()}>
          <header>
            <span className="brain-crumb plain">Context</span>
            <button type="button" className="brain-x" aria-label="Close" onClick={() => setShowContext(false)}>
              ✕
            </button>
          </header>
          {context.length > 1 && (
            <div className="design-context-tabs">
              {context.map((c) => (
                <button key={c.id} type="button" className={c.id === shownPiece.id ? "on" : ""} onClick={() => setPiece(c.id)} title={c.title}>
                  {c.title}
                </button>
              ))}
            </div>
          )}
          <h3 dir="auto">{shownPiece.title}</h3>
          <div className="design-context-text">
            <Markdown text={shownPiece.text} />
          </div>
          <footer className="design-context-foot muted">
            {shownPiece.by && <span>From {shownPiece.by}</span>}
            {shownPiece.url && (
              <a href={shownPiece.url} target="_blank" rel="noreferrer">
                Open the source ↗
              </a>
            )}
          </footer>
        </aside>
      )}
      {(openBox || openArrow) && (
        <aside className={`brain-card ${!tall && view && openAt * view.zoom + view.x > size.w / 2 ? "left" : "right"}`} role="dialog" aria-label={openBox?.label ?? "Arrow"} onClick={(e) => e.stopPropagation()}>
          <header>
            <span className="brain-crumb plain">{(openBox ?? openArrow)!.suggested ? "Suggested" : openBox ? [SORT[openBox.kind ?? "thing"]?.label ?? "Part", groups.find((g) => g.id === openBox.group)?.label].filter(Boolean).join(" · ") : "Relation"}</span>
            <button type="button" className="brain-x" aria-label="Close" onClick={() => setOpenId(null)}>
              ✕
            </button>
          </header>
          {openBox ? (
            <BoxDetails box={openBox} arrows={arrows} name={name} onPick={setOpenId} />
          ) : (
            <>
              <h3 dir="auto">
                {name(openArrow!.from)} <em>{openArrow!.label || "relates to"}</em> {name(openArrow!.to)}
              </h3>
              <Said quote={openArrow!.quote} />
            </>
          )}
          {props.onRename && live && !(openBox ?? openArrow)!.suggested ? (
            <EditRow name={(openBox ?? openArrow)!.label ?? ""} onRename={(label) => props.onRename!(openId!, label)} onRemove={() => (props.onDrop?.(openId!), setOpenId(null))} />
          ) : props.onKeep && (
            <footer className="design-foot">
              {(openBox ?? openArrow)!.suggested && (
                <button type="button" className="primary" onClick={() => props.onKeep!(openId!)}>
                  Keep
                </button>
              )}
              <button type="button" onClick={() => (props.onDrop?.(openId!), setOpenId(null))}>
                {(openBox ?? openArrow)!.suggested ? "Drop" : "Take off the diagram"}
              </button>
            </footer>
          )}
        </aside>
      )}
    </div>
  );
}

function Said({ quote }: { quote: DesignBox["quote"] }) {
  if (!quote) return null;
  return (
    <cite>
      <Face name={quote.speaker} />
      {quote.speaker.split(" ")[0]} · {clock(quote.ts)}
    </cite>
  );
}

function BoxDetails(props: { box: DesignBox; arrows: DesignArrow[]; name: (id: string) => string; onPick: (id: string) => void }) {
  const { box } = props;
  const rel = props.arrows.filter((a) => a.from === box.id || a.to === box.id);
  return (
    <>
      <h3 dir="auto">{box.label}</h3>
      {box.detail && <p dir="auto">{box.detail}</p>}
      <Said quote={box.quote} />
      {box.points.length > 0 && (
        <section>
          <h4>Said about it</h4>
          {box.points.map((p, i) => (
            <div key={i} className="brain-point" title={p.quote ? `“${p.quote.text}”` : undefined}>
              {p.by && <Face name={p.by} />}
              <span dir="auto">{p.text}</span>
            </div>
          ))}
        </section>
      )}
      <CaughtMarks caught={box.caught} />
      {rel.length > 0 && (
        <section>
          <h4>Relates to</h4>
          {rel.map((a) => {
            const out = a.from === box.id;
            const other = out ? a.to : a.from;
            return (
              <button key={a.id} type="button" className="brain-point link" onClick={() => props.onPick(other)}>
                <span dir="auto">
                  {out ? "" : `${props.name(other)} `}
                  <em>{a.label || "relates to"}</em>
                  {out ? ` ${props.name(other)}` : " this"}
                  {a.suggested ? " (suggested)" : ""}
                </span>
              </button>
            );
          })}
        </section>
      )}
    </>
  );
}
