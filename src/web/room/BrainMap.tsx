// A brainstorm's map: the sentence it started from in the middle, the directions the talk opened
// around it, and the ideas said under each. In the call it grows as Stand reads the talk
// (server/brainstorm.ts); on the brainstorm's page it is the record. A click on a circle opens
// what's behind it, on your screen only.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrainCaught, BrainNode, BrainstormView } from "../../shared/protocol.ts";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { usePersonColors } from "../PersonColors.tsx";
import { initials } from "../util.ts";

const FRESH_MS = 7_000;
export const KIND = { action: { label: "To do", Icon: TodoIcon }, decision: { label: "Decided", Icon: DecidedIcon }, question: { label: "Open", Icon: QuestionIcon } } as const;
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

interface Placed {
  id: string;
  x: number;
  y: number;
  /** The circle it hangs off: "root" or a direction's id. */
  from: string;
  node?: BrainNode;
  /** A "+3" pill standing in for ideas that don't fit. */
  more?: number;
}

/** A centre on the map: the brainstorm's own sentence ("root"), or a separate subject the talk moved
 *  to, drawn as a centre of its own with its directions around it ("hub:<name>"). */
export interface Hub {
  id: string;
  label: string | null;
  x: number;
  y: number;
}

/** The separate subjects a map holds besides its centre, in the order they came up. */
export const clustersOf = (nodes: BrainNode[]): string[] => [...new Set(nodes.filter((n) => !n.parent && n.cluster).map((n) => n.cluster!))];
export const hubOf = (n: BrainNode) => (n.cluster ? `hub:${n.cluster}` : "root");

/** Where every circle goes: a radial tree around each centre. With one centre it has the whole
 *  canvas; a map the talk took to other subjects splits the canvas, the first centre taking the most. */
export function layout(nodes: BrainNode[], w: number, h: number): Placed[] {
  return layoutAll(nodes, w, h).placed;
}

export function layoutAll(nodes: BrainNode[], w: number, h: number): { placed: Placed[]; hubs: Hub[] } {
  if (!w || !h) return { placed: [], hubs: [] };
  const big = h > w ? 1.35 : 1;
  const clusters = clustersOf(nodes);
  if (!clusters.length) {
    const hubs = [{ id: "root", label: null, x: w / 2, y: h / 2 }];
    return { placed: spread(radial(nodes, nodes.filter((n) => !n.parent), "root", 0, 0, w, h, big), w, h, big, hubs), hubs };
  }
  // Cells along the long side: the centre's own cell is wider, as it usually holds the most.
  const across = w >= h;
  const shares = [1.4, ...clusters.map(() => 1)];
  const sum = shares.reduce((a, b) => a + b, 0);
  const long = across ? w : h;
  let at = 0;
  const hubs: Hub[] = [];
  const placed: Placed[] = [];
  ["root", ...clusters].forEach((c, i) => {
    const size = (long * shares[i]!) / sum;
    const [x0, y0, cw, ch] = across ? [at, 0, size, h] : [0, at, w, size];
    at += size;
    const id = i === 0 ? "root" : `hub:${c}`;
    hubs.push({ id, label: i === 0 ? null : c, x: x0 + cw / 2, y: y0 + ch / 2 });
    const dirs = nodes.filter((n) => !n.parent && (i === 0 ? !n.cluster : n.cluster === c));
    placed.push(...radial(nodes, dirs, id, x0, y0, cw, ch, big));
  });
  return { placed: spread(placed, w, h, big, hubs), hubs };
}

/** One centre's directions and their ideas, in the cell (x0, y0, w, h). Each direction gets a slice
 *  of the circle sized by how many ideas it holds, in the order the directions came up, and its ideas
 *  fan out inside that slice. */
