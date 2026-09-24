/**
 * A committee's neighborhood as a PNG, for a post or a printout.
 *
 * `GET /api/kym/snapshot/:id?cycle=` draws what the explorer opens on for
 * this committee: two hops, money in and out, every entity the crawl reaches.
 * The scene comes from `src/lib/kym/snapshot.ts`; this file only paints it,
 * in the explorer's colors, so a saved picture and the live graph read as the
 * same thing.
 *
 * Painted with `next/og`, which lays the tiles out from a handful of flex
 * boxes and rasterizes them with a bundled font, so nothing has to be added
 * to the serving image. The lines are one SVG underneath the tiles.
 *
 * Public, like the rest of `/kym`. Every picture is cached on disk under a
 * name that changes when the data does, so a shared link stays cheap however
 * often it is opened.
 */

import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { db } from '@/db';
import { committeeById, committeeSlug } from '@/lib/graph/committee';
import { formatMoney, kindColor } from '@/lib/graph/types';
import {
  buildScene,
  cachedSnapshot,
  fitLabel,
  snapshotKey,
  type Line,
  type Scene,
  type Tile,
} from '@/lib/kym/snapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f-]{36}$/i;
const CYCLE = /^[0-9A-Za-z-]{1,32}$/;

/* The explorer's palette. See the Cytoscape style in `GraphCanvas.tsx`. */
const GROUND = '#0f172a';
const INK = '#e2e8f0';
const MUTED = '#94a3b8';
const FAINT = '#64748b';
const SEED_BORDER = '#f8fafc';
/** A direct link: both ends move money. */
const LINK = '#818cf8';
/** Any other line, and its arrowhead. */
const LINE = '#475569';
const ARROW = '#64748b';

/** `#6366f1` at some opacity, in the form the rasterizer is sure to read. */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Where a line leaves a tile, heading toward a point.
 *
 * The explorer ends every line on the tile's border, with the arrowhead
 * touching it. A curved line leaves toward its control point, so that is the
 * point it heads for.
 */
function borderPoint(tile: Tile, toward: Point): Point {
  const dx = toward.x - tile.x;
  const dy = toward.y - tile.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const t = Math.min(
    Math.abs(ux) > 1e-6 ? tile.w / 2 / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-6 ? tile.h / 2 / Math.abs(uy) : Infinity,
  );
  return { x: tile.x + ux * t, y: tile.y + uy * t };
}

/**
 * A line's path: both ends on a border, and the point it bows toward.
 *
 * The bow is measured to the left of travel from the lower id to the higher,
 * whichever way the money ran. That is what puts A-to-B and B-to-A on
 * opposite sides of the pair instead of on top of each other.
 */
function geometry(l: Line): { a: Point; b: Point; c: Point } {
  const [lo, hi] = l.edge.source < l.edge.target ? [l.from, l.to] : [l.to, l.from];
  const dx = hi.x - lo.x;
  const dy = hi.y - lo.y;
  const len = Math.hypot(dx, dy) || 1;
  const c = {
    x: (l.from.x + l.to.x) / 2 + (-dy / len) * l.bend,
    y: (l.from.y + l.to.y) / 2 + (dx / len) * l.bend,
  };
  return { a: borderPoint(l.from, c), b: borderPoint(l.to, c), c };
}

/**
 * Arrowhead length, as Cytoscape sizes a triangle at the explorer's 0.9 scale.
 *
 * Cytoscape draws a head `max((width x 13.37)^0.9, 29)` across its unit
 * square, and the triangle is 0.3 of that long and wide.
 */
function headLength(width: number, scale: number): number {
  return 0.3 * 0.9 * Math.max(Math.pow((width / scale) * 13.37, 0.9), 29) * scale;
}

const f1 = (n: number) => n.toFixed(1);

