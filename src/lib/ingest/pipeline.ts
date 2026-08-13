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
import type { RawTransactionRow } from './types';

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
 * Ensure a county jurisdiction and its VoterFocus source exist.
 *
 * Counties hang off the Florida row as their parent, so a crawl can tell a
 * county filing apart from a state one — but entity resolution deliberately
 * ignores jurisdiction, which is what lets a committee giving at both levels
 * collapse to one node and the graph span tiers.
 */
export async function ensureCountySource(
  db: Db,
  county: { slug: string; name: string; code: string },
): Promise<{ jurisdictionId: string; sourceId: string }> {
  const [state] = await db
    .insert(jurisdictions)
    .values({ code: 'FL', name: 'Florida (statewide)', level: 'state', state: 'FL' })
    .onConflictDoUpdate({ target: jurisdictions.code, set: { name: 'Florida (statewide)' } })
    .returning({ id: jurisdictions.id });

  const [j] = await db
    .insert(jurisdictions)
    .values({
      code: county.code,
      name: `${county.name} County`,
      level: 'county',
      state: 'FL',
      parentId: state.id,
    })
    .onConflictDoUpdate({
      target: jurisdictions.code,
      set: { name: `${county.name} County`, parentId: state.id },
    })
    .returning({ id: jurisdictions.id });

  const [s] = await db
    .insert(sources)
    .values({
      key: `voterfocus-${county.slug}`,
      name: `${county.name} County Supervisor of Elections — VoterFocus`,
      url: `https://www.voterfocus.com/CampaignFinance/candidate_pr.php?c=${county.slug}`,
      jurisdictionId: j.id,
      notes:
        'County, municipal and special-district filings: county commission, school ' +
        'board, city commission, mosquito control, airport authority. Includes both ' +
        'contributions and expenditures.',
    })
    .onConflictDoUpdate({ target: sources.key, set: { jurisdictionId: j.id } })
    .returning({ id: sources.id });

  return { jurisdictionId: j.id, sourceId: s.id };
}

/**
 * Source and jurisdiction for a national 527 loaded from IRS Form 8872.
 *
 * These sit under a `federal` jurisdiction rather than Florida's: the money is
 * raised nationally and spent across dozens of states, and only a slice of it
 * ever reaches Florida.
 */