function radial(nodes: BrainNode[], dirs: BrainNode[], hub: string, x0: number, y0: number, w: number, h: number, big: number): Placed[] {
  if (!dirs.length) return [];
  const ideasOf = (id: string) => nodes.filter((n) => n.parent === id);
  // Fewer ideas per direction show as the map fills, so labels never pile up.
  // A phone's canvas is taller than wide and draws larger type, so each circle needs more of it.
  const room = Math.max(8, Math.floor((w * h) / (34_000 * big * big)));
  const cap = [12, 8, 6, 5, 4, 3, 2].find((c) => dirs.reduce((n, d) => n + Math.min(c, ideasOf(d.id).length), 0) <= room) ?? 2;
  const shown = dirs.map((d) => {
    const all = ideasOf(d.id);
    const fits = all.length > cap ? all.slice(0, cap - 1) : all;
    return { d, ideas: fits, more: all.length - fits.length };
  });
  const weight = (s: (typeof shown)[number]) => 1.4 + s.ideas.length + (s.more ? 1 : 0);
  const total = shown.reduce((n, s) => n + weight(s), 0);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const r1 = { x: Math.min(w * 0.23, 250), y: Math.min(h * 0.25, 170) };
  const r2 = { x: w / 2 - Math.min(96, w * 0.12), y: h / 2 - 36 };
  const out: Placed[] = [];
  // The first direction starts at the upper left, and they go round clockwise.
  let a = -Math.PI * 0.9;
  for (const s of shown) {
    const span = (weight(s) / total) * Math.PI * 2;
    const mid = a + span / 2;
    out.push({ id: s.d.id, x: cx + r1.x * Math.cos(mid), y: cy + r1.y * Math.sin(mid), from: hub, node: s.d });
    const slots = s.ideas.length + (s.more ? 1 : 0);
    // With one direction its ideas would circle the whole map: keep them to an arc on its side.
    const arc = Math.min(span, Math.PI * 1.1) * 0.8;
    for (let k = 0; k < slots; k++) {
      const t = slots === 1 ? mid : mid - arc / 2 + (arc * k) / (slots - 1);
      // Crowded slices stagger in and out so neighbours don't touch.
      const near = slots > 3 && k % 2 === 1 ? 0.8 : 1;
      const p = { x: cx + r2.x * near * Math.cos(t), y: cy + r2.y * near * Math.sin(t), from: s.d.id };
      const idea = s.ideas[k];
      out.push(idea ? { id: idea.id, ...p, node: idea } : { id: `more:${s.d.id}`, ...p, more: s.more });
    }
    a += span;
  }
  return out;
}

/** Room kept clear between two circles. */
const GAP = 22;

/** How big a circle draws, near enough to keep its neighbours off it. */
function boxOf(p: Placed): { w: number; h: number } {
  if (p.more) return { w: 84, h: 32 };
  const dir = !p.node?.parent;
  const text = p.node?.label ?? "";
  const max = dir ? 170 : 158;
  const pad = dir ? 36 : 26;
  const per = dir ? 8 : 6.9;
  const inner = max - pad;
  const lines = Math.max(1, Math.ceil((text.length * per) / inner));
  // The count of what was built on it and the marks for what was caught sit in a row underneath.
  const marks = p.node && (p.node.points.length || p.node.caught.length) ? 20 : 0;
  return { w: lines > 1 ? max : Math.min(max, Math.max(text.length * per + pad, marks ? 90 : 0)), h: (dir ? 20 : 12) + lines * (dir ? 17 : 16) + marks };
}

/** Nudges circles apart until none touch: each keeps GAP clear of the others and of the sentence
 *  in the middle, and stays on the canvas. Directions give way less than ideas, so the shape holds. */
