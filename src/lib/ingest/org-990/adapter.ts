/**
 * Corporate / Form 990 profiles for the dark-money nonprofits, assembled from
 * what can be fetched and a small hand-kept overlay of what cannot.
 *
 * These orgs are 501(c)(4) corporations, not campaign committees. Two public
 * records describe them, and only one has a machine route:
 *
 *   - IRS Form 990, via ProPublica's API (`client.ts`) — the tax status, the
 *     legal name and address, and the year-by-year financials the IRS
 *     extracted. Fetched fresh every run.
 *   - The Florida Division of Corporations (Sunbiz) — the registered agent, the
 *     document number, the incorporation date, the status, and the board.
 *     Sunbiz sits behind a Cloudflare bot wall with no API, so these few fields
 *     are kept by hand in `TRACKED_ORGS` below and read once from the website.
 *
 * The overlay is deliberately thin: everything the 990 can answer is left to the
 * 990, so adding an org is an EIN plus the handful of Sunbiz-only fields. The
 * registered agent and the board still become officer-hub links, which is what
 * ties the shells together — a shared agent is the strongest link in this
 * network, and it exists only in the Sunbiz half.
 */

import type { Propublica990Response } from './client';

export interface Person {
  first: string;
  last: string;
  display: string;
  title?: string;
}

/** The Sunbiz-only facts, kept by hand because Sunbiz has no machine route. */
interface SunbizOverlay {
  /** e.g. "Florida Not-For-Profit Corporation". Not a federal 990 concept. */
  corpType: string;
  docNumber?: string;
  status: string;
  filedDate?: string;
  registeredAgent?: Person;
  directors: Person[];
  /** A 527 files IRS Form 8872, not a 990; these are not 527s. */
  is527: boolean;
  /** 990 Schedule B is redacted, so the donors are not public anywhere. */
  donorsRestricted: boolean;
  /** Used only when the 990 has no subsection code (e.g. a dissolved org). */
  taxStatus?: string;
  /** Assembled from the 990 when absent; the curated form reads better. */
  address?: string;
  mission?: string;
  website?: string;
  note?: string;
  /** Hand-read financials for years the IRS extract does not cover. */
  financials?: Record<string, Record<string, number>>;
}

export interface TrackedOrg {
  slug: string;
  /** The graph node this profile attaches to. */
  entityId: string;
  ein: string;
  /** For the operator's reference only; the profile links by entityId. */
  name: string;
  sunbiz: SunbizOverlay;
}

const COATES: Person = { first: 'Richard', last: 'Coates', display: 'Richard E. Coates' };
const JONES: Person = { first: 'William', last: 'Jones', display: 'William S. Jones' };

export const TRACKED_ORGS: TrackedOrg[] = [
  {
    slug: 'eif',
    entityId: '98bb50e1-676a-4ceb-8fb6-57279e26d353',
    ein: '87-4361946',
    name: 'Economic Improvement Fund, Inc.',
    sunbiz: {
      corpType: 'Florida Not-For-Profit Corporation',
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
      is527: false,
      donorsRestricted: true,
      mission: 'Issue Advocacy',
      // The IRS has no e-file extract for these years — all three filings are
      // scanned PDFs — so the figures are hand-read from the returns.
      financials: {
        revenue: { '2022': 4238600, '2023': 616806, '2024': 2135289 },
        grantsPaid: { '2023': 340856, '2024': 1508500 },
      },
      note: 'Form 990 Schedule B contributors are marked RESTRICTED. Not a 527 (no IRS 8871/8872).',
    },
  },
  {
    slug: 'foundation-safe-environment',
    entityId: '8638a0a1-a078-46dd-a1b9-2994feba33f6',
    ein: '46-5701159',
    name: 'Foundation for a Safe Environment',
    sunbiz: {
      corpType: 'Florida Not-For-Profit Corporation',
      docNumber: 'N14000004688',
      status: 'Inactive (admin dissolved 2022-09-23)',
      filedDate: '2014-05-15',
      address: '115 East Park Avenue, Suite 1, Tallahassee, FL 32301',
      registeredAgent: COATES,
      directors: [{ ...JONES, title: 'Director' }],
      is527: false,
      donorsRestricted: true,
      note: 'Same address and registered agent as Economic Improvement Fund; William Jones is the sole director.',
    },
  },
  {
    slug: 'secure-floridas-future',
    entityId: 'd5752ce0-ddd4-4e79-a623-ea9294ae0bc6',
    ein: '82-3058657',
    name: "Secure Florida's Future",
    sunbiz: {
      corpType: 'Florida Not-For-Profit Corporation',
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
      is527: false,
      donorsRestricted: true,
      note: 'Registered agent Richard E. Coates at 115 East Park Avenue, Suite 1. Directors are Florida Chamber of Commerce officers.',
    },
  },
];

