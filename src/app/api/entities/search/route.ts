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
  /**
   * Show totals for this cycle rather than for all of them.
   *
   * Matching stays unfiltered — an entity should be findable whichever cycle
   * is selected — but a result reading "$723K in" that becomes a $160K tile
   * the moment it is picked is just a wrong number in the dropdown.
   */
  cycle: z.string().max(32).optional(),
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
  const { q, limit, traversableOnly, cycle } = parsed.data;
  const needle = normalizeName(q);

  // Ranking deliberately still uses lifetime totals: a committee that was huge
  // last cycle should stay easy to find while looking at this one.
  const cycleTotals = cycle
    ? sql`COALESCE(ct.total_received, 0)::text AS total_received,
          COALESCE(ct.total_given, 0)::text    AS total_given,
          COALESCE(ct.in_degree, 0)  AS in_degree,
          COALESCE(ct.out_degree, 0) AS out_degree,`
    : sql`e.total_received::text AS total_received,
          e.total_given::text    AS total_given,
          e.in_degree, e.out_degree,`;
  const cycleJoin = cycle
    ? sql`LEFT JOIN entity_cycle_totals ct
            ON ct.entity_id = e.id AND ct.election_cycle = ${cycle}`
    : sql``;

  const rows = await db.execute<EntitySearchHit>(sql`
    SELECT e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.city, e.state_code,
           ${cycleTotals}
           e.is_traversable,
           (
             similarity(e.normalized_name, ${needle})
             -- Prefix hits are what people actually mean when they type.
             + CASE WHEN e.normalized_name LIKE ${needle + '%'} THEN 0.35 ELSE 0 END
             -- Prefer nodes the crawler can actually expand.
             + CASE WHEN e.is_traversable THEN 0.15 ELSE 0 END
             -- Gently favour nodes with real money behind them.
             + LEAST(COALESCE(e.total_received, 0) / 5000000.0, 0.15)
           )::real AS score
      FROM entities e ${cycleJoin}
     WHERE (e.normalized_name % ${needle} OR e.normalized_name LIKE ${'%' + needle + '%'})
       ${traversableOnly ? sql`AND e.is_traversable` : sql``}
     ORDER BY score DESC, e.total_received DESC
     LIMIT ${limit}
  `);

  return Response.json({ results: rows });
}
