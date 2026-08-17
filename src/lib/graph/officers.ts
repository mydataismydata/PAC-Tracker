/**
 * A person named on committee filings, treated as a subject in their own right.
 *
 * The graph's nodes are entities that hold money. A treasurer is not one — but
 * asking what a hundred committees with one treasurer raised between them is a
 * reasonable question, and the answer is the union of their ledgers. This
 * resolves an officer key to that set; `ledger.ts` and `trace.ts` take it from
 * there.
 *
 * The key is `role:normalizedName`, matching the id the crawler gives an
 * officer hub node, so a hub selected on the canvas can look itself up.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

type Db = PostgresJsDatabase<typeof schema>;

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
  /** Node id for the officer hub, so the header can link straight to it. */
  nodeId: string;
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
  }>(sql`
    SELECT o.role::text AS role, o.full_name, o.normalized_name,
           (SELECT count(*)::int FROM committee_officers p
             WHERE p.is_current AND p.role = o.role
               AND p.normalized_name = o.normalized_name) AS committees
      FROM committee_officers o
     WHERE o.entity_id = ${entityId} AND o.is_current
     ORDER BY CASE o.role::text WHEN 'chair' THEN 0 WHEN 'treasurer' THEN 1 ELSE 2 END
  `);
  return rows.map((r) => ({
    role: r.role,
    fullName: r.full_name,
    normalizedName: r.normalized_name,
    committees: r.committees,
    nodeId: `officer:${r.role}:${r.normalized_name}`,
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