export async function ensureIrsSource(
  db: Db,
  org: { slug: string; name: string; ein: string },
): Promise<{ jurisdictionId: string; sourceId: string }> {
  const [j] = await db
    .insert(jurisdictions)
    .values({
      code: 'US-527',
      name: 'United States (527 organizations)',
      level: 'federal',
      state: 'US',
    })
    .onConflictDoUpdate({
      target: jurisdictions.code,
      set: { name: 'United States (527 organizations)' },
    })
    .returning({ id: jurisdictions.id });

  const [s] = await db
    .insert(sources)
    .values({
      key: `irs-8872-${org.slug}`,
      name: `${org.name} — IRS Form 8872`,
      url: 'https://forms.irs.gov/app/pod/basicSearch/search',
      jurisdictionId: j.id,
      notes:
        `Contributions received by ${org.name} (EIN ${org.ein}), as disclosed on ` +
        'IRS Form 8872. Loaded to explain a national committee that funds Florida ' +
        'races without filing in Florida. National pool: only a share reaches Florida.',
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
          electionCycle: row.electionCycle,
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
 * Persist normalized rows from any adapter.
 *
 * Handles both directions: a contribution flows counterparty → filer, an
 * expenditure flows filer → counterparty. The filer is always a candidate or
 * committee and therefore always traversable, so it is resolved as a recipient
 * regardless of which way the money went.
 */
export async function ingestTransactionRows(
  db: Db,
  rows: RawTransactionRow[],
  ctx: { sourceId: string; jurisdictionId: string; resolver?: EntityResolver },
): Promise<IngestResult> {
  const resolver = ctx.resolver ?? new EntityResolver(db);
  const before = resolver.getStats().created;

  let inserted = 0;
  let skipped = 0;
  const touched = new Set<string>();

  for (const row of rows) {
    try {
      const filer = await resolver.resolve({
        rawName: row.filerRaw,
        role: 'recipient',
        committeeType: row.filerTypeTag,
        office: row.filerOffice,
        party: row.filerParty,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });

      const counterparty = await resolver.resolve({
        rawName: row.counterpartyRaw,
        role: 'contributor',
        kindHint: row.counterpartyKind,
        city: row.city,
        state: row.state,
        zip: row.zip,
        address: row.address,
        occupation: row.occupation,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });

      const isContribution = row.direction === 'contribution';
      const from = isContribution ? counterparty : filer;
      const to = isContribution ? filer : counterparty;

      const result = await db
        .insert(transactions)
        .values({
          fromEntityId: from.entityId,
          toEntityId: to.entityId,
          rawFromName: isContribution ? row.counterpartyRaw : row.filerRaw,
          rawToName: isContribution ? row.filerRaw : row.counterpartyRaw,
          amount: row.amount,
          txnDate: row.date,
          direction: row.direction,
          txnTypeCode: row.typeCode,
          inkindDescription: row.description,
          // Address detail describes the counterparty in both directions.
          fromAddress: row.address,
          fromCity: row.city,
          fromState: row.state,
          fromZip: row.zip,
          fromOccupation: row.occupation,
          sourceId: ctx.sourceId,
          sourceRowHash: row.rowHash,
          fromConfidence: from.confidence,
          toConfidence: to.confidence,
        })
        .onConflictDoNothing({ target: transactions.sourceRowHash })
        .returning({ id: transactions.id });

      if (result.length > 0) {
        inserted++;
        touched.add(from.entityId);
        touched.add(to.entityId);
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
      console.warn(`  ! row failed (${row.counterpartyRaw} / ${row.filerRaw}):`, err);
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
      -- A self-loop is a candidate funding their own campaign, not a link
      -- between two organizations. Counting it as direct made lone
      -- self-funded candidates look connected in direct link mode.
      BOOL_AND(ef.is_traversable) AND BOOL_AND(et.is_traversable)
        AND t.from_entity_id <> t.to_entity_id AS is_direct_link,
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
 * Remove everything one source contributed, so it can be re-ingested cleanly.
 *
 * Needed after a parser fix. Row hashes include the names as parsed, so simply
 * re-running an adapter whose output has changed inserts a second copy of every
 * affected row instead of correcting the first — and a name that parsed wrongly
 * also produced a wrong normalized key, so the entity itself has to go.
 *
 * Entities are only deleted when nothing else references them, so a committee
 * that also appears in state filings survives with its other transactions
 * intact.
 */
export async function purgeSource(
  db: Db,
  sourceKey: string,
): Promise<{ transactions: number; entities: number }> {
  const [src] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, sourceKey));
  if (!src) throw new Error(`unknown source "${sourceKey}"`);

  const deletedTxns = await db.execute<{ count: number }>(sql`
    WITH removed AS (DELETE FROM transactions WHERE source_id = ${src.id} RETURNING 1)
    SELECT COUNT(*)::int AS count FROM removed
  `);

  // Aliases cascade with the entity; rollups reference entities, so clear any
  // that lost an endpoint before deleting.
  await db.execute(sql`
    DELETE FROM edge_rollups r
     WHERE NOT EXISTS (
       SELECT 1 FROM transactions t
        WHERE t.from_entity_id = r.from_entity_id AND t.to_entity_id = r.to_entity_id
     )
  `);

  const deletedEntities = await db.execute<{ count: number }>(sql`
    WITH removed AS (
      DELETE FROM entities e
       WHERE e.source_id = ${src.id}
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.from_entity_id = e.id OR t.to_entity_id = e.id
         )
         AND NOT EXISTS (SELECT 1 FROM saved_searches s WHERE s.seed_entity_id = e.id)
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM removed
  `);

  return {
    transactions: deletedTxns[0]?.count ?? 0,
    entities: deletedEntities[0]?.count ?? 0,
  };
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
      BOOL_AND(ef.is_traversable) AND BOOL_AND(et.is_traversable)
        AND t.from_entity_id <> t.to_entity_id,
      now()
    FROM transactions t
    JOIN entities ef ON ef.id = t.from_entity_id
    JOIN entities et ON et.id = t.to_entity_id
    WHERE t.from_entity_id IS NOT NULL AND t.to_entity_id IS NOT NULL
    GROUP BY t.from_entity_id, t.to_entity_id
  `);

  // Aggregate once over the rollups rather than running two lateral lookups
  // per entity. The lateral form plans well — index-only scans on both sides —
  // but it still visits every entity and rewrites every row, and at 626k
  // entities with seven indexes each the write amplification made this the
  // slowest phase of an ingest by a wide margin: over an hour, against a
  // scrape of a government website that took less.
  //
  // Two sequential scans and a hash aggregate produce the same numbers, and
  // the IS DISTINCT FROM guard means only entities whose totals actually moved
  // are written at all.
  await db.execute(sql`
    UPDATE entities e SET
      total_received = agg.received,
      total_given    = agg.given,
      in_degree      = agg.in_deg,
      out_degree     = agg.out_deg,
      first_seen     = agg.first_seen,
      last_seen      = agg.last_seen,
      updated_at     = now()
    FROM (
      SELECT id,
             SUM(received)      AS received,
             SUM(given)         AS given,
             SUM(in_deg)::int   AS in_deg,
             SUM(out_deg)::int  AS out_deg,
             MIN(first_date)    AS first_seen,
             MAX(last_date)     AS last_seen
      FROM (
        SELECT to_entity_id AS id, total_amount AS received, 0::numeric AS given,
               1 AS in_deg, 0 AS out_deg, first_date, last_date
          FROM edge_rollups
        UNION ALL
        SELECT from_entity_id, 0::numeric, total_amount,
               0, 1, first_date, last_date
          FROM edge_rollups
      ) sided
      GROUP BY id
    ) agg
    WHERE e.id = agg.id
      AND (e.total_received IS DISTINCT FROM agg.received
        OR e.total_given    IS DISTINCT FROM agg.given
        OR e.in_degree      IS DISTINCT FROM agg.in_deg
        OR e.out_degree     IS DISTINCT FROM agg.out_deg
        OR e.first_seen     IS DISTINCT FROM agg.first_seen
        OR e.last_seen      IS DISTINCT FROM agg.last_seen)
  `);

  // Entities that lost their last edge are not in the aggregate at all, so
  // they need clearing separately or they keep stale totals forever.
  await db.execute(sql`
    UPDATE entities e SET
      total_received = 0, total_given = 0, in_degree = 0, out_degree = 0,
      first_seen = NULL, last_seen = NULL, updated_at = now()
    WHERE (e.total_received <> 0 OR e.total_given <> 0
        OR e.in_degree <> 0 OR e.out_degree <> 0)
      AND NOT EXISTS (SELECT 1 FROM edge_rollups r WHERE r.to_entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM edge_rollups r WHERE r.from_entity_id = e.id)
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
