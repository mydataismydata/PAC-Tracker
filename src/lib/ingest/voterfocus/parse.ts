/**
 * Parsers for VoterFocus county portals.
 *
 * Two surfaces: the candidate/committee index (HTML) and the per-entity
 * transaction export (CSV). The export is the good one — it carries
 * contributions and expenditures together, ISO dates, and an explicit
 * contributor-type code that the state feed does not provide at all.
 */

import { createHash } from 'node:crypto';
import type { CounterpartyKind, RawTransactionRow } from '../types';

/* -------------------------------------------------------------------------- */
/* Candidate / committee index                                                */
/* -------------------------------------------------------------------------- */

export interface VoterFocusEntity {
  /** The `ca=` id, unique within a county. */
  candId: string;
  name: string;
  isCommittee: boolean;
  office: string | null;
  party: string | null;
  /** e.g. "Active", "Inactive - Withdrawn". */
  status: string | null;
}

export interface VoterFocusElection {
  /** The `e=` id. */
  id: string;
  label: string;
  /** Four-digit year parsed out of the label, when present. */
  year: number | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Strip markup and decode entities.
 *
 * Numeric entities matter as much as named ones here: VoterFocus escapes
 * quotes in nicknames as `&#34;`, so "Rhodesia &#34;Rho&#34; Butler" would
 * otherwise be stored — and matched against — with the escape intact.
 *
 * `&amp;` is decoded last so double-encoded input ("&amp;#34;") resolves in
 * the right order instead of turning into a literal quote a pass too early.
 * It is matched case-insensitively: filings do carry `&AMP;`, and an ampersand
 * left encoded normalizes to the token "AND AMP", which matches nothing.
 */
const decode = (s: string): string =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Guard against malformed entities producing an exception or a control char. */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/** Election cycles offered by the county, newest first as the site orders them. */
export function parseElections(html: string): VoterFocusElection[] {
  const sel = html.match(/<select[^>]*name="el"[^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return [];
  return [...sel[1].matchAll(/<option[^>]*value='?"?(\d+)'?"?[^>]*>([^<]*)/g)].map((m) => {
    const label = decode(m[2]);
    const year = label.match(/\b(19|20)\d{2}\b/);
    return { id: m[1], label, year: year ? Number(year[0]) : null };
  });
}

/**
 * Candidates and committees listed for the selected election cycle.
 *
 * Each entry is an anchor carrying `ca=` and `committee=`; the office appears
 * as an `Office: …` label immediately before it, so it is read by looking
 * backwards from the link rather than by walking the table structure, which
 * differs between counties.
 */
export function parseEntityIndex(html: string): VoterFocusEntity[] {
  const out: VoterFocusEntity[] = [];
  const seen = new Set<string>();

  // Offices head a section covering the candidates that follow, so index their
  // positions once and bind each candidate to the nearest preceding heading.
  const officeMarks = [...html.matchAll(/Office:\s*([^<|]{2,60})/gi)].map((m) => ({
    at: m.index ?? 0,
    office: decode(m[1]),
  }));

  const officeFor = (position: number): string | null => {
    let lo = 0;
    let hi = officeMarks.length - 1;
    let found: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (officeMarks[mid].at < position) {
        found = officeMarks[mid].office;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const linkRe =
    /<a[^>]*href="[^"]*candidate_pr\.php[^"]*[?&]ca=(\d+)[^"]*[?&]committee=([YN])[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const [, candId, committeeFlag, inner] = m;
    if (seen.has(candId)) continue;
    seen.add(candId);

    // The name lives in the first grid cell. Taking the anchor's whole text
    // instead drags in the status cell, whose screen-reader span appends a
    // stray "status" to every name.
    const firstCell = inner.match(/role="gridcell"[^>]*>([\s\S]*?)<\/div>/i);
    const label = decode(firstCell ? firstCell[1] : inner);
    if (!label) continue;

    const party = label.match(/\(([A-Z/]{2,5})\)\s*$/);
    const name = (party ? label.slice(0, party.index) : label).trim();
    if (!name) continue;

    // Status sits in the sibling cell: "(Active-Qualified)", "(Inactive - …)".
    const statusMatch = decode(inner).match(/\(\s*(Active[^)]*|Inactive[^)]*)\)/i);

    out.push({
      candId,
      name,
      isCommittee: committeeFlag === 'Y',
      // Committees are not filed against an office.
      office: committeeFlag === 'Y' ? null : officeFor(m.index),
      party: party ? party[1] : null,
      status: statusMatch ? decode(statusMatch[1]) : null,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Transaction export                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Minimal RFC-4180 reader.
 *
 * Hand-rolled because the export quotes inconsistently — some fields are bare,
 * others quoted, and occupation contains embedded markup — and pulling in a CSV
 * dependency for one well-understood format is not worth it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Contributor-type codes used in the `cont. type` column. */
const CONTRIBUTOR_TYPES: Record<string, CounterpartyKind> = {
  I: 'individual',
  B: 'business',
  C: 'committee',
  P: 'party',
  O: 'other',
  S: 'self',
};

/**
 * Columns of the CFINANCE export, matched case-insensitively by header rather
 * than by position — the export has reordered columns between counties.
 */
type ExportColumn =
  | 'rpt code'
  | 'line number'
  | 'item date'
  | 'cont/exp'
  | 'name'
  | 'address 1'
  | 'address 2'
  | 'city'
  | 'state'
  | 'zip'
  | 'cont. type'
  | 'occupation'
  | 'item type'
  | 'description'
  | 'amount'
  | 'amend. code'
  | 'lastname';

export interface ParseExportOptions {
  /** The filer this export belongs to; the CSV itself does not name them. */
  filerName: string;
  filerOffice: string | null;
  filerParty: string | null;
  filerIsCommittee: boolean;
  /** County slug, folded into the row hash to keep counties from colliding. */
  countySlug: string;
}

/**
 * Parse one entity's CFINANCE export into normalized rows.
 *
 * Both directions come out of the same file: `Cont/Exp` is `C` for money in and
 * `E` for money out, so a committee paying a vendor stays in the graph instead
 * of being silently dropped.
 */
export function parseTransactionExport(
  csv: string,
  opts: ParseExportOptions,
): { rows: RawTransactionRow[]; skipped: number } {
  const table = parseCsv(csv);
  if (table.length === 0) return { rows: [], skipped: 0 };

  const header = table[0].map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const idx = (name: ExportColumn) => header.indexOf(name);

  const iDate = idx('item date');
  const iDir = idx('cont/exp');
  const iName = idx('name');
  const iAmount = idx('amount');

  // Without these four the file is not a CFINANCE export.
  if (iDate < 0 || iDir < 0 || iName < 0 || iAmount < 0) return { rows: [], skipped: 0 };

  const iRpt = idx('rpt code');
  const iLine = idx('line number');
  const iAddr1 = idx('address 1');
  const iAddr2 = idx('address 2');
  const iCity = idx('city');
  const iState = idx('state');
  const iZip = idx('zip');
  const iContType = idx('cont. type');
  const iOcc = idx('occupation');
  const iItemType = idx('item type');
  const iDesc = idx('description');

  const rows: RawTransactionRow[] = [];
  let skipped = 0;

  for (const cells of table.slice(1)) {
    const get = (i: number) => (i >= 0 && i < cells.length ? decode(cells[i]) : '');

    const counterpartyRaw = get(iName);
    const amountRaw = get(iAmount).replace(/[$,]/g, '');
    const dirCode = get(iDir).toUpperCase();

    if (!counterpartyRaw || !/^-?\d+(\.\d+)?$/.test(amountRaw)) {
      skipped++;
      continue;
    }

    const date = normalizeDate(get(iDate));
    const contType = get(iContType).toUpperCase();

    rows.push({
      filerRaw: opts.filerName,
      filerTruncated: false,
      filerTypeTag: null,
      filerOffice: opts.filerOffice,
      filerParty: opts.filerParty,
      filerIsCommittee: opts.filerIsCommittee,

      counterpartyRaw,
      counterpartyKind: CONTRIBUTOR_TYPES[contType] ?? 'unknown',

      direction: dirCode === 'E' ? 'expenditure' : 'contribution',

      amount: amountRaw,
      date,
      typeCode: get(iItemType) || null,
      description: get(iDesc) || null,

      address: [get(iAddr1), get(iAddr2)].filter(Boolean).join(' ') || null,
      city: get(iCity) || null,
      state: get(iState) || null,
      zip: get(iZip) || null,
      occupation: get(iOcc) || null,

      rowHash: hashRow([
        'voterfocus',
        opts.countySlug,
        opts.filerName,
        get(iRpt),
        get(iLine),
        counterpartyRaw,
        amountRaw,
        date ?? '',
        dirCode,
      ]),
    });
  }

  return { rows, skipped };
}

/**
 * VoterFocus emits ISO dates, but falls back to m/d/yyyy defensively.
 *
 * Shape alone is not enough to trust: the export uses "0000-00-00" as a
 * null-date placeholder, which matches the ISO pattern and is then rejected by
 * Postgres, losing the whole row. Every candidate is range-checked.
 */
function normalizeDate(value: string): string | null {
  const v = value.trim();

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return validDate(+us[3], +us[1], +us[2]);

  return null;
}

/** ISO string for a real calendar date, or null. Rejects 0000-00-00, Feb 30, … */
function validDate(year: number, month: number, day: number): string | null {
  if (year < 1800 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip catches overflow like 2026-02-30 rolling into March.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function hashRow(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}
