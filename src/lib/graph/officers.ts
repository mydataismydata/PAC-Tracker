/**
 * A person named on committee filings, treated as a subject in their own right.
 *
 * The graph's nodes are entities that hold money. A treasurer is not one — but
 * asking what a hundred committees with one treasurer raised between them is a
 * reasonable question, and the answer is the union of their ledgers. This
 * resolves an officer key to that set; `ledger.ts` and `trace.ts` take it from
 * there.
 *
 * Two subjects live here, and they are keyed differently on purpose.
 *
 * `officerSubject` is keyed `role:normalizedName`, matching the id the crawler
 * gives an officer hub node, so a hub selected on the canvas can look itself
 * up. One hub is one role.
 *
 * `personNetwork` is keyed on the name alone and gathers every role. A quarter
 * of the people in the filings hold more than one — the chair of a committee
 * is very often also its treasurer — and splitting them by role would hand a
 * reader two pages for one person with the same committees on both.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { committeeSlug } from '@/lib/graph/committee';

type Db = PostgresJsDatabase<typeof schema>;

/** How the filing offices' role codes are written for a reader. */
export const ROLE_LABELS: Record<string, string> = {
  chair: 'Chair',
  treasurer: 'Treasurer',
  deputy_treasurer: 'Deputy treasurer',
  registered_agent: 'Registered agent',
  director: 'Director',
  other: 'Officer',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

/** Several roles held by one person, written as a phrase: "Chair, treasurer and agent". */
export function rolePhrase(roles: string[]): string {
  const parts = roles.map((r, i) => (i === 0 ? roleLabel(r) : roleLabel(r).toLowerCase()));
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * A person's normalized name as a URL segment, and back.
 *
 * The same trick the committee slug uses, and safe for the same reason: every
 * `committee_officers.normalized_name` in the database is letters, digits and
 * spaces only, so hyphenating the spaces is reversible.
 */
export function personSlug(normalizedName: string): string {
  return normalizedName.toLowerCase().replace(/ /g, '-');
}

export function slugToOfficerName(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OfficerSubject {
  role: string;
  normalizedName: string;
  /** Every spelling filed for this person, most common first. */
  spellings: string[];
  /** Best display name: the spelling the most committees used. */
  name: string;
  entityIds: string[];
  committees: number;
  totalReceived: string;
  totalGiven: string;
}

/**
 * Split an officer node id into its parts.
 *
 * Ids look like `officer:treasurer:JONES WILLIAM`. The name may contain
 * colons in principle, so only the first two segments are split off.
 */
export function parseOfficerKey(raw: string): { role: string; normalizedName: string } | null {
  const withoutPrefix = raw.startsWith('officer:') ? raw.slice('officer:'.length) : raw;
  const idx = withoutPrefix.indexOf(':');
  if (idx <= 0) return null;
  const role = withoutPrefix.slice(0, idx);
  const normalizedName = withoutPrefix.slice(idx + 1);
  if (!role || !normalizedName) return null;
  return { role, normalizedName };
}

export interface EntityOfficer {
  role: string;
  fullName: string;
  normalizedName: string;
  /** How many committees name this person in this role, including this one. */
  committees: number;
  /**
   * How many committees name this person at all, in any role.
   *
   * The number that belongs beside a link to their own page, because that page
   * is keyed on the name rather than the role and shows exactly this many.
   */
  network: number;
  /** Node id for the officer hub, so the header can link straight to it. */
  nodeId: string;
  /** URL segment for this person's own page, which covers every role they hold. */
  slug: string;
}

/**
 * Who one committee reports as running it.
 *
 * Carries the committee count per person, because that number is what decides
 * whether a shared name means anything: named on three committees is a finding,
 * named on 107 is a filing agent. Showing the name without it invites the
 * wrong reading.
 */
export async function officersForEntity(db: Db, entityId: string): Promise<EntityOfficer[]> {
  const rows = await db.execute<{
    role: string;
    full_name: string;
    normalized_name: string;
    committees: number;
    network: number;
  }>(sql`
    SELECT o.role::text AS role, o.full_name, o.normalized_name,
           (SELECT count(*)::int FROM committee_officers p
             WHERE p.is_current AND p.role = o.role
               AND p.normalized_name = o.normalized_name) AS committees,
           (SELECT count(DISTINCT p.entity_id)::int FROM committee_officers p
             WHERE p.is_current AND p.normalized_name = o.normalized_name) AS network
      FROM committee_officers o
     WHERE o.entity_id = ${entityId} AND o.is_current
     ORDER BY CASE o.role::text WHEN 'chair' THEN 0 WHEN 'treasurer' THEN 1 ELSE 2 END
  `);
  return rows.map((r) => ({
    role: r.role,
    fullName: r.full_name,
    normalizedName: r.normalized_name,
    committees: r.committees,
    network: r.network,
    nodeId: `officer:${r.role}:${r.normalized_name}`,
    slug: personSlug(r.normalized_name),
  }));
}

export async function officerSubject(
  db: Db,
  role: string,
  normalizedName: string,
  cycle?: string,
): Promise<OfficerSubject | null> {
  const rows = await db.execute<{
    entity_id: string;
    full_name: string;
    total_received: string;
    total_given: string;
  }>(sql`
    SELECT o.entity_id, o.full_name,
           ${cycle
             ? sql`COALESCE(ct.total_received, 0)::text AS total_received,
                   COALESCE(ct.total_given, 0)::text    AS total_given`
             : sql`e.total_received::text AS total_received,
                   e.total_given::text    AS total_given`}
      FROM committee_officers o
      JOIN entities e ON e.id = o.entity_id
      ${cycle
        ? sql`LEFT JOIN entity_cycle_totals ct
                ON ct.entity_id = o.entity_id AND ct.election_cycle = ${cycle}`
        : sql``}
     WHERE o.is_current
       AND o.role::text = ${role}
       AND o.normalized_name = ${normalizedName}
  `);
  if (rows.length === 0) return null;

  // The filed spellings differ — that is the point of keying on a normalized
  // form — so the display name is whichever the most committees used rather
  // than whichever the database happened to return first.
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.full_name, (counts.get(r.full_name) ?? 0) + 1);
  const spellings = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);

  return {
    role,
    normalizedName,
    spellings,
    name: spellings[0],
    entityIds: rows.map((r) => r.entity_id),
    committees: rows.length,
    totalReceived: rows.reduce((a, r) => a + Number(r.total_received), 0).toFixed(2),
    totalGiven: rows.reduce((a, r) => a + Number(r.total_given), 0).toFixed(2),
  };
}

export interface PersonCommittee {
  id: string;
  name: string;
  slug: string;
  kind: string;
  committeeType: string | null;
  status: string;
  city: string | null;
  stateCode: string | null;
  /** Every role this person holds on this one committee, in filing order. */
  roles: string[];
  totalReceived: string;
  totalGiven: string;
  /** Whether another committee files under the same name, so a link knows to pin an id. */
  sharesName: boolean;
}

export interface PersonNetwork {
  normalizedName: string;
  slug: string;
  /** Best display name: the spelling the most filings used. */
  name: string;
  /** Every spelling on file, most common first. */
  spellings: string[];
  /** Roles held, most committees first. */
  roles: { role: string; committees: number }[];
  entityIds: string[];
  committees: PersonCommittee[];
  totalReceived: string;
  totalGiven: string;
}

/**
 * Everything one person is named on, across every role.
 *
 * The committees come back whole rather than as a count, because the count on
 * its own is the thing that misleads: named on three committees is a finding,
 * named on 229 is a filing practice, and only the list says which this is.
 *
 * Totals are summed per committee, not per filing. Somebody who is both chair
 * and treasurer of one committee appears on two rows in the source table, and
 * adding both would report its money twice.
 */
export async function personNetwork(
  db: Db,
  normalizedName: string,
): Promise<PersonNetwork | null> {
  if (!normalizedName) return null;

  const rows = await db.execute<{
    entity_id: string;
    full_name: string;
    role: string;
    name: string;
    kind: string;
    committee_type: string | null;
    status: string;
    city: string | null;
    state_code: string | null;
    total_received: string;
    total_given: string;
    shares_name: boolean;
  }>(sql`
    SELECT o.entity_id, o.full_name, o.role::text AS role,
           e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.city, e.state_code,
           e.total_received::text AS total_received,
           e.total_given::text    AS total_given,
           dup.n > 1 AS shares_name
      FROM committee_officers o
      JOIN entities e ON e.id = o.entity_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n
          FROM entities x
         WHERE x.kind IN ('committee', 'party')
           AND x.normalized_name = e.normalized_name
      ) dup ON true
     WHERE o.is_current AND o.normalized_name = ${normalizedName}
     ORDER BY e.total_received DESC, e.name,
              CASE o.role::text WHEN 'chair' THEN 0 WHEN 'treasurer' THEN 1 ELSE 2 END
  `);
  if (rows.length === 0) return null;

  const committees = new Map<string, PersonCommittee>();
  const roleCounts = new Map<string, Set<string>>();
  const spellingCounts = new Map<string, number>();

  for (const r of rows) {
    spellingCounts.set(r.full_name, (spellingCounts.get(r.full_name) ?? 0) + 1);

    if (!roleCounts.has(r.role)) roleCounts.set(r.role, new Set());
    roleCounts.get(r.role)!.add(r.entity_id);

    const held = committees.get(r.entity_id);
    if (held) {
      held.roles.push(r.role);
      continue;
    }
    committees.set(r.entity_id, {
      id: r.entity_id,
      name: r.name,
      slug: committeeSlug(r.name),
      kind: r.kind,
      committeeType: r.committee_type,
      status: r.status,
      city: r.city,
      stateCode: r.state_code,
      roles: [r.role],
      totalReceived: r.total_received,
      totalGiven: r.total_given,
      sharesName: r.shares_name,
    });
  }

  const spellings = [...spellingCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([spelling]) => spelling);
  const list = [...committees.values()];

  return {
    normalizedName,
    slug: personSlug(normalizedName),
    name: spellings[0],
    spellings,
    roles: [...roleCounts.entries()]
      .map(([role, ids]) => ({ role, committees: ids.size }))
      .sort((a, b) => b.committees - a.committees),
    entityIds: list.map((c) => c.id),
    committees: list,
    totalReceived: list.reduce((a, c) => a + Number(c.totalReceived), 0).toFixed(2),
    totalGiven: list.reduce((a, c) => a + Number(c.totalGiven), 0).toFixed(2),
  };
}
