/**
 * Everything one entity has received and given — straight from the database.
 *
 * A thin wrapper over `src/lib/graph/ledger.ts`, which works over a *set* of
 * committees; an entity is the set of size one. The officer route passes many.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { ledger } from '@/lib/graph/ledger';

export const dynamic = 'force-dynamic';

export type { LedgerSourceRow, LedgerTransactionRow } from '@/lib/graph/ledger';

export const ledgerQuerySchema = z.object({
  view: z.enum(['sources', 'transactions']).default('sources'),
  /** in = money received, out = money sent, all = both. */
  direction: z.enum(['in', 'out', 'all']).default('in'),
  q: z.string().max(120).optional(),
  sort: z.enum(['amount', 'date', 'name', 'count']).default('amount'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  minAmount: z.coerce.number().min(0).optional(),
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

  const parsed = ledgerQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: 'invalid query', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return Response.json(await ledger(db, [id], parsed.data));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
