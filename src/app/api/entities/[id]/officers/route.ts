/**
 * Who a committee reports as running it, with how many committees each is
 * named on. Feeds the chair/treasurer line in the panel header.
 */

import { NextRequest } from 'next/server';
import { db } from '@/db';
import { officersForEntity } from '@/lib/graph/officers';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    return Response.json({ officers: await officersForEntity(db, id) });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
