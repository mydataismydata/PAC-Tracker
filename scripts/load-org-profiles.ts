/**
 * Load hand-gathered corporate / Form 990 profiles for the dark-money nonprofits
 * that fund the Stafford Jones network, and the governance links between them.
 *
 * These orgs are 501(c)(4)s and nonprofit corporations, not campaign committees:
 * they file with the Division of Corporations and the IRS, not the Division of
 * Elections, so their donors never enter the graph. What is public is their
 * governance, and that is what links them — a shared registered agent or board
 * member ties the shells together the way a shared treasurer ties committees.
 *
 * The registered agent and each director go into `committee_officers` under a
 * corporate source, so the officer-hub machinery already in the crawler links
 * them with no further code. The corporate and 990 facts go into `org_profiles`
 * for the Details panel.
 *
 * This is a manual stopgap for the researched orgs. An automated Sunbiz + IRS
 * ingest is the eventual replacement; until then, run: pnpm tsx scripts/load-org-profiles.ts
 */

import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { officerKey } from '@/lib/normalize';

const CORP_SOURCE_KEY = 'org-corporate';
const CORP_SOURCE_NAME = 'Corporate & Form 990 records (FL Division of Corporations, IRS)';

interface Person {
  first: string;
  last: string;
  display: string;
  title?: string;
}
interface OrgProfile {
  entityId: string;
  corpType: string;
  taxStatus?: string;
  is527: boolean;
  ein?: string;
  docNumber?: string;
  status: string;
  filedDate?: string;
  address?: string;
  registeredAgent?: Person;
  directors: Person[];
  mission?: string;
  website?: string;
  financials?: Record<string, Record<string, number>>;
  donorsRestricted: boolean;
  note?: string;
}

const COATES: Person = { first: 'Richard', last: 'Coates', display: 'Richard E. Coates' };
const JONES: Person = { first: 'William', last: 'Jones', display: 'William S. Jones' };

const ORGS: OrgProfile[] = [
  {
    entityId: '98bb50e1-676a-4ceb-8fb6-57279e26d353',
    corpType: 'Florida Not-For-Profit Corporation',
    taxStatus: '501(c)(4)',
    is527: false,
    ein: '87-4361946',
    docNumber: 'N22000000639',
    status: 'Active',
    filedDate: '2022-01-27',
    address: '115 East Park Avenue, Suite 1, Tallahassee, FL 32301',
    registeredAgent: COATES,
    directors: [
      { ...JONES, title: 'Chairman' },
      { first: 'Walt', last: 'Boyer', display: 'Walt Boyer' },
      { first: 'Ann', last: 'Stone', display: 'Ann Stone' },
    ],
    mission: 'Issue Advocacy',
    financials: {
      revenue: { '2022': 4238600, '2023': 616806, '2024': 2135289 },
      grantsPaid: { '2023': 340856, '2024': 1508500 },
    },
    donorsRestricted: true,
    note: 'Form 990 Schedule B contributors are marked RESTRICTED. Not a 527 (no IRS 8871/8872).',
  },
  {
    entityId: '8638a0a1-a078-46dd-a1b9-2994feba33f6',
    corpType: 'Florida Not-For-Profit Corporation',
    is527: false,
    ein: '46-5701159',
    docNumber: 'N14000004688',
    status: 'Inactive (admin dissolved 2022-09-23)',
    filedDate: '2014-05-15',
    address: '115 East Park Avenue, Suite 1, Tallahassee, FL 32301',
    registeredAgent: COATES,
    directors: [{ ...JONES, title: 'Director' }],
    donorsRestricted: true,
    note: 'Same address and registered agent as Economic Improvement Fund; William Jones is the sole director.',
  },
  {
    entityId: 'd5752ce0-ddd4-4e79-a623-ea9294ae0bc6',
    corpType: 'Florida Not-For-Profit Corporation',
    taxStatus: '501(c)(4)',
    is527: false,
    ein: '82-3058657',
    docNumber: 'N17000010260',
    status: 'Active',
    filedDate: '2017-10-11',
    address: '136 S. Bronough St, Tallahassee, FL 32301 (Florida Chamber HQ)',
    registeredAgent: COATES,
    directors: [
      { first: 'Mark', last: 'Wilson', display: 'Mark A. Wilson', title: 'Director, Chairman, President' },
      { first: 'Frank', last: 'Walker', display: 'Frank Walker', title: 'Director, VP' },
      { first: 'Parker', last: 'DeWitt', display: 'Parker DeWitt', title: 'Treasurer' },
    ],
    donorsRestricted: true,
    note: 'Registered agent Richard E. Coates at 115 East Park Avenue, Suite 1. Directors are Florida Chamber of Commerce officers.',
  },
];

async function main() {
  const [source] = await db.execute<{ id: string }>(sql`
    INSERT INTO sources (key, name) VALUES (${CORP_SOURCE_KEY}, ${CORP_SOURCE_NAME})
    ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  const sourceId = source.id;

  for (const org of ORGS) {
    await db.execute(sql`
      INSERT INTO org_profiles (
        entity_id, corp_type, tax_status, is_527, ein, doc_number, status, filed_date,
        address, registered_agent, mission, website, board, financials, donors_restricted, note, updated_at
      ) VALUES (
        ${org.entityId}, ${org.corpType}, ${org.taxStatus ?? null}, ${org.is527}, ${org.ein ?? null},
        ${org.docNumber ?? null}, ${org.status}, ${org.filedDate ?? null}, ${org.address ?? null},
        ${org.registeredAgent?.display ?? null}, ${org.mission ?? null}, ${org.website ?? null},
        ${JSON.stringify(org.directors.map((d) => ({ name: d.display, title: d.title })))}::jsonb,
        ${org.financials ? JSON.stringify(org.financials) : null}::jsonb,
        ${org.donorsRestricted}, ${org.note ?? null}, now()
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
      DELETE FROM committee_officers WHERE entity_id = ${org.entityId} AND source_id = ${sourceId}
    `);

    const people: { role: 'registered_agent' | 'director'; p: Person }[] = [];
    if (org.registeredAgent) people.push({ role: 'registered_agent', p: org.registeredAgent });
    for (const d of org.directors) people.push({ role: 'director', p: d });

    for (const { role, p } of people) {
      const key = officerKey(p.last, p.first);
      if (!key) continue;
      await db.execute(sql`
        INSERT INTO committee_officers (entity_id, source_id, role, full_name, normalized_name, is_current)
        VALUES (${org.entityId}, ${sourceId}, ${role}::officer_role, ${p.display}, ${key}, true)
      `);
    }

    console.log(`  ${org.entityId.slice(0, 8)}  ${org.corpType}  agent+${org.directors.length} directors`);
  }

  console.log(`\nLoaded ${ORGS.length} org profiles and their governance links.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
