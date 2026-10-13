/**
 * How a graph is arranged, shared by the explorer and the shareable picture.
 *
 * The explorer lays tiles out in the browser. The picture on a Know Your
 * Mailer report lays out the same crawl on the server, headless. Both read the
 * tile sizes, the force settings and the overlap pass from here, so the
 * picture shows what the explorer shows and the two cannot drift apart.
 */

import type { Core, EdgeSingular, NodeSingular } from 'cytoscape';

/** Uniform tile geometry. */
export const TILE_W = 168;
export const TILE_H = 58;

/** The seed's tile, larger so it reads as the anchor of the whole view. */
export const SEED_W = TILE_W + 26;
export const SEED_H = TILE_H + 12;

/** Clear space kept around every tile, in graph units. */
export const TILE_GAP = 30;

/**
 * The force layout, tuned for 168x58 tiles.
 *
 * Without generous repulsion and edge length, a hub committee's spokes pile on
 * top of each other and the labels become unreadable. Animation, fitting and
 * randomizing are left to the caller: the explorer animates and holds tiles
 * the reader placed, and the picture does neither.
 */
export const FCOSE_LAYOUT = {
  name: 'fcose',
  quality: 'proof',
  padding: 60,
  nodeDimensionsIncludeLabels: true,
  nodeSeparation: 220,
  idealEdgeLength: 300,
  nodeRepulsion: 60000,
  gravity: 0.15,
  gravityRange: 3.8,
  numIter: 3000,
  tile: true,
} as const;

/**
 * The two ways the explorer can draw a graph.
 *
 * `tiles` gives every entity a labeled box with its money written inside.
 * `network` draws every entity as a small dot of one size with its name
 * beside it, so the shape of the connections reads before the words do. The
 * shareable picture draws the network look.
 */
export const GRAPH_LOOKS = ['network', 'tiles'] as const;
export type GraphLook = (typeof GRAPH_LOOKS)[number];

/**
 * The size of every dot in the network look at zoom 1, in graph units.
 *
 * One size for all of them. An entity is one point in the picture, and the
 * picture is the graph. On screen the explorer keeps a dot between 0.6 and
 * 1.3 times this size at any zoom, so zooming in spreads the dots out rather
 * than blowing them up.
 */
export const DOT = 8;

/** Clear space kept around every dot. */
export const DOT_GAP = 16;

/**
 * The force layout for dots.
 *
 * Shorter edges and far less repulsion than the tile layout, because a dot
 * needs a small part of a tile's room. Labels are left out of the node size
 * so that a long name does not push its neighbors across the canvas. A label
 * sits beside its dot and may cross a neighbor's line.
 */
export const FCOSE_NETWORK_LAYOUT = {
  ...FCOSE_LAYOUT,
  padding: 40,
  nodeDimensionsIncludeLabels: false,
  nodeSeparation: 70,
  idealEdgeLength: 120,
  nodeRepulsion: 18000,
  gravity: 0.25,
} as const;

/** fcose's own stiffness for a line, which every line but a short one keeps. */
const EDGE_ELASTICITY = 0.45;

/**
 * The dots' force layout for one graph, with entities that have a single
 * connection kept close to it.
 *
 * Most entities at the edge of a crawl connect to one other entity only, and
 * a hub can have dozens of them. With every line the same length and every
 * dot pushing the same, a hub's entities were pushed out into a wide ring
 * around the whole graph, some of them across the middle from the hub they
 * belong to, at the end of a long line. Here a line to such an entity is
 * shorter and stiffer, and the entity pushes its neighbors less, so each hub
 * keeps its own cluster around it. On a 600-entity graph that took the
 * median such line from 206 units to 126, and the longest from 354 to 217.
 */
export function networkLayout(cy: Core) {
  const single = new Set(
    cy
      .nodes()
      .filter((n) => n.neighborhood('node').length === 1)
      .map((n) => n.id()),
  );
  const toSingle = (e: EdgeSingular) => single.has(e.source().id()) || single.has(e.target().id());
  return {
    ...FCOSE_NETWORK_LAYOUT,
    idealEdgeLength: (e: EdgeSingular) => (toSingle(e) ? 80 : FCOSE_NETWORK_LAYOUT.idealEdgeLength),
    edgeElasticity: (e: EdgeSingular) => (toSingle(e) ? 0.8 : EDGE_ELASTICITY),
    nodeRepulsion: (n: NodeSingular) =>
      single.has(n.id()) ? 8000 : FCOSE_NETWORK_LAYOUT.nodeRepulsion,
  };
}

export type Point = { x: number; y: number };

