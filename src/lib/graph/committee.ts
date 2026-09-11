/**
 * A committee addressed by its name rather than by its id.
 *
 * A mailer carries a disclaimer naming whoever paid for it, and nothing else.
 * Somebody holding that mailer can read a name; they cannot know the internal
 * id of the committee behind it. This turns the name into a URL and back, so
 * the report is reachable from the only fact the reader actually has.
 *
 * The slug is the entity's `normalized_name` in lower case with the spaces
 * turned into hyphens. That form was chosen because it is already stored and
 * already indexed: `normalizeName` folds case, punctuation and accents away, so
 * "Keep Florida Great" and "KEEP FLORIDA GREAT," both arrive at
 * `keep-florida-great` without a second column to maintain.
 *
 * Names are not unique, and pretending otherwise is how two committees become
 * one wrong answer. Three separate committees file as "Florida Forward". A
 * lookup therefore returns every match, biggest first, and the page asks the
 * reader which one they mean.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { normalizeName } from '@/lib/normalize';

type Db = PostgresJsDatabase<typeof schema>;

/** What can pay for a mailer. Candidates and donors are out of scope here. */
const KINDS = sql`('committee', 'party')`;

/** `Keep Florida Great` → `keep-florida-great`. */
export function committeeSlug(name: string): string {
  return normalizeName(name).toLowerCase().replace(/ /g, '-');
}

/**
 * `keep-florida-great` → `KEEP FLORIDA GREAT`.
 *
 * Runs the slug back through `normalizeName` rather than merely upper-casing
 * it, so a hand-typed or hand-edited URL folds to the same key a generated one
 * does — `Keep--Florida_Great` included.
 */
export function slugToNormalizedName(slug: string): string {
  return normalizeName(slug.replace(/[-_]+/g, ' '));
}

export interface CommitteeSubject {
  id: string;
  name: string;
  slug: string;
  kind: string;
  committeeType: string | null;
  /** Spelled-out registration type, when the filing office publishes one. */
  typeDescription: string | null;
  status: string;
  city: string | null;
  stateCode: string | null;
  countyName: string | null;
  /** The filing office's own identifier, which is what tells two same-named committees apart. */
  accountNumber: string | null;
  totalReceived: string;
  totalGiven: string;
  inDegree: number;
  outDegree: number;
  /** Dates of the first and last transaction on file, either side. */
  firstDate: string | null;
  lastDate: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  type_description: string | null;
  status: string;
  city: string | null;
  state_code: string | null;
  county_name: string | null;
  account_number: string | null;
  total_received: string;
  total_given: string;
  in_degree: number;
  out_degree: number;
  first_date: string | null;
  last_date: string | null;
}

function toSubject(r: Row): CommitteeSubject {
  return {
    id: r.id,
    name: r.name,
    slug: committeeSlug(r.name),
    kind: r.kind,
    committeeType: r.committee_type,
    typeDescription: r.type_description,
    status: r.status,
    city: r.city,
    stateCode: r.state_code,
    countyName: r.county_name,
    accountNumber: r.account_number,
    totalReceived: r.total_received,
    totalGiven: r.total_given,
    inDegree: r.in_degree,
    outDegree: r.out_degree,
    firstDate: r.first_date,
    lastDate: r.last_date,
  };
}

/**
 * The registration the filing office currently publishes, plus the span of
 * activity on file.
 *
 * Both are lateral joins rather than grouped joins: a committee can hold
 * several registration rows (superseded ones are kept for history) and
 * hundreds of thousands of transactions, and neither should multiply the
 * entity row on its way out.
 */
const DETAIL = sql`
  LEFT JOIN LATERAL (
    SELECT r.external_id, r.type_description, r.county_name
      FROM committee_registrations r
     WHERE r.entity_id = e.id
     ORDER BY r.is_current DESC, r.observed_at DESC
     LIMIT 1
  ) reg ON true
  LEFT JOIN LATERAL (
    SELECT min(t.txn_date)::text AS first_date, max(t.txn_date)::text AS last_date
      FROM transactions t
     WHERE t.to_entity_id = e.id OR t.from_entity_id = e.id
  ) span ON true
`;

const COLUMNS = sql`
  e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
  e.status::text AS status, e.city, e.state_code,
  e.total_received::text AS total_received, e.total_given::text AS total_given,
  e.in_degree, e.out_degree,
  reg.external_id AS account_number, reg.type_description, reg.county_name,
  span.first_date, span.last_date
`;

/**
 * Every committee filing under one name, biggest first.
 *
 * Empty when the name is unknown. More than one when the name is shared, which
 * the caller has to resolve rather than quietly take the first of.
 */
