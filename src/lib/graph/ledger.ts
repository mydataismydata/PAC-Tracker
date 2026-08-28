/**
 * Everything a set of committees has received and given.
 *
 * A set, not one committee, because the same question gets asked of a person:
 * a treasurer named on 107 committees has a funding base, and it is the union
 * of theirs. One entity is just the set of size one, so the panel runs the same
 * code either way.
 *
 * Deliberately independent of the crawl. The graph shows a capped, filtered
 * slice — a candidate with 297 contributors may draw one edge — and the panel
 * has to be able to account for every dollar in the headline totals.
 *
 * ## Aggregating over a set changes two things
 *
 * A counterparty reached through several committees in the set is one row, not
 * several, so the sources view groups and sums. And a payment from one member
 * of the set to another is *internal*: it is real money, but it neither entered
 * nor left the group, and adding it to a total for the group double-counts it
 * on both sides. Those rows are flagged `is_self` rather than dropped —
 * committees shuffling money between themselves is often the whole story — and
 * the totals report them separately so a headline figure can exclude them.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { normalizeName } from '@/lib/normalize';
import { derivedCycleSql } from '@/lib/cycles';

type Db = PostgresJsDatabase<typeof schema>;

export interface LedgerSourceRow extends Record<string, unknown> {
  entity_id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  industry: string | null;
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
  address: string | null;
  city: string | null;
  state_code: string | null;
  zip: string | null;
  occupation: string | null;
  /** The counterparty entity's industry, when it resolved to one; not per-transaction. */
  industry: string | null;
  source_key: string | null;
  is_self: boolean;
}

export interface LedgerQuery {
  view: 'sources' | 'transactions';
  direction: 'in' | 'out' | 'all';
  q?: string;
  sort: 'amount' | 'date' | 'name' | 'count';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  minAmount?: number;
  cycle?: string;
  /**
   * Inclusive bounds on the transaction date.
   *
   * Both optional and independent, so one end alone is a valid window. Applied
   * to the same dates the graph is filtered on, so the panel and the map agree
   * about what is in range.
   */
  dateFrom?: string;
  dateTo?: string;
}

export interface LedgerResult {
  view: 'sources' | 'transactions';
  rows: LedgerSourceRow[] | LedgerTransactionRow[];
  total: number;
  totalAmount: string;
  /** Of `totalAmount`, how much moved between members of the set. */
  internalAmount: string;
  limit: number;
  offset: number;
}

export async function ledger(
  db: Db,
  entityIds: string[],
  query: LedgerQuery,
): Promise<LedgerResult> {
  const wantIn = query.direction === 'in' || query.direction === 'all';
  const wantOut = query.direction === 'out' || query.direction === 'all';
  const dir = sql.raw(query.order === 'asc' ? 'ASC' : 'DESC');
  // Trigram search needs the same normalization the names were stored under.
  const needle = query.q ? normalizeName(query.q) : null;
  const ids = sql`${sql.param(entityIds)}::uuid[]`;

  return query.view === 'sources'
    ? sourcesView(db, ids, { ...query, wantIn, wantOut, needle, dir })
    : transactionsView(db, ids, { ...query, wantIn, wantOut, needle, dir });
}

type ViewArgs = LedgerQuery & {
  wantIn: boolean;
  wantOut: boolean;
  needle: string | null;
  dir: ReturnType<typeof sql.raw>;
};

/** The date window as a fragment for a query aliasing `transactions` as `t`. */
function dateWindow(from?: string, to?: string) {
  return sql.join(
    [
      from ? sql`AND t.txn_date >= ${from}` : sql``,
      to ? sql`AND t.txn_date <= ${to}` : sql``,
    ],
    sql` `,
  );
}


