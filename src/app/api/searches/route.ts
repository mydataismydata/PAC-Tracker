/**
 * Saved searches: persist and list a named crawl configuration.
 *
 * Node positions are stored alongside the parameters so reopening a saved graph
 * restores the layout the user arranged rather than re-running the force
 * simulation into a different shape.
 */

import { NextRequest } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { savedSearches, entities } from '@/db/schema';

export const dynamic = 'force-dynamic';

const crawlParamsSchema = z.object({
  depth: z.number().int().min(1).max(6),
  direction: z.enum(['upstream', 'downstream', 'both']),
  linkMode: z.enum(['direct', 'donor']),
  minAmount: z.number().min(0).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  maxPerNode: z.number().int().min(1).max(200).optional(),
  maxNodes: z.number().int().min(10).max(5000).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  seedEntityId: z.string().uuid(),
  params: crawlParamsSchema,
  nodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});

export async function GET() {
  const rows = await db
    .select({
      id: savedSearches.id,
      name: savedSearches.name,
      description: savedSearches.description,
      seedEntityId: savedSearches.seedEntityId,
      seedName: entities.name,
      seedKind: entities.kind,
      params: savedSearches.params,
      nodePositions: savedSearches.nodePositions,
      createdAt: savedSearches.createdAt,
      updatedAt: savedSearches.updatedAt,
    })
    .from(savedSearches)
    .leftJoin(entities, eq(entities.id, savedSearches.seedEntityId))
    .orderBy(desc(savedSearches.updatedAt))
    .limit(100);

  return Response.json({ searches: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const [row] = await db
    .insert(savedSearches)
    .values({
      name: parsed.data.name,
      description: parsed.data.description,
      seedEntityId: parsed.data.seedEntityId,
      params: parsed.data.params,
      nodePositions: parsed.data.nodePositions ?? null,
    })
    .returning();

  return Response.json({ search: row }, { status: 201 });
}
