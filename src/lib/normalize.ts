/**
 * Name normalization for campaign-finance entity resolution.
 *
 * Florida's campaign finance export carries no entity identifiers. A recipient
 * is the string "Florida Chamber of Commerce PAC (PAC)" and a donor is the
 * string "SECURE FLORIDA'S FUTURE" — with the same organization appearing under
 * different spellings, ZIPs and truncations across filings. Everything that
 * makes the graph connected starts here.
 */

/** Florida truncates the candidate/committee column at this width. */
export const FL_NAME_TRUNCATION_WIDTH = 40;

/** Trailing corporate forms that carry no identity signal. */
const CORPORATE_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'LLP',
  'LP',
  'LTD',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'PA',
  'PC',
  'PLLC',
  'TRUST',
  'HOLDINGS',
  'GROUP',
  'ENTERPRISES',
]);

/**
 * Political-committee suffixes.
 *
 * Stripped only to build the loose blocking key, never the canonical form:
 * "Florida Chamber of Commerce PAC" and "Florida Chamber of Commerce Alliance"
 * are genuinely different committees and must not collapse together.
 */
const POLITICAL_SUFFIXES = new Set([
  'PAC',
  'PACS',
  'CCE',
  'ECO',
  'ECI',
  'IXO',
  'PAP',
  'PTY',
  'COMMITTEE',
  'POLITICAL',
  'CAMPAIGN',
  'FUND',
  'FOR',
]);

/** Words dropped entirely when comparing — pure noise across all filings. */
const STOPWORDS = new Set(['THE', 'OF', 'AND', 'A', 'AN']);

/**
 * Strip the parenthetical type tag Florida appends to recipient names, e.g.
 * "Florida Chamber of Commerce PAC (PAC)" -> "Florida Chamber of Commerce PAC".
 * Returns the bare name and the tag if one was present.
 */
export function splitTypeTag(raw: string): { name: string; typeTag: string | null } {
  const m = raw.match(/^(.*?)\s*\((PAC|CCE|ECO|ECI|IXO|PAP|PTY)\)\s*$/i);
  if (!m) return { name: raw.trim(), typeTag: null };
  return { name: m[1].trim(), typeTag: m[2].toUpperCase() };
}

/**
 * Canonical normalized form: case, punctuation and whitespace folded away, but
 * every meaningful word kept. This is the equality key — two strings sharing a
 * `normalizeName` are treated as the same entity without further evidence.
 */
