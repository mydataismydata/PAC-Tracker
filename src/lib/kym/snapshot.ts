/**
 * The picture of who a committee moves money with, two hops out, and the
 * file that holds it once drawn.
 *
 * The graph explorer draws the same neighborhood live, with a force layout
 * and a reader who can pan. A picture has neither, so it has to choose. It
 * keeps the twelve counterparties that moved the most money with the subject,
 * and around each of those the three that moved the most with them, thirty in
 * all. Everything it drops is counted and said in the caption, so a picture of
 * twelve never passes for a picture of a hundred.
 *
 * Direct links only. Following individual donors and vendors would put a
 * thousand tiles on the page, and the chain of committees is what a mailer's
 * recipient is trying to see.
 *
 * ## Layout
 *
 * Concentric, by hop. The subject sits in the middle, its counterparties on a
 * ring around it, and theirs on a ring outside that. The rings are sized from
 * the counts so tiles never overlap: a ring holds as many tiles as its
 * circumference has room for, and the outer one alternates between two radii
 * so it can hold twice as many. Each outer tile sits in the sector of the
 * inner tile it belongs to, which keeps the picture readable as a tree even
 * where the money runs sideways as well.
 *
 * ## Caching
 *
 * A picture costs a dozen queries and two seconds of drawing, and it is
 * 100–400KB. Holding a week of those in memory on a small box is the thing to
 * avoid, so they go to the disk store in `src/lib/cache/disk.ts`, which
 * survives a restart of the container, capped by age and by total size. The
 * name of the file carries the same data stamp the trace cache uses, so a
 * correction landing makes every old picture unreachable rather than merely
 * old; the sweep then removes them by age.
 */

import { createHash } from 'node:crypto';
import type { db as Database } from '@/db';
import * as disk from '@/lib/cache/disk';
import { crawlAll, type GraphEdge, type GraphNode } from '@/lib/graph/crawl';
import { dataStamp } from '@/lib/graph/traceCache';

type Db = typeof Database;

/** Direct counterparties drawn around the subject, most money first. */
export const RING_ONE = 12;
/** Counterparties drawn around each of those. */
export const RING_TWO_EACH = 3;
/** The outer ring as a whole. */
export const RING_TWO = 30;

/**
 * Neighbors asked for before ranking. Far above the caps, so that the twelve
 * drawn are the twelve largest rather than the first twelve found.
 */
const FETCH_PER_NODE = 200;

/** Tile geometry, matching the explorer's so the two read as the same thing. */
export const SEED_TILE = { w: 194, h: 70 };
export const TILE = { w: 168, h: 58 };
export const SMALL_TILE = { w: 136, h: 48 };

/** Clear space between neighboring tiles on a ring. */
const GAP = 24;
/** The outer ring's second radius, far enough out that a wide tile clears one beside it. */
const STAGGER = SMALL_TILE.w + 20;
/** Least distance between the two rings. */
const RING_GAP = 240;

const HEADER = 110;
const FOOTER = 64;
const MARGIN = 40;

export interface Tile {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  ring: 0 | 1 | 2;
}

export interface Line {
  edge: GraphEdge;
  from: Tile;
  to: Tile;
  /** Stroke width, on the same log scale the explorer uses. */
  width: number;
  /** Whether the amount is written on the line. Only the subject's own edges are. */
  labeled: boolean;
}

export interface Scene {
  seed: GraphNode;
  width: number;
  height: number;
  tiles: Tile[];
  lines: Line[];
  /** Direct counterparties the subject has in this period, drawn or not. */
  directCount: number;
  /** How many of them were drawn. */
  drawn: number;
}

