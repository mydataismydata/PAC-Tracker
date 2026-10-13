/**
 * The picture of who a committee moves money with, two hops out, and the
 * file that holds it once drawn.
 *
 * It is the explorer's own view, drawn on the server in the explorer's
 * network look: a small dot per entity with its name beside it, and one
 * plain line per pair of entities. The crawl is the explorer's default: two
 * hops, money in and out, direct links, and the same per-entity and total
 * caps. The layout is the explorer's force layout and overlap pass for dots,
 * run headless from `src/lib/graph/layout.ts`, and lines bow around dots by
 * the same rule. Every entity the explorer would draw is drawn here, whatever
 * its kind. It shows the graph as the explorer opens it, with the searched
 * entity selected and its whole network lit.
 *
 * The one difference is the frame. The explorer fits the graph to a window a
 * reader can zoom. A picture has one size, so a large graph is drawn smaller
 * rather than cropped, sized the way the explorer sizes dots, lines and names
 * at that zoom.
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
  DOT,
  DOT_GAP,
  bowAround,
  lineDensity,
  networkLayout,
  separateTiles,
  type Point,
} from '@/lib/graph/layout';
import { dataStamp } from '@/lib/graph/traceCache';
import { DEFAULT_SETTINGS, edgeTone, formatMoney } from '@/lib/graph/types';

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

/** Clear space kept around the graph, in pixels. */
const PAD = 48;

/** The longest side the graph may take, in pixels. */
const MAX_SIDE = 4200;

/** The closest the explorer zooms when it frames a whole graph of dots. */
const FIT_ZOOM = 1.4;

/**
 * Room each entity gets on the picture, in square pixels.
 *
 * At the explorer's framing zoom a crowded graph packs hundreds of names on
 * top of each other. Zooming in spreads the dots apart while names keep their
 * size, so a crowded graph is drawn closer, up to MAX_ZOOM, until each entity
 * has about this much room.
 */
const ROOM = 10000;

/** The closest a crowded graph is drawn. */
const MAX_ZOOM = 3;

/** Narrowest picture, so the masthead has room over a graph of one or two dots. */
const MIN_WIDTH = 1200;

/** The width the masthead and foot are designed at. Wider pictures scale them up. */
const DESIGN_WIDTH = 1600;

/** The size of a name on the explorer's canvas at zoom 1, in pixels. */
export const NAME = 10;

/** The longest name written beside a dot, as in the explorer. */
const NAME_MAX = 30;

/**
 * The searched entity's card, as the explorer draws it beside the dot, in
 * pixels. Its name wraps inside the width.
 */
export const CARD = {
  maxWidth: 320,
  /** Between the dot and the card. */
  gap: 12,
  padX: 14,
  padY: 10,
  name: 15,
  money: 12,
} as const;

export interface Dot {
  node: GraphNode;
  /** Center, in pixels. */
  x: number;
  y: number;
  seed: boolean;
  /** The name written beside it. Empty for the searched entity, which has its card. */
  label: string;
}

export interface Line {
  /** The ends of the largest payment between the pair. */
  from: Dot;
  to: Dot;
  /** Political money or a payment to a vendor. See `edgeTone`. */
  tone: 'political' | 'vendor';
  /**
   * How far the line's control point sits off the straight path, in pixels,
   * to the left of travel from `from` to `to`. Zero for a straight line.
   */
  arc: number;
}

export interface Scene {
  seed: GraphNode;
  width: number;
  height: number;
  /** Pixels per graph unit: the zoom the graph is drawn at. */
  scale: number;
  /**
   * What a pixel of line or dot at zoom 1 comes to at this zoom. Lines and
   * dots grow and shrink only with the square root of the zoom, as in the
   * explorer.
   */
  stroke: number;
  /** The size of a name, in pixels. Never larger than at zoom 1. */
  font: number;
  /** A dot's width, in pixels. */
  dot: number;
  /** Size of the masthead and foot relative to their design width. */
  unit: number;
  /** Height of the masthead band. */
  header: number;
  dots: Dot[];
  lines: Line[];
  /** How strongly lines are drawn on a graph this crowded. See `lineDensity`. */
  density: number;
  /** The crawl stopped at the explorer's node ceiling. */
  truncated: boolean;
}

