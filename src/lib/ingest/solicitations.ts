/**
 * Officeholders' Statements of Solicitation, from the Division of Elections.
 *
 * `https://doesecure.dos.state.fl.us/PublicSolicitations/` publishes every
 * statement an officeholder has filed under s. 106.0701: who, which office,
 * which organization, when, and whether it was a statement, an update or a
 * withdrawal. It is an ASP.NET form with no export, but one search with every
 * field left blank returns the whole list on one page — 1,396 rows in
 * November 2026 — so a sweep is two requests.
 *
 * The rows are stored as published. Matching an organization to a committee is
 * a separate step (`linkSolicitations`) so it can be re-run after the
 * committee filings change without fetching again.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { AUTO_LINK_THRESHOLD, normalizeName } from '@/lib/normalize';
import { registrationInForce } from './resolve';

type Db = PostgresJsDatabase<typeof schema>;

export const SOLICITATIONS_URL = 'https://doesecure.dos.state.fl.us/PublicSolicitations/';

export interface SolicitationRow {
  solicitorName: string;
  solicitorLast: string;
  solicitorFirst: string;
  office: string | null;
  formType: string;
  /** ISO date. */
  received: string | null;
  orgName: string;
  orgNormalized: string;
}

const SUFFIX = /\b(?:JR|SR|II|III|IV|V)\b/g;

/** Upper case, accents and punctuation gone, quotes kept apart as words. */
function letters(text: string): string {
  return text
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A published solicitor name into surname and given names.
 *
 *     'McClain Jr., Stanley E.'      -> ('MCCLAIN', 'STANLEY E')
 *     'Miller, Alexandra "Alex"'     -> ('MILLER', 'ALEXANDRA ALEX')
 *     'Bracy Davis, LaVon'           -> ('BRACY DAVIS', 'LAVON')
 *
 * A nickname in quotes stays among the given names, because the person's page
 * may be named for it.
 */
export function splitSolicitor(raw: string): { last: string; first: string } {
  const [surname, ...rest] = raw.split(',');
  const last = letters(surname).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  const first = letters(rest.join(' ')).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return { last, first };
}

/** `05/19/2022` -> `2022-05-19`. */
function isoDate(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The rows of the organization results table.
 *
 * Columns, as published: Organization | Office | Received | Form Type |
 * Solicitor Name | PDF. The PDF link is a postback into the same form, so it
 * cannot be stored as a URL and is not kept.
 */
export function parseSolicitations(html: string): SolicitationRow[] {
  const table = html.match(/<table[^>]*grdOrganizationResult[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) return [];
  const out: SolicitationRow[] = [];
  for (const tr of table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => decode(m[1]));
    if (cells.length < 5) continue; // the header row is <th>
    const [orgName, office, received, formType, solicitorName] = cells;
    if (!orgName || !solicitorName || !formType) continue;
    const { last, first } = splitSolicitor(solicitorName);
    if (!last) continue;
    out.push({
      solicitorName,
      solicitorLast: last,
      solicitorFirst: first,
      office: office || null,
      formType,
      received: isoDate(received),
      orgName,
      orgNormalized: normalizeName(orgName),
    });
  }
  return out;
}

/**
 * Fetch the whole published list.
 *
 * The form wants its view state echoed back, so the first request reads it and
 * the second posts the organization search with every field blank, which the
 * state answers with every row it holds.
 */
export async function fetchSolicitations(
  userAgent = process.env.FLDOE_USER_AGENT ??
    'PACTracker/0.1 (+https://github.com/mydataismydata/PAC-Tracker)',
): Promise<SolicitationRow[]> {
  const first = await fetch(SOLICITATIONS_URL, { headers: { 'User-Agent': userAgent } });
  if (!first.ok) throw new Error(`solicitations page: HTTP ${first.status}`);
  const page = await first.text();
  const cookie = (first.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');

  const form = new URLSearchParams();
  for (const m of page.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
    form.set(m[1], decode(m[2]));
  }
  // Each select's first option is "All".
  for (const name of ['ddlSolOffice', 'ddlOrgType', 'ddlOrgStatus']) {
    const value = page.match(
      new RegExp(`name="ctl00\\$MainContent\\$${name}"[\\s\\S]*?<option[^>]*value="([^"]*)"`, 'i'),
    )?.[1];
    if (value != null) form.set(`ctl00$MainContent$${name}`, value);
  }
  const button = page.match(/name="ctl00\$MainContent\$btnOrgSearch"[^>]*value="([^"]*)"/i)?.[1];
  if (!button) throw new Error('solicitations page: no organization search button');
  form.set('ctl00$MainContent$txtSolicitorName', '');
  form.set('ctl00$MainContent$txtOrgName', '');
  form.set('ctl00$MainContent$btnOrgSearch', button);

  const second = await fetch(SOLICITATIONS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: form.toString(),
  });
  if (!second.ok) throw new Error(`solicitations search: HTTP ${second.status}`);
  const html = await second.text();
  const rows = parseSolicitations(html);
  const stated = html.match(/'\s*(\d+)\s*'\s*records? found/i)?.[1];
  if (stated && Number(stated) !== rows.length) {
    throw new Error(`solicitations: the page says ${stated} records, ${rows.length} parsed`);
  }
  return rows;
}

/**
 * Write the published rows, updating any already held.
 *
 * The state lists a few filings twice, word for word. One copy is kept, since
 * an upsert cannot touch the same row twice in one statement.
 */
export async function storeSolicitations(
  db: Db,
  published: SolicitationRow[],
  sourceId: string,
): Promise<number> {
  const rows = [
    ...new Map(
      published.map((r) => [[r.solicitorName, r.orgName, r.formType, r.received].join('|'), r]),
    ).values(),
  ];
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db
      .insert(schema.solicitations)
      .values(chunk.map((r) => ({ ...r, sourceId })))
      .onConflictDoUpdate({
        target: [
          schema.solicitations.solicitorName,
          schema.solicitations.orgName,
          schema.solicitations.formType,
          schema.solicitations.received,
        ],
        set: {
          office: sql`excluded.office`,
          solicitorLast: sql`excluded.solicitor_last`,
          solicitorFirst: sql`excluded.solicitor_first`,
          orgNormalized: sql`excluded.org_normalized`,
          observedAt: sql`now()`,
        },
      });
    written += chunk.length;
  }
  return written;
}