/** One row per counterparty, from the pre-aggregated rollups. */
async function sourcesView(
  db: Db,
  ids: ReturnType<typeof sql>,
  a: ViewArgs,
): Promise<LedgerResult> {
  const { wantIn, wantOut, needle, sort, dir, limit, offset, minAmount, cycle } = a;
  const { dateFrom, dateTo } = a;

  /**
   * Where the counterparty totals come from.
   *
   * Normally the rollups, which are already grouped per pair and per cycle, so
   * the query is an index range rather than a scan of three million rows. A
   * rollup holds only the first and last date of the pair's dealings, though,
   * and no way to say how much of its total fell inside an arbitrary window —
   * so a date filter drops to the transactions themselves and re-aggregates.
   * Slower, and the only way to get an answer that is actually true.
   */
  const windowed = dateFrom != null || dateTo != null;
  const dates = dateWindow(dateFrom, dateTo);
  const cyc = cycle
    ? windowed
      ? sql`AND ${derivedCycleSql('t')} = ${cycle}`
      : sql`AND r.election_cycle = ${cycle}`
    : sql``;

  const inbound = windowed
    ? sql`
        SELECT t.from_entity_id AS entity_id, t.amount, 1 AS txn_count,
               t.txn_date AS first_date, t.txn_date AS last_date, 'in'::text AS flow
          FROM transactions t
         WHERE t.to_entity_id = ANY(${ids}) AND t.from_entity_id IS NOT NULL ${cyc} ${dates}
      `
    : sql`
        SELECT r.from_entity_id AS entity_id, r.total_amount AS amount, r.txn_count,
               r.first_date, r.last_date, 'in'::text AS flow
          FROM edge_rollups r WHERE r.to_entity_id = ANY(${ids}) ${cyc}
      `;
  const outbound = windowed
    ? sql`
        SELECT t.to_entity_id AS entity_id, t.amount, 1 AS txn_count,
               t.txn_date AS first_date, t.txn_date AS last_date, 'out'::text AS flow
          FROM transactions t
         WHERE t.from_entity_id = ANY(${ids}) AND t.to_entity_id IS NOT NULL ${cyc} ${dates}
      `
    : sql`
        SELECT r.to_entity_id AS entity_id, r.total_amount AS amount, r.txn_count,
               r.first_date, r.last_date, 'out'::text AS flow
          FROM edge_rollups r WHERE r.from_entity_id = ANY(${ids}) ${cyc}
      `;
  const union =
    wantIn && wantOut ? sql`(${inbound}) UNION ALL (${outbound})` : wantIn ? inbound : outbound;

  // The grouping is what makes a set work: one counterparty giving to four of
  // the committees is one row of four times the money, not four rows.
  const base = sql`
    SELECT u.entity_id, u.flow,
           SUM(u.amount) AS amount, SUM(u.txn_count)::int AS txn_count,
           MIN(u.first_date) AS first_date, MAX(u.last_date) AS last_date,
           (u.entity_id = ANY(${ids})) AS is_self
      FROM (${union}) u
     GROUP BY u.entity_id, u.flow
  `;

  const filters = sql.join(
    [
      needle
        ? sql`AND (e.normalized_name % ${needle} OR e.normalized_name LIKE ${`%${needle}%`})`
        : sql``,
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
           e.industry,
           x.amount::text AS amount, x.txn_count,
           x.first_date::text AS first_date, x.last_date::text AS last_date,
           x.flow, x.is_self
      FROM (${base}) x
      JOIN entities e ON e.id = x.entity_id
     WHERE true ${filters}
     ORDER BY ${orderBy}
     LIMIT ${limit} OFFSET ${offset}
  `);

  // Totals cover the whole filtered set, not just the page, so the panel can
  // reconcile against the tile.
  const [totals] = await db.execute<{
    total: number;
    total_amount: string;
    internal_amount: string;
  }>(sql`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(x.amount), 0)::text AS total_amount,
           COALESCE(SUM(x.amount) FILTER (WHERE x.is_self), 0)::text AS internal_amount
      FROM (${base}) x
      JOIN entities e ON e.id = x.entity_id
     WHERE true ${filters}
  `);

  return {
    view: 'sources',
    rows,
    total: totals?.total ?? 0,
    totalAmount: totals?.total_amount ?? '0',
    internalAmount: totals?.internal_amount ?? '0',
    limit,
    offset,
  };
}

/** One row per reported line item. */
async function transactionsView(
  db: Db,
  ids: ReturnType<typeof sql>,
  a: ViewArgs,
): Promise<LedgerResult> {
  const { wantIn, wantOut, needle, sort, dir, limit, offset, minAmount, cycle } = a;

  // Transactions carry a filing cycle rather than the derived one, so the same
  // rule the rollups were built with has to be applied here or a filtered
  // ledger disagrees with the filtered graph beside it.
  const cyc = cycle ? sql`AND ${derivedCycleSql('t')} = ${cycle}` : sql``;
  const dates = dateWindow(a.dateFrom, a.dateTo);

  // `flow` is relative to the set, and the counterparty is whichever end is not
  // in it. A transfer inside the set has both ends in it; `to` decides the flow
  // so the row appears once under `in` rather than twice.
  const sides = sql.join(
    [
      wantIn ? sql`t.to_entity_id = ANY(${ids})` : sql``,
      wantIn && wantOut ? sql`OR` : sql``,
      wantOut ? sql`t.from_entity_id = ANY(${ids})` : sql``,
    ],
    sql` `,
  );

  const base = sql`
    SELECT t.id,
           CASE WHEN t.to_entity_id = ANY(${ids}) THEN t.from_entity_id ELSE t.to_entity_id END
             AS counterparty_id,
           CASE WHEN t.to_entity_id = ANY(${ids}) THEN t.raw_from_name ELSE t.raw_to_name END
             AS counterparty_name,
           t.amount, t.txn_date,
           CASE WHEN t.to_entity_id = ANY(${ids}) THEN 'in' ELSE 'out' END AS flow,
           (t.from_entity_id = ANY(${ids}) AND t.to_entity_id = ANY(${ids})) AS is_self,
           t.txn_type_code, t.inkind_description AS description,
           t.from_address AS address, t.from_city AS city, t.from_state AS state_code,
           t.from_zip AS zip, t.from_occupation AS occupation, t.source_id
      FROM transactions t
     WHERE (${sides}) ${cyc} ${dates}
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
           x.amount::text AS amount, x.txn_date::text AS txn_date, x.flow, x.is_self,
           x.txn_type_code, x.description, x.address, x.city, x.state_code, x.zip,
           x.occupation, ce.industry, s.key AS source_key
      FROM (${base}) x
      LEFT JOIN sources s ON s.id = x.source_id
      LEFT JOIN entities ce ON ce.id = x.counterparty_id
     WHERE true ${filters}
     ORDER BY ${orderBy}
     LIMIT ${limit} OFFSET ${offset}
  `);

  const [totals] = await db.execute<{
    total: number;
    total_amount: string;
    internal_amount: string;
  }>(sql`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(x.amount), 0)::text AS total_amount,
           COALESCE(SUM(x.amount) FILTER (WHERE x.is_self), 0)::text AS internal_amount
      FROM (${base}) x WHERE true ${filters}
  `);

  return {
    view: 'transactions',
    rows,
    total: totals?.total ?? 0,
    totalAmount: totals?.total_amount ?? '0',
    internalAmount: totals?.internal_amount ?? '0',
    limit,
    offset,
  };
}