export function spread(placed: Placed[], w: number, h: number, big = 1, hubs: Array<{ x: number; y: number }> = [{ x: w / 2, y: h / 2 }]): Placed[] {
  // Each centre is fixed; a second or third one draws a little smaller than the map's own.
  const centres = hubs.map((c, i) => ({ x: c.x, y: c.y, w: (i ? 200 : Math.min(290, Math.max(180, w * 0.24))) * big, h: (i ? 80 : 104) * big, fixed: true, heavy: 1 }));
  const boxes = placed.map((p) => {
    const b = boxOf(p);
    return { x: p.x, y: p.y, w: b.w * big, h: b.h * big, fixed: false, heavy: p.from === "root" || p.from.startsWith("hub:") ? 3 : 1 };
  });
  const all = [...centres, ...boxes];
  const edge = 8;
  for (let pass = 0; pass < 240; pass++) {
    let moved = false;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const A = all[i]!;
        const B = all[j]!;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const ox = (A.w + B.w) / 2 + GAP - Math.abs(dx);
        const oy = (A.h + B.h) / 2 + GAP - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Out along whichever way is shorter; the heavier one moves less.
        const share = A.fixed ? 1 : B.fixed ? 0 : A.heavy / (A.heavy + B.heavy);
        if (ox < oy) {
          const s = dx >= 0 ? 1 : -1;
          if (!B.fixed) B.x += s * ox * share * 0.6;
          if (!A.fixed) A.x -= s * ox * (1 - share) * 0.6;
        } else {
          const s = dy >= 0 ? 1 : -1;
          if (!B.fixed) B.y += s * oy * share * 0.6;
          if (!A.fixed) A.y -= s * oy * (1 - share) * 0.6;
        }
      }
    }
    for (const b of boxes) {
      b.x = Math.min(w - b.w / 2 - edge, Math.max(b.w / 2 + edge, b.x));
      b.y = Math.min(h - b.h / 2 - edge, Math.max(b.h / 2 + edge, b.y));
    }
    if (!moved) break;
  }
  return placed.map((p, i) => ({ ...p, x: boxes[i]!.x, y: boxes[i]!.y }));
}

export const KINDS: Array<{ kind: BrainCaught["kind"]; Icon: typeof TodoIcon; one: string; many: string }> = [
  { kind: "action", Icon: TodoIcon, one: "to-do", many: "To-dos" },
  { kind: "decision", Icon: DecidedIcon, one: "decision", many: "Decisions" },
  { kind: "question", Icon: QuestionIcon, one: "open question", many: "Open questions" },
];