/** Trim a name to what two lines of a tile will hold. */
export function fitLabel(name: string, max: number): string {
  const clean = name.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function amountOf(e: GraphEdge): number {
  const n = Number(e.amount);
  return Number.isFinite(n) ? n : 0;
}

function other(e: GraphEdge, id: string): string {
  return e.source === id ? e.target : e.source;
}

/**
 * The subject's neighborhood, chosen and placed.
 *
 * Two rounds of queries. The first is one hop from the subject with a high
 * cap, which is what ranks the counterparties. The second is one hop from
 * each counterparty kept, run together; it finds the outer ring and, as a
 * side effect, every payment between two inner-ring tiles, which is drawn
 * as well because money running around a hub is the pattern worth seeing.
 *
 * Null when the id names nothing.
 */
export async function buildScene(db: Db, seedId: string, cycle?: string): Promise<Scene | null> {
  const hop = (id: string) =>
    crawlAll(db, {
      seedEntityId: id,
      depth: 1,
      direction: 'both',
      linkMode: 'direct',
      cycle,
      maxPerNode: FETCH_PER_NODE,
      maxNodes: FETCH_PER_NODE * 2 + 1,
    });

  const first = await hop(seedId);
  const seed = first.nodes.find((n) => n.id === seedId);
  if (!seed) return null;

  // Rank counterparties by everything that moved between them and the
  // subject, both ways, so a committee that gave $50K and got $40K back
  // outranks one that only gave $60K. Both are real, but the round trip is
  // the one a reader should see first.
  const byNode = new Map<string, { node: GraphNode; amount: number }>();
  for (const n of first.nodes) if (n.id !== seedId) byNode.set(n.id, { node: n, amount: 0 });
  for (const e of first.edges) {
    const held = byNode.get(other(e, seedId));
    if (held) held.amount += amountOf(e);
  }
  const ringOne = [...byNode.values()].sort((a, b) => b.amount - a.amount).slice(0, RING_ONE);
  const inner = new Set(ringOne.map((r) => r.node.id));

  const second = await Promise.all(ringOne.map((r) => hop(r.node.id)));

  // Outer candidates, each under the inner tile it moved the most with.
  const outer = new Map<string, { node: GraphNode; parent: string; amount: number }>();
  const edges = new Map<string, GraphEdge>();
  for (const e of first.edges) edges.set(e.id, e);

  second.forEach((hopResult, i) => {
    const parent = ringOne[i].node.id;
    const nodes = new Map(hopResult.nodes.map((n) => [n.id, n]));
    for (const e of hopResult.edges) {
      const id = other(e, parent);
      if (id === seedId) continue;
      // A payment between two inner tiles: keep the edge, place no new tile.
      if (inner.has(id)) {
        edges.set(e.id, e);
        continue;
      }
      // A direct counterparty that missed the cut stays out. Drawn as some
      // other tile's neighbor it would read as two hops away, and it is one.
      if (byNode.has(id)) continue;
      const node = nodes.get(id);
      if (!node) continue;
      const amount = amountOf(e);
      const held = outer.get(id);
      if (!held) outer.set(id, { node, parent, amount });
      else if (amount > held.amount) {
        held.parent = parent;
        held.amount = amount;
      }
    }
  });

  // Three per parent, then the thirty largest of those.
  const perParent = new Map<string, number>();
  const ringTwo = [...outer.values()]
    .sort((a, b) => b.amount - a.amount)
    .filter((c) => {
      const n = perParent.get(c.parent) ?? 0;
      if (n >= RING_TWO_EACH) return false;
      perParent.set(c.parent, n + 1);
      return true;
    })
    .slice(0, RING_TWO);
  // An outer tile is joined to its parent and to nothing else. The full set
  // of links among thirty outer tiles is real, and it is also the hairball
  // the explorer exists to untangle; a still picture cannot, so it draws the
  // tree and the loops among the inner ring, and leaves the rest to the
  // explorer.
  const parentOf = new Map(ringTwo.map((c) => [c.node.id, c.parent]));
  for (const hopResult of second) {
    for (const e of hopResult.edges) {
      const child = parentOf.get(e.source) ?? parentOf.get(e.target);
      if (!child) continue;
      const parent = parentOf.has(e.source) ? e.target : e.source;
      if (child === parent) edges.set(e.id, e);
    }
  }

  return place(seed, ringOne, ringTwo, [...edges.values()], byNode.size);
}

function place(
  seed: GraphNode,
  ringOne: { node: GraphNode; amount: number }[],
  ringTwo: { node: GraphNode; parent: string; amount: number }[],
  edges: GraphEdge[],
  directCount: number,
): Scene {
  const n1 = ringOne.length;
  const r1 = Math.max(320, (n1 * (TILE.w + GAP)) / (2 * Math.PI));

  const children = new Map<string, typeof ringTwo>();
  for (const c of ringTwo) {
    const held = children.get(c.parent);
    if (held) held.push(c);
    else children.set(c.parent, [c]);
  }
  for (const list of children.values()) list.sort((a, b) => b.amount - a.amount);

  // The outer ring alternates radii, so tiles two apart share one and the
  // angular step between neighbors need only hold half a tile.
  const hasOuter = ringTwo.length > 0;
  const r2 = hasOuter
    ? Math.max(r1 + RING_GAP, (n1 * RING_TWO_EACH * (SMALL_TILE.w + GAP)) / (4 * Math.PI))
    : 0;
  const step = hasOuter ? (SMALL_TILE.w + GAP) / (2 * r2) : 0;

  const reachX = hasOuter ? r2 + STAGGER + SMALL_TILE.w / 2 : r1 + TILE.w / 2;
  const reachY = hasOuter ? r2 + STAGGER + SMALL_TILE.h / 2 : r1 + TILE.h / 2;
  const width = Math.ceil(2 * (Math.max(reachX, 420) + MARGIN));
  const height = Math.ceil(HEADER + 2 * (reachY + MARGIN) + FOOTER);
  const cx = width / 2;
  const cy = HEADER + MARGIN + reachY;

  const tiles: Tile[] = [{ node: seed, x: cx, y: cy, ...SEED_TILE, ring: 0 }];
  const at = new Map<string, Tile>([[seed.id, tiles[0]]]);

  let outerIndex = 0;
  ringOne.forEach((r, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n1;
    const tile: Tile = {
      node: r.node,
      x: cx + Math.cos(angle) * r1,
      y: cy + Math.sin(angle) * r1,
      ...TILE,
      ring: 1,
    };
    tiles.push(tile);
    at.set(r.node.id, tile);

    const kids = children.get(r.node.id) ?? [];
    kids.forEach((c, j) => {
      const a = angle + (j - (kids.length - 1) / 2) * step;
      const radius = r2 + (outerIndex % 2) * STAGGER;
      outerIndex += 1;
      const t: Tile = {
        node: c.node,
        x: cx + Math.cos(a) * radius,
        y: cy + Math.sin(a) * radius,
        ...SMALL_TILE,
        ring: 2,
      };
      tiles.push(t);
      at.set(c.node.id, t);
    });
  });

  const maxAmount = edges.reduce((m, e) => Math.max(m, amountOf(e)), 0);
  const lines: Line[] = [];
  for (const e of edges) {
    const from = at.get(e.source);
    const to = at.get(e.target);
    if (!from || !to || from === to) continue;
    const amount = amountOf(e);
    // Log scale, as on the canvas: amounts span five orders of magnitude.
    const width = 1.5 + (Math.log10(amount + 1) / Math.log10(maxAmount + 1)) * 6.5;
    lines.push({
      edge: e,
      from,
      to,
      width: Number.isFinite(width) ? width : 1.5,
      labeled: from.ring === 0 || to.ring === 0,
    });
  }
  // Heavier lines last, so the money that matters is drawn over the rest.
  lines.sort((a, b) => a.width - b.width);

  return { seed, width, height, tiles, lines, directCount, drawn: n1 };
}

/* ------------------------------------------------------------------------ */
/* The file                                                                  */
/* ------------------------------------------------------------------------ */

/** Bump when the drawing changes, so pictures drawn the old way are not served. */
export const RENDER_VERSION = 4;

/** How long a picture stands once the filings behind it stop moving. */
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Disk the pictures may take, all together. At 100–400KB each, this is hundreds of them. */
export const MAX_BYTES = 256 * 1024 * 1024;
/** Pictures drawn at once. Each render holds a canvas of a few megapixels while it works. */
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
