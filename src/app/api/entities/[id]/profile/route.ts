/**
 * The corporate / Form 990 profile of an entity, when it is a nonprofit rather
 * than a campaign committee. Feeds the org-details block in the panel.
 */

import { NextRequest } from 'next/server';
import { db } from '@/db';
import { orgProfileForEntity } from '@/lib/graph/orgProfile';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    return Response.json({ profile: await orgProfileForEntity(db, id) });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
