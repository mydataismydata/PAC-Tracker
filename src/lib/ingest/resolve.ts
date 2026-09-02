/**
 * Entity resolution against the database.
 *
 * This is the load-bearing piece of the whole project. Florida's export gives
 * only free-text names, so "SECURE FLORIDA'S FUTURE" (a donor string) and
 * "Secure Florida's Future Inc." (another donor string) and any committee node
 * of the same name have to collapse onto one graph node — otherwise the money
 * chain breaks and the crawler cannot walk past the first hop.
 *
 * Strategy, cheapest first:
 *   1. in-process cache
 *   2. exact match on normalized name
 *   3. exact match on a known alias
 *   4. prefix match, for names truncated at Florida's 40-char column width
 *   5. trigram shortlist, scored with address signals
 *   6. create a new entity
 *
 * The auto-link threshold is deliberately high. A false merge fabricates money
 * flows that do not exist, which is a far worse failure for this tool than
 * leaving two nodes separate.
 */

import { sql, eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { entities, entityAliases } from '@/db/schema';
import * as schema from '@/db/schema';
import type { CounterpartyKind } from './types';
import {
  normalizeName,
  scoreMatch,
  looksTruncated,
  classifyName,
  personDisplayName,
  plainNameTokens,
  AUTO_LINK_THRESHOLD,
  isGenericLocalOffice,
  scopedName,
  REVIEW_FLOOR,
} from '@/lib/normalize';
import { classifyIndustry } from './industry';
import { CandidateIndex, officeCodeFromName } from './candidates';

type Db = PostgresJsDatabase<typeof schema>;

export interface ResolveInput {
  rawName: string;
  /** Recipients are filers and therefore authoritative; donors are messy. */
  role: 'recipient' | 'contributor';
  /**
   * What the source says this counterparty is.
   *
   * County VoterFocus exports carry a real contributor-type code, so a
   * `committee` here is direct evidence rather than a guess. The state feed
   * offers nothing equivalent, which is why `classifyContributor` exists.
   */
  kindHint?: CounterpartyKind;
  /**
   * The other side of an expenditure: a vendor, not a donor. Money paid out
   * goes to businesses far more often than to people, so a payee the name
   * cannot place is an organization where a donor would be a person.
   */
  payee?: boolean;
  /**
   * The payer is a committee or party, so this payee is where a conduit's
   * money went. A candidate's name here is the campaign account, and it
   * resolves to the candidate node before any other lookup runs.
   */
  payerIsCommittee?: boolean;
  /**
   * The source calls this row a contribution to a candidate — Florida's
   * expenditure type `CAN`, or a purpose reading CONTRIBUTION. A bare person
   * name on a committee's payee line is the campaign only then; the same name
   * on a mileage or reimbursement line is a staffer who shares it.
   */
  candidateContribution?: boolean;
  /** Date of the row, for telling one person's campaigns apart. */
  txnDate?: string | null;
  /** Office sought, when the source reports it. */
  office?: string | null;
  party?: string | null;
  committeeType?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  address?: string | null;
  occupation?: string | null;
  jurisdictionId?: string | null;
  /**
   * Jurisdiction code, e.g. `FL-STJOHNS`, when the caller loaded from a source
   * scoped to one place. Only used to disambiguate generic local-office names.
   */
  jurisdictionCode?: string | null;
  sourceId?: string | null;
}

export interface ResolveResult {
  entityId: string;
  confidence: number;
  created: boolean;
  method: 'cache' | 'exact' | 'alias' | 'prefix' | 'fuzzy' | 'created' | 'candidate';
}

/** Rows the shortlist query returns. */
interface Candidate {
  id: string;
  name: string;
  normalizedName: string;
  zip: string | null;
  city: string | null;
  kind: string;
}

/**
 * Trust the source's own type code when it gives one.
 *
 * Returns undefined for hints that carry no entity information — `self` just
 * means the candidate funded their own campaign, and `other`/`unknown` are
 * where the heuristic has to take over.
 */
function kindFromHint(
  hint?: CounterpartyKind,
): 'committee' | 'party' | 'organization' | 'individual' | undefined {
  switch (hint) {
    case 'committee':
      return 'committee';
    case 'party':
      return 'party';
    case 'business':
      return 'organization';
    case 'individual':
    case 'self':
      return 'individual';
    default:
      return undefined;
  }
}

/** Which check settled a contributor's kind. */
export type KindRule =
  | 'committee-name'
  | 'committee-occupation'
  | 'org-word'
  | 'person-name'
  | 'person-comma'
  | 'person-occupation'
  | 'org-occupation'
  | 'plain-name'
  | 'payee-default'
  | 'default-org';

/** Rules that rest on the name itself. The others lean on weaker evidence. */
export const STRONG_KIND_RULES: ReadonlySet<KindRule> = new Set<KindRule>([
  'committee-name',
  'org-word',
  'person-name',
]);

const BLANK_OCCUPATION = /^(N\/?A|NONE|UNK|UNKNOWN|NOT PROVIDED|INFO(RMATION)? REQUESTED|REQUESTED)$/;

const COMMITTEE_OCCUPATION = /^(.*\b)?(PAC|PC|CCE|ECO|POLITICAL (ACTION )?COMMITTEE|ACTION COMMITTEE)$/;

/**
 * A registered form or a "<sector> FIRM" describes the organization itself,
 * and outranks a job word in the same string: "CPA FIRM" is a firm.
 */
const REGISTERED_ORG_OCCUPATION =
  /\b(INC|LLC|CORP|CORPORATION|INCORPORATED|LLP|PLLC|NON[- ]?PROFIT|NOT[- ]FOR[- ]PROFIT|501|ORGANIZATION|ASSOCIATION|ASSN|FOUNDATION|COALITION|ALLIANCE|COOPERATIVE|CO-OP|TRIBE|TRIBAL)\b|^(CPA|LAW|ACCOUNTING|CONSULTING|ENGINEERING|ARCHITECTURE|ARCHITECTURAL|LOBBYING|PR|MARKETING|ADVERTISING|INVESTMENT|REAL ESTATE|INSURANCE|TITLE|DESIGN) FIRM$/;

/** Job titles. OWNER or ATTORNEY describes a person, whatever the sector. */
const PERSON_OCCUPATION =
  /\b(RETIRED|HOMEMAKER|HOUSEWIFE|NOT EMPLOYED|UNEMPLOYED|STUDENT|INDIVIDUAL|SELF[- ]?EMPLOYED|ATTORNEY|LAWYER|PHYSICIAN|DOCTOR|DENTIST|NURSE|TEACHER|PROFESSOR|ENGINEER|ARCHITECT|ACCOUNTANT|CPA|CONSULTANT|EXECUTIVE|OFFICER|PRESIDENT|DIRECTOR|MANAGER|OWNER|BROKER|AGENT|REALTOR|SALES|SALESMAN|SALESPERSON|DEVELOPER|INVESTOR|BANKER|PILOT|FIREFIGHTER|POLICE|DEPUTY|SHERIFF|ELECTRICIAN|PLUMBER|IRONWORKER|CARPENTER|MECHANIC|DRIVER|FARMER|RANCHER|GROWER|CHEF|SERVER|ARTIST|WRITER|AUTHOR|EDITOR|JOURNALIST|PASTOR|MINISTER|RABBI|COMMISSIONER|MAYOR|SENATOR|REPRESENTATIVE|LEGISLATOR|JUDGE|CANDIDATE|ANALYST|PROGRAMMER|SCIENTIST|PHARMACIST|THERAPIST|COUNSELOR|VETERINARIAN|CHIROPRACTOR|OPTOMETRIST|OPTICIAN|ANESTHESIOLOGIST|SURGEON|RADIOLOGIST|PHILANTHROPIST|ENTREPRENEUR|ADVISOR|ADVISER|SPECIALIST|COORDINATOR|ASSISTANT|TECHNICIAN|CLERK|SECRETARY|PARALEGAL|PRINCIPAL|SUPERINTENDENT|ADMINISTRATOR|SUPERVISOR|FOREMAN|LABORER|WORKER|EMPLOYEE|MEMBER|PARTNER|FOUNDER|CEO|CFO|COO|CHAIRMAN|CHAIRWOMAN|TRUSTEE|DESIGNER|STYLIST|BARBER|MUSICIAN|ACTOR|COACH|TRAINER|ATHLETE|VOLUNTEER|VETERAN|INVESTIGATOR|INSPECTOR|PLANNER|CONTRACTOR|DISABLED|LOBBYIST|BUSINESSMAN|BUSINESSWOMAN|DIR|MGR|VP|EVP|SVP|EXEC|ATTY|PRES|ASST|REP|SUPV|DEAN|PROF|BOOKKEEPER|RECEPTIONIST)\b/;

/**
 * Words that describe an organization rather than a job. Checked after the
 * job titles, so "BUSINESS OWNER" and "BANK PRESIDENT" stay people.
 */
const ORG_OCCUPATION =
  /\b(COMPANY|CO\.|SOCIAL WELFARE|TRUST|FUND|PARTNERSHIP|BUSINESS|DISTRIBUTOR|MANUFACTURER|DEALERSHIP|FIRM|INDUSTRY|GOVERNMENT|UNION|CHAMBER|CLUB|CHURCH|HOSPITAL|UNIVERSITY|SCHOOL|BANK|COMPANIES|SUPPLIER|VENDOR|RETAILER|ENTERPRISE|ENTERPRISES|FACILITY|CENTER|AGENCY|STORE|SHOP|PRACTICE|CLINIC|OFFICES|ATTORNEYS|AT LAW|STADIUM|THERAPEUTICS)\b/;

/**
 * What the occupation column says about a contributor when the name alone
 * does not settle it. Florida requires an occupation for individuals, and
 * organizations tend to put a sector or a corporate form there instead.
 * Sector words on their own — REAL ESTATE, INSURANCE, HEALTHCARE — are used
 * by both and decide nothing.
 */
export function classifyOccupation(
  occupation?: string | null,
): 'committee' | 'person' | 'organization' | null {
  const occ = (occupation ?? '').trim().toUpperCase();
  if (!occ || BLANK_OCCUPATION.test(occ)) return null;
  if (COMMITTEE_OCCUPATION.test(occ) || classifyIndustry(occ, '') === 'Political committee') {
    return 'committee';
  }
  if (REGISTERED_ORG_OCCUPATION.test(occ)) return 'organization';
  if (PERSON_OCCUPATION.test(occ)) return 'person';
  if (ORG_OCCUPATION.test(occ)) return 'organization';
  return null;
}

/**
 * Classify a contributor string when the source offers no type code, and say
 * which check decided.
 *
 * The order matters. A committee-shaped name wins outright: a PAC is a
 * conduit, not a terminal donor, and a trace needs `kind` to say so or it
 * stops there and credits the PAC itself as an original source. An
 * organization word in the name comes next and beats every person signal, so
 * a law firm filed as "RONALD BOOK, PA" with occupation ATTORNEY stays a
 * firm. Then the person shapes, then occupation, and last the shape of the
 * name alone: a name that could be a person's and carries nothing else is
 * far more often a person with an uncommon given name than a company with
 * none of the usual words in it. A vendor is the exception — see
 * `ResolveInput.payee`.
 */
export function classifyContributorDetailed(
  rawName: string,
  occupation?: string | null,
  opts: { payee?: boolean } = {},
): { kind: 'individual' | 'organization' | 'committee'; rule: KindRule } {
  const shape = classifyName(rawName);
  if (shape === 'committee') return { kind: 'committee', rule: 'committee-name' };
  const occ = classifyOccupation(occupation);
  if (occ === 'committee' && shape !== 'person' && shape !== 'person-comma') {
    return { kind: 'committee', rule: 'committee-occupation' };
  }
  if (shape === 'organization') return { kind: 'organization', rule: 'org-word' };
  if (shape === 'person') return { kind: 'individual', rule: 'person-name' };
  if (shape === 'person-comma') return { kind: 'individual', rule: 'person-comma' };
  if (occ === 'person') return { kind: 'individual', rule: 'person-occupation' };
  if (occ === 'organization') return { kind: 'organization', rule: 'org-occupation' };
  if (plainNameTokens(rawName)) {
    return opts.payee
      ? { kind: 'organization', rule: 'payee-default' }
      : { kind: 'individual', rule: 'plain-name' };
  }
  return { kind: 'organization', rule: 'default-org' };
}

/** `classifyContributorDetailed` without the reason. */
export function classifyContributor(
  rawName: string,
  occupation?: string | null,
  opts: { payee?: boolean } = {},
): 'individual' | 'organization' | 'committee' {
  return classifyContributorDetailed(rawName, occupation, opts).kind;
}

export class EntityResolver {
  /** normalizedName -> entityId, scoped to one ingest run. */
  private cache = new Map<string, string>();
  private stats = { cache: 0, exact: 0, alias: 0, prefix: 0, fuzzy: 0, created: 0, candidate: 0 };
  /** Candidate nodes by person name, loaded the first time a committee's payee needs it. */
  private candidates: CandidateIndex | null = null;

  constructor(private readonly db: Db) {}

  private async candidateIndex(): Promise<CandidateIndex> {
    if (!this.candidates) this.candidates = await CandidateIndex.load(this.db);
    return this.candidates;
  }

  getStats() {
    return { ...this.stats };
  }

  clearCache() {
    this.cache.clear();
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const bare = normalizeName(input.rawName);
    if (!bare) {
      throw new Error(`cannot resolve empty name from "${input.rawName}"`);
    }

    // A name that gives a local office but no county means "ours" to the county
    // that filed it, and nothing at all on its own. The caller knows which
    // county — it picked one to fetch — so that is folded into the identity
    // used for matching. Everything else resolves statewide as before, which is
    // what lets a committee giving at several levels stay one node.
    const normalized =
      input.jurisdictionCode && isGenericLocalOffice(bare)
        ? scopedName(bare, input.jurisdictionCode)
        : bare;

    // 1. A committee's or party's payee that names a candidate is that
    //    candidate's campaign account, whatever spelling the payer used. This
    //    runs before the cache because the cache is keyed on the name alone,
    //    and the same name on the contributor side is the person, not the
    //    campaign: those rows keep resolving as they always did.
    if (input.payee && input.payerIsCommittee) {
      const hit = (await this.candidateIndex()).match(input.rawName, input.txnDate ?? null);
      // A name written as a campaign is the campaign on any line; a bare
      // person name is only when the row itself says it is a contribution.
      if (hit.node && (hit.parsed.named || input.candidateContribution)) {
        this.stats.candidate++;
        return { entityId: hit.node.id, confidence: 1, created: false, method: 'candidate' };
      }
    }

    const cached = this.cache.get(normalized);
    if (cached) {
      this.stats.cache++;
      return { entityId: cached, confidence: 1, created: false, method: 'cache' };
    }

    // 2. Exact normalized-name hit.
    const exact = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.normalizedName, normalized))
      .limit(1);
    if (exact.length > 0) {
      this.cache.set(normalized, exact[0].id);
      await this.enrich(exact[0].id, input);
      this.stats.exact++;
      return { entityId: exact[0].id, confidence: 1, created: false, method: 'exact' };
    }

    // 3. Known alias.
    //
    // Only one good enough to have been linked on its own. Step 6 also stores
    // near-misses, purely so a human can review them, and reading those back as
    // answers is how "Republican Executive Committee" — scoring 0.809 against a
    // committee in a county 170 miles away, well under the bar to link — became
    // the permanent identity for two other counties' party committees.
    const alias = await this.db
      .select({ id: entityAliases.entityId, confidence: entityAliases.confidence })
      .from(entityAliases)
      .where(
        and(
          eq(entityAliases.normalizedAlias, normalized),
          sql`${entityAliases.confidence} >= ${AUTO_LINK_THRESHOLD}`,
        ),
      )
      .orderBy(sql`${entityAliases.confidence} DESC`)
      .limit(1);
    if (alias.length > 0) {
      this.cache.set(normalized, alias[0].id);
      this.stats.alias++;
      return {
        entityId: alias[0].id,
        confidence: alias[0].confidence,
        created: false,
        method: 'alias',
      };
    }

    // 4. Truncated names can only be a prefix of the true name.
    if (looksTruncated(input.rawName) && normalized.length >= 12) {
      const prefixHit = await this.db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(sql`${entities.normalizedName} LIKE ${normalized + '%'}`)
        .orderBy(sql`length(${entities.normalizedName}) ASC`)
        .limit(2);

      // Only accept an unambiguous prefix expansion.
      if (prefixHit.length === 1) {
        await this.recordAlias(prefixHit[0].id, input.rawName, normalized, 0.95, true);
        this.cache.set(normalized, prefixHit[0].id);
        this.stats.prefix++;
        return { entityId: prefixHit[0].id, confidence: 0.95, created: false, method: 'prefix' };
      }
    }

    // 5. Trigram shortlist, then score properly in application code where the
    //    address signals are available.
    const shortlist = await this.shortlist(normalized);
    let best: { candidate: Candidate; score: number } | null = null;
    for (const c of shortlist) {
      const { score } = scoreMatch(input.rawName, c.name, {
        zipA: input.zip,
        zipB: c.zip,
        cityA: input.city,
        cityB: c.city,
        truncated: looksTruncated(input.rawName),
      });
      if (!best || score > best.score) best = { candidate: c, score };
    }

    if (best && best.score >= AUTO_LINK_THRESHOLD) {
      await this.recordAlias(best.candidate.id, input.rawName, normalized, best.score, false);
      this.cache.set(normalized, best.candidate.id);
      this.stats.fuzzy++;
      return {
        entityId: best.candidate.id,
        confidence: best.score,
        created: false,
        method: 'fuzzy',
      };
    }

    // 6. Nothing convincing — this is a new node. Near-misses above the review
    //    floor are still recorded as low-confidence aliases so a human (or a
    //    later pass with more evidence) can merge them.
    const created = await this.create(input, normalized);
    if (best && best.score >= REVIEW_FLOOR) {
      await this.recordAlias(best.candidate.id, input.rawName, normalized, best.score, false);
    }
    this.cache.set(normalized, created);
    this.stats.created++;
    return { entityId: created, confidence: 1, created: true, method: 'created' };
  }

  /**
   * Trigram-similar entities, using the GIN index.
   *
   * `%` is pg_trgm's similarity operator and is index-backed;
   * `similarity()` in the ORDER BY only ranks the already-narrowed set.
   */
  private async shortlist(normalized: string): Promise<Candidate[]> {
    const rows = await this.db
      .select({
        id: entities.id,
        name: entities.name,
        normalizedName: entities.normalizedName,
        zip: entities.zip,
        city: entities.city,
        kind: sql<string>`${entities.kind}::text`,
      })
      .from(entities)
      .where(sql`${entities.normalizedName} % ${normalized}`)
      .orderBy(sql`similarity(${entities.normalizedName}, ${normalized}) DESC`)
      .limit(10);
    return rows as Candidate[];
  }

  private async recordAlias(
    entityId: string,
    alias: string,
    normalizedAlias: string,
    confidence: number,
    isTruncated: boolean,
  ): Promise<void> {
    await this.db
      .insert(entityAliases)
      .values({
        entityId,
        alias,
        normalizedAlias,
        origin: 'resolved',
        confidence,
        isTruncated,
      })
      .onConflictDoNothing();
  }

  /**
   * Fill in blanks on an existing entity without overwriting known values.
   *
   * A recipient row carries a clean filer name and committee type; a
   * contributor row often carries the only address we will ever see.
   */
  private async enrich(entityId: string, input: ResolveInput): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.zip) patch.zip = sql`COALESCE(${entities.zip}, ${input.zip})`;
    if (input.city) patch.city = sql`COALESCE(${entities.city}, ${input.city})`;
    if (input.address) patch.address = sql`COALESCE(${entities.address}, ${input.address})`;
    if (input.state) patch.stateCode = sql`COALESCE(${entities.stateCode}, ${input.state})`;
    if (input.occupation) {
      patch.occupation = sql`COALESCE(${entities.occupation}, ${input.occupation})`;
      const inferred = classifyIndustry(input.occupation, input.rawName);
      if (inferred) {
        patch.industry = sql`COALESCE(${entities.industry}, ${inferred})`;
      }
    }
    if (Object.keys(patch).length === 0) return;
    await this.db.update(entities).set(patch).where(eq(entities.id, entityId));
  }

  private async create(input: ResolveInput, normalized: string): Promise<string> {
    const isRecipient = input.role === 'recipient';
    const kind = isRecipient
      ? input.committeeType
        ? ('committee' as const)
        : ('candidate' as const)
      : (kindFromHint(input.kindHint) ??
        classifyContributor(input.rawName, input.occupation, { payee: input.payee }));

    const displayName =
      kind === 'individual' ? personDisplayName(input.rawName) : input.rawName.trim();

    const [row] = await this.db
      .insert(entities)
      .values({
        kind,
        name: displayName,
        normalizedName: normalized,
        committeeType: (input.committeeType as never) ?? null,
        // Anything that receives money is worth expanding. Contributors start
        // terminal and get promoted by `refreshTraversability` if they turn out
        // to receive money too — which is how a 501(c)(4) conduit like Secure
        // Florida's Future becomes walkable despite not being a registered
        // committee.
        isTraversable: isRecipient,
        jurisdictionId: input.jurisdictionId ?? null,
        city: input.city ?? null,
        stateCode: input.state ?? null,
        zip: input.zip ?? null,
        address: input.address ?? null,
        occupation: input.occupation ?? null,
        industry: classifyIndustry(input.occupation, displayName, kind),
        office: input.office ?? null,
        party: input.party ?? null,
        sourceId: input.sourceId ?? null,
      })
      .returning({ id: entities.id });

    if (kind === 'candidate') {
      this.candidates?.add({
        id: row.id,
        name: displayName,
        officeCode: officeCodeFromName(displayName),
        office: input.office ?? null,
        firstSeen: null,
        lastSeen: null,
      });
    }

    await this.db
      .insert(entityAliases)
      .values({
        entityId: row.id,
        alias: input.rawName.trim(),
        normalizedAlias: normalized,
        origin: isRecipient ? 'registry' : 'observed',
        confidence: 1,
      })
      .onConflictDoNothing();

    return row.id;
  }
}

/**
 * Promote any entity that has ever received money to traversable.
 *
 * Run after ingest. Registry membership is not sufficient on its own: the
 * biggest conduits in the live Florida data are 501(c)(4) corporations that
 * never appear in the committee registry but move millions between PACs.
 */
export async function refreshTraversability(db: Db): Promise<number> {
  const result = await db.execute(sql`
    UPDATE entities e
       SET is_traversable = true,
           updated_at = now()
     WHERE e.is_traversable = false
       AND EXISTS (SELECT 1 FROM transactions t WHERE t.to_entity_id = e.id)
  `);
  return result.count ?? 0;
}
