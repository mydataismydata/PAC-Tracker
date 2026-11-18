/**
 * The committees an officeholder raises money for, beyond their own accounts.
 *
 * `resolvePerson` finds a politician's filings by name, which finds the
 * campaign accounts and any "Friends of" committee. It cannot find the
 * committee that carries the big money under a name of its own — Stan
 * McClain's "Liberty for Florida", Blaise Ingoglia's "Government Gone Wild
 * PAC" — because nothing in that committee's filings names him.
 *
 * Two records do. The officeholder's Statement of Solicitation, which Florida
 * law requires and the Division of Elections publishes (`solicitations`), is
 * the strong one. A committee registration naming them as chair is the other.
 *
 * Matched to the page's person the way `resolvePerson` matches filings:
 * surname exact, given name agreeing. Agreement here also accepts the common
 * nicknames, because the state lists "Leek, Thomas" for one committee and
 * "Leek, Tom" for the next.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

type Db = PostgresJsDatabase<typeof schema>;

export interface TiedCommittee {
  /** Null when the organization files no committee report in Florida. */
  entityId: string | null;
  /** The committee's name, or the organization's as filed when unlinked. */
  name: string;
  /** How the officeholder's statements spelled it, when that differs. */
  filedAs: string[];
  /** The first Statement of Solicitation, ISO date. */
  since: string | null;
  /** The withdrawal filed after the last statement, if any. */
  withdrawn: string | null;
  /** Named chair on the committee's current registration. */
  chair: boolean;
}

/**
 * Nicknames that are not a prefix of the formal name. "Stan" and "Stanley"
 * agree already, as a prefix; "Tom" and "Thomas" need this.
 */
const NICKNAMES: Record<string, string[]> = {
  THOMAS: ['TOM', 'TOMMY'],
  WILLIAM: ['BILL', 'BILLY', 'WILL', 'WILLIE'],
  ROBERT: ['BOB', 'BOBBY', 'ROB', 'BOBBIE'],
  JAMES: ['JIM', 'JIMMY', 'JAMIE'],
  MICHAEL: ['MIKE'],
  RICHARD: ['DICK', 'RICK', 'RICKY', 'RICH'],
  CHARLES: ['CHUCK', 'CHARLIE'],
  JOHN: ['JACK', 'JOHNNY'],
  EDWARD: ['ED', 'EDDIE', 'TED', 'NED'],
  THEODORE: ['TED', 'TEDDY'],
  ELIZABETH: ['LIZ', 'BETH', 'BETSY', 'LIBBY'],
  MARGARET: ['PEGGY', 'MAGGIE', 'MEG'],
  KATHERINE: ['KATHY', 'KATIE', 'KATE'],
  KATHLEEN: ['KATHY', 'KATE'],
  NICHOLAS: ['NICK'],
  LAWRENCE: ['LARRY'],
  GERALD: ['JERRY'],
  HENRY: ['HANK'],
  ANTHONY: ['TONY'],
  JOSEPH: ['JOE', 'JOEY'],
  PATRICIA: ['PATTY', 'TRISH'],
  RONALD: ['RON'],
  DONALD: ['DON'],
  ALEXANDER: ['ALEX'],
  ALEXANDRA: ['ALEX'],
  FREDERICK: ['FRED'],
  GREGORY: ['GREG'],
  DOUGLAS: ['DOUG'],
};
const NICK_OF = new Map<string, Set<string>>();
for (const [formal, nicks] of Object.entries(NICKNAMES)) {
  for (const n of [formal, ...nicks]) {
    const set = NICK_OF.get(n) ?? new Set<string>();
    for (const m of [formal, ...nicks]) set.add(m);
    NICK_OF.set(n, set);
  }
}

/** Upper case, letters and spaces only, as the solicitations table stores names. */
export function letters(text: string): string {
  return text
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Do two given names name the same person, as far as a name can say? */
export function givenNamesAgree(a: string, b: string): boolean {
  const as = letters(a).split(' ').filter((t) => t.length > 1);
  const bs = letters(b).split(' ').filter((t) => t.length > 1);
  return as.some((x) =>
    bs.some(
      (y) =>
        x === y ||
        (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) ||
        (NICK_OF.get(x)?.has(y) ?? false),
    ),
  );
}

/**
 * Every committee tied to the person by a statement or a chair's seat,
 * leaving out the accounts the page already lists as theirs.
 */
export async function committeesTiedTo(
  db: Db,
  person: { last: string; first: string; entityIds: string[] },
): Promise<TiedCommittee[]> {
  const last = letters(person.last);
  if (!last) return [];

  // A surname may be one word of a longer filed one: the state files
  // "Bracy Davis, LaVon", and her page is named for Davis.
  const statements = await db.execute<{
    solicitor_first: string;
    form_type: string;
    received: string | null;
    org_name: string;
    entity_id: string | null;
    committee: string | null;
  }>(sql`
    SELECT s.solicitor_first, s.form_type, s.received::text AS received, s.org_name,
           s.entity_id, e.name AS committee
      FROM solicitations s
      LEFT JOIN entities e ON e.id = s.entity_id
     WHERE s.solicitor_last = ${last}
        OR s.solicitor_last LIKE ${`% ${last}`}
        OR s.solicitor_last LIKE ${`${last} %`}
     ORDER BY s.received ASC NULLS FIRST
  `);

  const chairs = await db.execute<{ entity_id: string; committee: string; name_first: string | null; full_name: string }>(sql`
    SELECT o.entity_id, e.name AS committee, o.name_first, o.full_name
      FROM committee_officers o
      JOIN entities e ON e.id = o.entity_id
     WHERE o.is_current AND o.role = 'chair'
       AND upper(regexp_replace(coalesce(o.name_last, ''), '[^A-Za-z ]+', ' ', 'g')) = ${last}
  `);

  const own = new Set(person.entityIds);
  const tied = new Map<string, TiedCommittee>();
  const keyOf = (entityId: string | null, orgName: string) => entityId ?? `name:${letters(orgName)}`;

  for (const s of statements) {
    if (!givenNamesAgree(s.solicitor_first, person.first)) continue;
    if (s.entity_id && own.has(s.entity_id)) continue;
    const key = keyOf(s.entity_id, s.org_name);
    const t =
      tied.get(key) ??
      ({
        entityId: s.entity_id,
        name: s.committee ?? s.org_name,
        filedAs: [],
        since: null,
        withdrawn: null,
        chair: false,
      } satisfies TiedCommittee);
    if (s.committee && letters(s.org_name) !== letters(s.committee) && !t.filedAs.includes(s.org_name)) {
      t.filedAs.push(s.org_name);
    }
    // Rows come oldest first, so the last of each kind is the latest.
    if (/withdraw/i.test(s.form_type)) {
      t.withdrawn = s.received;
    } else {
      t.since ??= s.received;
      if (/statement/i.test(s.form_type) && t.withdrawn && s.received && s.received > t.withdrawn) {
        t.withdrawn = null; // solicited again after withdrawing
      }
    }
    tied.set(key, t);
  }

  for (const c of chairs) {
    const given = c.name_first ?? c.full_name.split(/\s+/)[0] ?? '';
    if (!givenNamesAgree(given, person.first)) continue;
    if (own.has(c.entity_id)) continue;
    const t =
      tied.get(c.entity_id) ??
      ({ entityId: c.entity_id, name: c.committee, filedAs: [], since: null, withdrawn: null, chair: false } satisfies TiedCommittee);
    t.chair = true;
    tied.set(c.entity_id, t);
  }

  return [...tied.values()];
}