export async function committeesBySlug(db: Db, slug: string): Promise<CommitteeSubject[]> {
  const needle = slugToNormalizedName(slug);
  if (!needle) return [];

  const rows = await db.execute<Row>(sql`
    SELECT ${COLUMNS}
      FROM entities e ${DETAIL}
     WHERE e.kind IN ${KINDS} AND e.normalized_name = ${needle}
     ORDER BY e.total_received DESC, e.name
  `);
  return rows.map(toSubject);
}

/** One committee by id, for a link that pins which of several same-named ones it means. */
export async function committeeById(db: Db, id: string): Promise<CommitteeSubject | null> {
  const rows = await db.execute<Row>(sql`
    SELECT ${COLUMNS}
      FROM entities e ${DETAIL}
     WHERE e.id = ${id}::uuid AND e.kind IN ${KINDS}
  `);
  return rows.length > 0 ? toSubject(rows[0]) : null;
}

export interface CommitteeHit {
  id: string;
  name: string;
  slug: string;
  kind: string;
  committeeType: string | null;
  status: string;
  city: string | null;
  stateCode: string | null;
  totalReceived: string;
  totalGiven: string;
  /**
   * Whether another committee files under the same name.
   *
   * Decides how a link to this committee is written. A unique name needs
   * nothing but its slug, which is the readable URL worth sharing. A shared
   * one needs the id pinned to it, or the link lands on a page that has to
   * stop and ask which of them was meant.
   */
  sharesName: boolean;
}

/**
 * A link to one committee's report.
 *
 * Carries the id only where the name alone would be ambiguous, so the common
 * case stays `/kym/keep-florida-great`.
 */
export function committeeHref(hit: { id: string; slug: string; sharesName: boolean }): string {
  return hit.sharesName ? `/kym/${hit.slug}?id=${hit.id}` : `/kym/${hit.slug}`;
}

/** Committees sharing a name, counted per row so a link knows whether to pin an id. */
const NAMESAKES = sql`
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n
      FROM entities x
     WHERE x.kind IN ('committee', 'party')
       AND x.normalized_name = e.normalized_name
  ) dup ON true
`;

const HIT_COLUMNS = sql`
  e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
  e.status::text AS status, e.city, e.state_code,
  e.total_received::text AS total_received,
  e.total_given::text    AS total_given,
  dup.n > 1 AS shares_name
`;

interface HitRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  status: string;
  city: string | null;
  state_code: string | null;
  total_received: string;
  total_given: string;
  shares_name: boolean;
}

function toHit(r: HitRow): CommitteeHit {
  return {
    id: r.id,
    name: r.name,
    slug: committeeSlug(r.name),
    kind: r.kind,
    committeeType: r.committee_type,
    status: r.status,
    city: r.city,
    stateCode: r.state_code,
    totalReceived: r.total_received,
    totalGiven: r.total_given,
    sharesName: r.shares_name,
  };
}

/**
 * Committees whose name looks like what was typed.
 *
 * Serves the search box and the not-found page, which want the same thing: a
 * short list of plausible committees for a string that may be misremembered
 * off a mailer. Ranks on trigram similarity, lifts prefix matches because that
 * is what a person typing means, and lifts committees with money behind them
 * because a dormant namesake is rarely the one being asked about.
 */
export async function searchCommittees(
  db: Db,
  query: string,
  limit = 12,
): Promise<CommitteeHit[]> {
  const needle = normalizeName(query);
  if (needle.length < 2) return [];

  const rows = await db.execute<HitRow>(sql`
    SELECT ${HIT_COLUMNS}
      FROM entities e ${NAMESAKES}
     WHERE e.kind IN ${KINDS}
       AND (e.normalized_name % ${needle} OR e.normalized_name LIKE ${'%' + needle + '%'})
     ORDER BY (
             similarity(e.normalized_name, ${needle})
             + CASE WHEN e.normalized_name LIKE ${needle + '%'} THEN 0.35 ELSE 0 END
             + LEAST(COALESCE(e.total_received, 0) / 5000000.0, 0.15)
           ) DESC,
           e.total_received DESC
     LIMIT ${limit}
  `);

  return rows.map(toHit);
}

/**
 * The committees that move the most money, for a landing page with nothing
 * typed into it yet.
 *
 * Ordered by money paid out rather than money raised. The subject here is a
 * mailer, and a committee that raises millions and spends none of it never
 * sent one.
 */
export async function busiestCommittees(db: Db, limit = 12): Promise<CommitteeHit[]> {
  const rows = await db.execute<HitRow>(sql`
    SELECT ${HIT_COLUMNS}
      FROM entities e ${NAMESAKES}
     WHERE e.kind IN ${KINDS}
     ORDER BY e.total_given DESC
     LIMIT ${limit}
  `);

  return rows.map(toHit);
}
