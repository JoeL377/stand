// Where everything on a design session's diagram goes (room/DesignBoard.tsx). ELK places the boxes in
// ranks, keeps each group's boxes together inside its frame, and routes the arrows around the boxes
// with right-angle turns. The library is large, so it loads when the first diagram is laid out.

import type { DesignArrow, DesignBox, DesignDiagram, DesignGroup } from "../../shared/protocol.ts";

export const BOX_W = 204;
/** Notes shown under a box before "+N more". */
export const NOTES_SHOWN = 3;
const PAD = 20;

const lines = (text: string, perLine: number, max: number) => Math.min(max, Math.max(1, Math.ceil(text.length / perLine)));

/** How tall a box draws, so the layout leaves room for it. `body` is the box itself; the rest of `h`
 *  is the notes under it. `text`: descriptions and notes are showing. */
export function boxSize(b: DesignBox, text: boolean): { w: number; h: number; body: number } {
  // A screen's top bar and a data store's base take room of their own.
  let body = (b.kind === "screen" || b.kind === "store" ? 25 : 21) + lines(b.label, b.kind && b.kind !== "thing" ? 17 : 21, 3) * 19;
  if (text && b.detail) body += 3 + lines(b.detail, 29, 2) * 16;
  if (b.caught.length || (!text && b.points.length)) body += 22;
  if (b.suggested) body += 28;
  let notes = 0;
  if (text && b.points.length) {
    notes = 5 + b.points.slice(0, NOTES_SHOWN).reduce((n, p) => n + lines(p.text, 31, 2) * 15, 0);
    if (b.points.length > NOTES_SHOWN) notes += 15;
  }
  return { w: BOX_W, h: body + notes, body };
}

export interface Laid {
  w: number;
  h: number;
  /** x and y are the top left corner. */
  boxes: Array<{ box: DesignBox; x: number; y: number; w: number; h: number; body: number }>;
  groups: Array<{ group: DesignGroup; x: number; y: number; w: number; h: number }>;
  /** x and y are the middle of the arrow's label. */
  arrows: Array<{ arrow: DesignArrow; path: string; x: number; y: number }>;
}

interface Pt {
  x: number;
  y: number;
}
interface ElkOut {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkOut[];
  edges?: Array<{ id: string; container?: string; sections?: Array<{ startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }>; labels?: Array<{ x?: number; y?: number; width?: number; height?: number }> }>;
}

let elk: Promise<{ layout(graph: unknown): Promise<ElkOut> }> | null = null;
const engine = () => (elk ??= import("elkjs/lib/elk.bundled.js").then((m) => new (m.default as unknown as new () => { layout(graph: unknown): Promise<ElkOut> })()));

/** A line through the points with its corners rounded. */
export function roundedPath(p: Pt[], r = 8): string {
  if (p.length < 2) return "";
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const b = p[i];
    const c = p[i + 1];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y);
    const outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    if (k < 1) {
      d += ` L${b.x},${b.y}`;
      continue;
    }
    const from = { x: b.x - ((b.x - a.x) / inLen) * k, y: b.y - ((b.y - a.y) / inLen) * k };
    const to = { x: b.x + ((c.x - b.x) / outLen) * k, y: b.y + ((c.y - b.y) / outLen) * k };
    d += ` L${from.x},${from.y} Q${b.x},${b.y} ${to.x},${to.y}`;
  }
  const end = p[p.length - 1];
  return `${d} L${end.x},${end.y}`;
}

const SPACING = {
  "elk.spacing.nodeNode": "22",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.edgeNode": "18",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.spacing.edgeEdge": "12",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.spacing.edgeLabel": "3",
  "elk.spacing.componentComponent": "30",
};

