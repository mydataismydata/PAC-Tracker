/**
 * Write an assembled org profile to the graph.
 *
 * Two tables carry it. `org_profiles` holds the corporate and 990 facts the
 * Details panel shows. `committee_officers` holds the registered agent and the
 * board as officer rows, so the crawler's registration-link machinery ties
 * these shells together on a shared agent with no code of its own — the same
 * mechanism a shared treasurer uses between committees.
 *
 * Both writes converge on re-run: the profile upserts on the entity, and the
 * officers are replaced wholesale for this entity-and-source. The source key is
 * the one the hand loader used, so this adopts and overwrites its rows rather
 * than leaving a second copy behind.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { officerKey } from '@/lib/normalize';
import type { BuiltProfile } from './adapter';

type Db = PostgresJsDatabase<typeof schema>;

const SOURCE_KEY = 'org-corporate';
const SOURCE_NAME = 'Corporate & Form 990 records (FL Division of Corporations, IRS via ProPublica)';

/** The source that stands for these mixed corporate/990 records. */
export async function ensureOrgProfileSource(db: Db): Promise<string> {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO sources (key, name) VALUES (${SOURCE_KEY}, ${SOURCE_NAME})
    ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  return row.id;
}

/** Upsert one profile and replace its governance officers. */
export async function upsertProfile(db: Db, sourceId: string, p: BuiltProfile): Promise<void> {
  await db.execute(sql`
    INSERT INTO org_profiles (
      entity_id, corp_type, tax_status, is_527, ein, doc_number, status, filed_date,
      address, registered_agent, mission, website, board, financials, donors_restricted, note, updated_at
    ) VALUES (
      ${p.entityId}, ${p.corpType}, ${p.taxStatus}, ${p.is527}, ${p.ein},
      ${p.docNumber}, ${p.status}, ${p.filedDate}, ${p.address},
      ${p.registeredAgent}, ${p.mission}, ${p.website},
      ${JSON.stringify(p.board)}::jsonb,
      ${p.financials ? JSON.stringify(p.financials) : null}::jsonb,
      ${p.donorsRestricted}, ${p.note}, now()
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      corp_type = EXCLUDED.corp_type, tax_status = EXCLUDED.tax_status, is_527 = EXCLUDED.is_527,
      ein = EXCLUDED.ein, doc_number = EXCLUDED.doc_number, status = EXCLUDED.status,
      filed_date = EXCLUDED.filed_date, address = EXCLUDED.address,
      registered_agent = EXCLUDED.registered_agent, mission = EXCLUDED.mission,
      website = EXCLUDED.website, board = EXCLUDED.board, financials = EXCLUDED.financials,
      donors_restricted = EXCLUDED.donors_restricted, note = EXCLUDED.note, updated_at = now()
  `);

  // Replace this source's officer rows for the entity, so a re-run converges.
  await db.execute(sql`
    DELETE FROM committee_officers WHERE entity_id = ${p.entityId} AND source_id = ${sourceId}
  `);

  for (const { role, person } of p.people) {
    const key = officerKey(person.last, person.first);
    if (!key) continue;
    await db.execute(sql`
      INSERT INTO committee_officers (entity_id, source_id, role, full_name, normalized_name, is_current)
      VALUES (${p.entityId}, ${sourceId}, ${role}::officer_role, ${person.display}, ${key}, true)
    `);
  }
}
