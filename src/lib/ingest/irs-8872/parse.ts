/**
 * Parsers for the IRS POFD site and Form 8872 filings.
 *
 * Filings are PDFs — roughly 1,300 pages and 11,000 itemized contributions per
 * quarter for a committee the size of the RSLC — so the interesting part is
 * extracting contributor rows from them reliably.
 *
 * Extraction is by column position, not by splitting text. Merged page text
 * collapses the gap between columns to a single space, which makes
 * "U.S. CHAMBER OF COMMERCE AND RELATED ENTITIES N/A" indistinguishable from a
 * contributor whose name ends in "N/A". The rendered form is a rigid
 * three-column grid, so the x coordinate of each text item says exactly which
 * field it belongs to.
 */

import { createHash } from 'node:crypto';
import { getDocumentProxy } from 'unpdf';

/** Column origins in PDF user-space units, from the rendered 8872 grid. */
const COL_LEFT = 29;
const COL_MID = 259;
const COL_RIGHT = 490;
/** Half the gap between columns; anything closer belongs to that column. */
const COL_TOLERANCE = 100;
/** Items within this many units of each other are on the same visual line. */
const LINE_TOLERANCE = 3;

export interface Irs8872Contribution {
  contributorName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  employer: string | null;
  occupation: string | null;
  amount: string;
  /** ISO yyyy-mm-dd, or null when the filing omits or mangles it. */
  date: string | null;
  aggregateYtd: string | null;
  /**
   * A reporting placeholder rather than a real contributor.
   *
   * Filers roll unitemized money into a pseudo-contributor — "AGGREGATE BELOW
   * THRESHOLD" for sub-$200 gifts, and sometimes an entire period as one line
   * ("RSLC - SCHEDULE A RECEIPTS 7-1-25 THROUGH 12-31-25", $17,966,904). Left
   * unmarked these become the largest donors in the graph, which is a claim
   * about a person or company that does not exist.
   */
  isAggregate: boolean;
  rowHash: string;
}

export interface Irs8872Filing {
  orgName: string | null;
  ein: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  contributions: Irs8872Contribution[];
  /** Rows the grid produced but that failed validation. */
  skipped: number;
}

interface Cell {
  x: number;
  y: number;
  text: string;
}

interface Line {
  y: number;
  left: string;
  mid: string;
  right: string;
}

/** Assign a cell to a column, or null when it sits outside the grid. */
function columnOf(x: number): 'left' | 'mid' | 'right' | null {
  if (Math.abs(x - COL_LEFT) < COL_TOLERANCE) return 'left';
  if (Math.abs(x - COL_MID) < COL_TOLERANCE) return 'mid';
  if (Math.abs(x - COL_RIGHT) < COL_TOLERANCE) return 'right';
  return null;
}

/**
 * Group cells into visual lines without discarding anything.
 *
 * The cover page is laid out on a different grid from the contribution
 * schedule — the EIN sits at x=389 and the reporting period at x=140 and
 * x=312, none of which are contribution columns — so it has to be read before
 * the column filter is applied.
 */
function toFlatLines(cells: Cell[]): string[] {
  const byY: Cell[][] = [];
  for (const c of [...cells].sort((a, b) => b.y - a.y)) {
    const last = byY[byY.length - 1];
    if (last && Math.abs(last[0].y - c.y) <= LINE_TOLERANCE) last.push(c);
    else byY.push([c]);
  }
  return byY.map((row) =>
    row
      .sort((a, b) => a.x - b.x)
      .map((c) => c.text)
      .join(' '),
  );
}

function toLines(cells: Cell[]): Line[] {
  const byY: Cell[][] = [];
  for (const c of cells.sort((a, b) => b.y - a.y)) {
    const last = byY[byY.length - 1];
    if (last && Math.abs(last[0].y - c.y) <= LINE_TOLERANCE) last.push(c);
    else byY.push([c]);
  }
  return byY.map((row) => {
    const line: Line = { y: row[0].y, left: '', mid: '', right: '' };
    for (const c of row.sort((a, b) => a.x - b.x)) {
      const col = columnOf(c.x);
      if (!col) continue;
      line[col] = line[col] ? `${line[col]} ${c.text}` : c.text;
    }
    return line;
  });
}

