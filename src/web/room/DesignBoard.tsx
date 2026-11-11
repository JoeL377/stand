// A design session's diagram (server/designSession.ts): boxes for the things being designed and
// labelled arrows for how they relate. What Stand heard shows dashed, with Keep and Drop, and joins
// the diagram only when someone keeps it. A click on a box or an arrow opens what's behind it, on
// your screen only. Context a session was given (MCP start_design_session) sits behind a Context button. In the call it grows as the team talks; on the session's page it is the record.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { BrainstormView, DesignArrow, DesignBox } from "../../shared/protocol.ts";
import { Face, KIND, KINDS, clock } from "./BrainMap.tsx";
import { Markdown } from "../Markdown.tsx";

const BOX_W = 176;
const PAD = 28;
const LOOP_H = 28;

/** How tall a box draws, so the layout leaves room for it: its label's lines, and the row of marks. */
const boxHeight = (b: DesignBox) => {
  const lines = Math.min(3, Math.max(1, Math.ceil(b.label.length / 20)));
  return 22 + lines * 19 + (b.points.length || b.caught.length ? 20 : 0) + (b.suggested ? 26 : 0);
};

export interface Laid {
  w: number;
  h: number;
  boxes: Array<{ box: DesignBox; x: number; y: number; w: number; h: number }>;
  arrows: Array<{ arrow: DesignArrow; path: string; x: number; y: number }>;
}

/** Places the diagram: boxes in ranks, left to right on a wide board and top to bottom on a narrow
 *  one, with each arrow's label on its line. */
export function layoutDiagram(boxes: DesignBox[], arrows: DesignArrow[], tall: boolean): Laid {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: tall ? "TB" : "LR", nodesep: 36, ranksep: tall ? 56 : 92, edgesep: 18, marginx: PAD, marginy: PAD });
  g.setDefaultEdgeLabel(() => ({}));
  const on = new Set(boxes.map((b) => b.id));
  // An arrow from a box to itself is a loop under that box, in the gap the layout leaves between boxes.
  const loops = arrows.filter((a) => a.from === a.to && on.has(a.from));
  for (const b of boxes) g.setNode(b.id, { width: BOX_W, height: boxHeight(b) });
  const drawn = arrows.filter((a) => a.from !== a.to && on.has(a.from) && on.has(a.to));
  for (const a of drawn) g.setEdge(a.from, a.to, { width: Math.min(150, 16 + a.label.length * 6.4 + (a.suggested ? 44 : 0)), height: 22, labelpos: "c" }, a.id);
  dagre.layout(g);
  const size = g.graph() as { width?: number; height?: number };
  return {
    w: Math.max(1, size.width ?? 1),
    h: Math.max(1, size.height ?? 1),
    boxes: boxes.map((box) => {
      const n = g.node(box.id) as { x: number; y: number; width: number; height: number };
      return { box, x: n.x, y: n.y, w: n.width, h: n.height };
    }),
    arrows: [...loops.map((arrow) => {
      const n = g.node(arrow.from) as { x: number; y: number; height: number };
      const k = loops.filter((a) => a.from === arrow.from).indexOf(arrow);
      const top = n.y + n.height / 2;
      const y = top + k * 20 + LOOP_H - 12;
      return { arrow, path: `M${n.x + 46},${top} C${n.x + 46},${y + 6} ${n.x - 46},${y + 6} ${n.x - 46},${top + 2}`, x: n.x, y };
    }), ...drawn.map((arrow) => {
      const e = g.edge({ v: arrow.from, w: arrow.to, name: arrow.id }) as { points: Array<{ x: number; y: number }>; x?: number; y?: number };
      const p = e.points;
      // A smooth line through the layout's points: straight to the first midpoint, then curves.
      let path = `M${p[0].x},${p[0].y}`;
      if (p.length < 3) path += p.slice(1).map((q) => ` L${q.x},${q.y}`).join("");
      else {
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i].x + p[i + 1].x) / 2;
          const my = (p[i].y + p[i + 1].y) / 2;
          path += i === p.length - 2 ? ` Q${p[i].x},${p[i].y} ${p[i + 1].x},${p[i + 1].y}` : ` Q${p[i].x},${p[i].y} ${mx},${my}`;
        }
      }
      const mid = p[Math.floor(p.length / 2)];
      return { arrow, path, x: e.x ?? mid.x, y: e.y ?? mid.y };
    })],
  };
}

