/**
 * Parsers for Florida Division of Elections responses.
 *
 * Two formats matter: the tab-delimited contribution/expenditure export
 * (`queryformat=2`) and the HTML table returned by the committee registry
 * lookup, which has no machine-readable alternative.
 */

import { createHash } from 'node:crypto';
import { splitTypeTag, looksTruncated } from '@/lib/normalize';
import type { RawTransactionRow } from '../types';

/** Column header emitted by `contrib.exe` with `queryformat=2`. */
export const CONTRIBUTION_HEADER = [
  'Candidate/Committee',
  'Date',
  'Amount',
  'Typ',
  'Contributor Name',
  'Address',
  'City State Zip',
  'Occupation',
  'Inkind Desc',
] as const;

export interface RawContributionRow {
  /** Recipient exactly as reported, e.g. "Florida Chamber of Commerce PAC (PAC)". */
  recipientRaw: string;
  recipientName: string;
  recipientTypeTag: string | null;
  /** True when the recipient column hit Florida's 40-char ceiling. */
  recipientTruncated: boolean;

  contributorRaw: string;

  amount: string;
  date: string | null;
  typeCode: string | null;

  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  occupation: string | null;
  inkindDescription: string | null;

  /**
   * Which cycle this row was filed under, e.g. `20261103-GEN`.
   *
   * The export itself never says — it is a property of the query, not the row —
   * but without it two cycles are indistinguishable once they share a table,
   * and an entity's totals silently sum across both.
   */
  electionCycle: string;

  /** Stable dedupe key across re-ingests of the same underlying filing. */
  rowHash: string;
}

/**
 * Split "TALLAHASSEE, FL 32301" into parts.
 *
 * The state packs city, state and ZIP into one column, and the content is not
 * always well-formed — city names contain commas and the ZIP is sometimes ZIP+4
 * or missing entirely.
 */
export function parseCityStateZip(value: string): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const v = value.trim();
  if (!v) return { city: null, state: null, zip: null };

  // Preferred shape: "<city>, <ST> <zip>"
  const m = v.match(/^(.*),\s*([A-Za-z]{2})\s+([\d-]+)\s*$/);
  if (m) {
    return { city: m[1].trim() || null, state: m[2].toUpperCase(), zip: m[3].trim() || null };
  }

  // No ZIP: "<city>, <ST>"
  const m2 = v.match(/^(.*),\s*([A-Za-z]{2})\s*$/);
  if (m2) return { city: m2[1].trim() || null, state: m2[2].toUpperCase(), zip: null };

  // Trailing ZIP with no state.
  const m3 = v.match(/^(.*?)\s+([\d]{5}(?:-\d{4})?)\s*$/);
  if (m3) return { city: m3[1].replace(/,$/, '').trim() || null, state: null, zip: m3[2] };

  return { city: v || null, state: null, zip: null };
}

/**
 * Normalize Florida's m/d/yyyy dates to ISO, or null when unparseable.
 *
 * Range-checked rather than shape-checked: a well-formed but impossible date
 * ("0/0/0000", "2/30/2024") would otherwise reach Postgres and fail the whole
 * insert, losing a row that is fine apart from its date.
 */