/** Places the diagram: ranks run left to right on a wide board and top to bottom on a narrow one. */
export async function layoutDiagram(d: DesignDiagram, opts: { tall: boolean; text: boolean }): Promise<Laid> {
  const { boxes, arrows } = d;
  const on = new Set(boxes.map((b) => b.id));
  const groups = (d.groups ?? []).filter((g) => boxes.some((b) => b.group === g.id));
  const inGroup = new Set(groups.map((g) => g.id));
  const size = new Map(boxes.map((b) => [b.id, boxSize(b, opts.text)]));
  const node = (b: DesignBox) => ({ id: b.id, width: size.get(b.id)!.w, height: size.get(b.id)!.h });
  const drawn = arrows.filter((a) => on.has(a.from) && on.has(a.to));
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": opts.tall ? "DOWN" : "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.separateConnectedComponents": "true",
      "elk.aspectRatio": opts.tall ? "0.6" : "1.7",
      "elk.padding": `[top=${PAD},left=${PAD},bottom=${PAD},right=${PAD}]`,
      ...SPACING,
    },
    children: [
      ...groups.map((g) => ({
        id: g.id,
        layoutOptions: {
          "elk.padding": `[top=${opts.text && g.detail ? 50 : 34},left=14,bottom=14,right=14]`,
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${Math.min(260, 40 + g.label.length * 7.5)},60)`,
          ...SPACING,
        },
        children: boxes.filter((b) => b.group === g.id).map(node),
      })),
      ...boxes.filter((b) => !b.group || !inGroup.has(b.group)).map(node),
    ],
    edges: drawn.map((a) => ({
      id: a.id,
      sources: [a.from],
      targets: [a.to],
      labels: [{ id: `${a.id}-label`, text: a.label || "relates to", width: Math.min(150, 16 + (a.label || "relates to").length * 6.4 + (a.suggested ? 44 : 0)), height: 20, layoutOptions: { "elk.edgeLabels.inline": "true" } }],
    })),
  };
  const out = await (await engine()).layout(graph);

  /** Where each container's top left corner is on the board: arrows are placed relative to theirs. */
  const origin = new Map<string, Pt>([["root", { x: 0, y: 0 }]]);
  const laid: Laid = { w: Math.max(1, out.width ?? 1), h: Math.max(1, out.height ?? 1), boxes: [], groups: [], arrows: [] };
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const walk = (n: ElkOut, at: Pt) => {
    for (const c of n.children ?? []) {
      const p = { x: at.x + (c.x ?? 0), y: at.y + (c.y ?? 0) };
      const box = byId.get(c.id);
      const group = groups.find((g) => g.id === c.id);
      if (box) laid.boxes.push({ box, x: p.x, y: p.y, w: c.width ?? BOX_W, h: c.height ?? 0, body: size.get(box.id)!.body });
      else if (group) {
        origin.set(c.id, p);
        laid.groups.push({ group, x: p.x, y: p.y, w: c.width ?? 0, h: c.height ?? 0 });
        walk(c, p);
      }
    }
  };
  walk(out, { x: 0, y: 0 });
  const edges = [out, ...(out.children ?? [])].flatMap((n) => (n.edges ?? []).map((e) => ({ e, owner: n.id })));
  for (const { e, owner } of edges) {
    const arrow = drawn.find((a) => a.id === e.id);
    const s = e.sections?.[0];
    if (!arrow || !s) continue;
    const o = origin.get(e.container ?? owner) ?? { x: 0, y: 0 };
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
    const label = e.labels?.[0];
    const mid = pts[Math.floor(pts.length / 2)];
    laid.arrows.push({
      arrow,
      path: roundedPath(pts),
      x: label?.x != null ? label.x + o.x + (label.width ?? 0) / 2 : mid.x,
      y: label?.y != null ? label.y + o.y + (label.height ?? 0) / 2 : mid.y,
    });
  }
  return laid;
}

/** The view that shows the whole diagram in a board of this size, down to a zoom that still reads.
 *  Past that the board pans, and starts where the diagram's topmost part is so it never opens on an
 *  empty corner. */
export function fitView(laid: Pick<Laid, "w" | "h" | "boxes" | "groups">, size: { w: number; h: number }, tall: boolean): { x: number; y: number; zoom: number } {
  const zoom = Math.min(1.15, Math.max(tall ? 0.62 : 0.55, Math.min(size.w / laid.w, size.h / laid.h)));
  const top = [...laid.groups, ...laid.boxes].reduce<{ x: number; y: number } | null>((a, b) => (!a || b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a), null);
  const start = (room: number, need: number, at: number) => (need <= room ? (room - need) / 2 : Math.min(6, Math.max(room - need - 6, 12 - at * zoom)));
  return { x: start(size.w, laid.w * zoom, top?.x ?? 0), y: start(size.h, laid.h * zoom, top?.y ?? 0), zoom };
}