export function findTrackedOrg(slug: string): TrackedOrg | undefined {
  return TRACKED_ORGS.find((o) => o.slug === slug.toLowerCase());
}

/** The org_profiles row plus the officer people, ready to write. */
export interface BuiltProfile {
  entityId: string;
  corpType: string | null;
  taxStatus: string | null;
  is527: boolean;
  ein: string | null;
  docNumber: string | null;
  status: string | null;
  filedDate: string | null;
  address: string | null;
  registeredAgent: string | null;
  mission: string | null;
  website: string | null;
  board: { name: string; title?: string }[];
  financials: Record<string, Record<string, number>> | null;
  donorsRestricted: boolean;
  note: string | null;
  people: { role: 'registered_agent' | 'director'; person: Person }[];
  /** What the 990 actually supplied this run, for the CLI to report. */
  provenance: { taxStatusFromIrs: boolean; financialYearsFromIrs: number };
}

/** IRS subsection code (the "c" paragraph) to its exemption label. */
function subsectionLabel(code: number | null): string | null {
  return code && code > 0 ? `501(c)(${code})` : null;
}

/** Join the 990's address parts into one line, or null if it has none. */
function addressFrom990(org: Propublica990Response['organization']): string | null {
  const tail = [org.city, [org.state, org.zipcode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [org.address, tail].filter(Boolean).join(', ') || null;
}

/**
 * Financials extracted from the 990, one metric per line, keyed by tax year.
 * A filing with no numbers (a PDF-only year) contributes nothing.
 */
function financialsFrom990(resp: Propublica990Response): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const put = (metric: string, year: number | null, value: number | null) => {
    if (year == null || value == null) return;
    (out[metric] ??= {})[String(year)] = value;
  };
  for (const f of resp.filings_with_data ?? []) {
    put('revenue', f.tax_prd_yr, f.totrevenue);
    put('expenses', f.tax_prd_yr, f.totfuncexpns);
    put('contributions', f.tax_prd_yr, f.totcntrbgfts);
    put('assets', f.tax_prd_yr, f.totassetsend);
  }
  return out;
}

/**
 * Overlay the hand-kept figures under the IRS ones, letting the IRS win.
 *
 * The extract is authoritative for a year it covers; the overlay fills the
 * years it does not (for these orgs, most of them). Returns null when neither
 * side has anything, so the column stays empty rather than an empty object.
 */
function mergeFinancials(
  irs: Record<string, Record<string, number>>,
  overlay: Record<string, Record<string, number>> | undefined,
): Record<string, Record<string, number>> | null {
  const out: Record<string, Record<string, number>> = {};
  for (const src of [overlay ?? {}, irs]) {
    for (const [metric, years] of Object.entries(src)) {
      out[metric] = { ...(out[metric] ?? {}), ...years };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge a tracked org's Sunbiz overlay with its live 990, into one profile row.
 *
 * `resp` is null when ProPublica does not know the EIN; the overlay then stands
 * on its own, which is the same profile the hand loader used to write.
 */
export function buildProfile(org: TrackedOrg, resp: Propublica990Response | null): BuiltProfile {
  const s = org.sunbiz;
  const irsTaxStatus = resp ? subsectionLabel(resp.organization.subsection_code) : null;
  const irsFinancials = resp ? financialsFrom990(resp) : {};

  const people: BuiltProfile['people'] = [];
  if (s.registeredAgent) people.push({ role: 'registered_agent', person: s.registeredAgent });
  for (const d of s.directors) people.push({ role: 'director', person: d });

  return {
    entityId: org.entityId,
    corpType: s.corpType,
    taxStatus: irsTaxStatus ?? s.taxStatus ?? null,
    is527: s.is527,
    ein: org.ein,
    docNumber: s.docNumber ?? null,
    status: s.status,
    filedDate: s.filedDate ?? null,
    address: s.address ?? (resp ? addressFrom990(resp.organization) : null),
    registeredAgent: s.registeredAgent?.display ?? null,
    mission: s.mission ?? null,
    website: s.website ?? null,
    board: s.directors.map((d) => (d.title ? { name: d.display, title: d.title } : { name: d.display })),
    financials: mergeFinancials(irsFinancials, s.financials),
    donorsRestricted: s.donorsRestricted,
    note: s.note ?? null,
    people,
    provenance: {
      taxStatusFromIrs: irsTaxStatus != null,
      financialYearsFromIrs: new Set(
        Object.values(irsFinancials).flatMap((years) => Object.keys(years)),
      ).size,
    },
  };
}