export function parseFlDate(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1800 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Strip currency formatting; returns a plain decimal string. */
export function parseAmount(value: string): string | null {
  const cleaned = value.replace(/[$,\s]/g, '').trim();
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Parse the tab-delimited contribution export.
 *
 * `scopeKey` identifies the query that produced these rows (election cycle plus
 * search terms). It is folded into each row hash so that the same underlying
 * filing seen through two different queries still dedupes to one transaction.
 */
export function parseContributionTsv(
  text: string,
  opts: { electionCycle: string },
): { rows: RawContributionRow[]; skipped: number; headerSeen: boolean; dataLines: number } {
  const lines = text.split(/\r?\n/);
  const rows: RawContributionRow[] = [];
  let skipped = 0;
  let headerSeen = false;

  for (const line of lines) {
    if (!line.trim()) continue;

    // The header repeats when the CGI restarts a page; skip every occurrence.
    if (line.startsWith(CONTRIBUTION_HEADER[0])) {
      headerSeen = true;
      continue;
    }
    // Any HTML means we ran past the data into an error or footer block.
    if (line.trimStart().startsWith('<')) continue;

    const cells = line.split('\t');
    if (cells.length < 5) {
      skipped++;
      continue;
    }

    const [
      recipientRaw = '',
      dateCell = '',
      amountCell = '',
      typeCell = '',
      contributorRaw = '',
      addressCell = '',
      cityStateZipCell = '',
      occupationCell = '',
      inkindCell = '',
    ] = cells.map((c) => decodeHtml(c.trim()));

    const amount = parseAmount(amountCell);
    if (!recipientRaw || !contributorRaw || amount === null) {
      skipped++;
      continue;
    }

    const { name: recipientName, typeTag } = splitTypeTag(recipientRaw);
    const { city, state, zip } = parseCityStateZip(cityStateZipCell);
    const date = parseFlDate(dateCell);

    rows.push({
      recipientRaw,
      recipientName,
      recipientTypeTag: typeTag,
      recipientTruncated: looksTruncated(recipientRaw),
      contributorRaw,
      amount,
      date,
      typeCode: typeCell || null,
      address: addressCell || null,
      city,
      state,
      zip,
      occupation: occupationCell || null,
      inkindDescription: inkindCell || null,
      electionCycle: opts.electionCycle,
      rowHash: hashRow([
        opts.electionCycle,
        recipientName,
        contributorRaw,
        amount,
        date ?? '',
        typeCell,
        addressCell,
        cityStateZipCell,
      ]),
    });
  }

  // See `parseExpenditureTsv`: the row cap applies to lines delivered, not
  // rows successfully parsed, and conflating the two makes a truncated window
  // look complete.
  return { rows, skipped, headerSeen, dataLines: rows.length + skipped };
}

/** Column header emitted by `expend.exe` with `queryformat=2`. */
export const EXPENDITURE_HEADER = [
  'Candidate/Committee',
  'Date',
  'Amount',
  'Payee Name',
  'Address',
  'City State Zip',
  'Purpose',
  'Type',
] as const;

/**
 * Parse the tab-delimited expenditure export.
 *
 * Money *out* of a committee, which the contribution feed cannot see at all: a
 * transfer to another committee is reported by the recipient and so appears
 * there, but a payment to a vendor or consultant is only ever reported by the
 * payer. Without this, a committee's spending is invisible.
 *
 * The layout is close to the contribution export but not identical — the type
 * code moves from column 4 to the end, and `Purpose` takes the slot that held
 * `Occupation` — so the two cannot share a parser.
 */
export function parseExpenditureTsv(
  text: string,
  opts: { electionCycle: string },
): { rows: RawTransactionRow[]; skipped: number; headerSeen: boolean; dataLines: number } {
  const lines = text.split(/\r?\n/);
  const rows: RawTransactionRow[] = [];
  let skipped = 0;
  let headerSeen = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith(EXPENDITURE_HEADER[0])) {
      headerSeen = true;
      continue;
    }
    if (line.trimStart().startsWith('<')) continue;

    const cells = line.split('\t');
    if (cells.length < 4) {
      skipped++;
      continue;
    }

    const [
      filerRaw = '',
      dateCell = '',
      amountCell = '',
      payeeRaw = '',
      addressCell = '',
      cityStateZipCell = '',
      purposeCell = '',
      typeCell = '',
    ] = cells.map((c) => decodeHtml(c.trim()));

    const amount = parseAmount(amountCell);
    if (!filerRaw || !payeeRaw || amount === null) {
      skipped++;
      continue;
    }

    const { typeTag } = splitTypeTag(filerRaw);
    const { city, state, zip } = parseCityStateZip(cityStateZipCell);
    const date = parseFlDate(dateCell);

    rows.push({
      filerRaw,
      filerTruncated: looksTruncated(filerRaw),
      filerTypeTag: typeTag,
      // The expenditure export reports neither, unlike the county feeds.
      filerOffice: null,
      filerParty: null,
      // Florida tags committees with "(PAC)", "(CCE)", "(ECO)", "(PTY)" and
      // leaves candidate rows bare, so the tag is the only signal available.
      filerIsCommittee: typeTag !== null,

      counterpartyRaw: payeeRaw,
      // The state says nothing about what a payee is; resolution has to guess.
      counterpartyKind: 'unknown',

      direction: 'expenditure',

      amount,
      date,
      typeCode: typeCell || null,
      description: purposeCell || null,

      address: addressCell || null,
      city,
      state,
      zip,
      // Payees have no occupation; the column holds Purpose instead.
      occupation: null,

      electionCycle: opts.electionCycle,
      rowHash: hashRow([
        'expenditure',
        opts.electionCycle,
        filerRaw,
        payeeRaw,
        amount,
        date ?? '',
        purposeCell,
        addressCell,
        cityStateZipCell,
      ]),
    });
  }

  // Every line the CGI meant as data, whether or not it parsed. This, not
  // `rows.length`, is what the row cap applies to: the export drops a variable
  // number of lines to malformed content, so a response cut off at exactly the
  // cap can still yield far fewer usable rows and read as a short — meaning
  // complete — window.
  return { rows, skipped, headerSeen, dataLines: rows.length + skipped };
}

