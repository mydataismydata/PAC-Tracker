/**
 * Server-sent-events endpoint for graph expansion.
 *
 * Each BFS level is flushed the moment it is available, so the client renders
 * the seed and its immediate neighbours within a few hundred milliseconds and
 * keeps filling outward while deeper levels are still being queried. That is
 * what makes a deep crawl usable instead of a long blank wait.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { crawl, CRAWL_DEFAULTS } from '@/lib/graph/crawl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({
  seed: z.string().uuid(),
  depth: z.coerce.number().int().min(1).max(6).default(CRAWL_DEFAULTS.depth),
  direction: z.enum(['upstream', 'downstream', 'both']).default(CRAWL_DEFAULTS.direction),
  linkMode: z.enum(['direct', 'donor']).default(CRAWL_DEFAULTS.linkMode),
  minAmount: z.coerce.number().min(0).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxPerNode: z.coerce.number().int().min(1).max(200).default(CRAWL_DEFAULTS.maxPerNode),
  maxNodes: z.coerce.number().int().min(10).max(5000).default(CRAWL_DEFAULTS.maxNodes),
});

export async function GET(req: NextRequest) {
  const parsed = paramsSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid parameters', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const p = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Abort promptly if the user navigates away or changes the query mid-crawl.
      let cancelled = false;
      req.signal.addEventListener('abort', () => {
        cancelled = true;
      });

      const startedAt = Date.now();
      let nodeCount = 0;
      let edgeCount = 0;

      try {
        send('start', { params: p });

        for await (const level of crawl(db, {
          seedEntityId: p.seed,
          depth: p.depth,
          direction: p.direction,
          linkMode: p.linkMode,
          minAmount: p.minAmount,
          dateFrom: p.dateFrom,
          dateTo: p.dateTo,
          maxPerNode: p.maxPerNode,
          maxNodes: p.maxNodes,
        })) {
          if (cancelled) break;
          nodeCount += level.nodes.length;
          edgeCount += level.edges.length;
          send('level', level);
        }

        if (!cancelled) {
          send('done', {
            nodes: nodeCount,
            edges: edgeCount,
            elapsedMs: Date.now() - startedAt,
          });
        }
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Prevents proxies from buffering the stream into one lump.
      'X-Accel-Buffering': 'no',
    },
  });
}
