/**
 * Hold a completed trace for a while, and let concurrent readers share one.
 *
 * A trace walks the whole graph, and the cost scales with the subject. One
 * committee takes two to five seconds. The largest network in the data —
 * 229 committees under one operator — takes twenty-four. That is a real
 * answer to a real question, so the page runs it; what it must not do is run
 * it again from scratch for every reader who opens the same page.
 *
 * The promise goes in the map, not the result. Two requests arriving while a
 * walk is still running then wait on the same walk instead of starting a
 * second one, which is the case that actually hurts.
 *
 * Deliberately in-process and deliberately small. The filings behind a trace
 * change only when an ingest runs, so half an hour of staleness costs nothing;
 * a few dozen entries is enough for the pages anyone is reading at once.
 */

import type { db as Database } from '@/db';
import { trace, type TraceOptions, type TraceResult } from '@/lib/graph/trace';

type Db = typeof Database;

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 24;

const held = new Map<string, { at: number; result: Promise<TraceResult> }>();

/** Same ids in a different order are the same question, so the key sorts them. */
function keyFor(ids: string[], opts: TraceOptions): string {
  return JSON.stringify([[...ids].sort(), opts]);
}

function evict(now: number): void {
  for (const [key, entry] of held) {
    if (now - entry.at > TTL_MS) held.delete(key);
  }
  // Map iterates in insertion order, so the front of it is the oldest.
  while (held.size >= MAX_ENTRIES) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    held.delete(oldest.value);
  }
}

export function cachedTrace(
  db: Db,
  ids: string[],
  opts: TraceOptions = {},
): Promise<TraceResult> {
  const now = Date.now();
  const key = keyFor(ids, opts);

  const hit = held.get(key);
  if (hit && now - hit.at <= TTL_MS) return hit.result;

  evict(now);
  // A failed walk must not be remembered, or one transient database error
  // would keep answering for the next half hour.
  const result = trace(db, ids, opts).catch((err) => {
    held.delete(key);
    throw err;
  });
  held.set(key, { at: now, result });
  return result;
}
