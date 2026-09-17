/**
 * What is in this database, where it came from, and what has been changed.
 *
 * Every figure a reader is shown rests on three judgements they cannot see:
 * which filings were swept, which two filers were decided to be one, and which
 * payer was decided to be a nonprofit rather than a company. This is where
 * those are written down. A report that says a committee raised $8M without
 * saying that four filers were folded into it is asking to be trusted rather
 * than checked.
 *
 * ## Why it is cached
 *
 * These are aggregates over the whole transaction table, and the page is
 * public. The answers are held under the same stamp the traces and pictures
 * use — the last write to `transactions` and `entities` — so a correction
 * landing makes them unreachable rather than merely old, and nothing here can
 * disagree with the report a reader opens next.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import * as disk from '@/lib/cache/disk';
import { dataStamp } from '@/lib/graph/traceCache';
import { personDisplayName, personSlug } from '@/lib/graph/officers';

type Db = typeof Database;

const NS = 'methods';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LIMITS = { ttlMs: TTL_MS, maxBytes: 16 * 1024 * 1024 };

/**
 * Bump this whenever the shape below changes.
 *
 * The data stamp alone says nothing about the shape of what was written under
 * it. A held answer from before a field existed comes back with that field
 * undefined, and the page renders it as a missing figure rather than failing —
 * which is how every dollar column on this page read as a dash for as long as
 * it took to notice.
 */
const VERSION = 8;

/** One feed, and what it put in the database. */
export interface SourceCoverage {
  key: string;
  name: string;
  url: string | null;
  /** First and last filing date in this feed's rows, not when it was swept. */
  firstFiled: string | null;
  lastFiled: string | null;
  /** When the sweep last ran. */
  lastRunAt: string | null;
  records: number;
  amount: string;
  /** False for a feed that carries no money, such as the corporate records. */
  carriesMoney: boolean;
}

/** The feed that holds the corporate and Form 990 records, which move no money. */
const ORG_PROFILE_SOURCE = 'org-corporate';

/** The same feed, counted by what kind of filer it created. */
export interface SourceKinds {
  key: string;
  committee: number;
  individual: number;
  organization: number;
  party: number;
  candidate: number;
  total: number;
}

/** One entity folded into another, and what each of them was. */
export interface Fold {
  id: string;
  name: string;
  sourceKey: string | null;
  targetId: string | null;
  targetName: string | null;
  targetKind: string | null;
  targetSourceKey: string | null;
  at: string;
}

/** One name on a nonprofit's corporate record, and its page here. */
export interface NonprofitOfficer {
  name: string;
  role: string;
  slug: string;
}

/** A payer we hold corporate and tax filings for. */
export interface Nonprofit {
  id: string;
  name: string;
  taxStatus: string | null;
  corpType: string | null;
  /** The registered agent first, then the directors. */
  officers: NonprofitOfficer[];
  transactions: number;
  amount: string;
}

export interface Methods {
  sources: SourceCoverage[];
  kinds: SourceKinds[];
  folds: Fold[];
  /** Folds left off the list because nothing on file names what they folded. */
  unnamedFolds: number;
  nonprofits: Nonprofit[];
  totals: {
    records: number;
    amount: string;
    entities: number;
    firstFiled: string | null;
    lastFiled: string | null;
    sources: number;
  };
}

async function sourceCoverage(db: Db): Promise<SourceCoverage[]> {
  const rows = await db.execute<{
    key: string;
    name: string;
    url: string | null;
    first_filed: string | null;
    last_filed: string | null;
    last_run_at: string | null;
    records: string;
    amount: string;
  }>(sql`
    SELECT s.key, s.name, s.url,
           min(t.txn_date)::text        AS first_filed,
           max(t.txn_date)::text        AS last_filed,
           s.last_run_at::text          AS last_run_at,
           count(t.id)::text            AS records,
           COALESCE(sum(t.amount), 0)::text AS amount
      FROM sources s
      LEFT JOIN transactions t ON t.source_id = s.id
     GROUP BY s.id, s.key, s.name, s.url, s.last_run_at
     ORDER BY count(t.id) DESC
  `);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    url: r.url,
    firstFiled: r.first_filed,
    lastFiled: r.last_filed,
    lastRunAt: r.last_run_at,
    records: Number(r.records),
    amount: r.amount,
    carriesMoney: Number(r.records) > 0,
  }));
}