/** Every line and arrowhead, as one SVG the tiles are laid over. */
function linesSvg(scene: Scene): string {
  const parts: string[] = [];
  for (const l of scene.lines) {
    const { a, b, c } = geometry(l);
    // The head points along the curve where it arrives, which is from the
    // control point to the end.
    const tx = b.x - c.x;
    const ty = b.y - c.y;
    const tlen = Math.hypot(tx, ty);
    if (tlen < 1 || Math.hypot(b.x - a.x, b.y - a.y) < 4) continue;
    const ux = tx / tlen;
    const uy = ty / tlen;
    const head = headLength(l.width, scene.scale);
    const half = head / 2;
    // Stop the shaft at the base of the head, so the head is not painted over.
    const sx = b.x - ux * head;
    const sy = b.y - uy * head;
    const stroke = l.direct ? LINK : LINE;
    const fill = l.direct ? LINK : ARROW;
    const opacity = l.direct ? 0.75 : 0.55;
    const d =
      l.bend === 0
        ? `M${f1(a.x)},${f1(a.y)} L${f1(sx)},${f1(sy)}`
        : `M${f1(a.x)},${f1(a.y)} Q${f1(c.x)},${f1(c.y)} ${f1(sx)},${f1(sy)}`;
    parts.push(
      `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${l.width.toFixed(2)}" stroke-opacity="${opacity}"/>`,
      `<polygon points="${f1(b.x)},${f1(b.y)} ${f1(sx - uy * half)},${f1(sy + ux * half)} ${f1(sx + uy * half)},${f1(sy - ux * half)}" fill="${fill}" fill-opacity="${opacity}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">${parts.join('')}</svg>`;
}

/**
 * Rough width of a string in Geist, in multiples of the font size.
 *
 * Capitals and digits run wider than lower case. Counting characters alone
 * let an all-capitals vendor name run past the edge of its tile.
 */
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += ch === ' ' ? 0.28 : /[A-Z0-9$@&%#MW]/.test(ch) ? 0.66 : /[il.,:;'!|]/.test(ch) ? 0.3 : 0.54;
  }
  return w;
}

/** Cut a line to a width, with a mark where it was cut. */
function fitWidth(line: string, room: number): string {
  if (textWidth(line) <= room) return line;
  let cut = line;
  while (cut.length > 1 && textWidth(`${cut}…`) > room) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * A name on at most two lines, broken by hand.
 *
 * The rasterizer wraps text, and it also clips a third line without a mark.
 * "Florida House Republican Campaign" came out as "Florida House Republican"
 * and read as a complete name. Breaking the lines here means the cut always
 * shows, and the width estimate only has to be conservative, since a line
 * that comes up short leaves a little slack rather than spilling.
 */
function wrapName(name: string, width: number, fontSize: number): string[] {
  const room = width / fontSize;
  const words = name.trim().split(/\s+/);
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < 2) {
    let line = words[i++];
    while (i < words.length && textWidth(`${line} ${words[i]}`) <= room) line += ` ${words[i++]}`;
    lines.push(line);
  }
  // Words left over mean the name was cut, and the cut has to show.
  if (i < words.length) lines[lines.length - 1] += '…';
  return lines.map((l) => fitWidth(l, room));
}

/** "in $1.2M · out $450K", or whichever half there is. */
function moneyLine(node: Tile['node']): string {
  const received = Number(node.totalReceived);
  const given = Number(node.totalGiven);
  return received > 0 && given > 0
    ? `in ${formatMoney(received)} · out ${formatMoney(given)}`
    : received > 0
      ? `in ${formatMoney(received)}`
      : given > 0
        ? `out ${formatMoney(given)}`
        : '';
}

/** One tile, styled as the explorer styles it. */
function TileBox({ tile, scale }: { tile: Tile; scale: number }) {
  const { node, seed } = tile;
  const color = kindColor(node.kind);
  const fontSize = (seed ? 11 : 10) * scale;
  const money = moneyLine(node);

  return (
    <div
      style={{
        position: 'absolute',
        left: tile.x - tile.w / 2,
        top: tile.y - tile.h / 2,
        width: tile.w,
        height: tile.h,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // No overflow clip. On a rounded box the rasterizer masks each tile
        // separately, and two hundred masks took half a minute to draw. The
        // name is broken to fit by hand, so there is nothing to clip.
        padding: `${2 * scale}px ${8 * scale}px`,
        borderRadius: 8 * scale,
        // The shorthand. The rasterizer draws a dash only when it is given here.
        border: `${(seed ? 3 : 1.5) * scale}px ${tile.hasMore && !seed ? 'dashed' : 'solid'} ${seed ? SEED_BORDER : color}`,
        // Opaque, the ground mixed with the kind's color, so a line passing
        // under a tile does not show through it.
        backgroundColor: mix(color, seed ? 0.32 : 0.16),
        color: INK,
        fontSize,
        lineHeight: 1.3,
        textAlign: 'center',
      }}
    >
      {wrapName(fitLabel(node.name, 38), tile.w - 16 * scale, fontSize).map((text, i) => (
        <div key={i} style={{ display: 'flex', whiteSpace: 'nowrap' }}>
          {text}
        </div>
      ))}
      {money && (
        <div style={{ display: 'flex', whiteSpace: 'nowrap' }}>
          {fitWidth(money, (tile.w - 16 * scale) / fontSize)}
        </div>
      )}
    </div>
  );
}

/** A kind's color laid over the ground at some strength, as one opaque color. */
function mix(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const g = parseInt(GROUND.slice(1), 16);
  const ch = (shift: number) =>
    Math.round(((n >> shift) & 255) * alpha + ((g >> shift) & 255) * (1 - alpha));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/**
 * The amount, at the middle of its line, turned to run along it.
 *
 * The explorer labels every line and keeps the text upright, so a line
 * running right to left still reads left to right.
 */
function LineLabel({ line, scale }: { line: Line; scale: number }) {
  const text = formatMoney(Number(line.edge.amount));
  const fontSize = 9 * scale;
  const pad = 2 * scale;
  const w = text.length * fontSize * 0.6 + 2 * pad;
  const h = fontSize * 1.25 + 2 * pad;
  const { a, b, c } = geometry(line);
  // The middle of a quadratic curve, and the direction it runs there.
  const x = 0.25 * a.x + 0.5 * c.x + 0.25 * b.x;
  const y = 0.25 * a.y + 0.5 * c.y + 0.25 * b.y;
  let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle < -90) angle += 180;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - w / 2,
        top: y - h / 2,
        width: w,
        height: h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `rotate(${angle.toFixed(1)}deg)`,
        backgroundColor: rgba(GROUND, 0.85),
        color: MUTED,
        fontSize,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

const KIND_NAMES: Record<string, string> = {
  committee: 'Committee',
  candidate: 'Candidate',
  party: 'Party',
  organization: 'Organization',
  individual: 'Individual',
};

function Picture({ scene, scope, site }: { scene: Scene; scope: string; site: string }) {
  const u = scene.unit;
  const kinds = [...new Set(scene.tiles.map((t) => t.node.kind))].filter((k) => KIND_NAMES[k]);
  const count = scene.tiles.length - 1;
  const coverage =
    count === 0
      ? 'no direct links on file'
      : scene.truncated
        ? `${count} entities, stopped at the explorer's ceiling`
        : `${count} ${count === 1 ? 'entity' : 'entities'}`;
  const svg = Buffer.from(linesSvg(scene)).toString('base64');

  return (
    <div
      style={{
        width: scene.width,
        height: scene.height,
        display: 'flex',
        position: 'relative',
        backgroundColor: GROUND,
        fontFamily: 'Geist',
      }}
    >
      {/* Masthead */}
      <div
        style={{
          position: 'absolute',
          left: 40 * u,
          top: 30 * u,
          right: 40 * u,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', maxWidth: scene.width - 380 * u }}>
          <div
            style={{
              display: 'flex',
              fontSize: 30 * u,
              lineHeight: 1.1,
              color: '#f8fafc',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {scene.seed.name}
          </div>
          <div style={{ display: 'flex', marginTop: 8 * u, fontSize: 15 * u, color: MUTED }}>
            {`Money in and out, two hops · ${scope} · ${coverage}`}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', fontSize: 17 * u, color: '#f1f5f9', letterSpacing: 0.5 * u }}>
            Know Your Mailer
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 4 * u,
              fontSize: 11 * u,
              color: FAINT,
              letterSpacing: 1.6 * u,
              textTransform: 'uppercase',
            }}
          >
            Powered by the PAC Tracker database
          </div>
        </div>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element -- painted into a PNG, not served to a browser */}
      <img
        src={`data:image/svg+xml;base64,${svg}`}
        width={scene.width}
        height={scene.height}
        style={{ position: 'absolute', left: 0, top: 0 }}
        alt=""
      />

      {scene.lines.map((l) => (
        <LineLabel key={l.edge.id} line={l} scale={scene.scale} />
      ))}
      {scene.tiles.map((t) => (
        <TileBox key={t.node.id} tile={t} scale={scene.scale} />
      ))}

      {count === 0 && (
        <div
          style={{
            position: 'absolute',
            left: 40 * u,
            right: 40 * u,
            top: scene.tiles[0].y + scene.tiles[0].h / 2 + 22 * u,
            display: 'flex',
            justifyContent: 'center',
            fontSize: 14 * u,
            color: MUTED,
          }}
        >
          No direct link to or from this committee is on file for this period.
        </div>
      )}

      {/* Foot: legend and where this came from */}
      <div
        style={{
          position: 'absolute',
          left: 40 * u,
          right: 40 * u,
          bottom: 26 * u,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12 * u,
          color: FAINT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 * u }}>
          {kinds.map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 * u }}>
              <div
                style={{
                  width: 12 * u,
                  height: 12 * u,
                  borderRadius: 3 * u,
                  border: `${1.5 * u}px solid ${kindColor(k)}`,
                  backgroundColor: rgba(kindColor(k), 0.3),
                }}
              />
              <div style={{ display: 'flex' }}>{KIND_NAMES[k]}</div>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 * u }}>
            <div style={{ width: 22 * u, height: 3 * u, borderRadius: 2 * u, backgroundColor: LINK }} />
            <div style={{ display: 'flex' }}>Arrows point the way the money went</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 * u }}>
            <div
              style={{
                width: 16 * u,
                height: 12 * u,
                borderRadius: 3 * u,
                border: `${1.5 * u}px dashed ${MUTED}`,
              }}
            />
            <div style={{ display: 'flex' }}>Dashed: can be followed further in the explorer</div>
          </div>
        </div>
        <div style={{ display: 'flex' }}>{site}</div>
      </div>
    </div>
  );
}

