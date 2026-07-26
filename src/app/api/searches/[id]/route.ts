/** Update (rename, re-save layout) or delete a single saved search. */

import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { savedSearches } from '@/db/schema';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  nodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const [row] = await db
    .update(savedSearches)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(savedSearches.id, id))
    .returning();

  if (!row) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ search: row });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deleted = await db
    .delete(savedSearches)
    .where(eq(savedSearches.id, id))
    .returning({ id: savedSearches.id });

  if (deleted.length === 0) return Response.json({ error: 'not found' }, { status: 404 });
  return new Response(null, { status: 204 });
}
