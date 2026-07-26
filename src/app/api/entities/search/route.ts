/**
 * Entity search for the seed picker.
 *
 * Ranks by trigram similarity but boosts traversable, well-connected nodes:
 * someone typing "florida chamber" wants the PAC that moves millions, not a
 * private individual who happens to share a substring.
 */

import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { normalizeName } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  traversableOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export interface EntitySearchHit extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  status: string;
  city: string | null;
  state_code: string | null;
  total_received: string;
  total_given: string;
  in_degree: number;
  out_degree: number;
  is_traversable: boolean;
  score: number;
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: 'invalid query' }, { status: 400 });
  }
  const { q, limit, traversableOnly } = parsed.data;
  const needle = normalizeName(q);

  const rows = await db.execute<EntitySearchHit>(sql`
    SELECT e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.city, e.state_code,
           e.total_received::text AS total_received,
           e.total_given::text    AS total_given,
           e.in_degree, e.out_degree, e.is_traversable,
           (
             similarity(e.normalized_name, ${needle})
             -- Prefix hits are what people actually mean when they type.
             + CASE WHEN e.normalized_name LIKE ${needle + '%'} THEN 0.35 ELSE 0 END
             -- Prefer nodes the crawler can actually expand.
             + CASE WHEN e.is_traversable THEN 0.15 ELSE 0 END
             -- Gently favour nodes with real money behind them.
             + LEAST(COALESCE(e.total_received, 0) / 5000000.0, 0.15)
           )::real AS score
      FROM entities e
     WHERE (e.normalized_name % ${needle} OR e.normalized_name LIKE ${'%' + needle + '%'})
       ${traversableOnly ? sql`AND e.is_traversable` : sql``}
     ORDER BY score DESC, e.total_received DESC
     LIMIT ${limit}
  `);

  return Response.json({ results: rows });
}
