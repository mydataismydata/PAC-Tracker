'use client';

/**
 * Cytoscape canvas for the money-flow graph.
 *
 * Two behaviours matter most here:
 *
 *  1. Incremental growth. Levels stream in, so elements are added in batches and
 *     the layout runs only over *new* nodes, with already-placed nodes locked.
 *     Re-running a global layout on every batch would make tiles jump around
 *     while the user is reading them.
 *
 *  2. Manual arrangement survives. Any node the user drags is pinned, so later
 *     levels arrange themselves around the user's layout instead of discarding
 *     it.
 *
 * It draws in one of two looks, `tiles` or `network` (see `GraphLook`). Both
 * share everything above. Only the stylesheet, the spacing and what a label
 * says differ between them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, {
  type Core,
  type EdgeCollection,
  type EdgeSingular,
  type ElementDefinition,
  type NodeSingular,
  type EventObject,
} from 'cytoscape';
import fcose from 'cytoscape-fcose';
import {
  KIND_COLORS,
  formatMoney,
  kindLabel,

  type GraphEdge,
  type GraphNode,
  type ViewIntent,
} from '@/lib/graph/types';
import {
  DOT,
  DOT_GAP,
  FCOSE_LAYOUT,
  FCOSE_NETWORK_LAYOUT,
  SEED_H,
  SEED_W,
  TILE_GAP,
  TILE_H,
  TILE_W,
  edgeWidth,
  separateTiles,
  type GraphLook,
} from '@/lib/graph/layout';

cytoscape.use(fcose);

/** How far each ghost tile is stepped off the one before it. */
const GHOST_DX = TILE_W + 150;
const GHOST_DY = TILE_H + 70;

/** The canvas behind the network look. Dots are ringed in it. */
const GROUND = '#020617';

/**
 * How strongly an organization's dot is filled.
 *
 * Amber is far brighter than the other kinds' colors on the dark ground, so
 * at full strength the vendors outshine the committees they were paid by.
 * The legend's swatch uses the same value.
 */
const ORGANIZATION_FILL = 0.55;

/**
 * Line colors in the network look.
 *
 * Money between committees, parties, candidates and their donors is white. A
 * payment to a vendor is pale yellow and drawn fainter, so the political
 * money reads first.
 */
const POLITICAL_LINE = '#f8fafc';
const VENDOR_LINE = '#f2e3a0';

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

/** Every class a highlight puts on. A new highlight takes all of them off first. */
const LIT = 'dimmed highlighted reach far-end label-left';

/** Where the canvas keeps the factor that sizes lines and dots against the zoom. */
const SCREEN_SCALE = 'pactracker:screenScale';

/** Where the canvas keeps the factor that stops names growing past zoom 1. */
const TEXT_SCALE = 'pactracker:textScale';

/** Where the canvas keeps the factor that fades lines as the graph fills up. */
const LINE_DENSITY = 'pactracker:lineDensity';

/**
 * A length of `px` screen pixels at zoom 1, which changes only gently as the
 * graph is zoomed. Used for line widths and for the size of dots and their
 * rings. See `fitToZoom`.
 *
 * Functions rather than numbers, so that a fresh style pass reads the factor
 * in force at the time.
 */
const onScreen = (px: number) => (el: NodeSingular | EdgeSingular) =>
  px * ((el.cy().scratch(SCREEN_SCALE) as number | undefined) ?? 1);

/**
 * A text size, or a gap beside text, of `px` screen pixels at zoom 1. It
 * shrinks with the view when zoomed out, and stays at `px` when zoomed in.
 * See `fitToZoom`.
 */
const onText = (px: number) => (el: NodeSingular | EdgeSingular) =>
  px * ((el.cy().scratch(TEXT_SCALE) as number | undefined) ?? 1);

/** A line's opacity, lowered on a crowded canvas. See `fitLinesToDensity`. */
const crowdedOpacity = (opacity: number) => (e: EdgeSingular) =>
  opacity * ((e.cy().scratch(LINE_DENSITY) as number | undefined) ?? 1);

/**
 * Radius that holds one spaced tile, used to size a ring for a whole batch.
 *
 * Area per tile over pi, square-rooted. Multiplying it by the square root of a
 * count gives a circle with room for that many tiles at the density the gap
 * asks for, which is what keeps a hundred-spoke hub from being seeded into a
 * disc a fifth of the size it needs.
 */
const TILE_RADIUS = Math.sqrt(((TILE_W + TILE_GAP) * (TILE_H + TILE_GAP)) / Math.PI);

/**
 * What changes with the look, other than the stylesheet.
 *
 * Dots take a small part of a tile's room, so everything that spaces nodes
 * out has a value for each look. Read through `lookRef` by callbacks that are
 * built once.
 */
interface Geometry {
  layout: typeof FCOSE_LAYOUT | typeof FCOSE_NETWORK_LAYOUT;
  /** Room one node takes, for sizing the ring a new batch is seeded on. */
  unitRadius: number;
  /** Clear space the overlap pass keeps around each node. */
  gap: number;
  /** How far each ghost is stepped off the one before it. */
  ghostStep: { dx: number; dy: number };
  /** Closest that framing the whole graph will zoom. */
  fitZoom: number;
  /** Zoom used when homing in on one entity. */
  focusZoom: number;
}

const GEOMETRY: Record<GraphLook, Geometry> = {
  tiles: {
    layout: FCOSE_LAYOUT,
    unitRadius: TILE_RADIUS,
    gap: TILE_GAP,
    ghostStep: { dx: GHOST_DX, dy: GHOST_DY },
    fitZoom: 1.2,
    focusZoom: 1.1,
  },
  network: {
    layout: FCOSE_NETWORK_LAYOUT,
    // A dot's neighbors settle about an ideal edge length away, so each one
    // holds roughly a disc of half that.
    unitRadius: 60,
    gap: DOT_GAP,
    ghostStep: { dx: 140, dy: 70 },
    fitZoom: 1.4,
    focusZoom: 1.15,
  },
};