/** Trim a name to a length, with a mark where it was cut. */
export function fitLabel(name: string, max: number): string {
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Rough width of a string in Geist, in multiples of the font size.
 *
 * Capitals and digits run wider than lower case. Counting characters alone
 * underestimates an all-capitals vendor name. Errs wide, so the frame leaves
 * room for every name.
 */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += ch === ' ' ? 0.28 : /[A-Z0-9$@&%#MW]/.test(ch) ? 0.66 : /[il.,:;'!|]/.test(ch) ? 0.3 : 0.54;
  }
  return w;
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
    (e) => e.kind === 'money' && ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );

  const positions = layOut(graph.nodes, edges);
  return place(seed, graph.nodes, edges, positions, graph.truncated);
}

/** The explorer's layout for dots, headless. Positions are in graph units. */
function layOut(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Point> {
  const cy = cytoscape({
    headless: true,
    // On, so the layout and the overlap pass read each dot's size.
    styleEnabled: true,
    style: [{ selector: 'node', style: { shape: 'ellipse', width: DOT, height: DOT } }],
    elements: [
      ...nodes.map((n) => ({ group: 'nodes' as const, data: { id: n.id } })),
      ...edges.map((e) => ({
        group: 'edges' as const,
        data: { id: e.id, source: e.source, target: e.target },
      })),
    ],
  });
  try {
    cy.layout({
      ...networkLayout(cy),
      animate: false,
      randomize: true,
      fit: false,
    } as unknown as cytoscape.LayoutOptions).run();
    separateTiles(cy, () => false, DOT_GAP);
    return new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
  } finally {
    cy.destroy();
  }
}

/**
 * One line per pair of entities, whatever passed between them, as the
 * explorer merges them.
 *
 * Money both ways arrives as two edges, and money over several cycles as one
 * edge per cycle. The largest stands for the rest, and the line is political
 * if any of them is.
 */
function pairUp(edges: GraphEdge[], kinds: Map<string, GraphNode>) {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()].map((group) => {
    group.sort(
      (x, y) => (Number(y.amount) || 0) - (Number(x.amount) || 0) || (x.id < y.id ? -1 : 1),
    );
    const political = group.some((e) => edgeTone(kinds.get(e.target)) === 'political');
    return { lead: group[0], tone: political ? ('political' as const) : ('vendor' as const) };
  });
}

