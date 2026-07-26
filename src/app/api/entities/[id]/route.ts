/** Fetch a single entity, used to rehydrate a shared/deep-linked seed. */

import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import type { EntitySearchHit } from '../search/route';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }

  const rows = await db.execute<EntitySearchHit>(sql`
    SELECT e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.city, e.state_code,
           e.total_received::text AS total_received,
           e.total_given::text    AS total_given,
           e.in_degree, e.out_degree, e.is_traversable, 1::real AS score
      FROM entities e WHERE e.id = ${id}
  `);

  if (rows.length === 0) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ entity: rows[0] });
}