/** Trim a name to what fits two lines of a tile without overflowing it. */
function fitLabel(name: string, max = 38): string {
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The name the network look writes beside a dot. */
function dotName(n: GraphNode): string {
  return fitLabel(n.name, 30);
}

/**
 * Whether a payment is political money or a payment to a vendor.
 *
 * Money into a committee, party or candidate is political, whoever sent it.
 * So is money one of them pays to another, or to a person. Money paid to an
 * organization is a payment to a vendor. Every filed payment has a committee,
 * party or candidate at one end, so the recipient alone decides.
 */
function edgeTone(recipient: GraphNode | undefined): 'political' | 'vendor' {
  return recipient?.kind === 'organization' ? 'vendor' : 'political';
}

/**
 * Draw one line for each pair of entities, whatever passed between them.
 *
 * Money both ways between two entities arrives as two edges, and money over
 * several cycles as one edge per cycle. The largest stands for the rest. It
 * carries the total each way and the more prominent tone of the group, and
 * the others are hidden. They stay on the canvas, so selection and routes
 * still find them.
 */
function mergePairs(cy: Core): void {
  const groups = new Map<string, EdgeSingular[]>();
  cy.edges('[kind = "money"]').forEach((e) => {
    const a = e.source().id();
    const b = e.target().id();
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  });

  cy.batch(() => {
    for (const group of groups.values()) {
      group.sort((x, y) => y.data('amount') - x.data('amount') || (x.id() < y.id() ? -1 : 1));
      const [lead, ...rest] = group;
      let fwd = 0;
      let back = 0;
      let tone = 'vendor';
      for (const e of group) {
        if (e.source().same(lead.source())) fwd += e.data('amount');
        else back += e.data('amount');
        if (e.data('ownTone') === 'political') tone = 'political';
      }
      // One of the searched entity's own lines. With its whole network lit,
      // only these carry arrows.
      const seedLine = Boolean(lead.source().data('isSeed') || lead.target().data('isSeed'));
      if (
        lead.data('fwd') !== fwd ||
        lead.data('back') !== back ||
        lead.data('tone') !== tone ||
        lead.data('seedLine') !== seedLine
      ) {
        lead.data({ fwd, back, tone, seedLine });
      }
      lead.removeClass('twin');
      for (const e of rest) e.addClass('twin');
    }
  });
}

type Point = { x: number; y: number };

/**
 * Draw each line straight, and bow it only to get around a dot in its way.
 *
 * A straight line that would run into a dot that is not one of its ends (see
 * COLLISION) bows around it. The bow is the least that keeps CLEARANCE from
 * every dot near the line, on whichever side needs less. A line stays
 * straight when it runs into more than MAX_DODGED dots, or when no bow within
 * MAX_BOW gets it clear, since dots sit beneath the lines anyway. So does a
 * line whose only obstacle hugs one of its ends, which would take a wide
 * swing to dodge.
 *
 * `at` gives a node's position: while a layout animates, the one the node is
 * headed for.
 *
 * A name with money written under it moves to whichever side of its dot the
 * lines now leave clear. See `labelFarEnds`.
 */
function routeLines(
  edges: EdgeCollection,
  at: (n: NodeSingular) => Point = (n) => n.position(),
): void {
  if (edges.empty()) return;
  const cy = edges.first().cy();
  const dots = cy.nodes().map((n) => ({ id: n.id(), p: at(n) }));
  cy.batch(() => {
    edges.forEach((e) => {
      if (e.hasClass('twin')) return;
      const s = e.source();
      const t = e.target();
      const arc = bowAround(at(s), at(t), s.id(), t.id(), dots);
      if (e.data('arc') !== arc) e.data('arc', arc);
    });
    edges.connectedNodes('.far-end').forEach((n) => {
      n.toggleClass('label-left', labelGoesLeft(n));
    });
  });
}

/**
 * The control point's offset that takes a line from `a` to `b` around the
 * dots in its way, or 0 for a straight line.
 *
 * Positive bows to the left of travel from `a` to `b`, which is the side
 * Cytoscape puts a positive `control-point-distances` on. Cytoscape draws the
 * bow as one control point off the middle of the line, a quadratic curve. At
 * a share t of the way along, that curve stands 2t(1 - t) times the control
 * point's offset away from the straight line. So each dot near the line rules
 * out a range of offsets on each side, the ones that bring the curve within
 * CLEARANCE of it. The answer is the smallest offset left on either side.
 */
function bowAround(
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

/**
 * Keep the network look's lines thin, its dots small and its names small, at
 * every zoom.
 *
 * Cytoscape draws everything in graph units, so it all scales with the zoom.
 * Framing a large graph whole thins a 1px line to a sixth of a pixel, too
 * faint to follow. Zooming in turns lines into bars, dots into discs and
 * names into headlines. Here the size of lines and dots on screen moves with
 * the square root of the zoom instead, held between 0.6 and 1.3 times their
 * size at zoom 1.
 *
 * Names shrink with the view when it is zoomed out, which hides them once
 * they are too small to read. Zoomed in, they stay the size they are at zoom
 * 1, so zooming in spreads crowded names apart instead of enlarging the
 * crowd.
 *
 * Both factors move in steps of 10%, so a zoom restyles the canvas now and
 * then rather than on every frame.
 */
function fitToZoom(cy: Core, look: GraphLook): void {
  if (look !== 'network') return;
  const zoom = cy.zoom();
  const step = Math.log(1.1);
  const quantize = (factor: number) => Math.exp(Math.round(Math.log(factor) / step) * step);
  const screen = quantize(Math.min(1.3, Math.max(0.6, Math.sqrt(zoom))) / zoom);
  const text = quantize(Math.min(1, 1 / zoom));
  if (cy.scratch(SCREEN_SCALE) === screen && cy.scratch(TEXT_SCALE) === text) return;
  cy.scratch(SCREEN_SCALE, screen);
  cy.scratch(TEXT_SCALE, text);
  restyle(cy.elements());
}

/**
 * Fade the network look's lines as the graph fills up.
 *
 * A hundred and fifty white lines read one by one. A thousand at the same
 * strength merge into a white mass where nothing can be followed. Past 250
 * lines, opacity falls with the square root of the count: to half at a
 * thousand, and never below 40%.
 */
function fitLinesToDensity(cy: Core): void {
  const drawn = cy.edges('[kind = "money"]').filter((e) => !e.hasClass('twin')).length;
  const density = Math.round(Math.min(1, Math.max(0.4, Math.sqrt(250 / Math.max(drawn, 1)))) * 20) / 20;
  if (cy.scratch(LINE_DENSITY) === density) return;
  cy.scratch(LINE_DENSITY, density);
  restyle(cy.edges());
}

/** Send elements through a fresh style pass. Cytoscape has this; its typings leave it out. */
function restyle(elements: cytoscape.Collection | EdgeCollection): void {
  (elements as unknown as { updateStyle(): void }).updateStyle();
}


/**
 * Deterministic starting point for a newly added tile.
 *
 * Golden-angle placement spreads consecutive nodes evenly around the ring
 * rather than clumping them, and deeper levels start further out so the force
 * layout usually converges to a roughly concentric arrangement by BFS depth.
 */
function spawnPosition(
  origin: { x: number; y: number },
  spread: number,
  index: number,
  count: number,
  level: number,
  unitRadius: number,
): { x: number; y: number } {
  const angle = index * 2.399963; // golden angle in radians
  // The ring has to hold the whole batch. A committee hub can arrive with a
  // hundred and forty tiles at once, and seeding those into a ring sized for a
  // handful hands the layout a pile it never fully unpicks.
  const ring = Math.max(spread * (0.5 + 0.35 * level), unitRadius * Math.sqrt(count));
  // Square root of the index, so tiles land at even density instead of
  // crowding the middle of the ring.
  const radius = ring * Math.sqrt((index + 1) / count);
  return {
    x: origin.x + Math.cos(angle) * radius,
    y: origin.y + Math.sin(angle) * radius,
  };
}

export interface GraphCanvasHandle {
  exportPng: (filename: string) => void;
  fit: () => void;
  /** Centre and zoom on one node. False when it is not on the canvas. */
  focusOn: (nodeId: string) => boolean;
  getPositions: () => Record<string, { x: number; y: number }>;
  /** Multiply the zoom about the viewport centre. >1 zooms in. */
  zoomBy: (factor: number) => void;
  /** Pan by a fraction of the viewport; +x moves the view right. */
  panBy: (dx: number, dy: number) => void;
  /** Re-measure the container after it has been hidden and shown again. */
  resize: () => void;
}

/** One press of + or −. */
export const ZOOM_STEP = 1.3;
/** One arrow-key press, as a share of the viewport. */
export const PAN_STEP = 0.2;

/**
 * Dim everything except a node and the tiles it trades with.
 *
 * Shared by tapping a tile and by focusing one from search or the ledger, so
 * an entity reached any of those ways reads the same on the canvas.
 */
function highlightNeighborhood(
  cy: Core,
  node: NodeSingular,
  keepLit: string[] = [],
  look: GraphLook = 'tiles',
): void {
  cy.elements().removeClass(LIT).addClass('dimmed');
  for (const id of keepLit) {
    const el = cy.getElementById(id);
    if (el.nonempty() && el.isNode()) el.removeClass('dimmed');
  }
  // In the network look the searched entity's network is everything within
  // the chosen depth, and it lights alike: a line two hops out is as much a
  // part of it as a line one hop out. Only a line past the depth, or a hop
  // borrowed to draw a route, stays dim.
  if (look === 'network' && node.data('isSeed')) {
    cy.elements()
      .filter((el) => !el.hasClass('ghost') && !(el.isEdge() && el.data('beyond')))
      .removeClass('dimmed')
      .addClass('highlighted reach');
    return;
  }
  node.closedNeighborhood().removeClass('dimmed').addClass('highlighted');
}

/**
 * Write the money along each lit line under the name at its far end.
 *
 * `ends` pairs each lit line with its end nearer the entity the panel is
 * about. The other end is the entity the reader picked, and the money is
 * worded from its side: what it received along the line, what it gave, or
 * both, summed over every lit line that ends there. Under its name, "$12K
 * out" would read as money it paid out when it was money paid to it. Only the
 * network look draws these, and it writes no amount on a line.
 */
function labelFarEnds(ends: [EdgeSingular, NodeSingular][]): void {
  const farEnds = new Map<string, { node: NodeSingular; received: number; gave: number; also: string[] }>();
  for (const [e, near] of ends) {
    if (e.hasClass('twin')) continue;
    const far = e.source().same(near) ? e.target() : e.source();
    const farIsTarget = e.target().same(far);
    let sum = farEnds.get(far.id());
    if (!sum) {
      sum = { node: far, received: 0, gave: 0, also: [] };
      farEnds.set(far.id(), sum);
    }
    if (e.data('kind') === 'money') {
      sum.received += farIsTarget ? e.data('fwd') : e.data('back');
      sum.gave += farIsTarget ? e.data('back') : e.data('fwd');
    } else if (e.data('amountLabel')) {
      // A borrowed hop knows its amount only as text, and points the way the
      // money went.
      sum.also.push(`${farIsTarget ? 'received' : 'gave'} ${e.data('amountLabel')}`);
    }
  }

  for (const { node, received, gave, also } of farEnds.values()) {
    const money = [
      received > 0 ? `received ${formatMoney(received)}` : '',
      gave > 0 ? `gave ${formatMoney(gave)}` : '',
      ...also,
    ]
      .filter(Boolean)
      .join(' · ');
    if (!money) continue;
    node.data('farLabel', `${node.data('name')}\n${money}`);
    node.addClass('far-end');
    node.toggleClass('label-left', labelGoesLeft(node));
  }
}

/**
 * Whether a dot's name belongs on its left, clear of its lit lines.
 *
 * A name sits to the right of its dot. With money written under it, the two
 * lines of text fill a band beside the dot, and a lit line leaving the dot
 * into that band runs straight through them. A line climbing more steeply than
 * 45 degrees passes over the text, and one dropping more steeply than about
 * 70 degrees passes under it. The text goes on the left only when fewer lit
 * lines cross that side.
 */
function labelGoesLeft(node: NodeSingular): boolean {
  const p = node.position();
  let right = 0;
  let left = 0;
  node.connectedEdges('.highlighted').forEach((e) => {
    if (e.hasClass('twin')) return;
    const toward = leavesToward(e, node);
    const dx = toward.x - p.x;
    const dy = toward.y - p.y;
    if (dx === 0) return;
    // Screen y grows downward.
    const slope = dy / Math.abs(dx);
    if (slope < -1 || slope > 3) return;
    if (dx > 0) right++;
    else left++;
  });
  return left < right;
}

/**
 * A point on the way a line sets off from `end`: the line's control point
 * where it bows, otherwise its other end. See `bowAround` for the control
 * point.
 */
function leavesToward(e: EdgeSingular, end: NodeSingular): Point {
  const a = e.source().position();
  const b = e.target().position();
  const arc: number = e.data('arc') ?? 0;
  if (arc === 0) return e.source().same(end) ? b : a;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return {
    x: (a.x + b.x) / 2 - (arc * (b.y - a.y)) / length,
    y: (a.y + b.y) / 2 + (arc * (b.x - a.x)) / length,
  };
}

/**
 * Dim everything except the routes through the graph the reader has asked for.
 *
 * Used where the interesting thing is not who a tile trades with but how it
 * connects back to the entity the reader started from — a donor several
 * transfers upstream, say, whose neighbourhood says nothing about why it is on
 * screen. Takes several routes because the panel lets names be clicked down
 * one after another, and the point of doing that is to see them lit at once.
 * Returns false when no route has two tiles drawn, so the caller can fall back
 * to the neighbourhood rather than dimming the whole map down to a single tile.
 *
 * `focus` is the entity the panel is about. Each lit line's money is written
 * under the name at its end away from the focus. See `labelFarEnds`. Names
 * clicked down in the panel start their route from the focus, and a name
 * opened from the panel ends its route on it, so it can sit at either end.
 */
function highlightRoutes(
  cy: Core,
  chains: string[][],
  keepLit: string[],
  focus: NodeSingular,
): boolean {
  let route = cy.collection();
  const ends: [EdgeSingular, NodeSingular][] = [];
  let drawn = 0;

  for (const chain of chains) {
    const hops = chain
      .map((id) => cy.getElementById(id) as NodeSingular)
      .filter((el) => el.nonempty() && el.isNode());
    if (hops.length < 2) continue;
    drawn++;
    // The start of the route stands in for the focus where the focus is not on it.
    const anchor = Math.max(0, hops.findIndex((h) => h.same(focus)));

    for (const [i, hop] of hops.entries()) {
      route = route.union(hop);
      if (i === 0) continue;
      // Either direction: a chain is a route the money took, and the edge
      // recording it points whichever way the filing did.
      const prev = hops[i - 1];
      const between = prev.edgesWith(hop);
      route = route.union(between);
      const nearer = Math.abs(i - anchor) < Math.abs(i - 1 - anchor) ? hop : prev;
      between.forEach((e) => {
        ends.push([e, nearer]);
      });
    }
  }
  if (drawn === 0) return false;

  // Paperwork, not money: also keep lit any registration hop tying a tile on
  // this money route to an officer hub — the treasurer, chair or agent behind
  // those committees — so the person stays connected to the path instead of
  // dimming out one hop off it. A dashed registration edge never records a
  // payment, so lighting it beside the route claims no money the route did not.
  // Only the hub and the single hop reaching it light; the hub's own links to
  // its other committees stay dimmed, so the focus does not sprawl.
  const regHops = route.nodes().connectedEdges('edge[kind = "registration"]');
  route = route.union(regHops).union(regHops.connectedNodes('node[kind = "officer"]'));

  // Tiles that stay readable without being part of this route — the seed and
  // everywhere the reader has been. Nodes only: two tiles being on the same
  // trail says nothing about money passing between them, and lighting an edge
  // would claim it did.
  let lit = cy.collection();
  for (const id of keepLit) {
    const el = cy.getElementById(id);
    if (el.nonempty() && el.isNode()) lit = lit.union(el);
  }

  cy.elements().removeClass(LIT).addClass('dimmed');
  lit.removeClass('dimmed');
  route.removeClass('dimmed').addClass('highlighted');
  labelFarEnds(ends);
  return true;
}

/**
 * Tiles pulled onto the canvas to show a link the crawl itself did not draw.
 *
 * The graph is a filtered slice — in `direct` mode an individual donor is
 * never drawn at all — so a row in the ledger routinely names an entity with
 * no tile. Rather than have the click do nothing visible, the parent hands
 * over the missing tiles and the hops joining them, and they are laid in
 * beside the graph without disturbing it.
 */
export interface GhostGraph {
  /** Route order, the anchor already on the canvas first. */
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string; label: string }[];
}


interface Props {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  seedId: string | null;
  /** Restored layout from a saved search. */
  initialPositions?: Record<string, { x: number; y: number }> | null;
  onSelectNode?: (node: GraphNode | null) => void;
  /** Double-click re-roots the crawl on that node. */
  onExpandNode?: (nodeId: string) => void;
  onReady?: (handle: GraphCanvasHandle) => void;
  /**
   * What to do with the viewport, raised by the parent as a token.
   *
   * The canvas is lazily loaded and a crawl over warm data can complete before
   * Cytoscape has mounted, so the parent cannot just call fit()/focusOn()
   * itself — it states an intent and the canvas acts as soon as it is able,
   * retrying until the target node actually exists.
   */
  viewIntent?: ViewIntent;
  /** Entity selected elsewhere (search, ledger), mirrored into the canvas. */
  selectedId?: string | null;
  /**
   * The route back from the selection to where the reader came from.
   *
   * Takes the place of the neighbourhood highlight when present, so following
   * money out of the panel shows the connection rather than a fresh, unrelated
   * cluster around wherever you landed.
   */
  /**
   * Routes to light, each a list of tile ids from the reader's position out.
   *
   * More than one because names clicked in the panel stack up rather than
   * replacing each other.
   */
  highlightChains?: string[][] | null;
  /**
   * Tiles to leave readable whatever else is dimmed.
   *
   * The entity being searched and every tile the reader has opened on the way
   * here, so the path taken through the graph stays visible behind whatever is
   * currently in focus.
   */
  keepLit?: string[];
  /** Tiles to lay in for the parts of that route the crawl never drew. */
  ghost?: GhostGraph | null;
  /** How to draw the graph. Switching it restyles the canvas and lays it out again. */
  look?: GraphLook;
  /**
   * How many hops out from the searched entity the crawl went.
   *
   * A line lies within the depth when it is on a path of that many hops or
   * fewer from the searched entity, which is when either end is nearer than
   * the full depth. The network look draws any other line faint.
   */
  depth?: number;
}

/** Where the hover card stands, in pixels from the canvas's top left, and whom it is about. */
interface Hover {
  id: string;
  node: GraphNode;
  x: number;
  y: number;
  /** The dot's radius on screen, so the card clears it. */
  r: number;
  /** The canvas's width when the card opened, so the card can stay on it. */
  w: number;
  /** The canvas's height, so the card opens upward in its lower half. */
  h: number;
}

/**
 * A tile's full label: name on the first line, money on the second.
 *
 * Returns the *whole* label rather than just the money, because both the add
 * and the relabel path use it. Returning only the money line once meant a
 * cycle switch rewrote a surviving tile's label to its amount alone and threw
 * the name away.
 */
function tileLabel(n: GraphNode): string {
  // An officer hub is a person. "in $0 · out $0" on one would read as a party
  // to the money rather than the reason the committees around it are grouped.
  if (n.kind === 'officer') {
    return [fitLabel(n.name), n.office ?? ''].filter(Boolean).join('\n');
  }
  const received = Number(n.totalReceived);
  const given = Number(n.totalGiven);
  const money =
    received > 0 && given > 0
      ? `in ${formatMoney(received)} · out ${formatMoney(given)}`
      : received > 0
        ? `in ${formatMoney(received)}`
        : given > 0
          ? `out ${formatMoney(given)}`
          : '';
  return [fitLabel(n.name), money].filter(Boolean).join('\n');
}

/** A node's fill: the color of its kind, as on the dots beside names in the panels. */
const kindFill = (n: NodeSingular) => KIND_COLORS[n.data('kind') as string] ?? KIND_COLORS.unknown;

/** The tiles look: a labeled box per entity, its money written inside. */
const TILE_STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      shape: 'round-rectangle',
      'background-color': kindFill,
      'background-opacity': 0.16,
      'border-width': 1.5,
      'border-color': kindFill,
      label: 'data(label)',
      color: '#e2e8f0',
      'font-size': 10,
      'font-weight': 500,
      'text-wrap': 'wrap',
      'text-max-width': `${TILE_W - 16}px`,
      'text-valign': 'center',
      'text-halign': 'center',
      // Explicit dimensions, NOT width/height: 'label'. Auto-sizing leaves
      // some nodes with an unresolved size, which makes Cytoscape report
      // them invisible and silently cull every edge attached to them.
      width: TILE_W,
      height: TILE_H,
      'line-height': 1.3,
    },
  },
  {
    // The seed reads as the anchor of the whole view.
    selector: 'node[?isSeed]',
    style: {
      'border-width': 3,
      'border-color': '#f8fafc',
      'background-opacity': 0.32,
      'font-size': 11,
      'font-weight': 700,
      width: SEED_W,
      height: SEED_H,
      'z-index': 10,
    },
  },
  {
    // A person, not a committee. Shaped and coloured unlike any tile so
    // it cannot be mistaken for something that holds or moves money.
    selector: 'node[kind = "officer"]',
    style: {
      shape: 'ellipse',
      'background-color': '#7c3aed',
      'background-opacity': 0.3,
      'border-width': 2,
      'border-color': '#a78bfa',
      'border-style': 'dashed',
      color: '#ddd6fe',
      'font-size': 11,
      'font-weight': 700,
      width: 132,
      height: 132,
      'z-index': 12,
    },
  },
  {
    selector: 'node:selected',
    style: { 'border-width': 3, 'border-color': '#fbbf24', 'background-opacity': 0.35 },
  },
  {
    // A node that can still be crawled further gets a dashed outline.
    selector: 'node[?hasMore]',
    style: { 'border-style': 'dashed' },
  },
  {
    selector: 'edge',
    style: {
      width: 'data(width)',
      'line-color': '#475569',
      'target-arrow-color': '#64748b',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.9,
      'curve-style': 'bezier',
      opacity: 0.55,
      label: 'data(label)',
      'font-size': 9,
      color: '#94a3b8',
      'text-background-color': '#0f172a',
      'text-background-opacity': 0.85,
      'text-background-padding': '2px',
      'text-rotation': 'autorotate',
    },
  },
  {
    // Committee-to-committee money is the story; individual gifts recede.
    selector: 'edge[?isDirectLink]',
    style: { 'line-color': '#818cf8', 'target-arrow-color': '#818cf8', opacity: 0.75 },
  },
  {
    // Paperwork, not payment. Dashed and arrowless so it cannot be read
    // as a direction of money, which is the one misreading that would
    // turn a shared accountant into a transfer that never happened.
    selector: 'edge[kind = "registration"]',
    style: {
      'line-style': 'dashed',
      'line-dash-pattern': [5, 4],
      'line-color': '#7c3aed',
      'target-arrow-shape': 'none',
      'source-arrow-shape': 'none',
      width: 1,
      opacity: 0.45,
      color: '#a78bfa',
    },
  },
  {
    selector: 'edge:selected',
    style: { 'line-color': '#fbbf24', 'target-arrow-color': '#fbbf24', opacity: 1 },
  },
  {
    // Not part of the crawl — pulled in to show one link. Dotted so it
    // cannot be read as a tile the current settings would have drawn.
    selector: 'node.ghost',
    style: {
      'border-style': 'dotted',
      'border-width': 2,
      'background-opacity': 0.1,
    },
  },
  {
    selector: 'edge.ghost',
    style: {
      'line-style': 'dotted',
      'line-color': '#94a3b8',
      'target-arrow-color': '#94a3b8',
      width: 2,
      opacity: 0.7,
    },
  },
  {
    selector: '.dimmed',
    style: { opacity: 0.12, 'text-opacity': 0 },
  },

  {
    selector: '.highlighted',
    style: { opacity: 1, 'text-opacity': 1 },
  },
  {
    // A hop on the route the reader is following. Lighter and thicker
    // than the same edge unhighlighted, so the line can be traced across
    // a dimmed graph without hunting for it.
    selector: 'edge.highlighted',
    style: {
      'line-color': '#818cf8',
      'target-arrow-color': '#818cf8',
      width: 3,
      color: '#c7d2fe',
      'font-size': 9.5,
      'text-background-color': '#1e1b4b',
      'text-background-opacity': 1,
      'text-background-padding': '3px',
      'text-border-color': '#6366f1',
      'text-border-opacity': 1,
      'text-border-width': 1,
      'text-background-shape': 'roundrectangle',
    },
  },
];

