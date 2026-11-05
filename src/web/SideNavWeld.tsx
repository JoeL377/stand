// The weld on the selected nav row, ported from Conxt's Sidebar.tsx: a short neck from the row to
// the page's inset panel, reaching out from both sides when a row becomes the selected one. The
// geometry assumes a 20px gutter between the row and the panel, both folded and open, so if the
// sidebar's padding or the shell's inset moves, this has to move too.

import { useEffect, useState } from "react";

/** The gutter, and how far across it the far end climbs. 16/20 is 38.7°. */
const W = 20;
const RISE = 16;
/**
 * Half the neck's section, measured across the axis — so the neck is 6
 * thick, which is the switcher's 6. The two are the same pipe seen at
 * two angles, and a thinner one here read as a lesser thing rather than
 * a steeper one.
 */
const WAIST = 3;
/** The four blend radii, clockwise from the row's top corner. */
const B_ROW_TOP = 3;
const B_WALL_TOP = 2.5;
const B_WALL_BOTTOM = 3.5;
const B_ROW_BOTTOM = 2;

/** The neck's normal, and its length. Fixed: the tilt never changes. */
const NX = RISE / Math.hypot(W, RISE);
const NY = W / Math.hypot(W, RISE);
const LEN = Math.hypot(W, RISE);

/** Section at zero reach, and the fraction of the travel it fills out over. */
const FILAMENT = 1;
const SECTION = 0.7;
/** The reaching tip: its radius, and the run it narrows to that over. */
const TIP = 0.4;
const TAPER = 4.5;

const REACH_MS = 200;
const SEAL_MS = 200;

type Pt = [number, number];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * A point on the neck, given as a distance `s` out along its axis from
 * whichever end is being drawn and an offset `h` across it. Everything
 * below is easier to state this way than in x and y, because the neck's
 * two long edges are simply h = ∓WAIST.
 */
function at(s: number, h: number): Pt {
  return [s * NY + h * NX, -s * NX + h * NY];
}

/**
 * One end of the neck, in a frame whose origin is that end's centreline
 * point: where its two edges cross the root face, where the blends hand
 * over to the straight edges, and how far along the axis that happens.
 *
 * The `/NY` turns a distance measured across the neck into one measured
 * up the face it is cut against, which is what makes a tilted neck's
 * contact taller than its section. The `±b·NX` is the same conversion
 * applied to the blend's own offset along the axis.
 */
function rootEnd(bTop: number, bBottom: number, waist: number) {
  const yt = (-bTop - bTop * NX - waist) / NY;
  const yb = (bBottom - bBottom * NX + waist) / NY;
  const top: Pt = [bTop + bTop * NX, yt + bTop * NY];
  const bot: Pt = [bBottom - bBottom * NX, yb - bBottom * NY];
  return {
    faceTop: [0, yt] as Pt,
    faceBot: [0, yb] as Pt,
    top,
    bot,
    sTop: top[0] * NY - top[1] * NX,
    sBot: bot[0] * NY - bot[1] * NX,
  };
}

/** 180° about the neck's midpoint: the far end is the near one, turned. */
function turn(p: Pt): Pt {
  return [W - p[0], -RISE - p[1]];
}

/**
 * The seated shape, which is what sizes and places the box. Nothing
 * drawn mid-flight is longer, thicker or taller than it, so the viewBox
 * never has to grow and the svg's own clip only ever bites where it is
 * wanted — on the two tips that overrun their far root by two thirds of
 * a pixel, one into the row's fill and one into the wall.
 */
const SEATED = rootEnd(B_ROW_TOP, B_ROW_BOTTOM, WAIST);
const WALL = rootEnd(B_WALL_BOTTOM, B_WALL_TOP, WAIST);
// The wall end's own face bottom, turned, is the shape's topmost point.
const SHIFT = -turn(WALL.faceBot)[1];
const HEIGHT = SEATED.faceBot[1] + SHIFT;
/** Where the row-side contact centres inside that box. */
const ANCHOR = (SEATED.faceTop[1] + SEATED.faceBot[1]) / 2 + SHIFT;

function emit(pts: Pt[], flip: boolean): string {
  return pts
    .map((p) => {
      const q = flip ? turn(p) : p;
      return `${q[0].toFixed(2)} ${(q[1] + SHIFT).toFixed(2)}`;
    })
    .join(" ");
}

// Sweep 0 throughout for the blends: on a clockwise outline that puts
// each blend circle's centre in the EMPTY corner, which is the concave
// meniscus. Sweep 1 is the same two endpoints with the centre inside the
// material — a convex chamfer, and the wrong read entirely. The reaching
// tip is the one place sweep 1 belongs, because a tip IS convex.
const arc = (r: number) => `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 0`;
const cap = (r: number) => `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1`;

/** The finished neck: one body, both ends blended into their wall. */
function seatedPath(): string {
  return [
    `M${emit([SEATED.faceTop], false)}`,
    `${arc(B_ROW_TOP)} ${emit([SEATED.top], false)}`,
    `L${emit([WALL.bot], true)}`,
    `${arc(B_WALL_TOP)} ${emit([WALL.faceBot], true)}`,
    `L${emit([WALL.faceTop], true)}`,
    `${arc(B_WALL_BOTTOM)} ${emit([WALL.top], true)}`,
    `L${emit([SEATED.bot], false)}`,
    `${arc(B_ROW_BOTTOM)} ${emit([SEATED.faceBot], false)}`,
    `Z`,
  ].join(" ");
}