export function BrainMap(props: { brainstorm: BrainstormView; onRemove?: (id: string) => void; className?: string }) {
  const { brainstorm } = props;
  const nodes = brainstorm.nodes;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = size.w > 0 && size.w < 620;
  // A phone draws the whole map on a canvas bigger than its screen, fitted to it, and you drag and pinch.
  const cw = narrow ? Math.max(1000, size.w * 2.6) : size.w;
  const ch = narrow ? cw * (size.h / Math.max(1, size.w)) : size.h;
  const fit = narrow ? size.w / cw : 1;
  /** Where you've dragged and pinched to; null is the whole map fitted to the screen. */
  const [view, setView] = useState<{ k: number; x: number; y: number } | null>(null);
  const v = view ?? { k: fit, x: 0, y: 0 };
  // A phone never goes smaller than the whole map; a wider screen can shrink it a little and grow it more.
  const minK = narrow ? fit : 0.6;
  const maxK = narrow ? 1.5 : 2.5;
  const clampView = (k: number, x: number, y: number) => {
    const kk = Math.min(maxK, Math.max(minK, k));
    const lim = (pos: number, screen: number, canvas: number) => (canvas * kk <= screen ? (screen - canvas * kk) / 2 : Math.min(0, Math.max(screen - canvas * kk, pos)));
    return Math.abs(kk - fit) <= fit * 0.02 ? null : { k: kk, x: lim(x, size.w, cw), y: lim(y, size.h, ch) };
  };
  /** Zooms by `by` keeping the point (px, py) of the screen where it is. */
  const zoomAt = (from: { k: number; x: number; y: number }, by: number, px: number, py: number, dx = 0, dy = 0) => {
    const k = Math.min(maxK, Math.max(minK, from.k * by));
    const r = k / from.k;
    return clampView(k, px - (px - from.x) * r + dx, py - (py - from.y) * r + dy);
  };
  // The wheel and a trackpad pinch zoom the graph only. A pinch reaches the page as a wheel with
  // Control held, which the browser would also use to zoom the whole page, card and all, unless it
  // is refused here; React's own wheel handler can't refuse it.
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e) => {
    const onCard = !!(e.target as HTMLElement).closest?.(".brain-card");
    // A card scrolls as usual; a pinch on it does nothing.
    if (onCard && !e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (onCard) return;
    const rect = box.current!.getBoundingClientRect();
    setView(zoomAt(v, Math.exp(-e.deltaY / (e.ctrlKey ? 90 : 300)), e.clientX - rect.left, e.clientY - rect.top));
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => wheel.current(e);
    // Safari sends its own pinch events and zooms the page on them.
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", stop);
    el.addEventListener("gesturechange", stop);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", stop);
      el.removeEventListener("gesturechange", stop);
    };
  }, []);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const gestures = {
        onPointerDown: (e: React.PointerEvent) => {
          if ((e.target as HTMLElement).closest(".brain-card, .brain-fit, .brain-kinds, .brain-zoom")) return;
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (touches.current.size === 1) moved.current = false;
        },
        onPointerMove: (e: React.PointerEvent) => {
          const was = touches.current.get(e.pointerId);
          if (!was) return;
          const rect = box.current!.getBoundingClientRect();
          const others = [...touches.current].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
          const dx = e.clientX - was.x;
          const dy = e.clientY - was.y;
          if (!moved.current && !others.length && Math.hypot(dx, dy) < 6) return;
          moved.current = true;
          touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (!others.length) return setView(clampView(v.k, v.x + dx, v.y + dy));
          // Two fingers: the map follows the point between them, and scales with how far apart they are.
          const o = others[0];
          const before = Math.hypot(was.x - o.x, was.y - o.y) || 1;
          const after = Math.hypot(e.clientX - o.x, e.clientY - o.y) || 1;
          setView(zoomAt(v, after / before, (e.clientX + o.x) / 2 - rect.left, (e.clientY + o.y) / 2 - rect.top, dx / 2, dy / 2));
        },
        onPointerUp: (e: React.PointerEvent) => void touches.current.delete(e.pointerId),
        onPointerCancel: (e: React.PointerEvent) => void touches.current.delete(e.pointerId),
        onPointerLeave: (e: React.PointerEvent) => void touches.current.delete(e.pointerId),
        // A drag that ends on a circle isn't a tap on it.
        onClickCapture: (e: React.MouseEvent) => {
          if (!moved.current) return;
          moved.current = false;
          e.stopPropagation();
        },
        onDoubleClick: (e: React.MouseEvent) => {
          if ((e.target as HTMLElement).closest(".brain-node, .brain-card")) return;
          const rect = box.current!.getBoundingClientRect();
          setView(view ? null : zoomAt(v, narrow ? 1 / fit : 1.8, e.clientX - rect.left, e.clientY - rect.top));
        },
      };
  const { placed, hubs } = useMemo(() => layoutAll(nodes, cw, ch), [nodes, cw, ch]);
  const at = new Map(placed.map((p) => [p.id, p]));
  const hubAt = new Map(hubs.map((c) => [c.id, c]));
  const rootAt = hubAt.get("root") ?? { x: cw / 2, y: ch / 2 };

  // A circle that arrives while you watch glows for a few seconds with who raised it.
  const seen = useRef<Map<string, number> | null>(null);
  if (!seen.current) seen.current = new Map(nodes.map((n) => [n.id, 0]));
  const now = Date.now();
  for (const n of nodes) if (!seen.current.has(n.id)) seen.current.set(n.id, now);
  const fresh = (id: string) => now - (seen.current!.get(id) ?? 0) < FRESH_MS;
  const [, tick] = useState(0);
  const anyFresh = nodes.some((n) => fresh(n.id));
  useEffect(() => {
    if (!anyFresh) return;
    const t = setTimeout(() => tick((n) => n + 1), FRESH_MS + 100);
    return () => clearTimeout(t);
  }, [anyFresh, nodes.length]);

  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId === "root" ? null : (nodes.find((n) => n.id === openId) ?? null);
  // A "+N more" pill opens a card of just the ideas it stands for.
  const moreOf = openId?.startsWith("more:") ? (nodes.find((n) => n.id === openId.slice(5)) ?? null) : null;
  useEffect(() => {
    if (!openId) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpenId(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openId]);

  const dirs = nodes.filter((n) => !n.parent);
  const ideas = nodes.filter((n) => n.parent);
  const cx = cw / 2;
  const cy = ch / 2;
  const [only, setOnly] = useState<BrainCaught["kind"] | null>(null);
  const pick = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  // What came out of a circle: the to-dos, decisions and open questions caught while it was talked about.
  const totals = KINDS.map((k) => ({ ...k, n: new Set(nodes.flatMap((n) => n.caught.filter((c) => c.kind === k.kind).map((c) => c.id))).size })).filter((k) => k.n > 0);
  const has = (n: BrainNode, kind: BrainCaught["kind"]) => n.caught.some((c) => c.kind === kind);
  /** With a kind picked, a circle stays lit when it or one of its ideas has that kind. */
  const lit = (n: BrainNode) => !only || has(n, only) || (!n.parent && nodes.some((i) => i.parent === n.id && has(i, only)));

  return (
    <div className={`brain${narrow ? " narrow" : ""}${props.className ? ` ${props.className}` : ""}`} ref={box} onClick={() => setOpenId(null)} {...gestures}>
      {!narrow && dirs.length > 0 && (
        <div className="brain-zoom" role="group" aria-label="Zoom" onClick={(e) => e.stopPropagation()}>
          <button type="button" aria-label="Zoom out" title="Zoom out" disabled={v.k <= minK + 0.001} onClick={() => setView(zoomAt(v, 1 / 1.3, size.w / 2, size.h / 2))}>
            −
          </button>
          <button type="button" className="brain-zoom-pct" title="See it all" onClick={() => setView(null)}>
            {Math.round(v.k * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" disabled={v.k >= maxK - 0.001} onClick={() => setView(zoomAt(v, 1.3, size.w / 2, size.h / 2))}>
            +
          </button>
        </div>
      )}
      {narrow && view && (
        <button type="button" className="brain-fit" onClick={(e) => (e.stopPropagation(), setView(null))}>
          See it all
        </button>
      )}
      {totals.length > 0 && (
        <div className="brain-kinds" role="group" aria-label="Show one kind" onClick={(e) => e.stopPropagation()}>
          {totals.map(({ kind, Icon, many, n }) => (
            <button key={kind} type="button" className={`brain-kind-pill ${kind}${only === kind ? " on" : ""}`} aria-pressed={only === kind} onClick={() => setOnly(only === kind ? null : kind)}>
              <Icon size={13} />
              {many}
              <span>{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="brain-canvas" style={narrow || view ? { width: cw, height: ch, inset: "auto", top: 0, left: 0, transformOrigin: "0 0", transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})` } : undefined}>
          <svg className="brain-lines" width={cw} height={ch} aria-hidden>
            {placed.map((p) => {
              const hub = hubAt.get(p.from);
              const from = hub ?? at.get(p.from);
              return from ? <line key={p.id} x1={from.x} y1={from.y} x2={p.x} y2={p.y} className={hub ? "trunk" : undefined} /> : null;
            })}
          </svg>
          <div className={`brain-node root${brainstorm.busy ? " busy" : ""}`} style={{ left: rootAt.x, top: rootAt.y }}>
            <span dir="auto">{brainstorm.prompt}</span>
            {!dirs.length && (
              <small>{brainstorm.status !== "live" ? "Nothing came up in this one" : brainstorm.heard === "failed" ? "Stand couldn't read the talk just now. It tries again as you talk." : "✦ Ideas branch out here as people talk"}</small>
            )}
          </div>
          {hubs
            .filter((c) => c.label)
            .map((c) => (
              <div key={c.id} className="brain-node root hub" style={{ left: c.x, top: c.y }} title="The talk moved to this, so it has its own centre">
                <span dir="auto">{c.label}</span>
              </div>
            ))}
          {placed.map((p) =>
            p.node ? (
              <button
                key={p.id}
                type="button"
                className={`brain-node ${p.node.parent ? "idea" : "dir"}${fresh(p.id) ? " fresh" : ""}${openId === p.id ? " on" : ""}${lit(p.node) ? "" : " dim"}`}
                style={{ left: p.x, top: p.y }}
                aria-expanded={openId === p.id}
                onClick={(e) => (e.stopPropagation(), pick(p.id))}
              >
                <span className="brain-label">
                  {fresh(p.id) && p.node.by && <Face name={p.node.by} />}
                  <span dir="auto">{p.node.label}</span>
                </span>
                {(p.node.points.length > 0 || p.node.caught.length > 0) && (
                  <span className="brain-marks">
                    {p.node.points.length > 0 && (
                      <i className="brain-badge" title={p.node.points.length === 1 ? "1 remark built on it" : `${p.node.points.length} remarks built on it`}>
                        {p.node.points.length}
                      </i>
                    )}
                    {KINDS.filter((k) => has(p.node!, k.kind)).map(({ kind, Icon, one }) => {
                      const n = p.node!.caught.filter((c) => c.kind === kind).length;
                      return (
                        <i key={kind} className={`brain-kind ${kind}`} title={n === 1 ? `1 ${one}` : `${n} ${one}s`}>
                          <Icon size={12} />
                          {n > 1 && n}
                        </i>
                      );
                    })}
                  </span>
                )}
              </button>
            ) : (
              <button key={p.id} type="button" className={`brain-node idea more${only ? " dim" : ""}${openId === p.id ? " on" : ""}`} style={{ left: p.x, top: p.y }} onClick={(e) => (e.stopPropagation(), pick(p.id))}>
                +{p.more} more
              </button>
            ),
          )}
      </div>
      {moreOf && (
        <aside className={`brain-card ${!narrow && (at.get(openId!)?.x ?? 0) > cx ? "left" : "right"}`} role="dialog" aria-label={`More ideas on ${moreOf.label}`} onClick={(e) => e.stopPropagation()}>
          <header>
            <button type="button" className="brain-crumb" onClick={() => setOpenId(moreOf.id)}>
              {moreOf.label}
            </button>
            <button type="button" className="brain-x" aria-label="Close" onClick={() => setOpenId(null)}>
              ✕
            </button>
          </header>
          <section>
            <h4>Not on the map · {ideas.filter((i) => i.parent === moreOf.id && !at.has(i.id)).length}</h4>
            {ideas
              .filter((i) => i.parent === moreOf.id && !at.has(i.id))
              .map((i) => (
                <button key={i.id} type="button" className="brain-point link" onClick={() => setOpenId(i.id)}>
                  {i.by && <Face name={i.by} />}
                  <span dir="auto">{i.label}</span>
                </button>
              ))}
          </section>
        </aside>
      )}
      {open && (
        <BrainDetails
          node={open}
          parent={open.parent ? (nodes.find((n) => n.id === open.parent) ?? null) : null}
          ideas={ideas.filter((i) => i.parent === open.id)}
          onMap={(id) => at.has(id)}
          // It opens on the side away from the circle, so the circle stays in view.
          side={!narrow && (at.get(open.id)?.x ?? 0) > cx ? "left" : "right"}
          onPick={setOpenId}
          onClose={() => setOpenId(null)}
          onRemove={props.onRemove && brainstorm.status === "live" ? () => (props.onRemove!(open.id), setOpenId(null)) : undefined}
        />
      )}
    </div>
  );
}

/** What a card's circle or box caught: one mark with a count per kind, as on the map. The lines
 *  themselves show while a mark is hovered or focused; a click (a tap on a phone) keeps them open. */
export function CaughtMarks({ caught }: { caught: BrainCaught[] }) {
  const [hover, setHover] = useState<BrainCaught["kind"] | null>(null);
  const [pinned, setPinned] = useState<BrainCaught["kind"] | null>(null);
  const touched = useRef(0);
  const kinds = KINDS.map((k) => ({ ...k, got: caught.filter((c) => c.kind === k.kind) })).filter((k) => k.got.length);
  if (!kinds.length) return null;
  const open = kinds.find((k) => k.kind === (hover ?? pinned));
  return (
    <section className="brain-got" onMouseLeave={() => setHover(null)}>
      <div className="brain-got-row">
        {kinds.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`brain-got-mark ${k.kind}${open?.kind === k.kind ? " on" : ""}`}
            aria-expanded={open?.kind === k.kind}
            aria-label={`${k.got.length} ${k.got.length === 1 ? k.one : k.many}`}
            // A finger has no hover: its tap opens and closes the lines, on the way down, because the
            // card grows as they open and a mark that moved under the finger never gets its click.
            onPointerEnter={(e) => e.pointerType === "mouse" && setHover(k.kind)}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse") return;
              touched.current = Date.now();
              setPinned(pinned === k.kind ? null : k.kind);
            }}
            onFocus={(e) => e.currentTarget.matches(":focus-visible") && setHover(k.kind)}
            onBlur={() => setHover(null)}
            onClick={() => Date.now() - touched.current > 700 && setPinned(pinned === k.kind ? null : k.kind)}
          >
            <k.Icon />
            {k.got.length}
          </button>
        ))}
        {open && <h4>{open.many}</h4>}
      </div>
      {open?.got.map((c) => (
        <div key={c.id} className={`brain-point caught ${c.kind}${c.done ? " done" : ""}`}>
          <span dir="auto">{c.text}</span>
          {c.owner && <small>{c.owner.split(" ")[0]}</small>}
        </div>
      ))}
    </section>
  );
}

export function Face({ name }: { name: string }) {
  const colorFor = usePersonColors();
  return (
    <span className="brain-face" style={{ background: colorFor(name) }} title={name}>
      {initials(name)}
    </span>
  );
}

function BrainDetails(props: { node: BrainNode; parent: BrainNode | null; ideas: BrainNode[]; onMap: (id: string) => boolean; side: "left" | "right"; onPick: (id: string) => void; onClose: () => void; onRemove?: () => void }) {
  const { node } = props;
  const hidden = props.ideas.filter((i) => !props.onMap(i.id));
  return (
    <aside className={`brain-card ${props.side}`} role="dialog" aria-label={node.label} onClick={(e) => e.stopPropagation()}>
      <header>
        {props.parent ? (
          <button type="button" className="brain-crumb" onClick={() => props.onPick(props.parent!.id)}>
            {props.parent.label}
          </button>
        ) : (
          <span className="brain-crumb plain">Direction</span>
        )}
        <button type="button" className="brain-x" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </header>
      <h3 dir="auto">{node.label}</h3>
      {node.detail && <p dir="auto">{node.detail}</p>}
      {node.quote && (
        // Who raised it and when; the words themselves are in the transcript.
        <cite>
          <Face name={node.quote.speaker} />
          {node.quote.speaker.split(" ")[0]} · {clock(node.quote.ts)}
        </cite>
      )}
      {node.points.length > 0 && (
        <section>
          <h4>Built on it</h4>
          {node.points.map((p, i) => (
            <div key={i} className="brain-point" title={p.quote ? `“${p.quote.text}”` : undefined}>
              {p.by && <Face name={p.by} />}
              <span dir="auto">{p.text}</span>
            </div>
          ))}
        </section>
      )}
      <CaughtMarks caught={node.caught} />
      {/* The ideas the map had no room for come first, under their own heading: they're what "+N more" stands for. */}
      {[
        { title: hidden.length ? "Not on the map" : "Ideas", list: hidden.length ? hidden : props.ideas },
        { title: "On the map", list: hidden.length ? props.ideas.filter((i) => props.onMap(i.id)) : [] },
      ].map(
        (g) =>
          g.list.length > 0 && (
            <section key={g.title}>
              <h4>
                {g.title} · {g.list.length}
              </h4>
              {g.list.map((i) => (
                <button key={i.id} type="button" className="brain-point link" onClick={() => props.onPick(i.id)}>
                  {i.by && <Face name={i.by} />}
                  <span dir="auto">{i.label}</span>
                </button>
              ))}
            </section>
          ),
      )}
      {props.onRemove && (
        <footer>
          <button type="button" className="link muted" onClick={props.onRemove} title="Stand got this one wrong. It won't come back.">
            Take off the map
          </button>
        </footer>
      )}
    </aside>
  );
}
