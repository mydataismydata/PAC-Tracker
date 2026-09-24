/**
 * How a graph is arranged, shared by the explorer and the shareable picture.
 *
 * The explorer lays tiles out in the browser. The picture on a Know Your
 * Mailer report lays out the same crawl on the server, headless. Both read the
 * tile sizes, the force settings and the overlap pass from here, so the
 * picture shows what the explorer shows and the two cannot drift apart.
 */

import type { Core } from 'cytoscape';

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
 */
export function separateTiles(cy: Core, isFixed: (id: string) => boolean): void {
  const boxes = cy.nodes().map((n, index) => {
    const p = n.position();
    return {
      node: n,
      index,
      x: p.x,
      y: p.y,
      halfW: n.outerWidth() / 2 + TILE_GAP / 2,
      halfH: n.outerHeight() / 2 + TILE_GAP / 2,
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