export function DesignBoard(props: { brainstorm: BrainstormView; onKeep?: (id: string) => void; onDrop?: (id: string) => void; className?: string }) {
  const { brainstorm } = props;
  const { boxes, arrows } = brainstorm.design ?? { boxes: [], arrows: [] };
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
  // Laid out again only when what's on the diagram changes, not on every broadcast.
  const key = JSON.stringify([boxes.map((b) => [b.id, b.label, b.points.length, b.caught.length, !!b.suggested]), arrows.map((a) => [a.id, a.from, a.to, a.label, !!a.suggested]), tall]);
  const laid = useMemo(() => layoutDiagram(boxes, arrows, tall), [key]);
  // The whole diagram fits the board, down to a size that still reads; past that the board scrolls.
  const fit = size.w && size.h ? Math.min(1.3, Math.max(tall ? 0.7 : 0.6, Math.min(size.w / laid.w, size.h / laid.h))) : 1;

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
  const act = (fn: ((id: string) => void) | undefined, id: string) => (e: React.MouseEvent) => (e.stopPropagation(), fn?.(id));
  const openAt = laid.boxes.find((p) => p.box.id === openId)?.x ?? laid.arrows.find((p) => p.arrow.id === openId)?.x ?? 0;

  return (
    <div className={`brain design${tall ? " narrow" : ""}${props.className ? ` ${props.className}` : ""}`} onClick={() => (setOpenId(null), setShowContext(false))}>
      <div className="design-top">
        <span className="design-what" dir="auto" title={brainstorm.prompt}>
          {brainstorm.prompt}
        </span>
        {context.length > 0 && (
          <button type="button" className={`design-context${showContext ? " on" : ""}`} onClick={(e) => (e.stopPropagation(), setOpenId(null), setShowContext((v) => !v))}>
            Context <i>{context.length}</i>
          </button>
        )}
        {waiting > 0 && <span className="design-waiting">{waiting} {live ? "suggested" : "left as suggestions"}</span>}
        {brainstorm.busy && <span className="design-busy">Listening…</span>}
      </div>
      <div className="design-frame" ref={frame}>
        {boxes.length === 0 ? (
          <p className="design-empty muted">{live ? "Start talking it through. What Stand hears shows here as suggestions, and joins the diagram when someone keeps it." : "Nothing was put on this diagram."}</p>
        ) : (
          <div className="design-fit" style={{ width: laid.w * fit, height: laid.h * fit }}>
            <div className="design-canvas" style={{ width: laid.w, height: laid.h, transform: `scale(${fit})` }}>
              <svg className="design-lines" width={laid.w} height={laid.h} aria-hidden>
                <defs>
                  <marker id="design-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
                  </marker>
                </defs>
                {laid.arrows.map(({ arrow, path }) => (
                  <path key={arrow.id} d={path} className={`${arrow.suggested ? "suggested" : ""}${openId === arrow.id || openId === arrow.from || openId === arrow.to ? " on" : ""}`} markerEnd="url(#design-tip)" />
                ))}
              </svg>
              {laid.arrows.map(({ arrow, x, y }) => (
                <span key={arrow.id} className={`design-rel${arrow.suggested ? " suggested" : ""}${openId === arrow.id ? " on" : ""}`} style={{ left: x, top: y }}>
                  <button type="button" onClick={(e) => (e.stopPropagation(), pick(arrow.id))} title={`${name(arrow.from)} ${arrow.label || "relates to"} ${name(arrow.to)}`}>
                    {arrow.label || "relates to"}
                  </button>
                  {arrow.suggested && props.onKeep && (
                    <>
                      <button type="button" className="design-yes" aria-label="Keep this arrow" title="Keep" onClick={act(props.onKeep, arrow.id)}>
                        ✓
                      </button>
                      <button type="button" className="design-no" aria-label="Drop this arrow" title="Drop" onClick={act(props.onDrop, arrow.id)}>
                        ✕
                      </button>
                    </>
                  )}
                </span>
              ))}
              {laid.boxes.map(({ box, x, y, w, h }) => (
                <div
                  key={box.id}
                  role="button"
                  tabIndex={0}
                  className={`design-box${box.suggested ? " suggested" : ""}${openId === box.id ? " on" : ""}`}
                  style={{ left: x - w / 2, top: y - h / 2, width: w, minHeight: h }}
                  onClick={(e) => (e.stopPropagation(), pick(box.id))}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(box.id))}
                >
                  <strong dir="auto">{box.label}</strong>
                  {(box.points.length > 0 || box.caught.length > 0) && (
                    <span className="brain-marks">
                      {box.points.length > 0 && (
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
                  {box.suggested && props.onKeep && (
                    <span className="design-ask">
                      <button type="button" className="design-yes" onClick={act(props.onKeep, box.id)}>
                        Keep
                      </button>
                      <button type="button" className="design-no" onClick={act(props.onDrop, box.id)}>
                        Drop
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
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
        <aside className={`brain-card ${!tall && openAt * fit > size.w / 2 ? "left" : "right"}`} role="dialog" aria-label={openBox?.label ?? "Arrow"} onClick={(e) => e.stopPropagation()}>
          <header>
            <span className="brain-crumb plain">{(openBox ?? openArrow)!.suggested ? "Suggested" : openBox ? "Part" : "Relation"}</span>
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
          {props.onKeep && (
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
      {box.caught.length > 0 && (
        <section>
          <h4>Caught</h4>
          {box.caught.map((c) => {
            const k = KIND[c.kind];
            return (
              <div key={c.id} className={`brain-point ${c.kind}${c.done ? " done" : ""}`} title={k.label}>
                <k.Icon />
                <span dir="auto">{c.text}</span>
                {c.owner && <small>{c.owner.split(" ")[0]}</small>}
              </div>
            );
          })}
        </section>
      )}
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
