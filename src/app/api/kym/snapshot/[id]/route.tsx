/**
 * A committee's neighborhood as a PNG, for a post or a printout.
 *
 * `GET /api/kym/snapshot/:id?cycle=` draws what the explorer opens on for
 * this committee: two hops, money in and out, every entity the crawl reaches.
 * The scene comes from `src/lib/kym/snapshot.ts`; this file only paints it,
 * in the explorer's network look, so a saved picture and the live graph read
 * as the same thing.
 *
 * Painted with `next/og`, which rasterizes a handful of flex boxes with a
 * bundled font, so nothing has to be added to the serving image. Dots and
 * lines are SVG, and the names are text laid between them: over the dots and
 * under the lines, as the explorer stacks them. The searched entity is drawn
 * over the lines, with its card beside it.
 *
 * Public, like the rest of `/kym`. Every picture is cached on disk under a
 * name that changes when the data does, so a shared link stays cheap however
 * often it is opened.
 */

import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { db } from '@/db';
import { committeeById, committeeSlug } from '@/lib/graph/committee';
import { controlPoint, type Point } from '@/lib/graph/layout';
import {
  NETWORK_GROUND as GROUND,
  ORGANIZATION_FILL,
  POLITICAL_LINE,
  VENDOR_LINE,
  formatMoney,
  kindColor,
} from '@/lib/graph/types';
import {
  CARD,
  buildScene,
  cachedSnapshot,
  cardMoney,
  snapshotKey,
  type Dot,
  type Line,
  type Scene,
} from '@/lib/kym/snapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f-]{36}$/i;
const CYCLE = /^[0-9A-Za-z-]{1,32}$/;

/* The explorer's palette. See the network look's style in `GraphCanvas.tsx`. */
const MUTED = '#94a3b8';
const FAINT = '#64748b';
/** A name beside a dot: slate-300, faint, as the lit network draws it. */
const NAME_INK = 'rgba(203, 213, 225, 0.55)';
/** The ring on the selected entity. */
const RING = '#f8fafc';

/**
 * How the explorer draws each kind of line with the searched entity's
 * network lit: width in pixels at zoom 1, and opacity before a crowded graph
 * thins it.
 */
const STROKE = {
  political: { color: POLITICAL_LINE, width: 1.1, opacity: 0.8 },
  vendor: { color: VENDOR_LINE, width: 0.9, opacity: 0.45 },
} as const;

/** `#6366f1` at some opacity, in the form the rasterizer is sure to read. */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const f1 = (n: number) => n.toFixed(1);

/** `from` moved `by` toward `to`. */
function toward(from: Point, to: Point, by: number): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / len) * by, y: from.y + ((to.y - from.y) / len) * by };
}

/**
 * A line's path, from the edge of one dot to the edge of the other.
 *
 * The explorer ends a line at the dot's border. A bowed line sets off toward
 * its control point, so that is the way it leaves each dot.
 */
function linePath(l: Line, r: number): string | null {
  const a = { x: l.from.x, y: l.from.y };
  const b = { x: l.to.x, y: l.to.y };
  if (Math.hypot(b.x - a.x, b.y - a.y) < 2 * r + 1) return null;
  if (l.arc === 0) {
    const s = toward(a, b, r);
    const e = toward(b, a, r);
    return `M${f1(s.x)},${f1(s.y)} L${f1(e.x)},${f1(e.y)}`;
  }
  const c = controlPoint(a, b, l.arc);
  const s = toward(a, c, r);
  const e = toward(b, c, r);
  return `M${f1(s.x)},${f1(s.y)} Q${f1(c.x)},${f1(c.y)} ${f1(e.x)},${f1(e.y)}`;
}

function svg(scene: Scene, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">${body}</svg>`;
}

/** A dot in its kind's color, ringed in the ground so that touching dots read as two. */
function dotSvg(d: Dot, scene: Scene): string {
  const fill = kindColor(d.node.kind);
  const opacity = d.node.kind === 'organization' ? ORGANIZATION_FILL : 1;
  return `<circle cx="${f1(d.x)}" cy="${f1(d.y)}" r="${f1(scene.dot / 2)}" fill="${fill}" fill-opacity="${opacity}" stroke="${GROUND}" stroke-width="${f1(scene.stroke)}"/>`;
}

/** Every dot but the searched entity's, which goes over the lines. */
function dotsSvg(scene: Scene): string {
  return svg(scene, scene.dots.filter((d) => !d.seed).map((d) => dotSvg(d, scene)).join(''));
}

/** Every line, then the searched entity's dot and its ring over them. */
function linesSvg(scene: Scene): string {
  const r = (scene.dot + scene.stroke) / 2;
  const parts: string[] = [];
  for (const l of scene.lines) {
    const d = linePath(l, r);
    if (!d) continue;
    const s = STROKE[l.tone];
    parts.push(
      `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${(s.width * scene.stroke).toFixed(2)}" stroke-opacity="${(s.opacity * scene.density).toFixed(2)}"/>`,
    );
  }
  const seed = scene.dots.find((d) => d.seed);
  if (seed) {
    const ring = 2 * scene.stroke;
    parts.push(
      dotSvg(seed, scene),
      `<circle cx="${f1(seed.x)}" cy="${f1(seed.y)}" r="${f1(r + 2 * scene.stroke + ring / 2)}" fill="none" stroke="${RING}" stroke-width="${f1(ring)}"/>`,
    );
  }
  return svg(scene, parts.join(''));
}

