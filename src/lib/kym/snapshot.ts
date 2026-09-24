/**
 * The picture of who a committee moves money with, two hops out, and the
 * file that holds it once drawn.
 *
 * It is the explorer's own view, drawn on the server. The crawl is the
 * explorer's default: two hops, money in and out, direct links, and the same
 * per-entity and total caps. The layout is the explorer's force layout and
 * overlap pass, run headless from `src/lib/graph/layout.ts`. Every entity the
 * explorer would draw is drawn here, whatever its kind.
 *
 * The one difference is the frame. The explorer fits the graph to a window a
 * reader can zoom. A picture has one size, so a large graph is drawn smaller
 * rather than cropped, down to the point where a tile's name is still legible
 * when the file is opened full size.
 *
 * ## Caching
 *
 * A picture costs a crawl, a layout and a few seconds of drawing, and it can
 * run to a few megabytes. Holding a week of those in memory is the thing to
 * avoid, so they go to the disk store in `src/lib/cache/disk.ts`, which
 * survives a restart of the container, capped by age and by total size. The
 * name of the file carries the same data stamp the trace cache uses, so a
 * correction landing makes every old picture unreachable rather than merely
 * old; the sweep then removes them by age.
 */

import { createHash } from 'node:crypto';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { db as Database } from '@/db';
import * as disk from '@/lib/cache/disk';
import { crawlAll, type GraphEdge, type GraphNode } from '@/lib/graph/crawl';
import {
  FCOSE_LAYOUT,
  SEED_H,
  SEED_W,
  TILE_H,
  TILE_W,
  edgeWidth,
  separateTiles,
} from '@/lib/graph/layout';
import { dataStamp } from '@/lib/graph/traceCache';
import { DEFAULT_SETTINGS } from '@/lib/graph/types';

cytoscape.use(fcose);

type Db = typeof Database;

/**
 * The explorer's default crawl, less the cycle, which the report chooses.
 *
 * Read from the explorer's settings rather than copied, so a change to what
 * the explorer opens on changes the picture with it.
 */
export const CRAWL = {
  depth: DEFAULT_SETTINGS.depth,
  direction: DEFAULT_SETTINGS.direction,
  linkMode: DEFAULT_SETTINGS.linkMode,
  maxPerNode: DEFAULT_SETTINGS.maxPerNode,
  maxNodes: DEFAULT_SETTINGS.maxNodes,
};

/** Space kept around the graph, in graph units. The explorer's fit uses the same. */
const PAD = 60;

/**
 * The longest side the graph may take, in pixels.
 *
 * Six hundred tiles lay out to about five thousand graph units a side. Drawn
 * at full size that is a 25-megapixel file. This bound keeps the largest
 * graphs near 0.8 of full size, where a tile's 10px name is still 8px.
 */
const MAX_SIDE = 4200;

/** Narrowest picture, so the masthead has room over a graph of one or two tiles. */
const MIN_WIDTH = 1200;

/** The width the masthead and foot are designed at. Wider pictures scale them up. */
const DESIGN_WIDTH = 1600;

/** Distance between two edges joining the same pair, as the explorer bends them. */
const BUNDLE_STEP = 40;

export interface Tile {
  node: GraphNode;
  /** Center, in pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  seed: boolean;
  /** More lies past this tile than the crawl drew. Dashed, as in the explorer. */
  hasMore: boolean;
}

export interface Line {
  edge: GraphEdge;
  from: Tile;
  to: Tile;
  /** Stroke width in pixels, on the explorer's log scale. */
  width: number;
  /** Both ends are committees or others that move money. Drawn in the explorer's link color. */
  direct: boolean;
  /**
   * How far the line bows off the straight path, in pixels, to the left of
   * travel from the lower id to the higher. Zero for a pair joined once.
   */
  bend: number;
}

export interface Scene {
  seed: GraphNode;
  width: number;
  height: number;
  /** Pixels per graph unit. Fonts and strokes inside the graph scale by it. */
  scale: number;
  /** Size of the masthead and foot relative to their design width. */
  unit: number;
  /** Height of the masthead band. */
  header: number;
  tiles: Tile[];
  lines: Line[];
  /** The crawl stopped at the explorer's node ceiling. */
  truncated: boolean;
}

/** Trim a name to what two lines of a tile will hold. */
export function fitLabel(name: string, max: number): string {
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The subject's neighborhood as the explorer draws it, placed.
 *
 * Null when the id names nothing.
 */
export async function buildScene(db: Db, seedId: string, cycle?: string): Promise<Scene | null> {
  const graph = await crawlAll(db, { seedEntityId: seedId, ...CRAWL, cycle });
  const seed = graph.nodes.find((n) => n.id === seedId);
  if (!seed) return null;

  // The crawl reports an edge even where the node ceiling kept its far end
  // off the canvas. The explorer skips those, and so does this. A payment to
  // itself has no line to draw.
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );

  const positions = layOut(graph.nodes, edges, seedId);
  return place(seed, graph.nodes, edges, positions, graph.truncated);
}