/**
 * Point each organization at the committee it files as.
 *
 * A wrong link here hands one officeholder another's committee, and nothing on
 * the page would look wrong, so only two kinds of evidence count.
 *
 * - The exact name of a committee. A registered one wins over one known only
 *   from filings; where several registered committees share the name, the one
 *   whose filings were under way on the statement's date takes it, as the
 *   resolver decides a shared name.
 * - Failing that, a spelling the resolver already accepts as a registered
 *   committee's own, at its auto-link bar. The state's list carries typos —
 *   "Conservative for Principled Leadership", "Alliance for a Strong Econmy" —
 *   and the filings carry the same ones, which is how those aliases exist. A
 *   spelling two committees both answer to is left unlinked.
 *
 * Plain fuzzy matching is not used: that is how "Liberty for Florida" came to
 * sit on "Liberty Florida". An organization neither rule places — a 501(c)(4)
 * or a 527 that files elsewhere, or a committee long gone from the state's
 * lists — stays unlinked, and the page shows it by name.
 */
export async function linkSolicitations(db: Db): Promise<{ linked: number; unlinked: number }> {
  const rows = await db.execute<{ id: string; org_normalized: string; received: string | null }>(sql`
    SELECT id, org_normalized, received::text AS received FROM solicitations
  `);
  const names = [...new Set(rows.map((r) => r.org_normalized))];

  const exact = await db.execute<{
    id: string;
    normalized_name: string;
    first_seen: string | null;
    last_seen: string | null;
    registered: boolean;
  }>(sql`
    SELECT e.id, e.normalized_name, e.first_seen::text AS first_seen, e.last_seen::text AS last_seen,
           EXISTS (SELECT 1 FROM committee_registrations r WHERE r.entity_id = e.id) AS registered
      FROM entities e
     WHERE e.normalized_name = ANY(${sql.param(names)}::text[])
       AND e.kind IN ('committee', 'party')
     ORDER BY e.created_at ASC, e.id ASC
  `);
  type Found = { id: string; firstSeen: string | null; lastSeen: string | null; registered: boolean };
  const byName = new Map<string, Found[]>();
  for (const c of exact) {
    const list = byName.get(c.normalized_name) ?? [];
    list.push({ id: c.id, firstSeen: c.first_seen, lastSeen: c.last_seen, registered: c.registered });
    byName.set(c.normalized_name, list);
  }

  const aliased = await db.execute<{ normalized_alias: string; ids: string[] }>(sql`
    SELECT a.normalized_alias, array_agg(DISTINCT a.entity_id::text) AS ids
      FROM entity_aliases a
     WHERE a.normalized_alias = ANY(${sql.param(names)}::text[])
       AND a.confidence >= ${AUTO_LINK_THRESHOLD}::real
       AND EXISTS (SELECT 1 FROM committee_registrations r WHERE r.entity_id = a.entity_id)
     GROUP BY a.normalized_alias
  `);
  const byAlias = new Map(aliased.filter((a) => a.ids.length === 1).map((a) => [a.normalized_alias, a.ids[0]]));

  let linked = 0;
  let unlinked = 0;
  for (const r of rows) {
    const found = byName.get(r.org_normalized) ?? [];
    const registered = found.filter((f) => f.registered);
    const pool = registered.length > 0 ? registered : found;
    const entityId =
      pool.length === 1
        ? pool[0].id
        : pool.length > 1
          ? registrationInForce(pool, r.received).id
          : (byAlias.get(r.org_normalized) ?? null);
    await db.execute(sql`UPDATE solicitations SET entity_id = ${entityId} WHERE id = ${r.id}`);
    if (entityId) linked++;
    else unlinked++;
  }
  return { linked, unlinked };
}