/** An SVG laid over the whole picture. */
function Layer({ scene, markup }: { scene: Scene; markup: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- painted into a PNG, not served to a browser
    <img
      src={`data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`}
      width={scene.width}
      height={scene.height}
      style={{ position: 'absolute', left: 0, top: 0 }}
      alt=""
    />
  );
}

/** A dot's name, beside it on the right, level with it. */
function Name({ dot, scene }: { dot: Dot; scene: Scene }) {
  const h = scene.font * 1.2;
  return (
    <div
      style={{
        position: 'absolute',
        left: dot.x + scene.dot / 2 + 4 * Math.min(1, scene.scale),
        top: dot.y - h / 2,
        height: h,
        display: 'flex',
        alignItems: 'center',
        fontSize: scene.font,
        lineHeight: 1.2,
        color: NAME_INK,
        whiteSpace: 'nowrap',
      }}
    >
      {dot.label}
    </div>
  );
}

/**
 * The searched entity's name and money, on a card beside its dot, as the
 * explorer draws it.
 *
 * The card is set in a tall band centered on the dot, so it is centered on
 * the dot without knowing its own height.
 */
function SeedCard({ scene }: { scene: Scene }) {
  const seed = scene.dots.find((d) => d.seed);
  if (!seed) return null;
  const { received, given } = cardMoney(seed.node);
  const reach = (scene.dot + scene.stroke) / 2 + CARD.gap;
  const band = 400;
  return (
    <div
      style={{
        position: 'absolute',
        top: seed.y - band / 2,
        height: band,
        display: 'flex',
        alignItems: 'center',
        left: seed.x + reach,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxWidth: CARD.maxWidth,
          padding: `${CARD.padY}px ${CARD.padX}px`,
          borderRadius: 8,
          border: '1px solid rgba(51, 65, 85, 0.7)',
          backgroundColor: 'rgba(15, 23, 42, 0.8)',
          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)',
        }}
      >
        <div style={{ display: 'flex', fontSize: CARD.name, lineHeight: 1.375, color: '#f1f5f9' }}>
          {seed.node.name}
        </div>
        {(received > 0 || given > 0) && (
          <div style={{ display: 'flex', marginTop: 4, gap: 12, fontSize: CARD.money }}>
            {received > 0 && <div style={{ display: 'flex', color: '#34d399' }}>{`in ${formatMoney(received)}`}</div>}
            {given > 0 && <div style={{ display: 'flex', color: '#fbbf24' }}>{`out ${formatMoney(given)}`}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const KIND_NAMES: Record<string, string> = {
  committee: 'Committee / PAC',
  candidate: 'Candidate',
  party: 'Party',
  organization: 'Organization',
  individual: 'Individual',
};

/** The two kinds of line, as the explorer's legend draws them. */
const LINE_KEY = [
  { label: 'Political money', color: POLITICAL_LINE, opacity: 0.75, tone: 'political' },
  { label: 'Paid to vendors', color: VENDOR_LINE, opacity: 0.45, tone: 'vendor' },
] as const;

function Picture({ scene, scope, site }: { scene: Scene; scope: string; site: string }) {
  const u = scene.unit;
  const kinds = [...new Set(scene.dots.map((d) => d.node.kind))].filter((k) => KIND_NAMES[k]);
  const tones = new Set(scene.lines.map((l) => l.tone));
  const count = scene.dots.length - 1;
  const seed = scene.dots.find((d) => d.seed);
  const coverage =
    count === 0
      ? 'no direct links on file'
      : scene.truncated
        ? `${count} entities, stopped at the explorer's ceiling`
        : `${count} ${count === 1 ? 'entity' : 'entities'}`;

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

      <Layer scene={scene} markup={dotsSvg(scene)} />
      {scene.font >= 6 &&
        scene.dots.filter((d) => d.label).map((d) => <Name key={d.node.id} dot={d} scene={scene} />)}
      <Layer scene={scene} markup={linesSvg(scene)} />
      <SeedCard scene={scene} />

      {count === 0 && seed && (
        <div
          style={{
            position: 'absolute',
            left: 40 * u,
            right: 40 * u,
            top: seed.y + 60,
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
                  width: 9 * u,
                  height: 9 * u,
                  borderRadius: 5 * u,
                  backgroundColor: rgba(kindColor(k), k === 'organization' ? ORGANIZATION_FILL : 1),
                }}
              />
              <div style={{ display: 'flex' }}>{KIND_NAMES[k]}</div>
            </div>
          ))}
          {LINE_KEY.filter((l) => tones.has(l.tone)).map((l) => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 * u }}>
              <div
                style={{
                  width: 20 * u,
                  height: Math.max(1, 1.5 * u),
                  backgroundColor: rgba(l.color, l.opacity),
                }}
              />
              <div style={{ display: 'flex' }}>{l.label}</div>
            </div>
          ))}
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
