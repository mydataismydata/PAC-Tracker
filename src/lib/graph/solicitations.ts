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
 *
 * A statement is not always a claim of ownership. The form asks whether the
 * officeholder established, maintains or controls the organization, and
 * "maintained" alone means raising money for it. When another officeholder
 * says they established or control the same committee, and has not withdrawn,
 * it is that person's committee, and a maintain-only statement does not put
 * it on anyone else's page: Floridians for Economic Freedom belongs to Chris
 * Sprowls, not to Paul Renner, who raised for it from 2016 to 2018. A
 * maintain-only statement still counts where nobody claims the committee, and
 * a person who chairs a committee runs it whatever they filed.
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
  /** How their latest statement described the tie: "Established/Controlled", ... */
  relationship: string | null;
}

/**
 * Did they say the organization is theirs: that they set it up or run it?
 * The form's answers are Established, Maintained, Controlled, or a pair.
 */
export function owns(relationship: string | null): boolean {
  return relationship != null && /established|controlled/i.test(relationship);
}

/** One filing as the state lists it, enough to tell who holds a committee. */
interface Filing {
  solicitor: string;
  formType: string;
  received: string | null;
  relationship: string | null;
}

/**
 * Where one solicitor stands with one organization: the relationship their
 * latest statement or update declared, or null once they have withdrawn.
 */
function standing(filings: Filing[]): string | null | 'withdrawn' {
  const ordered = [...filings].sort((a, b) => (a.received ?? '').localeCompare(b.received ?? ''));
  const latest = ordered.at(-1);
  if (!latest) return null;
  if (/withdraw/i.test(latest.formType)) return 'withdrawn';
  return latest.relationship;
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
    solicitor_name: string;
    solicitor_first: string;
    form_type: string;
    received: string | null;
    relationship: string | null;
    org_name: string;
    org_normalized: string;
    entity_id: string | null;
    committee: string | null;
  }>(sql`
    SELECT s.solicitor_name, s.solicitor_first, s.form_type, s.received::text AS received,
           s.relationship, s.org_name, s.org_normalized, s.entity_id, e.name AS committee
      FROM solicitations s
      LEFT JOIN entities e ON e.id = s.entity_id
     WHERE s.solicitor_last = ${last}
        OR s.solicitor_last LIKE ${`% ${last}`}
        OR s.solicitor_last LIKE ${`${last} %`}
     ORDER BY s.received ASC NULLS FIRST
  `);
  const mine = statements.filter((s) => givenNamesAgree(s.solicitor_first, person.first));
  const myNames = new Set(mine.map((s) => s.solicitor_name));

  // Everyone else's filings for the same organizations, to see whether one of
  // them says the committee is theirs.
  const ids = [...new Set(mine.flatMap((s) => (s.entity_id ? [s.entity_id] : [])))];
  const names = [...new Set(mine.filter((s) => !s.entity_id).map((s) => s.org_normalized))];
  const others = await db.execute<{
    solicitor_name: string;
    form_type: string;
    received: string | null;
    relationship: string | null;
    entity_id: string | null;
    org_normalized: string;
  }>(sql`
    SELECT s.solicitor_name, s.form_type, s.received::text AS received, s.relationship,
           s.entity_id, s.org_normalized
      FROM solicitations s
     WHERE s.entity_id = ANY(${sql.param(ids)}::uuid[])
        OR (s.entity_id IS NULL AND s.org_normalized = ANY(${sql.param(names)}::text[]))
  `);
  const orgKey = (entityId: string | null, normalized: string) => entityId ?? `name:${normalized}`;
  const bySolicitor = new Map<string, Map<string, Filing[]>>();
  for (const o of others) {
    if (myNames.has(o.solicitor_name)) continue;
    const key = orgKey(o.entity_id, o.org_normalized);
    const people = bySolicitor.get(key) ?? new Map<string, Filing[]>();
    const list = people.get(o.solicitor_name) ?? [];
    list.push({ solicitor: o.solicitor_name, formType: o.form_type, received: o.received, relationship: o.relationship });
    people.set(o.solicitor_name, list);
    bySolicitor.set(key, people);
  }
  /** Someone else established or controls it, and has not withdrawn. */
  const ownedByAnother = (key: string) =>
    [...(bySolicitor.get(key)?.values() ?? [])].some((filings) => {
      const now = standing(filings);
      return now !== 'withdrawn' && owns(now);
    });

  const chairs = await db.execute<{ entity_id: string; committee: string; name_first: string | null; full_name: string }>(sql`
    SELECT o.entity_id, e.name AS committee, o.name_first, o.full_name
      FROM committee_officers o
      JOIN entities e ON e.id = o.entity_id
     WHERE o.is_current AND o.role = 'chair'
       AND upper(regexp_replace(coalesce(o.name_last, ''), '[^A-Za-z ]+', ' ', 'g')) = ${last}
  `);

  // Keyed as the filings are: by committee where one is linked, by the
  // organization's name where none is.
  const own = new Set(person.entityIds);
  const tied = new Map<string, TiedCommittee>();

  for (const s of mine) {
    if (s.entity_id && own.has(s.entity_id)) continue;
    const key = orgKey(s.entity_id, s.org_normalized);
    const t =
      tied.get(key) ??
      ({
        entityId: s.entity_id,
        name: s.committee ?? s.org_name,
        filedAs: [],
        since: null,
        withdrawn: null,
        chair: false,
        relationship: null,
      } satisfies TiedCommittee);
    if (!/withdraw/i.test(s.form_type) && s.relationship) t.relationship = s.relationship;
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
      ({
        entityId: c.entity_id,
        name: c.committee,
        filedAs: [],
        since: null,
        withdrawn: null,
        chair: false,
        relationship: null,
      } satisfies TiedCommittee);
    t.chair = true;
    tied.set(c.entity_id, t);
  }

  // Raising money for a committee someone else owns does not make it yours.
  return [...tied.entries()]
    .filter(([key, t]) => t.chair || owns(t.relationship) || t.relationship === null || !ownedByAnother(key))
    .map(([, t]) => t);
}