/**
 * Half the weld: rooted at one end, running out along the axis, closing
 * in a point.
 *
 * `sTip` is how far that point has got. `bloom` is the weld taking — it
 * opens the point back out to full section and carries it on past the
 * far root, which is what turns two fingers that have met into one neck.
 *
 * The clamps are not defensive padding. A stub shorter than its own root
 * blends has no straight edge left to taper, so `sEnd` refuses to let
 * the tip fall behind the handover and `sFlat` refuses to start the
 * taper before it. `sFlat` is also what TAPER actually runs into at the
 * moment the two meet: the row's blends have eaten the first 8.6 of a
 * 12.8 travel, so the taper gets the 3.8 that are left and TAPER is the
 * cap on it rather than the value of it. That is the sharpest point this
 * neck can come to, which is the point of asking for 4.5.
 */
function stubPath(
  bTop: number,
  bBottom: number,
  sTip: number,
  bloom: number,
  flip: boolean,
): string {
  const g = clamp01(sTip / ((LEN / 2) * SECTION));
  const waist = FILAMENT + (WAIST - FILAMENT) * g;
  const e = rootEnd(bTop * g, bBottom * g, waist);

  const tip0 = (TIP * waist) / WAIST;
  const tipR = tip0 + (waist - tip0) * bloom;
  const taper = ((TAPER * waist) / WAIST) * (1 - bloom);
  const sMin = Math.max(e.sTop, e.sBot);
  const sEnd = Math.max(sTip, sMin + tipR);
  const sFlat = Math.max(sMin, sEnd - tipR - taper);
  const sNose = sEnd - tipR;

  return [
    `M${emit([e.faceTop], flip)}`,
    `${arc(bTop * g)} ${emit([e.top], flip)}`,
    // Out along the top edge, then a quadratic through the shoulder into
    // the tip — control on the corner the two would have made.
    `L${emit([at(sFlat, -waist)], flip)}`,
    `Q${emit([at(sNose, -waist), at(sNose, -tipR)], flip)}`,
    `${cap(tipR)} ${emit([at(sNose, tipR)], flip)}`,
    `Q${emit([at(sNose, waist), at(sFlat, waist)], flip)}`,
    `L${emit([e.bot], flip)}`,
    `${arc(bBottom * g)} ${emit([e.faceBot], flip)}`,
    `Z`,
  ].join(" ");
}

function reaching(sTip: number, bloom: number): string[] {
  return [
    stubPath(B_ROW_TOP, B_ROW_BOTTOM, sTip, bloom, false),
    stubPath(B_WALL_BOTTOM, B_WALL_TOP, sTip, bloom, true),
  ];
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The weld arriving, borrowed off the ring's own splice.
 *
 * There a strut grows up the V between two modules and its width follows
 * its reach rather than the clock — it leaves as a filament and is at
 * full section before the tip lands, because a bar that thin carries no
 * field and has nothing to weld with yet. Here it happens from both
 * sides at once: the row puts out a finger to the right and the shell
 * puts one out to the left, each thickening from 1 to its full 3 over
 * the first 70% of its own travel, and they meet nose to nose in the
 * middle of the gutter.
 *
 * Then it welds. Both tips carry on PAST each other while their points
 * open back out to full section, so for the first part of it the union
 * is pinched where the two tapers cross — a narrow waist with a concave
 * crease on each side, which is what a merge looks like — and it fills
 * out from there. At the end each stub covers the whole neck, one
 * carrying the row's blends and the other the wall's, and their union is
 * the seated shape exactly; it is swapped for the single path at that
 * point so the finished weld is one outline rather than two.
 *
 * The reach eases out and the weld eases in and out. That is the whole
 * reason for the second curve: with an ease-out the union is pinched for
 * about fifteen milliseconds and the merge is over before it reads, and
 * the merge is the part worth seeing.
 *
 * Redrawn per frame rather than tweened. Two fingers becoming one neck
 * is not a shape any interpolator can get to — the outline changes
 * count, a transform could only scale the seated one, and CSS `d` cannot
 * take a tip into two arcs. It is two small paths for 400ms, once, when
 * a row becomes the selected one; `prefers-reduced-motion` gets the
 * seated weld and no loop at all.
 */
export function SelectedTabWeld() {
  const [paths, setPaths] = useState<string[]>(() =>
    reducedMotion() ? [seatedPath()] : [],
  );

  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = now - t0;
      if (t < REACH_MS) {
        setPaths(reaching((LEN / 2) * easeOutCubic(t / REACH_MS), 0));
      } else if (t < REACH_MS + SEAL_MS) {
        const bloom = easeInOutCubic((t - REACH_MS) / SEAL_MS);
        setPaths(reaching((LEN / 2) * (1 + bloom), bloom));
      } else {
        setPaths([seatedPath()]);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${W} ${HEIGHT.toFixed(2)}`}
      style={{
        width: W,
        height: HEIGHT,
        transform: `translateY(${(-ANCHOR).toFixed(2)}px)`,
      }}
      className="sp-weld"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
