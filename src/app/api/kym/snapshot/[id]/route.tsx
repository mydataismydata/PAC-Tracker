/**
 * A committee's neighborhood as a PNG, for a post or a printout.
 *
 * `GET /api/kym/snapshot/:id?cycle=` draws the subject, the twelve
 * counterparties that moved the most money with it, and the three that moved
 * the most with each of those. Direct links only: committee to committee,
 * candidate or party. The scene comes from `src/lib/kym/snapshot.ts`; this
 * file only paints it.
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

const GROUND = '#0f172a';
const INK = '#e2e8f0';
const MUTED = '#94a3b8';
const FAINT = '#64748b';
/** The explorer's color for a direct link. */
const LINK = '#818cf8';

/** `#6366f1` at some opacity, in the form the rasterizer is sure to read. */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Where a line leaves a tile.
 *
 * The line runs center to center, but it is drawn from border to border so
 * the arrowhead lands on the tile rather than under it.
 */
function edgePoint(tile: Tile, toward: Tile, pad: number): { x: number; y: number } {
  const dx = toward.x - tile.x;
  const dy = toward.y - tile.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const hw = tile.w / 2 + pad;
  const hh = tile.h / 2 + pad;
  const t = Math.min(
    Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity,
  );
  return { x: tile.x + ux * t, y: tile.y + uy * t };
}

/** Every line and arrowhead, as one SVG the tiles are laid over. */
function linesSvg(scene: Scene): string {
  const parts: string[] = [];
  for (const l of scene.lines) {
    const a = edgePoint(l.from, l.to, 4);
    const b = edgePoint(l.to, l.from, 4);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) continue;
    const ux = dx / len;
    const uy = dy / len;
    const color = l.labeled ? LINK : FAINT;
    const opacity = l.labeled ? 0.8 : 0.6;
    const head = 9 + l.width;
    const half = 3.5 + l.width / 2;
    // Stop the shaft short of the point so the head is not painted over.
    const sx = b.x - ux * head;
    const sy = b.y - uy * head;
    parts.push(
      `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" stroke="${color}" stroke-width="${l.width.toFixed(2)}" stroke-opacity="${opacity}" stroke-linecap="round"/>`,
      `<polygon points="${b.x.toFixed(1)},${b.y.toFixed(1)} ${(sx - uy * half).toFixed(1)},${(sy + ux * half).toFixed(1)} ${(sx + uy * half).toFixed(1)},${(sy - ux * half).toFixed(1)}" fill="${color}" fill-opacity="${opacity}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">${parts.join('')}</svg>`;
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
  const perLine = Math.max(8, Math.floor(width / (fontSize * 0.56)));
  const words = name.trim().split(/\s+/);
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < 2) {
    let line = words[i++];
    while (i < words.length && `${line} ${words[i]}`.length <= perLine) line += ` ${words[i++]}`;
    lines.push(line);
  }
  // Words left over mean the name was cut, and the cut has to show.
  if (i < words.length) lines[lines.length - 1] += '…';
  return lines.map((l) => fitLabel(l, perLine));
}

function TileBox({ tile }: { tile: Tile }) {
  const { node } = tile;
  const color = kindColor(node.kind);
  const seed = tile.ring === 0;
  const small = tile.ring === 2;
  const fontSize = seed ? 15 : small ? 11.5 : 12.5;
  const received = Number(node.totalReceived);
  const given = Number(node.totalGiven);
  const money =
    received > 0 && given > 0
      ? `in ${formatMoney(received)} · out ${formatMoney(given)}`
      : received > 0
        ? `in ${formatMoney(received)}`
        : given > 0
          ? `out ${formatMoney(given)}`
          : '';

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
        overflow: 'hidden',
        padding: small ? '3px 7px' : '4px 9px',
        borderRadius: 8,
        border: `${seed ? 3 : small ? 1.25 : 1.5}px solid ${color}`,
        backgroundColor: rgba(color, seed ? 0.42 : 0.24),
        color: INK,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          fontSize,
          lineHeight: 1.25,
          color: seed ? '#f8fafc' : INK,
        }}
      >
        {wrapName(node.name, tile.w - (small ? 14 : 18), fontSize).map((text, i) => (
          <div key={i} style={{ display: 'flex', whiteSpace: 'nowrap' }}>
            {text}
          </div>
        ))}
      </div>
      {money && (
        <div
          style={{
            display: 'flex',
            marginTop: 2,
            fontSize: small ? 10 : 11,
            lineHeight: 1.2,
            color: seed ? '#e0e7ff' : MUTED,
            whiteSpace: 'nowrap',
          }}
        >
          {money}
        </div>
      )}
    </div>
  );
}

