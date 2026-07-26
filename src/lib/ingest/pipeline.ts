/**
 * Ingest pipeline: raw source rows -> resolved entities -> transactions -> edges.
 *
 * Every stage is idempotent. Re-ingesting the same query is a no-op because
 * transactions dedupe on `sourceRowHash`, and edge rollups are recomputed from
 * whatever transactions currently exist rather than incremented in place.
 */

import { sql, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { transactions, entities, sources, jurisdictions, ingestRuns } from '@/db/schema';
import { EntityResolver, refreshTraversability } from './resolve';
import type { RawContributionRow } from './fl-doe/parse';

type Db = PostgresJsDatabase<typeof schema>;

export interface IngestResult {
  rowsFetched: number;
  rowsInserted: number;
  rowsSkipped: number;
  entitiesCreated: number;
  resolverStats: Record<string, number>;
}

/** Ensure the Florida jurisdiction + source rows exist; returns their ids. */
export async function ensureFloridaSource(db: Db): Promise<{
  jurisdictionId: string;
  sourceId: string;
}> {
  const [j] = await db
    .insert(jurisdictions)
    .values({ code: 'FL', name: 'Florida (statewide)', level: 'state', state: 'FL' })
    .onConflictDoUpdate({
      target: jurisdictions.code,
      set: { name: 'Florida (statewide)' },
    })
    .returning({ id: jurisdictions.id });

  const [s] = await db
    .insert(sources)
    .values({
      key: 'fl-doe',
      name: 'Florida Division of Elections — Campaign Finance Database',
      url: 'https://dos.elections.myflorida.com/campaign-finance/',
      jurisdictionId: j.id,
      notes:
        'State-level races and state-registered committees only. County, municipal, ' +
        'school board and special-district filings live with the 67 county Supervisors ' +
        'of Elections and with city clerks.',
    })
    .onConflictDoUpdate({ target: sources.key, set: { jurisdictionId: j.id } })
    .returning({ id: sources.id });

  return { jurisdictionId: j.id, sourceId: s.id };
}

/**
 * Persist a batch of parsed contribution rows.
 *
 * Resolution runs row-by-row because each resolution can create an entity that
 * the next row needs to find. The resolver's in-process cache keeps that from
 * turning into a query per row.
 */
export async function ingestContributionRows(
  db: Db,
  rows: RawContributionRow[],
  ctx: { sourceId: string; jurisdictionId: string; resolver?: EntityResolver },
): Promise<IngestResult> {
  const resolver = ctx.resolver ?? new EntityResolver(db);
  const before = resolver.getStats().created;

  let inserted = 0;
  let skipped = 0;
  const touched = new Set<string>();

  for (const row of rows) {
    try {
      const recipient = await resolver.resolve({
        rawName: row.recipientName,
        role: 'recipient',
        committeeType: row.recipientTypeTag,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });

      const contributor = await resolver.resolve({
        rawName: row.contributorRaw,
        role: 'contributor',
        city: row.city,
        state: row.state,
        zip: row.zip,
        address: row.address,
        occupation: row.occupation,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });

      const result = await db
        .insert(transactions)
        .values({
          fromEntityId: contributor.entityId,
          toEntityId: recipient.entityId,
          rawFromName: row.contributorRaw,
          rawToName: row.recipientRaw,
          amount: row.amount,
          txnDate: row.date,
          direction: 'contribution',
          txnTypeCode: row.typeCode,
          inkindDescription: row.inkindDescription,
          fromAddress: row.address,
          fromCity: row.city,
          fromState: row.state,
          fromZip: row.zip,
          fromOccupation: row.occupation,
          sourceId: ctx.sourceId,
          sourceRowHash: row.rowHash,
          fromConfidence: contributor.confidence,
          toConfidence: recipient.confidence,
        })
        .onConflictDoNothing({ target: transactions.sourceRowHash })
        .returning({ id: transactions.id });

      if (result.length > 0) {
        inserted++;
        touched.add(contributor.entityId);
        touched.add(recipient.entityId);
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
      console.warn(`  ! row failed (${row.contributorRaw} -> ${row.recipientName}):`, err);
    }
  }

  if (touched.size > 0) {
    await rebuildEdgeRollups(db, [...touched]);
    await refreshEntityTotals(db, [...touched]);
  }
  await refreshTraversability(db);

  const stats = resolver.getStats();
  return {
    rowsFetched: rows.length,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    entitiesCreated: stats.created - before,
    resolverStats: stats,
  };
}

/**
 * Recompute entity→entity rollups for the affected nodes.
 *
 * The graph shows one weighted edge per pair, not one per cheque: US Sugar's
 * five separate $250k gifts to the Florida Chamber PAC in 2024 render as a
 * single $1.25M link.
 */
export async function rebuildEdgeRollups(db: Db, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  await db.execute(sql`
    INSERT INTO edge_rollups (
      from_entity_id, to_entity_id, total_amount, txn_count,
      first_date, last_date, is_direct_link, updated_at
    )
    SELECT
      t.from_entity_id,
      t.to_entity_id,
      SUM(t.amount)          AS total_amount,
      COUNT(*)::int          AS txn_count,
      MIN(t.txn_date)        AS first_date,
      MAX(t.txn_date)        AS last_date,
      BOOL_AND(ef.is_traversable) AND BOOL_AND(et.is_traversable) AS is_direct_link,
      now()
    FROM transactions t
    JOIN entities ef ON ef.id = t.from_entity_id
    JOIN entities et ON et.id = t.to_entity_id
    WHERE t.from_entity_id IS NOT NULL
      AND t.to_entity_id IS NOT NULL
      AND (t.from_entity_id = ANY(${sql.param(entityIds)}::uuid[])
           OR t.to_entity_id = ANY(${sql.param(entityIds)}::uuid[]))
    GROUP BY t.from_entity_id, t.to_entity_id
    ON CONFLICT (from_entity_id, to_entity_id) DO UPDATE SET
      total_amount   = EXCLUDED.total_amount,
      txn_count      = EXCLUDED.txn_count,
      first_date     = EXCLUDED.first_date,
      last_date      = EXCLUDED.last_date,
      is_direct_link = EXCLUDED.is_direct_link,
      updated_at     = now()
  `);
}

/**
 * Recompute every rollup and total from the transaction table.
 *
 * The incremental path only touches entities seen in the current batch, so a
 * crashed or partial run can leave rollups behind. This is the repair path, and
 * the thing to run after changing resolution rules.
 */
export async function rebuildAll(db: Db): Promise<{ edges: number; entities: number }> {
  await refreshTraversability(db);

  await db.execute(sql`TRUNCATE edge_rollups`);
  await db.execute(sql`
    INSERT INTO edge_rollups (
      from_entity_id, to_entity_id, total_amount, txn_count,
      first_date, last_date, is_direct_link, updated_at
    )
    SELECT
      t.from_entity_id,
      t.to_entity_id,
      SUM(t.amount),
      COUNT(*)::int,
      MIN(t.txn_date),
      MAX(t.txn_date),
      BOOL_AND(ef.is_traversable) AND BOOL_AND(et.is_traversable),
      now()
    FROM transactions t
    JOIN entities ef ON ef.id = t.from_entity_id
    JOIN entities et ON et.id = t.to_entity_id
    WHERE t.from_entity_id IS NOT NULL AND t.to_entity_id IS NOT NULL
    GROUP BY t.from_entity_id, t.to_entity_id
  `);

  await db.execute(sql`
    UPDATE entities e SET
      total_received = COALESCE(inb.received, 0),
      total_given    = COALESCE(outb.given, 0),
      in_degree      = COALESCE(inb.in_deg, 0),
      out_degree     = COALESCE(outb.out_deg, 0),
      first_seen     = LEAST(inb.in_first, outb.out_first),
      last_seen      = GREATEST(inb.in_last, outb.out_last),
      updated_at     = now()
    FROM entities x
    LEFT JOIN LATERAL (
      SELECT SUM(total_amount) AS received, COUNT(*)::int AS in_deg,
             MIN(first_date) AS in_first, MAX(last_date) AS in_last
      FROM edge_rollups WHERE to_entity_id = x.id
    ) inb ON true
    LEFT JOIN LATERAL (
      SELECT SUM(total_amount) AS given, COUNT(*)::int AS out_deg,
             MIN(first_date) AS out_first, MAX(last_date) AS out_last
      FROM edge_rollups WHERE from_entity_id = x.id
    ) outb ON true
    WHERE e.id = x.id
  `);

  const [counts] = await db.execute<{ edges: number; entities: number }>(sql`
    SELECT (SELECT COUNT(*) FROM edge_rollups)::int AS edges,
           (SELECT COUNT(*) FROM entities)::int     AS entities
  `);
  return counts;
}

/** Refresh the denormalized totals and degrees shown on each tile. */
export async function refreshEntityTotals(db: Db, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  await db.execute(sql`
    UPDATE entities e SET
      total_received = COALESCE(agg.received, 0),
      total_given    = COALESCE(agg.given, 0),
      in_degree      = COALESCE(agg.in_deg, 0),
      out_degree     = COALESCE(agg.out_deg, 0),
      first_seen     = agg.first_seen,
      last_seen      = agg.last_seen,
      updated_at     = now()
    FROM (
      SELECT
        x.id,
        inb.received, inb.in_deg, inb.in_first, inb.in_last,
        outb.given, outb.out_deg, outb.out_first, outb.out_last,
        LEAST(inb.in_first, outb.out_first)  AS first_seen,
        GREATEST(inb.in_last, outb.out_last) AS last_seen
      FROM entities x
      LEFT JOIN LATERAL (
        SELECT SUM(total_amount) AS received, COUNT(*)::int AS in_deg,
               MIN(first_date) AS in_first, MAX(last_date) AS in_last
        FROM edge_rollups WHERE to_entity_id = x.id
      ) inb ON true
      LEFT JOIN LATERAL (
        SELECT SUM(total_amount) AS given, COUNT(*)::int AS out_deg,
               MIN(first_date) AS out_first, MAX(last_date) AS out_last
        FROM edge_rollups WHERE from_entity_id = x.id
      ) outb ON true
      WHERE x.id = ANY(${sql.param(entityIds)}::uuid[])
    ) agg
    WHERE e.id = agg.id
  `);
}

/** Bookkeeping helpers for observability of long scrape jobs. */
export async function startRun(
  db: Db,
  sourceId: string,
  scope: Record<string, unknown>,
): Promise<string> {
  const [run] = await db
    .insert(ingestRuns)
    .values({ sourceId, scope, status: 'running' })
    .returning({ id: ingestRuns.id });
  return run.id;
}

export async function finishRun(
  db: Db,
  runId: string,
  result: Partial<IngestResult> & { error?: string },
): Promise<void> {
  await db
    .update(ingestRuns)
    .set({
      status: result.error ? 'failed' : 'succeeded',
      rowsFetched: result.rowsFetched ?? 0,
      rowsInserted: result.rowsInserted ?? 0,
      rowsSkipped: result.rowsSkipped ?? 0,
      error: result.error,
      finishedAt: new Date(),
    })
    .where(eq(ingestRuns.id, runId));
}

/** Look up entity display rows by id, preserving caller order. */
export async function getEntities(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(entities).where(inArray(entities.id, ids));
}
