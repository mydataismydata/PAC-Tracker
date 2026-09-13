/**
 * Hold what a report needs from a trace, for as long as the filings behind it
 * stay put.
 *
 * A trace walks the whole graph, and the cost scales with the subject. One
 * committee takes two to five seconds. Evan Power's three — one of which is
 * the Republican Party of Florida — take ten. William Stafford Jones's 229
 * take twenty-four. Those are real answers to real questions, so the pages run
 * them; what they must not do is run them again for every reader.
 *
 * ## Why a digest rather than the result
 *
 * A report shows the largest twenty-five originators, every national pool, and
 * the first ten committees whose own funding is unknown. It shows sums and
 * counts for everything else. The full result behind that is enormous and
 * almost entirely unread: Evan Power's carries 17,484 sources and weighs 5.3MB,
 * of which the page renders twenty-five rows.
 *
 * Keeping the rows that get rendered plus the totals of the rest costs 12–17KB
 * whatever the subject — 300 times smaller in the worst case, and near enough
 * flat across all of them. That is what makes a week's retention cheap: five
 * hundred subjects held at once is around 17MB.
 *
 * ## Why the key carries a stamp
 *
 * A week is far longer than the gap between ingests, so a timer alone would
 * serve last week's answer after a correction landed. The key therefore
 * carries the latest write time of the two tables a trace reads — and every
 * path that changes the money touches one of them. A new filing, a merge or a
 * split writes `transactions`; a rebuild writes `entities`. When the stamp
 * moves, everything held under the old one is dropped rather than left to age
 * out, because none of it can ever be asked for again.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import * as disk from '@/lib/cache/disk';
import { trace, type InjectionPoint, type TraceOptions, type TracedSource } from '@/lib/graph/trace';

type Db = typeof Database;

/** How long an answer stands, once the data behind it has stopped moving. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Subjects held at once. At 12–17KB each this is on the order of 17MB. */
const MAX_ENTRIES = 500;

/** How often the database is asked whether anything has changed. */
const STAMP_TTL_MS = 60 * 1000;

const NS = 'traces';
/** Disk the digests may take. At 12–17KB each this is thousands of them. */
const LIMITS = { ttlMs: TTL_MS, maxBytes: 64 * 1024 * 1024 };

/** A list the report shows the top of, with the whole of it summed and counted. */
export interface DigestList {
  rows: TracedSource[];
  count: number;
  amount: number;
}

export interface TraceDigest {
  /** What the subject received, and the denominator every share is against. */
  seedTotal: number;
  hops: number;
  dispersed: number;
  truncated: boolean;
  cycle: string | null;
  sources: DigestList;
  unresolved: DigestList;
  /** Never truncated. There are 108 of these in the whole database. */
  injectionPoints: InjectionPoint[];
}

export interface Keep {
  sources: number;
  unresolved: number;
}

function sum(rows: { amount: number }[]): number {
  return rows.reduce((a, b) => a + b.amount, 0);
}

interface Entry {
  at: number;
  digest: Promise<TraceDigest>;
}

const held = new Map<string, Entry>();
let stamp: { value: string; at: number } | null = null;

/**
 * The latest write to anything a trace reads.
 *
 * Shared with the snapshot cache in `src/lib/kym/snapshot.ts`, which draws
 * from the same two tables and goes stale for the same reasons.
 *
 * `transactions.updated_at` is indexed, so its maximum is instant. The one on
 * `entities` is not, and costs about 80ms — which is why the answer stands for
 * a minute. Both are needed: money moving is a write to the first, and a kind
 * changing from committee to organization is a write only to the second, yet
 * it decides whether the trace treats that entity as a conduit or as a source.
 */
export async function dataStamp(db: Db): Promise<string> {
  const now = Date.now();
  if (stamp && now - stamp.at <= STAMP_TTL_MS) return stamp.value;

  const rows = await db.execute<{ stamp: string }>(sql`
    SELECT concat(
      (SELECT max(updated_at) FROM transactions), '|',
      (SELECT max(updated_at) FROM entities)
    ) AS stamp
  `);
  const value = rows[0]?.stamp ?? 'unknown';

  // Everything held was computed against filings that have since changed.
  // None of it can be asked for again, so it goes now rather than in a week.
  if (stamp && stamp.value !== value) held.clear();
  stamp = { value, at: now };
  return value;
}

/** Same ids in a different order are the same question, so the key sorts them. */
function keyFor(ids: string[], opts: TraceOptions, keep: Keep, at: string): string {
  return JSON.stringify([[...ids].sort(), opts, keep, at]);
}

function evict(): void {
  const now = Date.now();
  for (const [key, entry] of held) {
    if (now - entry.at > TTL_MS) held.delete(key);
  }
  // Map iterates in insertion order, and a hit re-inserts, so the front of it
  // is whatever has gone longest unread.
  while (held.size >= MAX_ENTRIES) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    held.delete(oldest.value);
  }
}

export async function cachedTrace(
  db: Db,
  ids: string[],
  opts: TraceOptions,
  keep: Keep,
): Promise<TraceDigest> {
  const key = keyFor(ids, opts, keep, await dataStamp(db));

  const hit = held.get(key);
  if (hit && Date.now() - hit.at <= TTL_MS) {
    // Re-insert to move it to the back of the eviction queue. The fetch time
    // rides along untouched: recency decides what is dropped first, and has
    // nothing to do with when the answer goes stale.
    held.delete(key);
    held.set(key, hit);
    return hit.digest;
  }

  evict();

  // A previous process may have already answered this.
  const file = createHash('sha1').update(key).digest('hex');
  const kept = await disk.read(NS, file, 'json').catch(() => null);
  if (kept) {
    try {
      const digest = JSON.parse(kept.toString('utf8')) as TraceDigest;
      held.set(key, { at: Date.now(), digest: Promise.resolve(digest) });
      return digest;
    } catch {
      // A torn or foreign file. Walk the graph as if it were not there.
    }
  }

  const digest = trace(db, ids, opts)
    .then((r) => ({
      seedTotal: r.seed.total,
      hops: r.hops,
      dispersed: r.dispersed,
      truncated: r.truncated,
      cycle: r.cycle,
      sources: {
        rows: r.sources.slice(0, keep.sources),
        count: r.sources.length,
        amount: sum(r.sources),
      },
      unresolved: {
        rows: r.unresolved.slice(0, keep.unresolved),
        count: r.unresolved.length,
        amount: sum(r.unresolved),
      },
      injectionPoints: r.injectionPoints,
    }))
    .then((d) => {
      void disk.write(NS, file, 'json', JSON.stringify(d), LIMITS);
      return d;
    })
    // A failed walk must not be remembered, or one transient database error
    // would keep answering for the next week.
    .catch((err) => {
      held.delete(key);
      throw err;
    });

  held.set(key, { at: Date.now(), digest });
  return digest;
}
