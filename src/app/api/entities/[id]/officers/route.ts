/**
 * Who a committee reports as running it, with how many committees each is
 * named on, and where it says it is. Feeds the chair/treasurer line and the
 * address line in the panel header.
 *
 * The address rides here rather than on the node because a crawl carries
 * thousands of nodes and only the open one has a panel.
 */

import { NextRequest } from 'next/server';
import { db } from '@/db';
import { addressForEntity, officersForEntity } from '@/lib/graph/officers';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    const [officers, address] = await Promise.all([
      officersForEntity(db, id),
      addressForEntity(db, id),
    ]);
    return Response.json({ officers, address });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