/**
 * The network look: a dot per entity and a thin arc per pair of entities.
 *
 * The graph is the picture, so the entities stay quiet. Every dot is the same
 * small size, colored by its kind, and its name is faint. Both sit beneath
 * the lines, until the pointer brings one forward. Lines are all one width.
 * White is political money, and pale yellow is a payment to a vendor, drawn
 * fainter. A line past the chosen depth is fainter still. Selecting an entity
 * brings its lines up to full strength, with arrows for the way the money
 * went. The searched entity's lines are every line within the depth. No line
 * carries an amount. A name picked in the panel has its money written under
 * it, off the line.
 */
const NETWORK_STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      shape: 'ellipse',
      width: onScreen(DOT),
      height: onScreen(DOT),
      'background-color': kindFill,
      // Ringed in the ground color, so dots that touch still read as two.
      'border-width': onScreen(1),
      'border-color': GROUND,
      label: 'data(name)',
      color: '#cbd5e1',
      'text-opacity': 0.55,
      'font-size': onText(10),
      'font-weight': 400,
      'text-halign': 'right',
      'text-valign': 'center',
      'text-margin-x': onText(4),
      'text-wrap': 'none',
      // A name too small to read is not drawn.
      'min-zoomed-font-size': 6,
      // Beneath the lines. Cytoscape draws a name with its dot, so the name
      // can only go under the lines if the dot does too. `manual` lets an
      // edge's z-index put it above a node's, which `auto` never does.
      'z-index-compare': 'manual',
      'z-index': 1,
    },
  },
  {
    // The anchor of the view stays above the lines, ringed, so it can always
    // be found.
    selector: 'node[?isSeed]',
    style: {
      color: '#f1f5f9',
      'text-opacity': 0.9,
      'font-weight': 500,
      'outline-width': onScreen(1.5),
      'outline-color': '#cbd5e1',
      'outline-offset': onScreen(2),
      'min-zoomed-font-size': 4,
      'z-index': 3,
    },
  },
  {
    selector: 'node[kind = "organization"]',
    style: { 'background-opacity': ORGANIZATION_FILL },
  },
  {
    // A person named on filings. Hollow, so it cannot be read as something
    // that holds money.
    selector: 'node[kind = "officer"]',
    style: {
      'background-opacity': 0,
      'border-width': onScreen(1.5),
      'border-color': '#a78bfa',
      'border-style': 'dashed',
      color: '#c4b5fd',
    },
  },
  {
    // Not part of the crawl, pulled in to show one link.
    selector: 'node.ghost',
    style: {
      'background-opacity': 0.35,
      'outline-width': onScreen(1.5),
      'outline-style': 'dotted',
      'outline-color': kindFill,
      'outline-offset': onScreen(2),
    },
  },
  {
    selector: 'edge',
    style: {
      width: onScreen(1),
      'line-color': POLITICAL_LINE,
      opacity: crowdedOpacity(0.55),
      'curve-style': 'unbundled-bezier',
      'control-point-distances': 'data(arc)',
      'control-point-weights': 0.5,
      'edge-distances': 'node-position',
      'z-index-compare': 'manual',
      'z-index': 2,
      // Lines take no clicks or hovers, so a dot beneath one is still what
      // the pointer reaches.
      events: 'no',
    },
  },
  {
    selector: 'edge[tone = "vendor"]',
    style: { 'line-color': VENDOR_LINE, width: onScreen(0.8), opacity: crowdedOpacity(0.28) },
  },
  {
    // Past the chosen depth, or a hop borrowed to show a route.
    selector: 'edge[?beyond]',
    style: { opacity: crowdedOpacity(0.1) },
  },
  {
    // Paperwork, not payment: dashed, and never given an arrow.
    selector: 'edge[kind = "registration"]',
    style: {
      'line-style': 'dashed',
      'line-dash-pattern': [4, 4],
      'line-color': '#8b5cf6',
      opacity: 0.45,
    },
  },
  {
    selector: 'edge.ghost',
    style: { 'line-style': 'dotted' },
  },
  {
    // Stood for by the other line of its pair. See `mergePairs`.
    selector: 'edge.twin',
    style: { display: 'none' },
  },
  {
    selector: 'edge.hovered',
    style: { opacity: 0.9 },
  },
  {
    selector: 'node.dimmed',
    style: { opacity: 0.28, 'text-opacity': 0 },
  },
  {
    selector: 'edge.dimmed',
    style: { opacity: 0.04 },
  },
  {
    selector: 'node.highlighted',
    style: {
      opacity: 1,
      'text-opacity': 0.8,
      color: '#e2e8f0',
      'min-zoomed-font-size': 4,
    },
  },
  {
    selector: 'edge.highlighted',
    style: {
      opacity: 1,
      width: onScreen(1.5),
      'target-arrow-shape': 'triangle',
      'target-arrow-color': POLITICAL_LINE,
      'arrow-scale': 0.6,
      'font-size': onText(9),
      'font-weight': 500,
      color: '#f1f5f9',
      'text-rotation': 'none',
      'text-background-color': GROUND,
      'text-background-opacity': 0.85,
      'text-background-padding': '2px',
      'text-background-shape': 'roundrectangle',
      'min-zoomed-font-size': 5,
    },
  },
  {
    // The line stands for money both ways, so it points both ways.
    selector: 'edge.highlighted[back > 0]',
    style: { 'source-arrow-shape': 'triangle', 'source-arrow-color': POLITICAL_LINE },
  },
  {
    // Still the fainter of the two kinds of line when lit.
    selector: 'edge.highlighted[tone = "vendor"]',
    style: {
      width: onScreen(1.1),
      opacity: 0.75,
      'target-arrow-color': VENDOR_LINE,
      'source-arrow-color': VENDOR_LINE,
      color: VENDOR_LINE,
    },
  },
  {
    // The searched entity's whole network, every line alike. Lighter than one
    // entity's lines picked out of the graph, because here they are all lit
    // at once, and a crowded canvas thins them further. Arrows are kept for
    // the searched entity's own lines: on every line, they ring each busy dot
    // with arrowheads.
    selector: 'edge.highlighted.reach',
    style: {
      width: onScreen(1.1),
      opacity: crowdedOpacity(0.8),
      'target-arrow-shape': 'none',
      'source-arrow-shape': 'none',
    },
  },
  {
    selector: 'edge.highlighted.reach[tone = "vendor"]',
    style: { width: onScreen(0.9), opacity: crowdedOpacity(0.45) },
  },
  {
    selector: 'edge.highlighted.reach[?seedLine]',
    style: { 'target-arrow-shape': 'triangle' },
  },
  {
    selector: 'edge.highlighted.reach[?seedLine][back > 0]',
    style: { 'source-arrow-shape': 'triangle' },
  },
  {
    // With the whole network lit, names stay as quiet as at rest, or six
    // hundred of them are drawn at once.
    selector: 'node.highlighted.reach',
    style: { 'text-opacity': 0.55, color: '#cbd5e1', 'min-zoomed-font-size': 6 },
  },
  {
    // The far end of a route picked in the panel, with the money along the
    // route written under its name. See `labelFarEnds`.
    selector: 'node.far-end',
    style: {
      label: 'data(farLabel)',
      'text-wrap': 'wrap',
      'text-max-width': '400px',
      'line-height': 1.3,
      // Half a line down, so the name stays level with its dot.
      'text-margin-y': onText(6.5),
      color: '#f1f5f9',
      'text-opacity': 0.9,
      'min-zoomed-font-size': 4,
    },
  },
  {
    // Moved off the side a lit line leaves from. See `labelGoesLeft`.
    selector: 'node.far-end.label-left',
    style: { 'text-halign': 'left', 'text-margin-x': onText(-4) },
  },
  {
    // A borrowed hop's word for how it was found. An amount goes under the
    // name at the far end instead.
    selector: 'edge.highlighted.ghost',
    style: { label: 'data(lineLabel)' },
  },
  {
    // A shared officer, named on the line rather than at an end, since
    // neither end is where anything went.
    selector: 'edge.highlighted[kind = "registration"]',
    style: {
      width: onScreen(1.5),
      'line-color': '#a78bfa',
      'target-arrow-shape': 'none',
      'source-arrow-shape': 'none',
      color: '#c4b5fd',
      label: 'data(label)',
    },
  },
  {
    selector: 'node:selected',
    style: {
      'outline-width': onScreen(2),
      'outline-color': '#f8fafc',
      'outline-offset': onScreen(2),
      color: '#f8fafc',
      'text-opacity': 1,
      'font-weight': 500,
      'min-zoomed-font-size': 4,
      'z-index': 20,
    },
  },
  {
    // The pointer brings a dot forward, above the lines and every other dot,
    // larger and ringed, so it is easy to click. Its name is at full strength
    // whenever its card is closed, as while it is dragged.
    selector: 'node.hovered',
    style: {
      width: onScreen(DOT * 1.5),
      height: onScreen(DOT * 1.5),
      opacity: 1,
      'outline-width': onScreen(1.5),
      'outline-color': '#cbd5e1',
      'outline-offset': onScreen(2),
      color: '#f8fafc',
      'text-opacity': 1,
      'min-zoomed-font-size': 0,
      'z-index': 30,
    },
  },
  {
    // The hover card names the dot in larger type, so its own name steps
    // aside rather than peek out from under the card. See `HoverCard`.
    selector: 'node.carded',
    style: { 'text-opacity': 0 },
  },
];