/**
 * When a line runs into a dot that is not one of its ends: closer to the
 * dot's center than this, in graph units, which is over the dot or just
 * grazing it. A line that passes further off stays straight.
 */
const COLLISION = DOT * 0.75;

/** How far a line that bows around a dot keeps from its center, in graph units. */
const CLEARANCE = DOT * 1.25;

/**
 * The most dots a line will bow to get around. A line that runs into more is
 * crossing a crowd: no bow clears it, and a bowed line through a crowd only
 * swaps the dots it crosses, so it stays straight.
 */
const MAX_DODGED = 2;

/**
 * The furthest a line's control point may sit off straight, as a share of
 * the line's length. The curve itself strays half that far at its middle.
 */
const MAX_BOW = 0.6;

/**
 * The control point's offset that takes a line from `a` to `b` around the
 * dots in its way, or 0 for a straight line.
 *
 * A straight line that would run into a dot that is not one of its ends (see
 * COLLISION) bows around it. The bow is the least that keeps CLEARANCE from
 * every dot near the line, on whichever side needs less. A line stays
 * straight when it runs into more than MAX_DODGED dots, or when no bow within
 * MAX_BOW gets it clear, since dots sit beneath the lines anyway. So does a
 * line whose only obstacle hugs one of its ends, which would take a wide
 * swing to dodge.
 *
 * Positive bows to the left of travel from `a` to `b`, which is the side
 * Cytoscape puts a positive `control-point-distances` on. Cytoscape draws the
 * bow as one control point off the middle of the line, a quadratic curve. At
 * a share t of the way along, that curve stands 2t(1 - t) times the control
 * point's offset away from the straight line. So each dot near the line rules
 * out a range of offsets on each side, the ones that bring the curve within
 * CLEARANCE of it. The answer is the smallest offset left on either side.
 */
export function bowAround(
  a: Point,
  b: Point,
  aId: string,
  bId: string,
  dots: { id: string; p: Point }[],
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < DOT * 2) return 0;
  const ux = dx / length;
  const uy = dy / length;
  const cap = MAX_BOW * length;

  const ruledOut: { side: number; lo: number; hi: number }[] = [];
  let blocked = 0;
  for (const dot of dots) {
    if (dot.id === aId || dot.id === bId) continue;
    const rx = dot.p.x - a.x;
    const ry = dot.p.y - a.y;
    const t = (rx * ux + ry * uy) / length;
    if (t <= 0 || t >= 1) continue;
    const off = ry * ux - rx * uy;
    const k = 2 * t * (1 - t);
    // Further off the line than any allowed bow could carry it.
    if (Math.abs(off) - CLEARANCE >= k * cap) continue;
    // Too costly to get round: the dot stays under the line.
    if ((CLEARANCE - Math.abs(off)) / k > cap) continue;
    if (Math.abs(off) < COLLISION) blocked++;
    for (const side of [1, -1]) {
      const at = side * off;
      ruledOut.push({ side, lo: (at - CLEARANCE) / k, hi: (at + CLEARANCE) / k });
    }
  }
  if (blocked === 0 || blocked > MAX_DODGED) return 0;

  let best = Infinity;
  let bestSide = 1;
  for (const side of [1, -1]) {
    const ranges = ruledOut
      .filter((r) => r.side === side && r.hi > 0)
      .sort((x, y) => x.lo - y.lo);
    let bow = 0;
    for (const r of ranges) {
      if (r.lo > bow) break;
      bow = Math.max(bow, r.hi);
    }
    if (bow < best) {
      best = bow;
      bestSide = side;
    }
  }
  return best > cap ? 0 : Math.round(bestSide * best);
}

/** The control point of a line from `a` to `b` bowed by `arc`. See `bowAround`. */
export function controlPoint(a: Point, b: Point, arc: number): Point {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return {
    x: (a.x + b.x) / 2 - (arc * (b.y - a.y)) / length,
    y: (a.y + b.y) / 2 + (arc * (b.x - a.x)) / length,
  };
}

/**
 * How strongly the network look draws its lines, for a graph of this many.
 *
 * A hundred and fifty white lines read one by one. A thousand at the same
 * strength merge into a white mass where nothing can be followed. Past 250
 * lines, opacity falls with the square root of the count: to half at a
 * thousand, and never below 40%.
 */
export function lineDensity(drawn: number): number {
  return Math.round(Math.min(1, Math.max(0.4, Math.sqrt(250 / Math.max(drawn, 1)))) * 20) / 20;
}

/** Enough sweeps to open a pile of six hundred tiles stacked on one point. */
const SEPARATION_PASSES = 400;