function place(
  seed: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
  positions: Map<string, Point>,
  truncated: boolean,
): Scene {
  const at = (id: string) => positions.get(id) ?? { x: 0, y: 0 };

  // The zoom: the explorer's framing zoom, or closer for a crowded graph,
  // within MAX_SIDE. Names stop growing at zoom 1, so in graph units a name is
  // at most NAME long per unit of its width. Counting it so leaves room for it.
  let gx1 = Infinity;
  let gy1 = Infinity;
  let gx2 = -Infinity;
  let gy2 = -Infinity;
  let area = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const n of nodes) {
    const p = at(n.id);
    const name = n.id === seed.id ? 0 : DOT + textWidth(fitLabel(n.name, NAME_MAX)) * NAME;
    gx1 = Math.min(gx1, p.x - DOT);
    gy1 = Math.min(gy1, p.y - NAME);
    gx2 = Math.max(gx2, p.x + DOT + name);
    gy2 = Math.max(gy2, p.y + NAME);
    area = {
      x1: Math.min(area.x1, p.x),
      y1: Math.min(area.y1, p.y),
      x2: Math.max(area.x2, p.x),
      y2: Math.max(area.y2, p.y),
    };
  }
  const spread = Math.max((area.x2 - area.x1) * (area.y2 - area.y1), 1);
  const roomy = Math.min(MAX_ZOOM, Math.sqrt((ROOM * nodes.length) / spread));
  const scale = Math.min(Math.max(FIT_ZOOM, roomy), MAX_SIDE / Math.max(gx2 - gx1, gy2 - gy1, 1));

  // Sizes on the picture, by the explorer's rules for its zoom. See
  // `fitToZoom` in `GraphCanvas.tsx`.
  const stroke = Math.min(1.3, Math.max(0.6, Math.sqrt(scale)));
  const font = NAME * Math.min(1, scale);
  const dot = DOT * stroke;
  const gap = 4 * Math.min(1, scale);

  const dots: Dot[] = nodes.map((node) => {
    const p = at(node.id);
    const isSeed = node.id === seed.id;
    return {
      node,
      x: p.x * scale,
      y: p.y * scale,
      seed: isSeed,
      label: isSeed ? '' : fitLabel(node.name, NAME_MAX),
    };
  });
  const seedDot = dots.find((d) => d.seed)!;

  // The card stands to the right of the searched entity, as in the explorer.
  // The explorer moves it left only where it would run off the canvas, and
  // the picture grows to hold it instead.
  const cardW = cardWidth(seed);
  const cardH = cardHeight(seed);
  const reach = dot / 2 + CARD.gap;

  // The frame: every dot, every name and the card.
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const d of dots) {
    const right = d.label ? dot / 2 + gap + textWidth(d.label) * font : dot / 2;
    x1 = Math.min(x1, d.x - dot);
    y1 = Math.min(y1, d.y - Math.max(dot, font));
    x2 = Math.max(x2, d.x + right + dot);
    y2 = Math.max(y2, d.y + Math.max(dot, font));
  }
  x2 = Math.max(x2, seedDot.x + reach + cardW);
  y1 = Math.min(y1, seedDot.y - cardH / 2);
  y2 = Math.max(y2, seedDot.y + cardH / 2);

  const width = Math.max(MIN_WIDTH, Math.ceil(x2 - x1 + 2 * PAD));
  const unit = Math.min(3, Math.max(1, width / DESIGN_WIDTH));
  const header = Math.round(110 * unit);
  const footer = Math.round(64 * unit);
  const height = Math.ceil(header + (y2 - y1) + 2 * PAD + footer);
  const dx = (width - (x2 - x1)) / 2 - x1;
  const dy = header + PAD - y1;
  for (const d of dots) {
    d.x += dx;
    d.y += dy;
  }

  // Lines bow around dots in graph units, as the explorer works them out.
  const byId = new Map(dots.map((d) => [d.node.id, d]));
  const kinds = new Map(nodes.map((n) => [n.id, n]));
  const obstacles = nodes.map((n) => ({ id: n.id, p: at(n.id) }));
  const lines: Line[] = [];
  for (const { lead, tone } of pairUp(edges, kinds)) {
    const from = byId.get(lead.source);
    const to = byId.get(lead.target);
    if (!from || !to) continue;
    const arc = bowAround(at(lead.source), at(lead.target), lead.source, lead.target, obstacles);
    lines.push({ from, to, tone, arc: arc * scale });
  }
  // Payments to vendors first, so political money is drawn over them.
  lines.sort((a, b) => Number(a.tone === 'political') - Number(b.tone === 'political'));

  return {
    seed,
    width,
    height,
    scale,
    stroke,
    font,
    dot,
    unit,
    header,
    dots,
    lines,
    density: lineDensity(lines.length),
    truncated,
  };
}

/** The searched entity's money in and out, as its card writes them. */
export function cardMoney(node: GraphNode): { received: number; given: number } {
  return { received: Number(node.totalReceived) || 0, given: Number(node.totalGiven) || 0 };
}

/** How many lines the card's name wraps to, at most three. */
function cardNameLines(node: GraphNode): number {
  const room = (CARD.maxWidth - 2 * CARD.padX) / CARD.name;
  return Math.min(3, Math.max(1, Math.ceil(textWidth(node.name) / room)));
}

function cardWidth(node: GraphNode): number {
  const { received, given } = cardMoney(node);
  const name = Math.min(textWidth(node.name) * CARD.name, CARD.maxWidth - 2 * CARD.padX);
  const parts = [
    received > 0 ? `in ${formatMoney(received)}` : '',
    given > 0 ? `out ${formatMoney(given)}` : '',
  ];
  const money = textWidth(parts.join(' ')) * CARD.money + 12;
  return Math.max(name, money) + 2 * CARD.padX;
}

function cardHeight(node: GraphNode): number {
  const { received, given } = cardMoney(node);
  const money = received > 0 || given > 0 ? 4 + CARD.money * 1.4 : 0;
  return cardNameLines(node) * CARD.name * 1.375 + money + 2 * CARD.padY;
}

/* ------------------------------------------------------------------------ */
/* The file                                                                  */
/* ------------------------------------------------------------------------ */

/** Bump when the drawing changes, so pictures drawn the old way are not served. */
export const RENDER_VERSION = 7;

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