/** The amount, on a pill at the midpoint of one of the subject's own lines. */
function LineLabel({ line }: { line: Line }) {
  const text = formatMoney(Number(line.edge.amount));
  const w = text.length * 7.4 + 18;
  const h = 22;
  // Short of halfway, and off the line to the right of travel. Money going
  // both ways between the same two tiles is two lines on one segment, and
  // their labels would otherwise sit on each other; measured from each
  // line's own start, this puts them a fifth of the length apart and on
  // opposite sides.
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const x = line.from.x + dx * 0.4 + (-dy / len) * 14;
  const y = line.from.y + dy * 0.4 + (dx / len) * 14;
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
        borderRadius: 11,
        border: '1px solid #334155',
        backgroundColor: GROUND,
        color: '#c7d2fe',
        fontSize: 12,
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
  const kinds = [...new Set(scene.tiles.map((t) => t.node.kind))].filter((k) => KIND_NAMES[k]);
  const coverage =
    scene.directCount === 0
      ? 'no committee-to-committee money on file'
      : scene.drawn < scene.directCount
        ? `${scene.drawn} of ${scene.directCount} direct counterparties drawn, largest first`
        : `${scene.directCount} direct counterpart${scene.directCount === 1 ? 'y' : 'ies'}`;
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
          left: 40,
          top: 30,
          right: 40,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', maxWidth: scene.width - 380 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 30,
              lineHeight: 1.1,
              color: '#f8fafc',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {scene.seed.name}
          </div>
          <div style={{ display: 'flex', marginTop: 8, fontSize: 15, color: MUTED }}>
            {`Money to and from other committees, two hops · ${scope} · ${coverage}`}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', fontSize: 17, color: '#f1f5f9', letterSpacing: 0.5 }}>
            Know Your Mailer
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 4,
              fontSize: 11,
              color: FAINT,
              letterSpacing: 1.6,
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

      {scene.lines.filter((l) => l.labeled).map((l) => (
        <LineLabel key={l.edge.id} line={l} />
      ))}
      {scene.tiles.map((t) => (
        <TileBox key={t.node.id} tile={t} />
      ))}

      {scene.directCount === 0 && (
        <div
          style={{
            position: 'absolute',
            left: 40,
            right: 40,
            top: scene.tiles[0].y + scene.tiles[0].h / 2 + 22,
            display: 'flex',
            justifyContent: 'center',
            fontSize: 14,
            color: MUTED,
          }}
        >
          No payment to or from another committee, candidate or party is on file for this period.
        </div>
      )}

      {/* Foot: legend and where this came from */}
      <div
        style={{
          position: 'absolute',
          left: 40,
          right: 40,
          bottom: 26,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          color: FAINT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          {kinds.map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  border: `1.5px solid ${kindColor(k)}`,
                  backgroundColor: rgba(kindColor(k), 0.3),
                }}
              />
              <div style={{ display: 'flex' }}>{KIND_NAMES[k]}</div>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 22, height: 3, borderRadius: 2, backgroundColor: LINK }} />
            <div style={{ display: 'flex' }}>Arrows point the way the money went</div>
          </div>
        </div>
        <div style={{ display: 'flex' }}>{site}</div>
      </div>
    </div>
  );
}

const CACHE = 'public, max-age=3600, stale-while-revalidate=86400';

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

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
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
