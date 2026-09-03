/**
 * The corporate / Form 990 profile of an entity that is a nonprofit rather than
 * a campaign committee, and the labels that keep the two kinds of role apart.
 *
 * A committee's chair and treasurer are campaign-finance appointments; a
 * corporation's chairman, board, and registered agent are corporate governance.
 * The graph stores both in `committee_officers`, so the display has to name them
 * differently — "PAC Treasurer" is not the same office as "Registered agent".
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

type Db = PostgresJsDatabase<typeof schema>;

export interface OrgProfile {
  corpType: string | null;
  taxStatus: string | null;
  is527: boolean | null;
  ein: string | null;
  docNumber: string | null;
  status: string | null;
  filedDate: string | null;
  address: string | null;
  registeredAgent: string | null;
  mission: string | null;
  website: string | null;
  board: { name: string; title?: string }[] | null;
  financials: Record<string, Record<string, number>> | null;
  donorsRestricted: boolean | null;
  note: string | null;
}

/** The org profile for one entity, or null when it has none. */
export async function orgProfileForEntity(db: Db, entityId: string): Promise<OrgProfile | null> {
  const rows = await db.execute(sql`
    SELECT corp_type AS "corpType", tax_status AS "taxStatus", is_527 AS "is527", ein,
           doc_number AS "docNumber", status, filed_date::text AS "filedDate", address,
           registered_agent AS "registeredAgent", mission, website, board, financials,
           donors_restricted AS "donorsRestricted", note
      FROM org_profiles WHERE entity_id = ${entityId}
  `);
  return (rows[0] as unknown as OrgProfile) ?? null;
}

/**
 * How a `committee_officers` role reads in the panel.
 *
 * Committee appointments are prefixed "PAC" so they never read as the office of
 * the same name at a corporation; corporate roles get their own plain labels.
 */
export function officerRoleLabel(role: string): string {
  switch (role) {
    case 'chair':
      return 'PAC Chair';
    case 'treasurer':
      return 'PAC Treasurer';
    case 'deputy_treasurer':
      return 'PAC Deputy Treasurer';
    case 'registered_agent':
      return 'Registered agent';
    case 'director':
      return 'Board member';
    default:
      return 'Officer';
  }
}