/**
 * Filers counted against the feed that first created them.
 *
 * A filer that appears in two feeds is counted once, under the one that made
 * the node. Counting every appearance instead would add up to more filers than
 * exist, and the question here is what each sweep brought in that nothing else
 * had.
 */
async function sourceKinds(db: Db): Promise<SourceKinds[]> {
  const rows = await db.execute<{
    key: string;
    kind: string;
    n: string;
  }>(sql`
    SELECT s.key, e.kind::text AS kind, count(*)::text AS n
      FROM entities e JOIN sources s ON s.id = e.source_id
     GROUP BY s.key, e.kind
  `);

  const byKey = new Map<string, SourceKinds>();
  for (const r of rows) {
    const held = byKey.get(r.key) ?? {
      key: r.key,
      committee: 0,
      individual: 0,
      organization: 0,
      party: 0,
      candidate: 0,
      total: 0,
    };
    const n = Number(r.n);
    if (r.kind === 'committee') held.committee += n;
    else if (r.kind === 'individual') held.individual += n;
    else if (r.kind === 'organization') held.organization += n;
    else if (r.kind === 'party') held.party += n;
    else if (r.kind === 'candidate') held.candidate += n;
    held.total += n;
    byKey.set(r.key, held);
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total);
}

/**
 * Every fold that can say what it folded.
 *
 * A fold whose entity is unnamed is left off rather than shown as a blank row.
 * The row would carry one fact — that something was folded into this filer —
 * and a reader cannot check that against anything. The count of them is stated
 * under the table instead, which is the same disclosure without the noise.
 */
async function folds(db: Db): Promise<Fold[]> {
  // `name` is non-null in the type because the WHERE clause below makes it so.
  const rows = await db.execute<{
    id: string;
    name: string;
    source_key: string | null;
    target_id: string | null;
    target_name: string | null;
    target_kind: string | null;
    target_source_key: string | null;
    at: string;
  }>(sql`
    SELECT t.id,
           t.name,
           fs.key           AS source_key,
           t.merged_into    AS target_id,
           e.name           AS target_name,
           e.kind::text     AS target_kind,
           ts.key           AS target_source_key,
           t.deleted_at::date::text AS at
      FROM entity_tombstones t
      LEFT JOIN sources  fs ON fs.id = t.source_id
      LEFT JOIN entities e  ON e.id  = t.merged_into
      LEFT JOIN sources  ts ON ts.id = e.source_id
     WHERE t.name IS NOT NULL
     ORDER BY t.deleted_at DESC, t.name
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sourceKey: r.source_key,
    targetId: r.target_id,
    targetName: r.target_name,
    targetKind: r.target_kind,
    targetSourceKey: r.target_source_key,
    at: r.at,
  }));
}

async function nonprofits(db: Db): Promise<Nonprofit[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    tax_status: string | null;
    corp_type: string | null;
    officers: string;
    transactions: string;
    amount: string;
  }>(sql`
    SELECT e.id, e.name, p.tax_status, p.corp_type,
           -- The officer rows rather than the board on the profile: they carry
           -- the registered agent as well as the directors, and the agent is a
           -- named person on the corporate record like any other.
           --
           -- The agent leads. Three of these share one, which is the strongest
           -- tie between them and the first thing a reader should see.
           (SELECT COALESCE(
                     jsonb_agg(jsonb_build_object('name', x.full_name, 'role', x.role,
                                                  'key', x.normalized_name)
                               ORDER BY x.role <> 'registered_agent', x.full_name),
                     '[]'::jsonb)
              FROM (SELECT DISTINCT o.full_name, o.role::text AS role, o.normalized_name
                      FROM committee_officers o
                     WHERE o.entity_id = e.id AND o.is_current) x
           )::text AS officers,
           (SELECT count(*) FROM transactions t
             WHERE t.from_entity_id = e.id OR t.to_entity_id = e.id)::text AS transactions,
           e.total_given::text AS amount
      FROM org_profiles p
      JOIN entities e ON e.id = p.entity_id
     ORDER BY e.total_given DESC, e.name
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    taxStatus: r.tax_status,
    corpType: r.corp_type,
    // Keyed on `committee_officers.normalized_name`, which is surname-first and
    // is not what `normalizeName` makes of a display name: "William S. Jones"
    // normalizes to WILLIAM S JONES and keys as JONES WILLIAM.
    officers: (JSON.parse(r.officers) as { name: string; role: string; key: string }[]).map(
      (o) => ({
        name: personDisplayName(o.key, o.name),
        role: o.role,
        slug: personSlug(o.key),
      }),
    ),
    transactions: Number(r.transactions),
    amount: r.amount,
  }));
}