const NAME_HEADER = "Contributor's name";

/**
 * Placeholder contributor names.
 *
 * Deliberately narrow: "AGGREGATES" is a common word in real company names —
 * Palm Beach Aggregates LLC and Mid Coast Aggregates are genuine donors — so
 * these match the reporting phrases rather than the bare word.
 */
const AGGREGATE_PATTERNS = [
  /\bAGGREGATE\s+(BELOW|CONTRIBUTIONS?|RECEIPTS?|EXPENDITURES?)\b/i,
  /\bSCHEDULE\s+[AB]\b[\s\S]*\b(RECEIPTS?|EXPENDITURES?)\b/i,
  /\bUNITEMIZED\b/i,
];

export function looksAggregate(name: string): boolean {
  return AGGREGATE_PATTERNS.some((re) => re.test(name));
}
const AGGREGATE_HEADER = 'Aggregate contributions';

/** "$ 1,234.50" -> "1234.50"; returns null when it is not a number. */
export function parseIrsAmount(value: string): string | null {
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * mm/dd/yyyy -> ISO, range-checked.
 *
 * Same discipline as the state and county adapters: a well-formed but
 * impossible date must not reach Postgres and take the whole row down.
 */
export function parseIrsDate(value: string): string | null {
  const m = value.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1980 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "RIVIERA BEACH, FL 33404" -> parts. */
export function parseIrsCityStateZip(value: string): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const v = value.trim();
  if (!v) return { city: null, state: null, zip: null };
  const m = v.match(/^(.*),\s*([A-Za-z]{2})\s+([\d-]+)\s*$/);
  if (m) return { city: m[1].trim() || null, state: m[2].toUpperCase(), zip: m[3] || null };
  const m2 = v.match(/^(.*),\s*([A-Za-z]{2})\s*$/);
  if (m2) return { city: m2[1].trim() || null, state: m2[2].toUpperCase(), zip: null };
  return { city: v, state: null, zip: null };
}

/**
 * Parse one Form 8872 PDF.
 *
 * Each itemized contribution occupies six grid lines:
 *   1  header            | header
 *   2  NAME              | EMPLOYER
 *   3  ADDRESS           | "Contributor's occupation" | "Amount of contribution"
 *   4  CITY, ST ZIP      | OCCUPATION                 | $ AMOUNT
 *   5                    | "Aggregate contributions…"  | "Date of contribution"
 *   6                    | $ YEAR-TO-DATE              | DATE
 */
export async function parseIrs8872Pdf(
  bytes: Uint8Array,
  opts: { minAmount?: number } = {},
): Promise<Irs8872Filing> {
  const minAmount = opts.minAmount ?? 0;
  const pdf = await getDocumentProxy(bytes);

  const filing: Irs8872Filing = {
    orgName: null,
    ein: null,
    periodBegin: null,
    periodEnd: null,
    contributions: [],
    skipped: 0,
  };

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const cells: Cell[] = (content.items as Array<{ str?: string; transform?: number[] }>)
      .filter((i) => typeof i.str === 'string' && i.str.trim() && Array.isArray(i.transform))
      .map((i) => ({
        x: Math.round(i.transform![4]),
        y: Math.round(i.transform![5]),
        text: i.str!.trim(),
      }));
    const lines = toLines(cells);

    if (pageNo === 1) readCoverPage(toFlatLines(cells), filing);

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].left.startsWith(NAME_HEADER)) continue;
      const block = lines.slice(i + 1, i + 6);
      if (block.length < 4) continue;

      const [nameLine, addrLine, cityLine] = block;
      const amount = parseIrsAmount(cityLine?.right ?? '');
      const name = nameLine?.left?.trim();
      if (!name || amount === null) {
        filing.skipped++;
        continue;
      }
      if (Number(amount) < minAmount) continue;

      // Lines 5 and 6 carry the aggregate and date, but a block can be cut off
      // by a page break — treat them as optional rather than dropping the row.
      const dateLine = block.find((l) => l.mid.startsWith(AGGREGATE_HEADER));
      const valueLine = dateLine ? block[block.indexOf(dateLine) + 1] : undefined;

      const { city, state, zip } = parseIrsCityStateZip(cityLine?.left ?? '');
      filing.contributions.push({
        contributorName: name,
        address: addrLine?.left?.trim() || null,
        city,
        state,
        zip,
        employer: nameLine?.mid?.trim() || null,
        occupation: cityLine?.mid?.trim() || null,
        amount,
        date: parseIrsDate(valueLine?.right ?? ''),
        aggregateYtd: parseIrsAmount(valueLine?.mid ?? ''),
        isAggregate: looksAggregate(name),
        // The ordinal matters: a donor can give the same amount on the same
        // day twice, and those are two contributions, not one seen twice.
        // Parse order is stable for a given filing, so re-ingesting is still
        // idempotent.
        rowHash: hashIrsRow([
          filing.ein ?? '',
          filing.periodEnd ?? '',
          String(filing.contributions.length),
          name,
          amount,
          valueLine?.right ?? '',
          cityLine?.left ?? '',
        ]),
      });
    }
  }

  return filing;
}