/** How far one tile may travel in a single sweep. */
const SEPARATION_STEP = TILE_W * 2;

/** Overlap small enough to stop working on, in graph units. */
const SEPARATION_TOLERANCE = 0.5;

/**
 * An edge's stroke width.
 *
 * Log scale: contributions span five orders of magnitude, so a linear width
 * would render everything below the top donor as a hairline. Scaled against
 * the largest edge drawn, so the weighting reads the same whether the graph
 * spans $900 or $9M.
 */
export function edgeWidth(amount: number, maxAmount: number): number {
  const width = 1 + (Math.log10(amount + 1) / Math.log10(Math.max(maxAmount, 1) + 1)) * 7;
  return Number.isFinite(width) ? width : 1;
}

/**
 * Slide tiles apart until none of them covers another.
 *
 * A force layout repels centres. It has no notion of a rectangle that must
 * stay visible, so a treasurer named on a hundred committees settles with
 * tiles lying three deep and the names unreadable. This runs once the layout
 * has stopped, and moves each overlapping pair along whichever axis they
 * overlap least on. Choosing that axis is what keeps the arrangement
 * recognisable: tiles slide out of each other rather than being flung across
 * the canvas, and the graph simply grows to fit.
 *
 * Every pair is measured against the sweep before it moves anything, so a tile
 * pushed by two neighbours at once ends up clear of both. The step limit stops
 * a dense pile from exploding on its first sweep.
 *
 * A tile the reader placed is never moved. Its neighbours give way instead.
 *
 * `gap` is the clear space kept around each one. The dots of the network look
 * pass their own, smaller gap.
 */
export function separateTiles(
  cy: Core,
  isFixed: (id: string) => boolean,
  gap: number = TILE_GAP,
): void {
  const boxes = cy.nodes().map((n, index) => {
    const p = n.position();
    return {
      node: n,
      index,
      x: p.x,
      y: p.y,
      halfW: n.outerWidth() / 2 + gap / 2,
      halfH: n.outerHeight() / 2 + gap / 2,
      movable: !isFixed(n.id()),
    };
  });
  if (boxes.length < 2) return;

  let settled = false;
  for (let pass = 0; pass < SEPARATION_PASSES && !settled; pass++) {
    // Ordered by left edge, a tile can only cover ones that start before its
    // own right edge, so the sweep stops early instead of testing every pair.
    boxes.sort((a, b) => a.x - a.halfW - (b.x - b.halfW));

    settled = true;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (b.x - b.halfW >= a.x + a.halfW) break;

        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const overlapX = a.halfW + b.halfW - Math.abs(dx);
        const overlapY = a.halfH + b.halfH - Math.abs(dy);
        if (overlapX <= SEPARATION_TOLERANCE || overlapY <= SEPARATION_TOLERANCE) continue;
        if (!a.movable && !b.movable) continue;
        settled = false;

        // Two tiles exactly on top of each other have no direction to separate
        // along, so fall back to the sweep order to keep the result stable.
        if (dx === 0 && dy === 0) {
          dx = a.index < b.index ? -1 : 1;
          dy = 0;
        }

        // Move the pair apart along the line between them, far enough that one
        // axis clears. Holding that direction is what keeps the arrangement
        // recognisable — a tile slides out from under its neighbour instead of
        // being knocked sideways into the next one, which is the shuffling that
        // stops a shortest-axis push from ever settling.
        const byX = Math.abs(dx) < 1e-6 ? Infinity : (a.halfW + b.halfW) / Math.abs(dx);
        const byY = Math.abs(dy) < 1e-6 ? Infinity : (a.halfH + b.halfH) / Math.abs(dy);
        let push = (Math.min(byX, byY) - 1) / 2;

        // A pair almost exactly on top of each other asks to be thrown half the
        // canvas apart. Capping the step spreads that over several sweeps.
        const travel = push * Math.hypot(dx, dy);
        if (travel > SEPARATION_STEP) push *= SEPARATION_STEP / travel;

        // A tile held in place cannot take its half, so the other one takes it.
        const shareA = a.movable ? (b.movable ? 1 : 2) : 0;
        const shareB = b.movable ? (a.movable ? 1 : 2) : 0;
        a.x += dx * push * shareA;
        a.y += dy * push * shareA;
        b.x -= dx * push * shareB;
        b.y -= dy * push * shareB;
      }
    }
  }

  cy.batch(() => {
    for (const b of boxes) {
      const p = b.node.position();
      if (p.x !== b.x || p.y !== b.y) b.node.position({ x: b.x, y: b.y });
    }
  });
}
