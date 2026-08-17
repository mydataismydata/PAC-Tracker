/**
 * Everything the committees naming one person have received and given.
 *
 * The union of their ledgers, aggregated so a donor who gave to six of them is
 * one row. Transfers between committees in the set come back flagged `is_self`
 * and totalled separately — money shuffled inside a network is real, but it did
 * not enter or leave it, and a headline figure that includes it is wrong.
 */

import { NextRequest } from 'next/server';
import { db } from '@/db';
import { ledger } from '@/lib/graph/ledger';
import { officerSubject, parseOfficerKey } from '@/lib/graph/officers';
import { ledgerQuerySchema } from '@/app/api/entities/[id]/ledger/route';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const parts = parseOfficerKey(decodeURIComponent(key));
  if (!parts) return Response.json({ error: 'invalid officer key' }, { status: 400 });

  const parsed = ledgerQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: 'invalid query', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const subject = await officerSubject(db, parts.role, parts.normalizedName, parsed.data.cycle);
    if (!subject) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(await ledger(db, subject.entityIds, parsed.data));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