/**
 * Hash the identifying fields of a source row.
 *
 * Deliberately excludes anything we derive ourselves, so improving the parser
 * or the resolver does not orphan already-ingested transactions.
 */
export function hashRow(parts: string[]): string {
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* Committee registry                                                          */
/* -------------------------------------------------------------------------- */

export interface RegistryCommittee {
  name: string;
  type: string | null;
  status: 'active' | 'closed' | 'unknown';
}

/**
 * Scrape the committee registry table (Committee | Type | Status).
 *
 * The registry is the only place that tells us which names are committees at
 * all, which is what lets the crawler decide whether a contributor is a
 * traversable node or a leaf.
 */
export function parseCommitteeRegistryHtml(html: string): RegistryCommittee[] {
  const out: RegistryCommittee[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(decodeHtml(cellMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    }
    if (cells.length < 3) continue;

    const [name, type, status] = cells;
    if (!name || name.toLowerCase() === 'committee') continue; // header row
    if (!/^(PAC|CCE|ECO|ECI|IXO|PAP|PTY)$/i.test(type)) continue;

    out.push({
      name,
      type: type.toUpperCase(),
      status:
        status.toLowerCase() === 'active'
          ? 'active'
          : status.toLowerCase() === 'closed'
            ? 'closed'
            : 'unknown',
    });
  }
  return out;
}

/** Column header of the bulk committee list, in the order it is emitted. */
export const COMMITTEE_LIST_HEADER = [
  'AcctNum',
  'Name',
  'Type',
  'TypeDesc',
  'Addr1',
  'Addr2',
  'City',
  'State',
  'Zip',
  'County',
  'Phone',
  'ChrNameLast',
  'ChrNameFirst',
  'ChrNameMiddle',
  'TrsNameLast',
  'TrsNameFirst',
  'TrsNameMiddle',
] as const;

/** A committee's registration record from the bulk extract. */
export interface RegistryCommitteeDetail {
  /** The state's own account number — the identifier the exports lack. */
  acctNum: string | null;
  name: string;
  type: string | null;
  typeDescription: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  phone: string | null;
  chairLast: string | null;
  chairFirst: string | null;
  chairMiddle: string | null;
  treasurerLast: string | null;
  treasurerFirst: string | null;
  treasurerMiddle: string | null;
}

/**
 * Parse the tab-delimited committee list.
 *
 * Unlike the transaction exports this one is a genuine TSV with a single header
 * row and no repeated headers or footer markup, so it needs none of the
 * defensive skipping the contribution parser does. The header is still checked
 * by position rather than trusted: the file carries no version marker, and a
 * silently reordered column would map treasurers onto chairs.
 */
export function parseCommitteeListTsv(text: string): {
  rows: RegistryCommitteeDetail[];
  skipped: number;
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: RegistryCommitteeDetail[] = [];
  let skipped = 0;
  if (lines.length === 0) return { rows, skipped };

  const header = lines[0].split('\t').map((c) => c.trim());
  const mismatch = COMMITTEE_LIST_HEADER.filter((h, i) => header[i] !== h);
  if (mismatch.length > 0) {
    throw new Error(
      `unexpected committee list header: missing or reordered ${mismatch.join(', ')} — got ${header.join(', ')}`,
    );
  }

  const clean = (s: string | undefined): string | null => {
    const v = decodeHtml((s ?? '').trim()).replace(/\s+/g, ' ').trim();
    return v.length > 0 ? v : null;
  };

  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const name = clean(c[1]);
    if (!name) {
      skipped++;
      continue;
    }
    rows.push({
      acctNum: clean(c[0]),
      name,
      type: clean(c[2])?.toUpperCase() ?? null,
      typeDescription: clean(c[3]),
      addr1: clean(c[4]),
      addr2: clean(c[5]),
      city: clean(c[6]),
      state: clean(c[7]),
      zip: clean(c[8]),
      county: clean(c[9]),
      phone: clean(c[10]),
      chairLast: clean(c[11]),
      chairFirst: clean(c[12]),
      chairMiddle: clean(c[13]),
      treasurerLast: clean(c[14]),
      treasurerFirst: clean(c[15]),
      treasurerMiddle: clean(c[16]),
    });
  }

  return { rows, skipped };
}

/**
 * Decode HTML entities.
 *
 * Needed for the registry, which is scraped from HTML, but also for the
 * tab-delimited export: filings genuinely contain strings like
 * `THE EAR, NOSE &AMP; THROAT SURGICAL ASSOCIATES`. Left encoded, that
 * normalizes to the token sequence "AND AMP" and the entity can never match
 * the same organization spelled properly.
 *
 * Matching is case-insensitive because the source is inconsistent about it,
 * and `&amp;` resolves last so double-encoded input unwinds in order.
 */
export function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/** Guard against malformed entities producing an exception or a control char. */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}
