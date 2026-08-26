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
  looksLikePerson,
  personDisplayName,
  AUTO_LINK_THRESHOLD,
  isGenericLocalOffice,
  scopedName,
  REVIEW_FLOOR,
} from '@/lib/normalize';
import { classifyIndustry } from './industry';

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
  method: 'cache' | 'exact' | 'alias' | 'prefix' | 'fuzzy' | 'created';
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

/**
 * Classify a contributor string when the source offers no type code.
 *
 * Occupation is the strongest available signal — Florida requires it for
 * individuals, and organizations put a sector description there instead
 * ("SOCIAL WELFARE ORGANIZATION", "AGRICULTURE", "ENERGY COMPANY").
 */
export function classifyContributor(
  rawName: string,
  occupation?: string | null,
): 'individual' | 'organization' {
  if (looksLikePerson(rawName)) return 'individual';
  if (occupation && /\b(RETIRED|HOMEMAKER|ATTORNEY|PHYSICIAN|SELF[- ]EMPLOYED)\b/i.test(occupation)) {
    return 'individual';
  }
  return 'organization';
}

export class EntityResolver {
  /** normalizedName -> entityId, scoped to one ingest run. */
  private cache = new Map<string, string>();
  private stats = { cache: 0, exact: 0, alias: 0, prefix: 0, fuzzy: 0, created: 0 };

  constructor(private readonly db: Db) {}

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
        classifyContributor(input.rawName, input.occupation));

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