const STYLES: Record<GraphLook, cytoscape.StylesheetJson> = {
  tiles: TILE_STYLE,
  network: NETWORK_STYLE,
};

/**
 * The card beside a hovered dot, in the network look.
 *
 * The dots carry only a name, so this is where an entity's money shows
 * without a click. In and out use the panel's emerald and amber. Its text is
 * well above the size of the names on the canvas, since it is the one thing
 * the reader is looking at.
 */
function HoverCard({ hover }: { hover: Hover }) {
  const n = hover.node;
  const received = Number(n.totalReceived) || 0;
  const given = Number(n.totalGiven) || 0;
  const officer = n.kind === 'officer';
  const detail = officer
    ? n.office
    : [kindLabel(n), n.party, n.office].filter(Boolean).join(' · ');

  // The card goes to the right of the dot, or to its left where the right
  // side would run off the canvas. In the lower half of the canvas it opens
  // upward from the dot, so it does not run off the bottom.
  const CARD_W = 320;
  const right = hover.x + hover.r + 12;
  const left = right + CARD_W > hover.w ? Math.max(4, hover.x - hover.r - 12 - CARD_W) : right;
  const upward = hover.y > hover.h / 2;

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border border-slate-700
                 bg-slate-900/95 px-4 py-3 text-sm shadow-lg shadow-black/40"
      style={{
        left,
        width: CARD_W,
        ...(upward
          ? { bottom: Math.max(4, hover.h - hover.y - 24) }
          : { top: Math.max(4, hover.y - 24) }),
      }}
    >
      <div className="text-lg font-semibold leading-snug text-slate-100">{n.name}</div>
      {detail && <div className="mt-1 text-slate-400">{detail}</div>}
      {!officer && (received > 0 || given > 0) && (
        <div className="mt-2 flex gap-4 text-base tabular-nums">
          {received > 0 && <span className="text-emerald-400">in {formatMoney(received)}</span>}
          {given > 0 && <span className="text-amber-400">out {formatMoney(given)}</span>}
        </div>
      )}
      {n.isTraversable && (
        <div className="mt-2 text-xs text-slate-500">Double-click to follow its money</div>
      )}
    </div>
  );
}

