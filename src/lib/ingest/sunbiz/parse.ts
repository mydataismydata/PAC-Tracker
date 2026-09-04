/**
 * Parse one record of the Florida Division of Corporations corporate data file.
 *
 * The file is fixed-width ASCII, 1,440 bytes per record, one entity per line,
 * documented at https://dos.sunbiz.org/data-definitions/cor.html. This reads
 * only the fields that answer "who runs this nonprofit": the registered agent
 * and up to six officers/directors, plus the status, formation date and FEI/EIN
 * used to key and date the profile. Addresses are in the record too but are not
 * read here — the panel does not show them for the board.
 *
 * A name field is itself three fixed sub-columns, not free text: last (20),
 * first (14), middle (8). A record acting through a corporation (type `C`, e.g.
 * a commercial registered-agent company) has no first/middle, so the whole
 * field is the organisation's name.
 */

/** 1-based field positions, straight from the published layout. */
const F = {
  docNumber: [1, 12],
  name: [13, 192],
  status: [205, 1],
  fileDate: [473, 8],
  fei: [481, 14],
  raName: [545, 42],
  raType: [587, 1],
  // Officer 1 begins here; each officer is a fixed 128-byte block after it.
  officer0: 669,
  officerStride: 128,
  officerTitle: [0, 4], // offsets relative to an officer block's start
  officerType: [4, 1],
  officerName: [5, 42],
} as const;

/** The three sub-columns inside a 42-char name field. */
const NAME_LAST = [0, 20] as const;
const NAME_FIRST = [20, 14] as const;
const NAME_MIDDLE = [34, 8] as const;

export const SUNBIZ_RECORD_LENGTH = 1440;

export interface SunbizName {
  /** Present for a person; empty when the party is a corporation. */
  first: string;
  last: string;
  middle: string;
  /** Nicely-cased for display: "First M. Last", or the org name verbatim. */
  display: string;
  /** False when this officer/agent is a corporation, not a person. */
  isPerson: boolean;
}

export interface SunbizOfficer {
  /** The raw title code as filed, e.g. "D", "TREA", "PRES". */
  titleCode: string;
  /** That code expanded to a word, e.g. "Director", "Treasurer". */
  titleLabel: string;
  name: SunbizName;
}

export interface SunbizRecord {
  docNumber: string;
  name: string;
  status: 'A' | 'I';
  /** Formation filing date as ISO yyyy-mm-dd, or null if unparseable. */
  fileDate: string | null;
  /** FEI/EIN as filed (e.g. "87-4361946"), or null. */
  fei: string | null;
  registeredAgent: SunbizName | null;
  officers: SunbizOfficer[];
}

function at(line: string, [start1, len]: readonly [number, number]): string {
  return line.slice(start1 - 1, start1 - 1 + len).trim();
}

/** Title-case a token only when it arrives all-caps; leave mixed case alone. */
function smartCase(s: string): string {
  if (!s || /[a-z]/.test(s)) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/**
 * Split a 42-char name field into a person or an organisation.
 *
 * `isPerson` comes from the record's type flag: `P` is a person and splits into
 * the three sub-columns; anything else is a company whose name fills the field.
 */
function parseName(field: string, isPerson: boolean): SunbizName {
  if (!isPerson) {
    const org = field.trim();
    return { first: '', last: org, middle: '', display: smartCase(org), isPerson: false };
  }
  const last = smartCase(field.slice(NAME_LAST[0], NAME_LAST[0] + NAME_LAST[1]).trim());
  const first = smartCase(field.slice(NAME_FIRST[0], NAME_FIRST[0] + NAME_FIRST[1]).trim());
  const middle = smartCase(field.slice(NAME_MIDDLE[0], NAME_MIDDLE[0] + NAME_MIDDLE[1]).trim());
  const mid = middle ? (middle.length === 1 ? `${middle}.` : middle) : '';
  const display = [first, mid, last].filter(Boolean).join(' ');
  return { first, last, middle, display, isPerson: true };
}

/** Officer title code (1–4 chars, often truncated) to a readable office. */
function titleLabel(code: string): string {
  const c = code.toUpperCase();
  const prefix: [string, string][] = [
    ['DIR', 'Director'],
    ['PRE', 'President'],
    ['VIC', 'Vice President'],
    ['VP', 'Vice President'],
    ['TRE', 'Treasurer'],
    ['SEC', 'Secretary'],
    ['CHA', 'Chairman'],
    ['CHM', 'Chairman'],
    ['CEO', 'CEO'],
    ['CFO', 'CFO'],
    ['AMBR', 'Managing Member'],
    ['MGR', 'Manager'],
    ['MEM', 'Member'],
  ];
  for (const [p, label] of prefix) if (c.startsWith(p)) return label;
  const single: Record<string, string> = { P: 'President', V: 'Vice President', T: 'Treasurer', S: 'Secretary', D: 'Director', C: 'Chairman' };
  return single[c] ?? smartCase(code);
}

/** MMDDYYYY as filed to ISO yyyy-mm-dd, or null if it is not eight digits. */
function toIso(mmddyyyy: string): string | null {
  if (!/^\d{8}$/.test(mmddyyyy)) return null;
  return `${mmddyyyy.slice(4, 8)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
}

/** Parse one fixed-width line into the fields the profile needs. */
export function parseSunbizRecord(line: string): SunbizRecord {
  const raType = at(line, F.raType);
  const raField = line.slice(F.raName[0] - 1, F.raName[0] - 1 + F.raName[1]);
  const ra = raField.trim() ? parseName(raField, raType === 'P') : null;

  const officers: SunbizOfficer[] = [];
  for (let i = 0; i < 6; i++) {
    const base = F.officer0 + i * F.officerStride;
    const titleCode = line.slice(base - 1 + F.officerTitle[0], base - 1 + F.officerTitle[0] + F.officerTitle[1]).trim();
    const type = line.slice(base - 1 + F.officerType[0], base - 1 + F.officerType[0] + F.officerType[1]);
    const nameField = line.slice(base - 1 + F.officerName[0], base - 1 + F.officerName[0] + F.officerName[1]);
    if (!nameField.trim()) continue;
    officers.push({ titleCode, titleLabel: titleLabel(titleCode), name: parseName(nameField, type === 'P') });
  }

  const fei = at(line, F.fei);
  return {
    docNumber: at(line, F.docNumber),
    name: at(line, F.name),
    status: at(line, F.status) === 'I' ? 'I' : 'A',
    fileDate: toIso(at(line, F.fileDate)),
    fei: fei || null,
    registeredAgent: ra,
    officers,
  };
}
