/**
 * A candidate as a person, rather than as the several filings they leave behind.
 *
 * Florida gives one politician a campaign account per office sought and, very
 * often, an affiliated political committee alongside it. Blaise Ingoglia is
 * three entities: `Friends of Blaise Ingoglia` ($7.0M), `Ingoglia, Blaise
 * (REP)(CFO)` ($2.2M) and `Ingoglia, Blaise (REP)(STS)` ($184K). Linking to any
 * one of them shows a reader a fraction of the money.
 *
 * This resolves a name to that set. `ledger.ts` and `trace.ts` already take a
 * list of entity ids, so everything downstream works unchanged.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

type Db = PostgresJsDatabase<typeof schema>;

/** Office codes the state appends to a candidate's filed name. */
export const OFFICE_LABELS: Record<string, string> = {
  STR: 'State Representative',
  STS: 'State Senator',
  GOV: 'Governor',
  CFO: 'Chief Financial Officer',
  ATG: 'Attorney General',
  AGR: 'Commissioner of Agriculture',
  CTJ: 'County Judge',
  STA: 'State Attorney',
  PUB: 'Public Defender',
};

export interface PersonPart {
  id: string;
  name: string;
  kind: string;
  /** Office sought on this filing, when the name carries a code. */
  office: string | null;
  officeLabel: string | null;
  party: string | null;
  totalReceived: string;
  totalGiven: string;
}

export interface PersonSubject {
  last: string;
  first: string;
  /** Display name, in the order a person would say it. */
  name: string;
  entityIds: string[];
  parts: PersonPart[];
  /** Distinct office codes across the filings, most money first. */
  offices: string[];
  totalReceived: string;
  totalGiven: string;
  /**
   * Entities sharing the surname whose first name did not agree. Deliberately
   * NOT folded into the totals — surfaced so a page can say "there are other
   * people called Smith" instead of quietly attributing their money.
   */
  sameSurname: { id: string; name: string; kind: string }[];
}

/** `Ingoglia, Blaise  (REP)(CFO)` → office `CFO`, party `REP`. */
function parseCodes(name: string): { party: string | null; office: string | null } {
  const m = name.match(/\(([A-Z]{2,4})\)\s*\(([A-Z]{2,4})\)\s*$/);
  return m ? { party: m[1], office: m[2] } : { party: null, office: null };
}

/**
 * Find every filing belonging to one person.
 *
 * The surname is required; the given name only has to agree, where agreeing
 * includes one being a prefix of the other. That is what lets `Friends of Bev
 * Slough` resolve for a search on Beverly Slough, while keeping David, Carlos
 * and Jason Smith away from a search for John Smith — a real result, not a
 * hypothetical: the surname alone returns 23 entities for Smith.
 */
export async function resolvePerson(
  db: Db,
  last: string,
  first: string,
): Promise<PersonSubject | null> {
  if (!last.trim() || !first.trim()) return null;

  const rows = await db.execute<{
    id: string;
    name: string;
    kind: string;
    total_received: string;
    total_given: string;
    agrees: boolean;
  }>(sql`
    SELECT e.id, e.name, e.kind::text AS kind,
           e.total_received::text AS total_received,
           e.total_given::text    AS total_given,
           EXISTS (
             SELECT 1 FROM regexp_split_to_table(e.normalized_name, '[^A-Z0-9]+') t
              WHERE t = upper(${first})
                 OR (length(t) >= 3 AND length(${first}) >= 3
                     AND (t LIKE upper(${first}) || '%' OR upper(${first}) LIKE t || '%'))
           ) AS agrees
      FROM entities e
     WHERE e.kind IN ('candidate', 'committee')
       AND e.normalized_name ~ ('(^|[^A-Z])' || upper(${last}) || '([^A-Z]|$)')
     ORDER BY e.total_received DESC
  `);

  const mine = rows.filter((r) => r.agrees);
  if (mine.length === 0) return null;

  const parts: PersonPart[] = mine.map((r) => {
    const { party, office } = parseCodes(r.name);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      office,
      officeLabel: office ? (OFFICE_LABELS[office] ?? office) : null,
      party,
      totalReceived: r.total_received,
      totalGiven: r.total_given,
    };
  });

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  return {
    last,
    first,
    name: `${cap(first)} ${cap(last)}`,
    entityIds: parts.map((p) => p.id),
    parts,
    offices: [...new Set(parts.map((p) => p.office).filter((o): o is string => o !== null))],
    totalReceived: parts.reduce((a, p) => a + Number(p.totalReceived), 0).toFixed(2),
    totalGiven: parts.reduce((a, p) => a + Number(p.totalGiven), 0).toFixed(2),
    sameSurname: rows
      .filter((r) => !r.agrees)
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
  };
}
