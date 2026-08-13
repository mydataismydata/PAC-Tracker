/**
 * Everything an entity has received and given — straight from the database.
 *
 * The detail panel used to list only the edges the current crawl happened to
 * fetch, which is a small and arbitrary subset: a crawl in `direct` mode with a
 * per-node cap might pull one edge for a candidate who actually has 297
 * contributors. This endpoint is deliberately independent of the graph view, so
 * the panel can always reconcile to the headline totals on the tile.
 *
 * Two views over the same data:
 *   sources      — one row per counterparty, aggregated. Matches the "N sources"
 *                  count shown on the tile.
 *   transactions — one row per reported line item.
 */

import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { normalizeName } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  view: z.enum(['sources', 'transactions']).default('sources'),
  /** in = money received, out = money sent, all = both. */
  direction: z.enum(['in', 'out', 'all']).default('in'),
  q: z.string().max(120).optional(),
  sort: z.enum(['amount', 'date', 'name', 'count']).default('amount'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  minAmount: z.coerce.number().min(0).optional(),
});

export interface LedgerSourceRow extends Record<string, unknown> {
  entity_id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  amount: string;
  txn_count: number;
  first_date: string | null;
  last_date: string | null;
  flow: 'in' | 'out';
  is_self: boolean;
}

export interface LedgerTransactionRow extends Record<string, unknown> {
  id: string;
  counterparty_id: string | null;
  counterparty_name: string;
  amount: string;
  txn_date: string | null;
  flow: 'in' | 'out';
  txn_type_code: string | null;
  description: string | null;
  /** Contributor's street address as reported; recipients have none. */
  address: string | null;
  city: string | null;
  state_code: string | null;
  zip: string | null;
  occupation: string | null;
  source_key: string | null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return Response.json({ error: 'invalid query', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { view, direction, q, sort, order, limit, offset, minAmount } = parsed.data;

  const wantIn = direction === 'in' || direction === 'all';
  const wantOut = direction === 'out' || direction === 'all';
  const dir = sql.raw(order === 'asc' ? 'ASC' : 'DESC');
  // Trigram search needs the same normalization the names were stored under.
  const needle = q ? normalizeName(q) : null;

  return view === 'sources'
    ? sourcesView({ id, wantIn, wantOut, needle, sort, dir, limit, offset, minAmount })
    : transactionsView({ id, wantIn, wantOut, needle, sort, dir, limit, offset, minAmount });
}

interface ViewArgs {
  id: string;
  wantIn: boolean;
  wantOut: boolean;
  needle: string | null;
  sort: 'amount' | 'date' | 'name' | 'count';
  dir: ReturnType<typeof sql.raw>;
  limit: number;
  offset: number;
  minAmount?: number;
}

/** One row per counterparty, from the pre-aggregated rollups. */
async function sourcesView(a: ViewArgs) {
  const { id, wantIn, wantOut, needle, sort, dir, limit, offset, minAmount } = a;

  const inbound = sql`
    SELECT r.from_entity_id AS entity_id, r.total_amount AS amount, r.txn_count,
           r.first_date, r.last_date, 'in'::text AS flow
      FROM edge_rollups r WHERE r.to_entity_id = ${id}
  `;
  const outbound = sql`
    SELECT r.to_entity_id AS entity_id, r.total_amount AS amount, r.txn_count,
           r.first_date, r.last_date, 'out'::text AS flow
      FROM edge_rollups r WHERE r.from_entity_id = ${id}
  `;
  const base =
    wantIn && wantOut ? sql`(${inbound}) UNION ALL (${outbound})` : wantIn ? inbound : outbound;

  const filters = sql.join(
    [
      needle ? sql`AND (e.normalized_name % ${needle} OR e.normalized_name LIKE ${`%${needle}%`})` : sql``,
      minAmount != null ? sql`AND x.amount >= ${minAmount}` : sql``,
    ],
    sql` `,
  );

  const orderBy =
    sort === 'name'
      ? sql`e.name ${dir}`
      : sort === 'date'
        ? sql`x.last_date ${dir} NULLS LAST`
        : sort === 'count'
          ? sql`x.txn_count ${dir}`
          : sql`x.amount ${dir}`;

  const rows = await db.execute<LedgerSourceRow>(sql`
    SELECT x.entity_id, e.name, e.kind::text AS kind,
           e.committee_type::text AS committee_type,
           x.amount::text AS amount, x.txn_count,
           x.first_date::text AS first_date, x.last_date::text AS last_date,
           x.flow, (x.entity_id = ${id}) AS is_self
      FROM (${base}) x
      JOIN entities e ON e.id = x.entity_id
     WHERE true ${filters}
     ORDER BY ${orderBy}
     LIMIT ${limit} OFFSET ${offset}
  `);

  // Totals cover the whole filtered set, not just the page, so the panel can
  // reconcile against the tile.
  const [totals] = await db.execute<{ total: number; total_amount: string }>(sql`
    SELECT COUNT(*)::int AS total, COALESCE(SUM(x.amount), 0)::text AS total_amount
      FROM (${base}) x
      JOIN entities e ON e.id = x.entity_id
     WHERE true ${filters}
  `);

  return Response.json({
    view: 'sources',
    rows,
    total: totals?.total ?? 0,
    totalAmount: totals?.total_amount ?? '0',
    limit,
    offset,
  });
}

/** One row per reported line item. */
async function transactionsView(a: ViewArgs) {
  const { id, wantIn, wantOut, needle, sort, dir, limit, offset, minAmount } = a;

  // `flow` is relative to the subject entity, and the counterparty is whichever
  // end of the transaction is not the subject.
  const sides = sql.join(
    [
      wantIn ? sql`t.to_entity_id = ${id}` : sql``,
      wantIn && wantOut ? sql`OR` : sql``,
      wantOut ? sql`t.from_entity_id = ${id}` : sql``,
    ],
    sql` `,
  );

  const base = sql`
    SELECT t.id,
           CASE WHEN t.to_entity_id = ${id} THEN t.from_entity_id ELSE t.to_entity_id END
             AS counterparty_id,
           CASE WHEN t.to_entity_id = ${id} THEN t.raw_from_name ELSE t.raw_to_name END
             AS counterparty_name,
           t.amount, t.txn_date,
           CASE WHEN t.to_entity_id = ${id} THEN 'in' ELSE 'out' END AS flow,
           t.txn_type_code, t.inkind_description AS description,
           t.from_address AS address, t.from_city AS city, t.from_state AS state_code,
           t.from_zip AS zip, t.from_occupation AS occupation, t.source_id
      FROM transactions t
     WHERE (${sides})
  `;

  const filters = sql.join(
    [
      needle ? sql`AND upper(x.counterparty_name) LIKE ${`%${needle}%`}` : sql``,
      minAmount != null ? sql`AND x.amount >= ${minAmount}` : sql``,
    ],
    sql` `,
  );

  const orderBy =
    sort === 'name'
      ? sql`x.counterparty_name ${dir}`
      : sort === 'date'
        ? sql`x.txn_date ${dir} NULLS LAST`
        : sql`x.amount ${dir}`;

  const rows = await db.execute<LedgerTransactionRow>(sql`
    SELECT x.id, x.counterparty_id, x.counterparty_name,
           x.amount::text AS amount, x.txn_date::text AS txn_date, x.flow,
           x.txn_type_code, x.description, x.address, x.city, x.state_code, x.zip,
           x.occupation, s.key AS source_key
      FROM (${base}) x
      LEFT JOIN sources s ON s.id = x.source_id
     WHERE true ${filters}
     ORDER BY ${orderBy}
     LIMIT ${limit} OFFSET ${offset}
  `);

  const [totals] = await db.execute<{ total: number; total_amount: string }>(sql`
    SELECT COUNT(*)::int AS total, COALESCE(SUM(x.amount), 0)::text AS total_amount
      FROM (${base}) x WHERE true ${filters}
  `);

  return Response.json({
    view: 'transactions',
    rows,
    total: totals?.total ?? 0,
    totalAmount: totals?.total_amount ?? '0',
    limit,
    offset,
  });
}
