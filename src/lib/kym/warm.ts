/**
 * Run the expensive Know Your Mailer reports once, so no reader has to.
 *
 * A report's funding trace walks the whole graph. One committee takes two to
 * five seconds and William Stafford Jones's 229 take twenty-four, which is
 * why both the digest and the neighborhood picture are cached for a week.
 * The key of each carries a stamp of the last write to `transactions` and
 * `entities`, so a rebuild makes every held answer unreachable at once. The
 * first reader after a rebuild therefore pays the full cost of whichever page
 * they opened, and the busiest pages are also the slowest.
 *
 * This asks for those pages first. It is a plain HTTP client against the
 * running app, deliberately, for two reasons. The cache lives in the app's
 * process and on a volume mounted only on the app's container, so a call made
 * from the ingest container would warm nothing the app can read. And a page
 * is the only thing that knows its own cache key: calling the trace directly
 * from here would mean copying the depth, the dollar floor and the row caps
 * out of the report, and the copy would go stale the first time one changed.
 *
 * Only the unfiltered view of each subject is asked for. A cycle filter is its
 * own key, and a shared or hand-typed link carries no cycle.
 */

import type { db as Database } from '@/db';
import { busiestCommittees, committeeSlug } from '@/lib/graph/committee';
import { busiestPeople } from '@/lib/graph/officers';
import { snapshotKey } from '@/lib/kym/snapshot';

type Db = typeof Database;

/** Where the app is. The compose file points the ingest container at `app`. */
export const APP_URL = process.env.PT_APP_URL || 'http://localhost:3000';

/**
 * Longest one page may take.
 *
 * The slowest subject on file is a 229-committee network at around
 * twenty-five seconds, and a box under load is slower than that. Three
 * minutes is far above anything observed and still bounded.
 */
const REQUEST_TIMEOUT_MS = 180_000;

/** How long to keep asking whether the app has noticed the rebuild. */
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 15_000;

export interface WarmTarget {
  /** What to print. */
  label: string;
  path: string;
}

export interface WarmOutcome extends WarmTarget {
  status: number;
  ms: number;
  bytes: number;
  error?: string;
}

export interface WarmReport {
  ready: boolean;
  outcomes: WarmOutcome[];
  ms: number;
}

/**
 * The pages worth holding: the busiest committees and the busiest people.
 *
 * A committee contributes two, because its report and its picture are two
 * answers under two keys. The page emits the picture as an `<img>`, so a
 * reader fetches it separately and pays for it separately. A person's report
 * has no picture.
 */
export async function warmTargets(
  db: Db,
  counts: { committees: number; people: number },
): Promise<WarmTarget[]> {
  const [committees, people] = await Promise.all([
    busiestCommittees(db, counts.committees),
    busiestPeople(db, counts.people),
  ]);

  const targets: WarmTarget[] = [];
  for (const c of committees) {
    // The id is pinned rather than left to the slug. Three separate committees
    // file as "Florida Forward", and a bare slug makes that page ask which one
    // instead of tracing any of them.
    targets.push({ label: c.name, path: `/kym/${committeeSlug(c.name)}?id=${c.id}` });
    targets.push({ label: `${c.name} (picture)`, path: `/api/kym/snapshot/${c.id}` });
  }
  for (const p of people) {
    targets.push({
      label: `${p.name} — chair of ${p.chair}, treasurer of ${p.treasurer}`,
      path: `/kym/person/${p.slug}`,
    });
  }
  return targets;
}

async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; bytes: number; etag: string | null }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'pactracker-warm', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // The whole body, always. A report streams: the page flushes, and the trace
  // arrives later in the same response. Hanging up early would leave the walk
  // half done and nothing cached.
  const body = await res.arrayBuffer();
  return { status: res.status, bytes: body.byteLength, etag: res.headers.get('etag') };
}

/**
 * Whether the app is answering against the data this process can see.
 *
 * The app asks the database for the stamp behind its cache keys once a minute
 * and holds the answer in between, so for up to a minute after a rebuild it is
 * still keying on what the data looked like before. Warming into that window
 * fills a shelf nobody will reach.
 *
 * The probe is a snapshot's `ETag`, which is a hash of that same stamp. Sent
 * back as `If-None-Match`, a match answers 304 without drawing anything. A
 * miss costs one picture drawn under a key that is about to expire, which is
 * why the wait between tries is long.
 */
async function waitUntilCurrent(db: Db, base: string, probeId: string): Promise<boolean> {
  const { etag } = await snapshotKey(db, probeId, undefined);
  const url = `${base}/api/kym/snapshot/${probeId}`;
  const until = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    const res = await get(url, { 'If-None-Match': etag }).catch(() => null);
    if (res?.etag === etag) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/**
 * Ask for every page that is worth holding, one at a time.
 *
 * Sequential on purpose. Each of these walks the graph, the deployment box has
 * two cores, and running ten at once would make every one of them slower while
 * a reader waited behind the lot.
 */
export async function warmReports(
  db: Db,
  opts: {
    base?: string;
    committees?: number;
    people?: number;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<WarmReport> {
  const base = (opts.base ?? APP_URL).replace(/\/+$/, '');
  const started = Date.now();
  const targets = await warmTargets(db, {
    committees: opts.committees ?? 10,
    people: opts.people ?? 10,
  });

  const probe = targets.find((t) => t.path.startsWith('/api/kym/snapshot/'));
  const probeId = probe?.path.split('/').pop() ?? null;
  const ready = probeId ? await waitUntilCurrent(db, base, probeId) : true;
  if (!ready) {
    opts.onProgress?.('the app is still answering against older data — warming anyway');
  }

  const outcomes: WarmOutcome[] = [];
  for (const t of targets) {
    const at = Date.now();
    try {
      const res = await get(`${base}${t.path}`);
      outcomes.push({ ...t, status: res.status, ms: Date.now() - at, bytes: res.bytes });
    } catch (err) {
      outcomes.push({ ...t, status: 0, ms: Date.now() - at, bytes: 0, error: String(err) });
    }
    const last = outcomes[outcomes.length - 1];
    opts.onProgress?.(
      `${last.error ? 'failed' : String(last.status)} ${String(last.ms).padStart(6)}ms  ${t.label}` +
        (last.error ? ` — ${last.error}` : ''),
    );
  }

  return { ready, outcomes, ms: Date.now() - started };
}