export default function GraphCanvas({
  nodes,
  edges,
  seedId,
  initialPositions,
  onSelectNode,
  onExpandNode,
  onReady,
  viewIntent,
  selectedId,
  highlightChains,
  keepLit,
  ghost,
  look = 'tiles',
  depth = Infinity,
}: Props) {


  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  /**
   * The look in force, for the callbacks that are built once and the layout
   * pass that runs on a timer. Set when the canvas is built and on every
   * switch.
   */
  const lookRef = useRef<GraphLook>(look);
  /** The look whose stylesheet the canvas holds now, so a switch is applied once. */
  const appliedLookRef = useRef<GraphLook | null>(null);
  /**
   * Saved positions, for the layout pass, which runs on a timer after the
   * render that handed them over.
   */
  const restoredRef = useRef(initialPositions);
  const [hover, setHover] = useState<Hover | null>(null);
  /** Nodes the user has dragged; never re-laid-out. */
  const pinnedRef = useRef<Set<string>>(new Set());
  /** The in-flight layout, so a new batch can cancel it instead of racing it. */
  const layoutRef = useRef<cytoscape.Layouts | null>(null);
  const relayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The routes to favour over the neighbourhood, readable from a callback.
   *
   * `focusOn` and the tap handler are created once and live for the lifetime of
   * the canvas, so neither can close over the current prop. A ref lets both ask
   * what the routes are at the moment they run.
   */
  const chainsRef = useRef<string[][]>([]);
  const keepLitRef = useRef<string[]>([]);
  /**
   * The tap handlers, for the same reason and by the same means.
   *
   * They are installed once, so calling the prop directly would call whichever
   * version existed at mount — and the parent's answer to a tap depends on
   * what the reader has done since, such as which names they have clicked down
   * in the panel.
   */
  const handlersRef = useRef({ onSelectNode, onExpandNode });
  /**
   * Bumped every time a Cytoscape instance is created.
   *
   * A plain `ready` boolean is not enough: React StrictMode (and any remount)
   * tears the instance down and builds a new one, but the boolean stays `true`
   * throughout, so effects keyed on it never re-run and end up addressing the
   * destroyed instance — leaving the live canvas unpopulated and unfitted.
   */
  const [cyEpoch, setCyEpoch] = useState(0);
  const ready = cyEpoch > 0;

  // Edge widths are scaled against the largest edge currently on screen, so the
  // relative weighting stays readable whether the graph spans $900 or $9M.
  const maxAmount = useMemo(() => {
    let max = 0;
    for (const e of edges.values()) max = Math.max(max, Number(e.amount));
    return max || 1;
  }, [edges]);

  /**
   * Highlight a tile the way the reader arrived at it.
   *
   * A route wins where there is one, because someone who clicked a name in the
   * panel is asking how it connects to what they were already looking at. A
   * tap on the tile itself asks the other question, so it keeps the
   * neighbourhood.
   */
  const applyHighlight = useCallback((cy: Core, node: NodeSingular) => {
    const chains = chainsRef.current;
    if (chains.length > 0 && highlightRoutes(cy, chains, keepLitRef.current, node)) return;
    highlightNeighborhood(cy, node, keepLitRef.current, lookRef.current);
  }, []);

  /* ---------------------------------------------------------------- init -- */
  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;


    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      minZoom: 0.05,
      maxZoom: 4,
      wheelSensitivity: 0.2,
      // textureOnViewport/motionBlur leave stale ghost tiles behind while
      // levels stream in and the layout is animating. Correctness of what is
      // on screen matters more here than pan smoothness.
      textureOnViewport: false,
      motionBlur: false,
      pixelRatio: 1.5,
      style: STYLES[lookRef.current],
    });

    cy.on('tap', 'node', (evt: EventObject) => {
      const n = evt.target as NodeSingular;
      handlersRef.current.onSelectNode?.(n.data('entity') as GraphNode);
      highlightNeighborhood(cy, n, [], lookRef.current);
    });

    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        cy.elements().removeClass(LIT);
        handlersRef.current.onSelectNode?.(null);
      }
    });

    cy.on('dbltap', 'node', (evt: EventObject) => {
      handlersRef.current.onExpandNode?.((evt.target as NodeSingular).id());
    });

    // Dragging a node pins it so later layout passes leave it alone.
    cy.on('dragfree', 'node', (evt: EventObject) => {
      pinnedRef.current.add((evt.target as NodeSingular).id());
    });
    // A dragged dot's own lines are routed again as it moves. Once it is let
    // go, every line is, since others may now run through it. See `routeLines`.
    cy.on('drag', 'node', (evt: EventObject) => {
      routeLines((evt.target as NodeSingular).connectedEdges());
    });
    cy.on('free', 'node', () => {
      routeLines(cy.edges());
    });

    // Hovering a dot rings it, brightens its lines and opens its card. Tiles
    // already show all of that, so the tiles look skips it.
    cy.on('mouseover', 'node', (evt: EventObject) => {
      if (lookRef.current !== 'network') return;
      const n = evt.target as NodeSingular;
      n.addClass('hovered');
      n.connectedEdges().addClass('hovered');
      const p = n.renderedPosition();
      setHover({
        id: n.id(),
        node: n.data('entity') as GraphNode,
        x: p.x,
        y: p.y,
        r: n.renderedOuterWidth() / 2,
        w: cy.width(),
        h: cy.height(),
      });
    });
    cy.on('mouseout', 'node', (evt: EventObject) => {
      const n = evt.target as NodeSingular;
      n.removeClass('hovered');
      n.connectedEdges().removeClass('hovered');
      setHover(null);
    });
    // The card is placed against where the dot stood on screen. Once the view
    // moves, or the dot does, or the dot goes, that place is wrong.
    cy.on('grab', 'node', () => setHover(null));
    cy.on('remove', 'node', (evt: EventObject) => {
      const gone = (evt.target as NodeSingular).id();
      setHover((h) => (h && h.id === gone ? null : h));
    });
    cy.on('viewport', () => {
      setHover(null);
      fitToZoom(cy, lookRef.current);
    });

    appliedLookRef.current = lookRef.current;
    fitToZoom(cy, lookRef.current);

    cyRef.current = cy;
    setCyEpoch((e) => e + 1);

    // Handy for poking at the graph from the browser console during development.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { cy?: Core }).cy = cy;
    }

    // Cytoscape caches the container size at construction. In a flex layout the
    // pane is often still 0-sized then, which leaves the first fit centred on
    // the wrong box and the seed tile clipped at the corner.
    const ro = new ResizeObserver(() => {
      cy.resize();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (relayoutTimer.current) clearTimeout(relayoutTimer.current);
      layoutRef.current?.stop();
      cy.destroy();
      cyRef.current = null;
    };
    // Built once and torn down with the canvas. The tap handlers reach the
    // current props through `handlersRef` rather than closing over them.
  }, []);

  /**
   * Lay the canvas out again, after a short pause.
   *
   * Levels stream in milliseconds apart, and starting a layout while another
   * is still animating leaves the second batch stranded on top of the first —
   * stacked tiles, and zero-length edges that the renderer then culls. So
   * coalesce bursts into a single pass and cancel any layout still running.
   *
   * `fresh` lets go of every place the reader set, for a switch of look. A
   * place chosen among tiles means nothing among dots, which sit a fraction of
   * the distance apart, and the other way round.
   */
  const scheduleLayout = useCallback((fresh: boolean) => {
    const cy = cyRef.current;
    if (!cy) return;
    if (relayoutTimer.current) clearTimeout(relayoutTimer.current);
    relayoutTimer.current = setTimeout(() => {
      layoutRef.current?.stop();
      const geometry = GEOMETRY[lookRef.current];
      const held = (id: string) =>
        !fresh && (pinnedRef.current.has(id) || Boolean(restoredRef.current?.[id]));

      // Hold pinned and user-restored tiles; let everything else settle freely
      // so late arrivals don't get wedged into whatever gap is left over.
      //
      // Locking as well as constraining them is not belt and braces. fcose
      // reads `fixedNodeConstraint` only on a randomized run, and a randomized
      // run is the one thing this must not do, because it would throw every
      // other tile somewhere new while the reader is looking at them. A locked
      // node is one Cytoscape itself refuses to move, whatever the layout asks.
      const fixed: { nodeId: string; position: { x: number; y: number } }[] = [];
      cy.nodes().forEach((n) => {
        const id = n.id();
        if (held(id)) {
          const p = n.position();
          fixed.push({ nodeId: id, position: { x: p.x, y: p.y } });
          n.lock();
        } else {
          n.unlock();
        }
      });

      // Where each node is headed, as the layout hands it over, so the arcs
      // can be bent to the finished picture while the nodes move into it.
      const headed = new Map<string, { x: number; y: number }>();

      // Through `unknown`: Cytoscape's typings know only its built-in layouts,
      // and fcose ships no types of its own.
      const layout = cy.layout({
        ...geometry.layout,
        animate: true,
        animationDuration: 500,
        randomize: fixed.length === 0,
        fit: false,
        fixedNodeConstraint: fixed.length > 0 ? fixed : undefined,
        transform: (n: NodeSingular, p: { x: number; y: number }) => {
          headed.set(n.id(), p);
          return p;
        },
      } as unknown as cytoscape.LayoutOptions);

      /**
       * Open the tiles out, then frame them.
       *
       * The separation pass runs whatever the reader has arranged, because a
       * pinned tile only holds its own place and new arrivals still have to be
       * kept off it. Framing is the part that gets skipped once tiles have been
       * dragged: moving the viewport there would throw away the view they
       * built. fcose's own `fit` runs against the size it saw at layout start,
       * which in a flex pane is often stale, so this is the fit that counts.
       */
      const settleView = () => {
        // The lock was only for the duration of the layout. Leaving it on would
        // make a pinned tile the one tile the reader can no longer drag.
        cy.nodes().unlock();
        separateTiles(cy, held, geometry.gap);
        routeLines(cy.edges());
        if (!fresh && pinnedRef.current.size > 0) return;
        cy.resize();
        cy.fit(cy.elements(), 60);
        if (cy.zoom() > geometry.fitZoom) {
          cy.zoom(geometry.fitZoom);
          cy.center();
        }
      };

      // `layoutstop` does not fire when a layout is stopped early by the next
      // batch, so back it with a timer rather than leaving the view unfitted.
      layout.one('layoutstop', settleView);
      const fitFallback = setTimeout(settleView, 900);
      layout.one('layoutstop', () => clearTimeout(fitFallback));

      layoutRef.current = layout;
      layout.run();
      // fcose works out every position before it starts animating, so by
      // now `headed` holds the finished picture. A locked node stays put.
      routeLines(cy.edges(), (n) => (n.locked() ? n.position() : (headed.get(n.id()) ?? n.position())));
    }, 180);
  }, []);

  // Declared above the sync below, so a layout it schedules reads the
  // positions handed over in the same render.
  useEffect(() => {
    restoredRef.current = initialPositions;
  }, [initialPositions]);

  /* ------------------------------------------------------------- syncing -- */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;

    const nodeDefs: ElementDefinition[] = [];
    const edgeDefs: ElementDefinition[] = [];

    // The hook resets its maps when a crawl restarts, so `nodes` and `edges`
    // are the whole truth for the current crawl, not a delta. Anything on the
    // canvas that is missing from them belongs to a superseded graph: changing
    // the cycle used to leave the previous cycle's tiles sitting underneath the
    // new ones.
    const stale = cy.elements().filter((el) => {
      // Ghosts are the parent's to add and remove; they are absent from these
      // maps by definition, and sweeping them here would delete each one in
      // the same beat it was laid in.
      if (el.hasClass('ghost')) return false;
      const id = el.id();
      return el.isNode() ? !nodes.has(id) : !edges.has(id);
    });
    if (stale.nonempty()) cy.remove(stale);

    // Totals are cycle-dependent, so a node that survives the change still
    // needs its label rewritten.
    for (const n of nodes.values()) {
      const el = cy.getElementById(n.id);
      if (el.empty()) continue;
      const label = tileLabel(n);
      const isSeed = n.id === seedId;
      if (el.data('label') !== label || el.data('isSeed') !== isSeed) {
        el.data({ label, entity: n, isSeed, name: dotName(n) });
      }
    }

    // Cytoscape drops every positionless node at (0,0). A force layout started
    // from identical coordinates has no gradient to push against, so the whole
    // level stays welded into one pile. Seed each newcomer on a ring around the
    // existing graph's centre instead, and let the layout relax from there.
    const existing = cy.nodes();
    const centre = existing.length > 0 ? existing.boundingBox() : null;
    const origin = centre
      ? { x: (centre.x1 + centre.x2) / 2, y: (centre.y1 + centre.y2) / 2 }
      : { x: 0, y: 0 };
    const spread = centre ? Math.max(centre.w, centre.h, 400) * 0.7 : 400;
    const { unitRadius } = GEOMETRY[lookRef.current];
    // Counted before anything is placed, because the ring each tile lands on is
    // sized for the whole batch rather than for the tile in hand.
    let incoming = 0;
    for (const n of nodes.values()) {
      if (cy.getElementById(n.id).empty() && !initialPositions?.[n.id]) incoming++;
    }
    let spawnIndex = 0;

    for (const n of nodes.values()) {
      if (cy.getElementById(n.id).nonempty()) continue;


      nodeDefs.push({
        group: 'nodes',
        data: {
          id: n.id,
          label: tileLabel(n),
          fullName: n.name,
          kind: n.kind,
          isSeed: n.id === seedId,
          // Dashed border hints there is more to pull in beyond what is drawn.
          hasMore: n.isTraversable && n.inDegree + n.outDegree > 0,
          entity: n,
          name: dotName(n),
        },
        position: initialPositions?.[n.id]
          ? { ...initialPositions[n.id] }
          : spawnPosition(origin, spread, spawnIndex++, incoming, n.level, unitRadius),
      });
    }

    // In registration mode a node's depth counts shared officers, not
    // payments, so no money line there is past the depth. Officer hubs are in
    // the crawl in that mode and in no other.
    let byOfficers = false;
    for (const n of nodes.values()) {
      if (n.kind === 'officer') {
        byOfficers = true;
        break;
      }
    }

    for (const e of edges.values()) {
      if (cy.getElementById(e.id).nonempty()) continue;
      // Both endpoints must exist before Cytoscape will accept the edge.
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;

      const amount = Number(e.amount);
      const width = edgeWidth(amount, maxAmount);

      const isRegistration = e.kind === 'registration';
      const from = nodes.get(e.source);
      const to = nodes.get(e.target);
      const tone = isRegistration ? undefined : edgeTone(to);

      edgeDefs.push({
        group: 'edges',
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          width: isRegistration ? 1 : width,
          // A registration edge labelled "$0" would read as a payment of
          // nothing rather than as no payment at all, so it names the role.
          label: isRegistration ? (e.basis ?? 'shared officer') : formatMoney(amount),
          isDirectLink: e.isDirectLink,
          kind: e.kind,
          amount: isRegistration ? 0 : amount,
          txnCount: e.txnCount,
          edge: e,
          // How the network look draws the line. See `edgeTone`,
          // `mergePairs` and `routeLines`.
          ownTone: tone,
          tone,
          // Both ends at the full depth: no path of `depth` hops from the
          // searched entity runs along this line. A money crawl never draws
          // one, since it does not expand the entities at the full depth.
          beyond:
            !isRegistration &&
            !byOfficers &&
            Math.min(from?.level ?? 0, to?.level ?? 0) >= depth,
          fwd: isRegistration ? 0 : amount,
          back: 0,
          arc: 0,
        },
      });
    }

    if (nodeDefs.length === 0 && edgeDefs.length === 0) return;

    // Track which ids are new *before* adding, so membership tests are cheap
    // and do not depend on collection identity.
    const newNodeIds = new Set(nodeDefs.map((d) => String(d.data.id)));
    if (newNodeIds.size === 0 && edgeDefs.length === 0) return;

    let added = cy.collection();
    cy.batch(() => {
      if (nodeDefs.length) cy.add(nodeDefs);
      if (edgeDefs.length) added = cy.add(edgeDefs);
    });
    mergePairs(cy);
    fitLinesToDensity(cy);
    routeLines(added.edges());

    // Adding only edges between existing nodes needs no relayout.
    if (newNodeIds.size === 0) return;

    scheduleLayout(false);
    // cyEpoch is a dependency so a rebuilt instance gets repopulated; without
    // it a remount leaves the new canvas permanently empty. `ready` is derived
    // from cyEpoch and listed only to satisfy exhaustive-deps.
  }, [nodes, edges, seedId, maxAmount, cyEpoch, ready, initialPositions, scheduleLayout, depth]);

  /**
   * Switch look: restyle, and lay the graph out afresh.
   *
   * Places the reader dragged tiles to are let go, for the reason given at
   * `scheduleLayout`.
   */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready || appliedLookRef.current === look) return;
    appliedLookRef.current = look;
    lookRef.current = look;
    cy.style(STYLES[look]);
    fitToZoom(cy, look);
    pinnedRef.current.clear();
    if (cy.nodes().nonempty()) scheduleLayout(true);
  }, [look, ready, cyEpoch, scheduleLayout]);

  /* ------------------------------------------------------------- handle --- */
  const exportPng = useCallback((filename: string) => {
    const cy = cyRef.current;
    if (!cy) return;
    // The file is drawn at its own scale, not the screen's zoom, so lines, dots
    // and names go back to graph-unit sizes for it and return to the zoom
    // afterwards.
    const held = [SCREEN_SCALE, TEXT_SCALE].map((key) => [key, cy.scratch(key)] as const);
    const scaled = held.some(([, factor]) => factor !== undefined);
    if (scaled) {
      for (const [key] of held) cy.scratch(key, 1);
      restyle(cy.elements());
    }
    const png = cy.png({
      output: 'blob',
      bg: lookRef.current === 'network' ? GROUND : '#0f172a',
      full: true,
      scale: 2,
      maxWidth: 6000,
      maxHeight: 6000,
    });
    if (scaled) {
      for (const [key, factor] of held) {
        if (factor === undefined) cy.removeScratch(key);
        else cy.scratch(key, factor);
      }
      restyle(cy.elements());
    }
    const url = URL.createObjectURL(png);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  /**
   * Frame the whole graph.
   *
   * Returns false when the container currently has no size — a hidden tab, a
   * collapsed pane, or a mid-transition flex box. Fitting to a 0x0 viewport
   * silently produces a degenerate result and leaves the graph stranded
   * off-screen, so callers retry instead.
   */
  const fit = useCallback((): boolean => {
    const cy = cyRef.current;
    if (!cy || cy.elements().empty()) return false;

    const el = cy.container();
    if (!el || el.clientWidth < 2 || el.clientHeight < 2) return false;
    // Stop the layout first. Fitting while nodes are still animating measures a
    // bounding box that is obsolete by the time they land, which is why an
    // animated fit here silently appeared to do nothing.
    layoutRef.current?.stop();
    cy.stop();
    // resize() next: the container may have been laid out after Cytoscape last
    // measured it, and fitting to a stale box leaves tiles off-screen.
    cy.resize();
    cy.fit(cy.elements(), 60);
    const { fitZoom } = GEOMETRY[lookRef.current];
    if (cy.zoom() > fitZoom) {
      cy.zoom(fitZoom);
      cy.center();
    }
    return true;
  }, []);

  /**
   * Centre and zoom on one node, and mark it selected.
   *
   * Returns false when the node is not on the canvas yet — levels stream in, so
   * callers retry rather than give up.
   */
  const focusOn = useCallback((nodeId: string): boolean => {
    const cy = cyRef.current;
    if (!cy) return false;

    const node = cy.getElementById(nodeId);
    if (node.empty() || !node.isNode()) return false;

    const el = cy.container();
    if (!el || el.clientWidth < 2 || el.clientHeight < 2) return false;

    layoutRef.current?.stop();
    cy.stop();
    cy.resize();

    cy.nodes().unselect();
    node.select();
    applyHighlight(cy, node as NodeSingular);

    cy.animate({
      center: { eles: node },
      zoom: Math.min(GEOMETRY[lookRef.current].focusZoom, cy.maxZoom()),
      duration: 380,
      easing: 'ease-out',
    });
    return true;
  }, [applyHighlight]);

  /**
   * Step the zoom about the centre of the viewport.
   *
   * Multiplicative, not additive: zoom is a scale, so a fixed step feels
   * enormous when zoomed out and imperceptible when zoomed in. Anchored on the
   * viewport centre rather than the pointer, since the caller is a button and
   * has no pointer position to speak of.
   */
  const zoomBy = useCallback((factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    layoutRef.current?.stop();
    cy.stop();
    const next = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
    // Set rather than animate. An animated zoom rides requestAnimationFrame,
    // which a backgrounded tab stalls — the graph then jumps when the tab comes
    // forward, or not at all. A discrete step wants no easing anyway.
    //
    // `cy.width()`, not `container().clientWidth`: Cytoscape's own measure of
    // its viewport, which is what `renderedPosition` is expressed in.
    cy.zoom({ level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, []);

  /**
   * Pan by a fraction of the viewport.
   *
   * Proportional rather than a fixed pixel count so one press moves the same
   * share of what is on screen at any zoom level.
   */
  const panBy = useCallback((dx: number, dy: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    layoutRef.current?.stop();
    cy.stop();
    // Sign is inverted because panning the viewport right means moving the
    // scene left. `cy.width()` for the same reason as `zoomBy`.
    cy.panBy({ x: -dx * cy.width(), y: -dy * cy.height() });
  }, []);

  /**
   * Current tile coordinates, for saving a layout.
   *
   * A tile the layout has not placed yet can report a non-finite position, and
   * one of those is enough for the server to reject the whole save. Leaving it
   * out costs nothing: a tile with no saved position is placed by the layout
   * when the search is reopened, which is what happens to every new tile.
   */
  const getPositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return {};
    const out: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((n) => {
      const p = n.position();
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) out[n.id()] = { x: p.x, y: p.y };
    });
    return out;
  }, []);

  /**
   * Re-measure the container.
   *
   * Cytoscape caches its viewport size, so a canvas that was `display: none`
   * while another pane showed comes back convinced it is 0x0 and renders
   * nothing until something forces a measure. The mobile pane switcher hides
   * it on every tab change, so the graph pane calls this on the way back in.
   */
  const resize = useCallback(() => {
    const cy = cyRef.current;
    const el = cy?.container();
    if (!cy || !el || el.clientWidth < 2 || el.clientHeight < 2) return;
    cy.resize();
  }, []);

  useEffect(() => {
    if (ready) onReady?.({ exportPng, fit, focusOn, getPositions, zoomBy, panBy, resize });
  }, [ready, exportPng, fit, focusOn, getPositions, zoomBy, panBy, resize, onReady]);

  // A new seed means a new graph; whatever the user pinned belonged to the old
  // one and must not constrain the fresh layout.
  useEffect(() => {
    pinnedRef.current.clear();
  }, [seedId]);

  // Frame the finished graph once the layout animation has settled. Waits for
  // `ready`, so a crawl that outruns the canvas mount still gets fitted. The
  // token is an explicit request from the parent, so it is not second-guessed
  // against pinning here — only the layout-driven refits defer to that.
  useEffect(() => {
    if (!ready || !viewIntent || viewIntent.token === 0) return;

    // Poll until the action actually lands. The first attempt waits for the
    // debounced layout; later ones cover a container that was not yet sized
    // (hidden tab, collapsed pane) or a target node that has not streamed in
    // yet when the earlier attempts ran.
    let attempts = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const attempt = () => {
      const done = viewIntent.kind === 'focus' ? focusOn(viewIntent.nodeId) : fit();
      if (done || attempts >= 8) return;
      attempts++;
      timers.push(setTimeout(attempt, 400));
    };
    timers.push(setTimeout(attempt, 800));

    return () => timers.forEach(clearTimeout);
  }, [viewIntent, cyEpoch, ready, fit, focusOn]);

  // Declared above the two effects that read it, so a route arriving with a
  // selection is in place before the highlight for that selection runs.
  useEffect(() => {
    chainsRef.current = highlightChains ?? [];
    keepLitRef.current = keepLit ?? [];
  }, [highlightChains, keepLit]);

  useEffect(() => {
    handlersRef.current = { onSelectNode, onExpandNode };
  }, [onSelectNode, onExpandNode]);

  // Marks the dot whose card is open. A dot stays hovered while it is dragged
  // or the view moves, but its card closes then, and its name comes back.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes('.carded').removeClass('carded');
    if (hover) cy.getElementById(hover.id).addClass('carded');
  }, [hover]);

  /**
   * Lay in the routes' missing tiles, and take the previous set away.
   *
   * Placed by stepping off whichever tile of a route is already on screen,
   * never by running a layout: a layout pass moves every other tile on the
   * canvas, which is the precise disorientation this exists to prevent. What
   * is here is what the reader currently has clicked down, so a name they let
   * go of takes its tile with it.
   */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;

    cy.batch(() => {
      cy.remove(cy.elements('.ghost'));
      if (!ghost || ghost.nodes.length === 0) return;

      const drawn = cy.nodes();
      const box = drawn.nonempty() ? drawn.boundingBox() : null;
      let from = box ? { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 } : { x: 0, y: 0 };
      let step = 0;
      const { dx, dy } = GEOMETRY[lookRef.current].ghostStep;

      for (const n of ghost.nodes) {
        const already = cy.getElementById(n.id);
        if (already.nonempty()) {
          from = already.position();
          continue;
        }
        // Fanned around the tile they hang off rather than stepped along one
        // line. Several names clicked down all hang off the same tile, and a
        // line would lay every one of them in the same two places. The golden
        // angle spreads consecutive tiles instead of clumping them, and the
        // separation pass below opens whatever this still leaves touching.
        const angle = step * 2.399963;
        const position = {
          x: from.x - dx * Math.cos(angle),
          y: from.y + dy * 2 * Math.sin(angle),
        };
        step++;
        cy.add({
          group: 'nodes',
          classes: 'ghost',
          data: {
            id: n.id,
            label: tileLabel(n),
            fullName: n.name,
            kind: n.kind,
            isSeed: false,
            hasMore: false,
            entity: n,
            name: dotName(n),
          },
          position,
        });
        from = position;
      }

      for (const e of ghost.edges) {
        if (cy.getElementById(e.id).nonempty()) continue;
        // Both ends have to exist first, and one of them can be an officer hub
        // that this route never managed to resolve.
        if (cy.getElementById(e.source).empty() || cy.getElementById(e.target).empty()) continue;
        // A hop's label is the amount the panel row showed, or a word such as
        // "traced" or an officer's role. The network look writes an amount
        // under the name at the far end and keeps a word on the line.
        const isAmount = e.label.startsWith('$');
        cy.add({
          group: 'edges',
          classes: 'ghost',
          data: {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            lineLabel: isAmount ? '' : e.label,
            amountLabel: isAmount ? e.label : '',
            width: 2,
            // Borrowed, so off the crawl's paths and faint until lit.
            tone: 'political',
            beyond: true,
            arc: 0,
          },
        });
      }
    });

    // Only the tiles just laid in may move. The graph itself holds still,
    // which is the whole point of placing these by hand rather than by layout.
    separateTiles(
      cy,
      (id) => !cy.getElementById(id).hasClass('ghost'),
      GEOMETRY[lookRef.current].gap,
    );
    routeLines(cy.edges());
  }, [ghost, cyEpoch, ready]);

  /**
   * Mirror a selection made outside the canvas.

   *
   * Selecting from search or the ledger should look the same as tapping the
   * tile — otherwise the panel and the canvas disagree about what is selected.
   */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !ready) return;

    if (!selectedId) {
      cy.nodes().unselect();
      cy.elements().removeClass(LIT);
      return;
    }

    const node = cy.getElementById(selectedId);
    if (node.empty() || !node.isNode()) return;
    // Not skipped when the node is already selected: the same tile can be
    // arrived at twice by different routes, and the second arrival still has a
    // different route to draw.
    cy.nodes().unselect();
    node.select();
    applyHighlight(cy, node as NodeSingular);
  }, [selectedId, highlightChains, keepLit, ghost, cyEpoch, ready, nodes, applyHighlight]);



  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full bg-slate-950" />
      {hover && look === 'network' && <HoverCard hover={hover} />}
    </div>
  );
}
