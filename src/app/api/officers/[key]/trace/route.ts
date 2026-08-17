/**
 * Where the money behind one person's committees originated.
 *
 * Seeds the trace from every committee naming them at once, each carrying its
 * own receipts. Transfers between those committees resolve themselves: the
 * receiving one's parcel walks up into the sending one, which is where that
 * money came from, so a shuffle inside the network is not credited as an
 * origin.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { trace } from '@/lib/graph/trace';
import { officerSubject, parseOfficerKey } from '@/lib/graph/officers';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  depth: z.coerce.number().int().min(1).max(20).default(12),
  min: z.coerce.number().min(0).default(100),
  dateOrdered: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  cycle: z.string().max(32).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const parts = parseOfficerKey(decodeURIComponent(key));
  if (!parts) return Response.json({ error: 'invalid officer key' }, { status: 400 });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: 'invalid query', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { depth, min, dateOrdered, cycle } = parsed.data;

  try {
    const subject = await officerSubject(db, parts.role, parts.normalizedName, cycle);
    if (!subject) return Response.json({ error: 'not found' }, { status: 404 });
    const result = await trace(db, subject.entityIds, {
      maxDepth: depth,
      minDollars: min,
      dateOrdered,
      cycle,
    });
    // The group's identity is the person, which the trace cannot know.
    return Response.json({
      ...result,
      seed: { ...result.seed, name: subject.name, kind: 'officer' },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
