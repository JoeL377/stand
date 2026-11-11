// A brainstorm's map: the sentence it started from in the middle, the directions the talk opened
// around it, and the ideas said under each. In the call it grows as Stand reads the talk
// (server/brainstorm.ts); on the brainstorm's page it is the record. A click on a circle opens
// what's behind it, on your screen only.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrainNode, BrainstormView } from "../../shared/protocol.ts";
import { DecidedIcon, QuestionIcon, TodoIcon } from "../NoteIcons.tsx";
import { usePersonColors } from "../PersonColors.tsx";
import { initials } from "../util.ts";

const FRESH_MS = 7_000;
const KIND = { action: { label: "To do", Icon: TodoIcon }, decision: { label: "Decided", Icon: DecidedIcon }, question: { label: "Open", Icon: QuestionIcon } } as const;
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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

/** Where every circle goes: a radial tree. Each direction gets a slice of the circle sized by how
 *  many ideas it holds, in the order the directions came up, and its ideas fan out inside that slice. */
export function layout(nodes: BrainNode[], w: number, h: number): Placed[] {
  const dirs = nodes.filter((n) => !n.parent);
  if (!dirs.length || !w || !h) return [];
  const ideasOf = (id: string) => nodes.filter((n) => n.parent === id);
  // Fewer ideas per direction show as the map fills, so labels never pile up.
  // A phone's canvas is taller than wide and draws larger type, so each circle needs more of it.
  const big = h > w ? 1.35 : 1;
  const room = Math.max(8, Math.floor((w * h) / (34_000 * big * big)));
  const cap = [12, 8, 6, 5, 4, 3, 2].find((c) => dirs.reduce((n, d) => n + Math.min(c, ideasOf(d.id).length), 0) <= room) ?? 2;
  const shown = dirs.map((d) => {
    const all = ideasOf(d.id);
    const fits = all.length > cap ? all.slice(0, cap - 1) : all;
    return { d, ideas: fits, more: all.length - fits.length };
  });
  const weight = (s: (typeof shown)[number]) => 1.4 + s.ideas.length + (s.more ? 1 : 0);
  const total = shown.reduce((n, s) => n + weight(s), 0);
  const cx = w / 2;
  const cy = h / 2;
  const r1 = { x: Math.min(w * 0.23, 250), y: Math.min(h * 0.25, 170) };
  const r2 = { x: w / 2 - Math.min(96, w * 0.12), y: h / 2 - 36 };
  const out: Placed[] = [];
  // The first direction starts at the upper left, and they go round clockwise.
  let a = -Math.PI * 0.9;
  for (const s of shown) {
    const span = (weight(s) / total) * Math.PI * 2;
    const mid = a + span / 2;
    out.push({ id: s.d.id, x: cx + r1.x * Math.cos(mid), y: cy + r1.y * Math.sin(mid), from: "root", node: s.d });
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
  return spread(out, w, h, big);
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
  const extra = 24; // the count or the speaker's face beside the words
  const inner = max - pad - extra;
  const lines = Math.max(1, Math.ceil((text.length * per) / inner));
  return { w: lines > 1 ? max : Math.min(max, text.length * per + pad + extra), h: (dir ? 20 : 12) + lines * (dir ? 17 : 16) };
}

/** Nudges circles apart until none touch: each keeps GAP clear of the others and of the sentence
 *  in the middle, and stays on the canvas. Directions give way less than ideas, so the shape holds. */
export function spread(placed: Placed[], w: number, h: number, big = 1): Placed[] {
  const root = { x: w / 2, y: h / 2, w: Math.min(290, Math.max(180, w * 0.24)) * big, h: 104 * big, fixed: true, heavy: 1 };
  const boxes = placed.map((p) => {
    const b = boxOf(p);
    return { x: p.x, y: p.y, w: b.w * big, h: b.h * big, fixed: false, heavy: p.from === "root" ? 3 : 1 };
  });
  const all = [root, ...boxes];
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
  const v = narrow ? (view ?? { k: fit, x: 0, y: 0 }) : { k: 1, x: 0, y: 0 };
  const clampView = (k: number, x: number, y: number) => {
    const kk = Math.min(1.5, Math.max(fit, k));
    const lim = (pos: number, screen: number, canvas: number) => (canvas * kk <= screen ? (screen - canvas * kk) / 2 : Math.min(0, Math.max(screen - canvas * kk, pos)));
    return kk <= fit * 1.02 ? null : { k: kk, x: lim(x, size.w, cw), y: lim(y, size.h, ch) };
  };
  /** Zooms by `by` keeping the point (px, py) of the screen where it is. */
  const zoomAt = (from: { k: number; x: number; y: number }, by: number, px: number, py: number, dx = 0, dy = 0) => {
    const k = Math.min(1.5, Math.max(fit, from.k * by));
    const r = k / from.k;
    return clampView(k, px - (px - from.x) * r + dx, py - (py - from.y) * r + dy);
  };
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const gestures = narrow
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if ((e.target as HTMLElement).closest(".brain-card, .brain-fit")) return;
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
        onWheel: (e: React.WheelEvent) => {
          const rect = box.current!.getBoundingClientRect();
          setView(zoomAt(v, Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top));
        },
        onDoubleClick: (e: React.MouseEvent) => {
          if ((e.target as HTMLElement).closest(".brain-node, .brain-card")) return;
          const rect = box.current!.getBoundingClientRect();
          setView(view ? null : zoomAt(v, 1 / fit, e.clientX - rect.left, e.clientY - rect.top));
        },
      }
    : {};
  const placed = useMemo(() => layout(nodes, cw, ch), [nodes, cw, ch]);
  const at = new Map(placed.map((p) => [p.id, p]));

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
  const pick = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  const extra = (n: BrainNode) => n.points.length + n.caught.length;

  return (
    <div className={`brain${narrow ? " narrow" : ""}${props.className ? ` ${props.className}` : ""}`} ref={box} onClick={() => setOpenId(null)} {...gestures}>
      {narrow && view && (
        <button type="button" className="brain-fit" onClick={(e) => (e.stopPropagation(), setView(null))}>
          See it all
        </button>
      )}
      <div className="brain-canvas" style={narrow ? { width: cw, height: ch, transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})` } : undefined}>
          <svg className="brain-lines" width={cw} height={ch} aria-hidden>
            {placed.map((p) => {
              const from = p.from === "root" ? { x: cx, y: cy } : at.get(p.from);
              return from ? <line key={p.id} x1={from.x} y1={from.y} x2={p.x} y2={p.y} className={p.from === "root" ? "trunk" : undefined} /> : null;
            })}
          </svg>
          <div className={`brain-node root${brainstorm.busy ? " busy" : ""}`} style={{ left: cx, top: cy }}>
            <span dir="auto">{brainstorm.prompt}</span>
            {!dirs.length && <small>{brainstorm.status === "live" ? "✦ Ideas branch out here as people talk" : "Nothing came up in this one"}</small>}
          </div>
          {placed.map((p) =>
            p.node ? (
              <button
                key={p.id}
                type="button"
                className={`brain-node ${p.node.parent ? "idea" : "dir"}${fresh(p.id) ? " fresh" : ""}${openId === p.id ? " on" : ""}`}
                style={{ left: p.x, top: p.y }}
                aria-expanded={openId === p.id}
                onClick={(e) => (e.stopPropagation(), pick(p.id))}
              >
                {fresh(p.id) && p.node.by && <Face name={p.node.by} />}
                <span dir="auto">{p.node.label}</span>
                {extra(p.node) > 0 && <i className="brain-badge">{extra(p.node)}</i>}
              </button>
            ) : (
              <button key={p.id} type="button" className="brain-node idea more" style={{ left: p.x, top: p.y }} onClick={(e) => (e.stopPropagation(), pick(p.from))}>
                +{p.more} more
              </button>
            ),
          )}
      </div>
      {open && (
        <BrainDetails
          node={open}
          parent={open.parent ? (nodes.find((n) => n.id === open.parent) ?? null) : null}
          ideas={ideas.filter((i) => i.parent === open.id)}
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

function Face({ name }: { name: string }) {
  const colorFor = usePersonColors();
  return (
    <span className="brain-face" style={{ background: colorFor(name) }} title={name}>
      {initials(name)}
    </span>
  );
}

function BrainDetails(props: { node: BrainNode; parent: BrainNode | null; ideas: BrainNode[]; side: "left" | "right"; onPick: (id: string) => void; onClose: () => void; onRemove?: () => void }) {
  const { node } = props;
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
        <blockquote>
          <span dir="auto">“{node.quote.text}”</span>
          <cite>
            <Face name={node.quote.speaker} />
            {node.quote.speaker.split(" ")[0]} · {clock(node.quote.ts)}
          </cite>
        </blockquote>
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
      {node.caught.length > 0 && (
        <section>
          <h4>Caught</h4>
          {node.caught.map((c) => {
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
      {props.ideas.length > 0 && (
        <section>
          <h4>Ideas · {props.ideas.length}</h4>
          {props.ideas.map((i) => (
            <button key={i.id} type="button" className="brain-point link" onClick={() => props.onPick(i.id)}>
              {i.by && <Face name={i.by} />}
              <span dir="auto">{i.label}</span>
            </button>
          ))}
        </section>
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
