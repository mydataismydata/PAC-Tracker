/**
 * Where an entity's money actually came from, past the conduits.
 *
 * The ledger answers "who wrote the cheque". For a committee funded by other
 * committees that is not the same question as "who paid for this" — and in the
 * transfer layer it is routinely a different answer. This walks the chain to
 * entities that originate money and attributes the total back to them.
 *
 * See `src/lib/graph/trace.ts` for the method and its limits.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { trace } from '@/lib/graph/trace';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  depth: z.coerce.number().int().min(1).max(20).default(12),
  /** Strands below this are folded into `dispersed` rather than chased. */
  min: z.coerce.number().min(0).default(100),
  /** Only credit money a conduit held before it paid out. */
  dateOrdered: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  cycle: z.string().max(32).optional(),
  /** Inclusive bounds on the transaction date, as the graph filters on. */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: 'invalid query', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { depth, min, dateOrdered, cycle, dateFrom, dateTo } = parsed.data;

  try {
    const result = await trace(db, id, {
      maxDepth: depth,
      minDollars: min,
      dateOrdered,
      cycle,
      dateFrom,
      dateTo,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