const CACHE = 'public, max-age=3600, stale-while-revalidate=86400';

/**
 * The address the picture prints along its bottom edge.
 *
 * The drawn image is cached, so the first caller decides what every later
 * reader sees. That caller is usually `ingest warm`, which reaches the app
 * over the Docker network as `app:3000`. A reader who saves the picture then
 * has a hostname that resolves nowhere.
 *
 * `PT_PUBLIC_HOST` settles it where the operator has set one. The fallback
 * drops any host that is a bare container name, because that is the same
 * mistake arriving through the request instead of the environment. A name
 * with no dot is internal unless it is the loopback a local run serves from.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function externalHost(candidate: string | null | undefined): string | null {
  const bare = (candidate ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();
  if (!bare) return null;
  if (LOOPBACK.test(bare)) return bare;
  return bare.split(':')[0].includes('.') ? bare : null;
}

function publicHost(req: NextRequest): string {
  return (
    externalHost(process.env.PT_PUBLIC_HOST) ??
    externalHost(req.headers.get('x-forwarded-host')) ??
    externalHost(req.headers.get('host')) ??
    ''
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: 'invalid id' }, { status: 400 });

  const rawCycle = req.nextUrl.searchParams.get('cycle') || undefined;
  const cycle = rawCycle && CYCLE.test(rawCycle) ? rawCycle : undefined;

  const subject = await committeeById(db, id);
  if (!subject) return Response.json({ error: 'not found' }, { status: 404 });

  const { key, etag } = await snapshotKey(db, id, cycle);
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CACHE } });
  }

  const host = publicHost(req);
  const slug = committeeSlug(subject.name);
  const scope = cycle ? `${cycle.slice(0, 4)} cycle` : 'all cycles on file';

  const png = await cachedSnapshot(key, async () => {
    const scene = await buildScene(db, id, cycle);
    if (!scene) throw new Error('subject vanished between lookup and draw');
    const image = new ImageResponse(
      <Picture scene={scene} scope={scope} site={`${host}/kym/${slug}`} />,
      { width: scene.width, height: scene.height },
    );
    return new Uint8Array(await image.arrayBuffer());
  });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'Content-Disposition': `inline; filename="${slug}${cycle ? `-${cycle.slice(0, 4)}` : ''}.png"`,
      ETag: etag,
      'Cache-Control': CACHE,
    },
  });
}
