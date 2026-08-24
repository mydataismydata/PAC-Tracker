/**
 * What is currently loaded, for the guide's source table.
 *
 * Counted from the transactions themselves rather than from a figure stored at
 * ingest, so a run that half-finished cannot leave the page claiming a total it
 * never loaded.
 *
 * The count is a full group-by over three million rows and takes most of a
 * second, but the guide must not be a statically prerendered page: the Docker
 * builder stage has no DATABASE_URL and no route to the db service, so a
 * build-time prerender would fail the image build. The route is therefore
 * dynamic and the answer is memoised here for an hour instead. The server is a
 * long-lived Node process, so a module-level cache is a real cache, and the
 * numbers only move when someone runs an ingest.
 */

import { sql } from 'drizzle-orm';
import { db } from '@/db';

export interface LoadedSource extends Record<string, unknown> {
  key: string;
  name: string;
  url: string | null;
  jurisdiction: string | null;
  txns: number;
  earliest: string | null;
  latest: string | null;
  total: string;
}

export interface EntityCount extends Record<string, unknown> {
  kind: string;
  count: number;
}

export interface LoadedStats {
  sources: LoadedSource[];
  kinds: EntityCount[];
}

const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; stats: LoadedStats } | null = null;
/** Collapses a burst of concurrent first-hits into one pair of queries. */
let inFlight: Promise<LoadedStats> | null = null;

export async function loadedStats(now = Date.now()): Promise<LoadedStats> {
  if (cache && now - cache.at < TTL_MS) return cache.stats;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const [sources, kinds] = await Promise.all([querySources(), queryKinds()]);
    const stats = { sources, kinds };
    cache = { at: now, stats };
    return stats;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function querySources(): Promise<LoadedSource[]> {
  return db.execute<LoadedSource>(sql`
    SELECT s.key, s.name, s.url,
           j.name AS jurisdiction,
           count(t.id)::int AS txns,
           min(t.txn_date)::text AS earliest,
           max(t.txn_date)::text AS latest,
           COALESCE(sum(t.amount), 0)::text AS total
      FROM sources s
      LEFT JOIN jurisdictions j ON j.id = s.jurisdiction_id
      LEFT JOIN transactions t ON t.source_id = s.id
     GROUP BY s.key, s.name, s.url, j.name
     ORDER BY count(t.id) DESC
  `);
}

function queryKinds(): Promise<EntityCount[]> {
  return db.execute<EntityCount>(sql`
    SELECT kind::text AS kind, count(*)::int AS count
      FROM entities
     GROUP BY kind
     ORDER BY count(*) DESC
  `);
}
