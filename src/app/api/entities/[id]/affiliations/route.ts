/**
 * Who runs this committee, and what else they run.
 *
 * Reads registration filings rather than transactions, so it answers a question
 * the money cannot: two committees with no payment between them can still be
 * one operation. Returns nothing that becomes a graph edge — see
 * `src/lib/graph/affiliations.ts` for why that boundary matters.
 */

import { NextRequest } from 'next/server';
import { db } from '@/db';
import { affiliations } from '@/lib/graph/affiliations';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }

  try {
    const result = await affiliations(db, id);
    if (!result) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