/** The explorer's layout, headless. Positions are in graph units. */
function layOut(
  nodes: GraphNode[],
  edges: GraphEdge[],
  seedId: string,
): Map<string, { x: number; y: number }> {
  const cy = cytoscape({
    headless: true,
    // On, so the layout reads each tile's size from the style below.
    styleEnabled: true,
    style: [
      { selector: 'node', style: { shape: 'round-rectangle', width: TILE_W, height: TILE_H } },
      { selector: 'node[?isSeed]', style: { width: SEED_W, height: SEED_H } },
    ],
    elements: [
      ...nodes.map((n) => ({ group: 'nodes' as const, data: { id: n.id, isSeed: n.id === seedId } })),
      ...edges.map((e) => ({
        group: 'edges' as const,
        data: { id: e.id, source: e.source, target: e.target },
      })),
    ],
  });
  try {
    cy.layout({
      ...FCOSE_LAYOUT,
      animate: false,
      randomize: true,
      fit: false,
    } as cytoscape.LayoutOptions).run();
    separateTiles(cy, () => false);
    return new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
  } finally {
    cy.destroy();
  }
}

function place(
  seed: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
  positions: Map<string, { x: number; y: number }>,
  truncated: boolean,
): Scene {
  const sized = nodes.map((node) => {
    const isSeed = node.id === seed.id;
    const p = positions.get(node.id) ?? { x: 0, y: 0 };
    return { node, isSeed, x: p.x, y: p.y, w: isSeed ? SEED_W : TILE_W, h: isSeed ? SEED_H : TILE_H };
  });

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const t of sized) {
    x1 = Math.min(x1, t.x - t.w / 2);
    y1 = Math.min(y1, t.y - t.h / 2);
    x2 = Math.max(x2, t.x + t.w / 2);
    y2 = Math.max(y2, t.y + t.h / 2);
  }
  const graphW = x2 - x1 + 2 * PAD;
  const graphH = y2 - y1 + 2 * PAD;

  const scale = Math.min(1, MAX_SIDE / Math.max(graphW, graphH));
  const width = Math.max(MIN_WIDTH, Math.ceil(graphW * scale));
  const unit = Math.min(3, Math.max(1, width / DESIGN_WIDTH));
  const header = Math.round(110 * unit);
  const footer = Math.round(64 * unit);
  const height = Math.ceil(header + graphH * scale + footer);
  const left = (width - graphW * scale) / 2;

  const tiles: Tile[] = [];
  const at = new Map<string, Tile>();
  for (const t of sized) {
    const tile: Tile = {
      node: t.node,
      x: left + (t.x - x1 + PAD) * scale,
      y: header + (t.y - y1 + PAD) * scale,
      w: t.w * scale,
      h: t.h * scale,
      seed: t.isSeed,
      hasMore: t.node.isTraversable && t.node.inDegree + t.node.outDegree > 0,
    };
    tiles.push(tile);
    at.set(t.node.id, tile);
  }

  // Edges joining the same pair, either way round, fan out around the
  // straight path the way the explorer bundles them.
  const bundles = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    const held = bundles.get(key);
    if (held) held.push(e);
    else bundles.set(key, [e]);
  }

  const maxAmount = edges.reduce((m, e) => Math.max(m, Number(e.amount) || 0), 0);
  const lines: Line[] = [];
  for (const bundle of bundles.values()) {
    bundle.forEach((e, i) => {
      const from = at.get(e.source);
      const to = at.get(e.target);
      if (!from || !to) return;
      lines.push({
        edge: e,
        from,
        to,
        width: edgeWidth(Number(e.amount) || 0, maxAmount) * scale,
        direct: e.isDirectLink,
        bend: (i - (bundle.length - 1) / 2) * BUNDLE_STEP * scale,
      });
    });
  }
  // Heavier lines last, so the money that matters is drawn over the rest.
  lines.sort((a, b) => a.width - b.width);

  // The seed last, so nothing is drawn over it.
  tiles.sort((a, b) => Number(a.seed) - Number(b.seed));

  return { seed, width, height, scale, unit, header, tiles, lines, truncated };
}

/* ------------------------------------------------------------------------ */
/* The file                                                                  */
/* ------------------------------------------------------------------------ */

/** Bump when the drawing changes, so pictures drawn the old way are not served. */
export const RENDER_VERSION = 6;

/** How long a picture stands once the filings behind it stop moving. */
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Disk the pictures may take, all together. At 1–4MB each, this is several hundred of them. */
export const MAX_BYTES = 1024 * 1024 * 1024;
/** Pictures drawn at once. Each render holds a canvas of up to twelve megapixels while it works. */
const MAX_RENDERS = 2;

const NS = 'snapshots';
const LIMITS = { ttlMs: TTL_MS, maxBytes: MAX_BYTES };

const inflight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/**
 * What names a picture: the subject, the period, the data behind it and the
 * way it is drawn. Two readers asking for the same one get the same file, and
 * a correction landing changes the name so they do not get last week's.
 */
export async function snapshotKey(
  db: Db,
  id: string,
  cycle: string | undefined,
): Promise<{ key: string; etag: string }> {
  const stamp = await dataStamp(db);
  const key = createHash('sha1')
    .update([RENDER_VERSION, id, cycle ?? '', stamp].join('|'))
    .digest('hex');
  return { key, etag: `"${key}"` };
}

let active = 0;
const waiting: (() => void)[] = [];

/** Run one render, holding the rest until a slot is free. */
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_RENDERS) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/**
 * The picture under this key, drawn if it has to be.
 *
 * Reads through to `render` at most once per key however many readers ask at
 * the same moment.
 */
export async function cachedSnapshot(
  key: string,
  render: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer>> {
  const held = await disk.read(NS, key, 'png');
  if (held) return new Uint8Array(held);

  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    const png = await withSlot(render);
    await disk.write(NS, key, 'png', png, LIMITS);
    return png;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}