async function build(db: Db): Promise<Methods> {
  const [sources, kinds, foldRows, nonprofitRows] = await Promise.all([
    sourceCoverage(db),
    sourceKinds(db),
    folds(db),
    nonprofits(db),
  ]);

  const [counts] = await db.execute<{ entities: string }>(sql`
    SELECT count(*)::text AS entities FROM entities
  `);
  const [omitted] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM entity_tombstones WHERE name IS NULL
  `);

  // The corporate and Form 990 feed reports no transactions, because it loads
  // none — it answers what a payer *is*, not what it paid. Left as zero it
  // reads as a sweep that failed, so it is counted in the records it does
  // bring in.
  const withProfiles = sources.map((s) =>
    s.key === ORG_PROFILE_SOURCE && s.records === 0
      ? { ...s, records: nonprofitRows.length }
      : s,
  );

  const dated = withProfiles.filter((s) => s.firstFiled && s.lastFiled);
  return {
    sources: withProfiles,
    kinds,
    folds: foldRows,
    unnamedFolds: Number(omitted?.n ?? 0),
    nonprofits: nonprofitRows,
    totals: {
      records: withProfiles.reduce((a, s) => a + s.records, 0),
      amount: withProfiles.reduce((a, s) => a + Number(s.amount), 0).toFixed(2),
      entities: Number(counts?.entities ?? 0),
      firstFiled: dated.map((s) => s.firstFiled!).sort()[0] ?? null,
      lastFiled: dated.map((s) => s.lastFiled!).sort().pop() ?? null,
      sources: dated.length,
    },
  };
}

/**
 * What the fold list is built from, in a form that changes when it does.
 *
 * The shared data stamp is the last write to `transactions` and `entities`,
 * and a tombstone is neither. Naming a fold after the fact writes only to
 * `entity_tombstones`, which moves no timestamp the stamp reads — so the page
 * went on saying "not recorded" against rows that had names, for as long as
 * nothing else happened to the database.
 *
 * Three aggregates over 1,664 rows, which is free, and `count(name)` is the
 * one that catches a backfill.
 */
async function foldStamp(db: Db): Promise<string> {
  const rows = await db.execute<{ stamp: string }>(sql`
    SELECT concat(count(*), '|', count(name), '|', max(deleted_at)) AS stamp
      FROM entity_tombstones
  `);
  return rows[0]?.stamp ?? 'unknown';
}

let held: { key: string; value: Promise<Methods> } | null = null;

/**
 * The whole page's figures, computed once per change to the data.
 *
 * Held in the process and on the disk store, the way a trace digest is. The
 * heaviest query here groups the whole transaction table by feed and takes
 * about a second, which is fine once a week and wrong once a reader.
 */
export async function methods(db: Db): Promise<Methods> {
  const [data, folds] = await Promise.all([dataStamp(db), foldStamp(db)]);
  const stamp = `${VERSION}|${data}|${folds}`;
  if (held?.key === stamp) return held.value;

  const file = createHash('sha1').update(`methods|${VERSION}|${stamp}`).digest('hex');
  const kept = await disk.read(NS, file, 'json').catch(() => null);
  if (kept) {
    try {
      const value = JSON.parse(kept.toString('utf8')) as Methods;
      held = { key: stamp, value: Promise.resolve(value) };
      return value;
    } catch {
      // A torn or foreign file. Compute as if it were not there.
    }
  }

  const value = build(db)
    .then((m) => {
      void disk.write(NS, file, 'json', JSON.stringify(m), LIMITS);
      return m;
    })
    // A failed build must not be remembered, or one transient database error
    // would keep answering for the next week.
    .catch((err) => {
      held = null;
      throw err;
    });

  held = { key: stamp, value };
  return value;
}
