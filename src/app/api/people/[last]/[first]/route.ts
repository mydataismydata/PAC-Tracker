/**
 * One politician's filings, resolved from a name.
 *
 * `/api/people/ingoglia/blaise` → the campaign accounts and the affiliated
 * committee as a single subject, with combined totals. Built for linking in
 * from another application, which will know a sponsor's name but not the
 * internal id of any of their committees.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { resolvePerson } from '@/lib/graph/person';
import { ledger } from '@/lib/graph/ledger';

export const dynamic = 'force-dynamic';

const paramSchema = z.object({
  last: z.string().min(1).max(80),
  first: z.string().min(1).max(80),
});

const querySchema = z.object({
  cycle: z.string().max(32).optional(),
  /** How many counterparties to include per direction. 0 skips the ledger. */
  top: z.coerce.number().int().min(0).max(50).default(10),
});

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ last: string; first: string }> },
) {
  const raw = await ctx.params;
  const parsed = paramSchema.safeParse({
    last: decodeURIComponent(raw.last),
    first: decodeURIComponent(raw.first),
  });
  if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });

  const q = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) return Response.json({ error: 'invalid query' }, { status: 400 });

  try {
    const person = await resolvePerson(db, parsed.data.last, parsed.data.first);
    if (!person) return Response.json({ error: 'no such person' }, { status: 404 });

    if (q.data.top === 0) return Response.json({ person });

    const base = {
      view: 'sources' as const,
      sort: 'amount' as const,
      order: 'desc' as const,
      limit: q.data.top,
      offset: 0,
      cycle: q.data.cycle,
    };
    const [received, given] = await Promise.all([
      ledger(db, person.entityIds, { ...base, direction: 'in' }),
      ledger(db, person.entityIds, { ...base, direction: 'out' }),
    ]);

    return Response.json({ person, received, given });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