export function normalizeName(raw: string): string {
  return (
    splitTypeTag(raw)
      .name.toUpperCase()
      .normalize('NFKD')
      // Drop diacritics.
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' AND ')
      // Possessives: SECURE FLORIDA'S FUTURE -> SECURE FLORIDAS FUTURE
      .replace(/'S\b/g, 'S')
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Loose key for candidate generation: canonical form minus corporate and
 * political suffixes and stopwords, alphabetically sorted.
 *
 * Sorting makes word order irrelevant, so "Friends of Jane Doe" and
 * "Jane Doe, Friends of" produce the same key. Deliberately lossy — it proposes
 * candidates that `scoreMatch` then has to justify.
 */
export function blockingKey(raw: string): string {
  const tokens = normalizeName(raw)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .filter((t) => !CORPORATE_SUFFIXES.has(t))
    .filter((t) => !POLITICAL_SUFFIXES.has(t));

  // If suffix-stripping ate everything, fall back to the unstripped tokens
  // rather than emitting an empty key that would match every other empty key.
  const kept = tokens.length > 0 ? tokens : normalizeName(raw).split(' ').filter(Boolean);
  return [...kept].sort().join(' ');
}

/** Significant tokens of a name, for overlap scoring. */
export function significantTokens(raw: string): Set<string> {
  return new Set(
    normalizeName(raw)
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/**
 * True when a string looks like it was cut off at Florida's column width.
 *
 * A value at exactly the limit is almost certainly truncated — real names
 * rarely land on the boundary — so it must be compared by prefix, not equality.
 */
export function looksTruncated(raw: string, width = FL_NAME_TRUNCATION_WIDTH): boolean {
  const { name } = splitTypeTag(raw);
  return name.length >= width;
}

/**
 * Heuristic: does this contributor string name a person rather than an org?
 *
 * Florida reports individuals as "LAST, FIRST" or "LAST, FIRST M" and reports
 * organizations as plain names. Occupation is a strong secondary signal but is
 * handled by the caller.
 */
export function looksLikePerson(raw: string): boolean {
  const s = raw.trim();
  if (/\b(INC|LLC|CORP|COMPANY|PAC|COMMITTEE|ASSOCIATION|UNION|FUND|TRUST|LP|LLP)\b/i.test(s)) {
    return false;
  }
  // "SMITH, JOHN" / "SMITH, JOHN A"
  if (/^[A-Za-z'.\- ]+,\s*[A-Za-z][A-Za-z'.\- ]*$/.test(s)) return true;
  return false;
}

/** Reorder "LAST, FIRST" into "FIRST LAST"; leave anything else untouched. */
export function personDisplayName(raw: string): string {
  const m = raw.trim().match(/^([^,]+),\s*(.+)$/);
  if (!m || !looksLikePerson(raw)) return raw.trim();
  return `${m[2].trim()} ${m[1].trim()}`.replace(/\s+/g, ' ');
}

/** Dice coefficient over character trigrams — mirrors Postgres pg_trgm. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  if (a === b) return 1;
  if (!a || !b) return 0;
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  const union = ga.size + gb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Fraction of the smaller token set that both names share. */
export function tokenOverlap(a: string, b: string): number {
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export interface MatchSignals {
  /** ZIPs from the two records, if known. */
  zipA?: string | null;
  zipB?: string | null;
  cityA?: string | null;
  cityB?: string | null;
  /** Set when the shorter string came from a truncated column. */
  truncated?: boolean;
}

export interface MatchScore {
  score: number;
  reasons: string[];
}

/**
 * Score how likely two names refer to the same entity, in 0..1.
 *
 * Combines trigram similarity, token overlap and geography. Address agreement
 * only ever *raises* a score — a mismatch is weak evidence, because the same
 * organization legitimately files under 32301 and 32302 in the same cycle
 * (observed in the live 2024 data for Secure Florida's Future).
 */
export function scoreMatch(a: string, b: string, signals: MatchSignals = {}): MatchScore {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const reasons: string[] = [];

  if (na === nb) {
    reasons.push('exact-normalized');
    return { score: 1, reasons };
  }

  // A truncated string can only ever be a prefix of the full name.
  if (signals.truncated) {
    const [shortName, longName] = na.length <= nb.length ? [na, nb] : [nb, na];
    if (longName.startsWith(shortName) && shortName.length >= 12) {
      reasons.push('truncated-prefix');
      return { score: 0.95, reasons };
    }
  }

  if (blockingKey(a) === blockingKey(b)) reasons.push('same-blocking-key');

  const trig = trigramSimilarity(na, nb);
  const overlap = tokenOverlap(a, b);
  let score = trig * 0.55 + overlap * 0.45;
  reasons.push(`trigram=${trig.toFixed(2)}`, `overlap=${overlap.toFixed(2)}`);

  if (blockingKey(a) === blockingKey(b)) score = Math.max(score, 0.8);

  const zipA = signals.zipA?.slice(0, 5);
  const zipB = signals.zipB?.slice(0, 5);
  if (zipA && zipB && zipA === zipB) {
    score += 0.08;
    reasons.push('zip-match');
  } else if (
    zipA &&
    zipB &&
    zipA.slice(0, 3) === zipB.slice(0, 3) &&
    zipA.length === 5 &&
    zipB.length === 5
  ) {
    // Same ZIP3 covers the 32301/32302 case above.
    score += 0.04;
    reasons.push('zip3-match');
  }

  if (
    signals.cityA &&
    signals.cityB &&
    signals.cityA.trim().toUpperCase() === signals.cityB.trim().toUpperCase()
  ) {
    score += 0.03;
    reasons.push('city-match');
  }

  return { score: Math.min(score, 0.99), reasons };
}

/**
 * Confidence at or above which two names are auto-linked without review.
 * Deliberately high: a wrong merge invents money flows that do not exist, which
 * is far worse for this tool than leaving two nodes unlinked.
 */
export const AUTO_LINK_THRESHOLD = 0.88;

/** Below this, a candidate pair is not even worth storing for review. */
export const REVIEW_FLOOR = 0.62;

/**
 * Local offices that every county has one of, named without saying which.
 *
 * County filings routinely give the bare office — "Republican Executive
 * Committee", "Supervisor of Elections" — because within one county's records
 * there is no ambiguity. Across counties there is nothing but ambiguity: the
 * name is identical in all 67, so left alone they collapse into a single node,
 * or worse, onto some other county's committee that does spell itself out.
 *
 * Matching is deliberately narrow. It fires only when the name states one of
 * these offices *and* names no county, so "St. Johns County Republican
 * Executive Committee" is untouched and stays a single entity statewide.
 */
const GENERIC_LOCAL_OFFICES = [
  /\b(REPUBLICAN|DEMOCRATIC|LIBERTARIAN|GREEN|INDEPENDENT)\s+(PARTY\s+)?EXECUTIVE\s+COMMITTEE\b/,
  /\bSUPERVISOR\s+OF\s+ELECTIONS\b/,
  /\bELECTIONS\s+SUPERVISOR\b/,
  /\b(COUNTY\s+)?CANVASSING\s+BOARD\b/,
];

/** Words that mean the name already says which county it belongs to. */
const NAMES_A_PLACE = /\b(COUNTY|CNTY|COUNTIES|CO)\b\s*\w|\b(OF|FOR)\s+[A-Z]/;

/**
 * True when a name identifies a local office but not which county's.
 *
 * Such a name is only meaningful alongside the county it was filed in, which
 * the loader always knows — it chose the county when it fetched the file.
 */
export function isGenericLocalOffice(normalized: string): boolean {
  if (!GENERIC_LOCAL_OFFICES.some((re) => re.test(normalized))) return false;
  return !NAMES_A_PLACE.test(normalized);
}

/**
 * Key a generic office name to the county it was filed in.
 *
 * Kept out of the display name: the entity still reads as the county spells
 * it, and only the identity used for matching carries the qualifier.
 */
export function scopedName(normalized: string, jurisdictionCode: string): string {
  return `${normalized} @${jurisdictionCode}`;
}