/** Organization identity and reporting period, from the first page. */
function readCoverPage(lines: string[], filing: Irs8872Filing): void {
  const flat = lines.join('\n');

  const period = flat.match(
    /period beginning\s+(\d{2}\/\d{2}\/\d{4})[\s\S]{0,40}?ending\s+(\d{2}\/\d{2}\/\d{4})/i,
  );
  if (period) {
    filing.periodBegin = parseIrsDate(period[1]);
    filing.periodEnd = parseIrsDate(period[2]);
  }

  const ein = flat.match(/(\d{2})\s*-\s*(\d{7})/);
  if (ein) filing.ein = `${ein[1]}${ein[2]}`;

  // The name sits on the line below its label, sharing that line with the EIN.
  const labelAt = lines.findIndex((l) => /Name of organization/i.test(l));
  const nameLine = labelAt >= 0 ? lines[labelAt + 1] : undefined;
  if (nameLine) {
    filing.orgName = nameLine.replace(/\s+\d{2}\s*-\s*\d{7}.*$/, '').trim() || null;
  }
}

export function hashIrsRow(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* Search + details HTML                                                       */
/* -------------------------------------------------------------------------- */

export interface FilingLink {
  formId: string;
  href: string;
  periodEnd: string | null;
  posted: string | null;
}

/** Detail-page links from a search results page, one per name variant. */
export function parseSearchResults(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*basicSearch\/details\?[^"]*)"/g)) {
    out.add(decodeHtmlAttr(m[1]));
  }
  return [...out];
}

/**
 * Filing links from a detail page.
 *
 * Period end dates sit in the row that contains the download link, so the two
 * are paired by walking table rows rather than by index.
 */
export function parseDetailPage(html: string): { filings: FilingLink[]; nextPage: string | null } {
  const filings: FilingLink[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      decodeHtmlAttr(c[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    );
    const link = row[1].match(/href="([^"]*downloadFile\?[^"]*formType=e8872[^"]*)"/);
    if (!link) continue;
    const href = decodeHtmlAttr(link[1]);
    const formId = href.match(/formId=(\d+)/)?.[1] ?? href;
    const dates = cells.filter((c) => /^\d{2}\/\d{2}\/\d{4}/.test(c));
    filings.push({
      formId,
      href,
      periodEnd: dates[0] ? parseIrsDate(dates[0]) : null,
      posted: dates[1] ? parseIrsDate(dates[1]) : null,
    });
  }

  const next = html.match(/href="([^"]*details\?page=(\d+)[^"]*)"[^>]*>\s*(?:Next|&gt;)/i);
  return { filings, nextPage: next ? decodeHtmlAttr(next[1]) : null };
}

function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}
