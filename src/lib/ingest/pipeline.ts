/**
 * Ingest pipeline: raw source rows -> resolved entities -> transactions -> edges.
 *
 * Every stage is idempotent. Re-ingesting the same query is a no-op because
 * transactions dedupe on `sourceRowHash`, and edge rollups are recomputed from
 * whatever transactions currently exist rather than incremented in place.
 */

import { sql, eq, and, isNull, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import {
  transactions,
  entities,
  sources,
  jurisdictions,
  ingestRuns,
  entityAliases,
  committeeRegistrations,
  committeeOfficers,
  officerAliases,
} from '@/db/schema';
import { EntityResolver, refreshTraversability } from './resolve';
import type { RawContributionRow, RegistryCommitteeDetail } from './fl-doe/parse';
import type { RawTransactionRow } from './types';
import { derivedCycleSql } from '@/lib/cycles';
import {
  normalizeAddress,
  normalizePhone,
  officerKey,
  normalizeName,
  looksLikeCommittee,
} from '@/lib/normalize';
import { classifyIndustry } from './industry';

/** Which cycle a transaction row belongs to; see `src/lib/cycles.ts`. */
const derivedCycle = derivedCycleSql('t');

/**
 * Tells an upsert's inserted rows from its updated ones.
 *
 * `RETURNING` cannot say which branch it took, but a tuple this transaction
 * just inserted has no deleting transaction yet, while one it updated through
 * ON CONFLICT carries the lock in `xmax`.
 */
const NEWLY_INSERTED = sql<boolean>`xmax = 0`;

type Db = PostgresJsDatabase<typeof schema>;

export interface IngestResult {
  rowsFetched: number;
  rowsInserted: number;
  rowsSkipped: number;
  /** Rows already stored whose missing election cycle this run filled in. */
  rowsRepaired: number;
  /** Expenditures dropped because the recipient already filed the same money. */
  rowsMirrored: number;
  entitiesCreated: number;
  resolverStats: Record<string, number>;
}

/** Ensure the Florida jurisdiction + source rows exist; returns their ids. */
export async function ensureFloridaSource(db: Db): Promise<{
  jurisdictionId: string;
  sourceId: string;
}> {
  const [j] = await db
    .insert(jurisdictions)
    .values({ code: 'FL', name: 'Florida (statewide)', level: 'state', state: 'FL' })
    .onConflictDoUpdate({
      target: jurisdictions.code,
      set: { name: 'Florida (statewide)' },
    })
    .returning({ id: jurisdictions.id });

  const [s] = await db
    .insert(sources)
    .values({
      key: 'fl-doe',
      name: 'Florida Division of Elections — Campaign Finance Database',
      url: 'https://dos.elections.myflorida.com/campaign-finance/',
      jurisdictionId: j.id,
      notes:
        'State-level races and state-registered committees only. County, municipal, ' +
        'school board and special-district filings live with the 67 county Supervisors ' +
        'of Elections and with city clerks.',
    })
    .onConflictDoUpdate({ target: sources.key, set: { jurisdictionId: j.id } })
    .returning({ id: sources.id });

  return { jurisdictionId: j.id, sourceId: s.id };
}

/**
 * Ensure a county jurisdiction and its VoterFocus source exist.
 *
 * Counties hang off the Florida row as their parent, so a crawl can tell a
 * county filing apart from a state one — but entity resolution deliberately
 * ignores jurisdiction, which is what lets a committee giving at both levels
 * collapse to one node and the graph span tiers.
 */
export async function ensureCountySource(
  db: Db,
  county: { slug: string; name: string; code: string },
): Promise<{ jurisdictionId: string; sourceId: string }> {
  const [state] = await db
    .insert(jurisdictions)
    .values({ code: 'FL', name: 'Florida (statewide)', level: 'state', state: 'FL' })
    .onConflictDoUpdate({ target: jurisdictions.code, set: { name: 'Florida (statewide)' } })
    .returning({ id: jurisdictions.id });

  const [j] = await db
    .insert(jurisdictions)
    .values({
      code: county.code,
      name: `${county.name} County`,
      level: 'county',
      state: 'FL',
      parentId: state.id,
    })
    .onConflictDoUpdate({
      target: jurisdictions.code,
      set: { name: `${county.name} County`, parentId: state.id },
    })
    .returning({ id: jurisdictions.id });

  const [s] = await db
    .insert(sources)
    .values({
      key: `voterfocus-${county.slug}`,
      name: `${county.name} County Supervisor of Elections — VoterFocus`,
      url: `https://www.voterfocus.com/CampaignFinance/candidate_pr.php?c=${county.slug}`,
      jurisdictionId: j.id,
      notes:
        'County, municipal and special-district filings: county commission, school ' +
        'board, city commission, mosquito control, airport authority. Includes both ' +
        'contributions and expenditures.',
    })
    .onConflictDoUpdate({ target: sources.key, set: { jurisdictionId: j.id } })
    .returning({ id: sources.id });

  return { jurisdictionId: j.id, sourceId: s.id };
}

/**
 * Source and jurisdiction for a national 527 loaded from IRS Form 8872.
 *
 * These sit under a `federal` jurisdiction rather than Florida's: the money is
 * raised nationally and spent across dozens of states, and only a slice of it
 * ever reaches Florida.
 */
export async function ensureIrsSource(
  db: Db,
  org: { slug: string; name: string; ein: string },
): Promise<{ jurisdictionId: string; sourceId: string }> {
  const [j] = await db
    .insert(jurisdictions)
    .values({
      code: 'US-527',
      name: 'United States (527 organizations)',
      level: 'federal',
      state: 'US',
    })
    .onConflictDoUpdate({
      target: jurisdictions.code,
      set: { name: 'United States (527 organizations)' },
    })
    .returning({ id: jurisdictions.id });

  const [s] = await db
    .insert(sources)
    .values({
      key: `irs-8872-${org.slug}`,
      name: `${org.name} — IRS Form 8872`,
      url: 'https://forms.irs.gov/app/pod/basicSearch/search',
      jurisdictionId: j.id,
      notes:
        `Contributions received by ${org.name} (EIN ${org.ein}), as disclosed on ` +
        'IRS Form 8872. Loaded to explain a national committee that funds Florida ' +
        'races without filing in Florida. National pool: only a share reaches Florida.',
    })
    .onConflictDoUpdate({ target: sources.key, set: { jurisdictionId: j.id } })
    .returning({ id: sources.id });

  return { jurisdictionId: j.id, sourceId: s.id };
}

/**
 * Persist a batch of parsed contribution rows.
 *
 * Resolution runs row-by-row because each resolution can create an entity that
 * the next row needs to find. The resolver's in-process cache keeps that from
 * turning into a query per row.
 */
export async function ingestContributionRows(
  db: Db,
  rows: RawContributionRow[],
  ctx: { sourceId: string; jurisdictionId: string; resolver?: EntityResolver },
): Promise<IngestResult> {
  const resolver = ctx.resolver ?? new EntityResolver(db);
  const before = resolver.getStats().created;

  let inserted = 0;
  let skipped = 0;
  const touched = new Set<string>();

  for (const row of rows) {
    try {
      const recipient = await resolver.resolve({
        rawName: row.recipientName,
        role: 'recipient',
        committeeType: row.recipientTypeTag,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });

      const contributor = await resolver.resolve({
        rawName: row.contributorRaw,
        role: 'contributor',
        city: row.city,
        state: row.state,
        zip: row.zip,
        address: row.address,
        occupation: row.occupation,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });

      const result = await db
        .insert(transactions)
        .values({
          fromEntityId: contributor.entityId,
          toEntityId: recipient.entityId,
          rawFromName: row.contributorRaw,
          rawToName: row.recipientRaw,
          amount: row.amount,
          txnDate: row.date,
          direction: 'contribution',
          txnTypeCode: row.typeCode,
          inkindDescription: row.inkindDescription,
          fromAddress: row.address,
          fromCity: row.city,
          fromState: row.state,
          fromZip: row.zip,
          fromOccupation: row.occupation,
          electionCycle: row.electionCycle,
          sourceId: ctx.sourceId,
          sourceRowHash: row.rowHash,
          fromConfidence: contributor.confidence,
          toConfidence: recipient.confidence,
        })
        .onConflictDoNothing({ target: transactions.sourceRowHash })
        .returning({ id: transactions.id });

      if (result.length > 0) {
        inserted++;
        touched.add(contributor.entityId);
        touched.add(recipient.entityId);
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
      console.warn(`  ! row failed (${row.contributorRaw} -> ${row.recipientName}):`, err);
    }
  }

  if (touched.size > 0) {
    await rebuildEdgeRollups(db, [...touched]);
    await refreshEntityTotals(db, [...touched]);
  }
  await refreshTraversability(db);

  const stats = resolver.getStats();
  return {
    rowsFetched: rows.length,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    // The state feed has always carried its cycle, and the rows that predate
    // that were backfilled once, so there is nothing here left to repair.
    rowsRepaired: 0,
    // This path only ever sees contributions, which are the winning side.
    rowsMirrored: 0,
    entitiesCreated: stats.created - before,
    resolverStats: stats,
  };
}

/**
 * Persist normalized rows from any adapter.
 *
 * Handles both directions: a contribution flows counterparty → filer, an
 * expenditure flows filer → counterparty. The filer is always a candidate or
 * committee and therefore always traversable, so it is resolved as a recipient
 * regardless of which way the money went.
 */
export async function ingestTransactionRows(
  db: Db,
  rows: RawTransactionRow[],
  ctx: {
    sourceId: string;
    jurisdictionId: string;
    /** Set for single-county sources; disambiguates bare local-office names. */
    jurisdictionCode?: string;
    resolver?: EntityResolver;
  },
): Promise<IngestResult> {
  const resolver = ctx.resolver ?? new EntityResolver(db);
  const before = resolver.getStats().created;

  let inserted = 0;
  let skipped = 0;
  let repaired = 0;
  let mirrored = 0;
  const touched = new Set<string>();

  for (const row of rows) {
    try {
      const filer = await resolver.resolve({
        rawName: row.filerRaw,
        role: 'recipient',
        committeeType: row.filerTypeTag,
        office: row.filerOffice,
        party: row.filerParty,
        jurisdictionId: ctx.jurisdictionId,
        jurisdictionCode: ctx.jurisdictionCode,
        sourceId: ctx.sourceId,
      });

      const counterparty = await resolver.resolve({
        rawName: row.counterpartyRaw,
        role: 'contributor',
        kindHint: row.counterpartyKind,
        city: row.city,
        state: row.state,
        zip: row.zip,
        address: row.address,
        occupation: row.occupation,
        jurisdictionId: ctx.jurisdictionId,
        jurisdictionCode: ctx.jurisdictionCode,
        sourceId: ctx.sourceId,
      });

      const isContribution = row.direction === 'contribution';
      const from = isContribution ? counterparty : filer;
      const to = isContribution ? filer : counterparty;

      // Money between two committees is filed twice: the payer reports an
      // expenditure, the recipient reports a contribution. They reach us from
      // different feeds with different row hashes, so nothing else catches the
      // mirror, and the pair would inflate both ends of the edge.
      //
      // The recipient's filing wins, because the contribution feed already
      // covers every committee statewide while expenditures are loaded per
      // filer. Self-loops are exempt: a candidate reimbursing their own
      // campaign genuinely files both halves, and collapsing those would erase
      // a real transaction rather than a duplicate one.
      if (!isContribution && from.entityId !== to.entityId) {
        const [mirror] = await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              eq(transactions.direction, 'contribution'),
              eq(transactions.fromEntityId, from.entityId),
              eq(transactions.toEntityId, to.entityId),
              eq(transactions.amount, row.amount),
              row.date
                ? eq(transactions.txnDate, row.date)
                : isNull(transactions.txnDate),
            ),
          )
          .limit(1);
        if (mirror) {
          mirrored++;
          continue;
        }
      }

      const pending = db.insert(transactions).values({
        fromEntityId: from.entityId,
        toEntityId: to.entityId,
        rawFromName: isContribution ? row.counterpartyRaw : row.filerRaw,
        rawToName: isContribution ? row.filerRaw : row.counterpartyRaw,
        amount: row.amount,
        txnDate: row.date,
        direction: row.direction,
        txnTypeCode: row.typeCode,
        inkindDescription: row.description,
        // Address detail describes the counterparty in both directions.
        fromAddress: row.address,
        fromCity: row.city,
        fromState: row.state,
        fromZip: row.zip,
        fromOccupation: row.occupation,
        electionCycle: row.electionCycle ?? null,
        sourceId: ctx.sourceId,
        sourceRowHash: row.rowHash,
        fromConfidence: from.confidence,
        toConfidence: to.confidence,
      });

      // The row hash deliberately excludes the election cycle, so a row stored
      // before its cycle was known matches on a later sweep that *does* know it
      // — and plain DO NOTHING would leave that row NULL forever. Fill the gap,
      // and only the gap: a cycle already on the row is never overwritten, and
      // a sweep with no cycle of its own does not rewrite anything.
      const result =
        row.electionCycle == null
          ? await pending
              .onConflictDoNothing({ target: transactions.sourceRowHash })
              .returning({ id: transactions.id, isNew: NEWLY_INSERTED })
          : await pending
              .onConflictDoUpdate({
                target: transactions.sourceRowHash,
                set: { electionCycle: row.electionCycle },
                setWhere: sql`${transactions.electionCycle} IS NULL`,
              })
              .returning({ id: transactions.id, isNew: NEWLY_INSERTED });

      if (result.length === 0) {
        skipped++;
      } else if (result[0].isNew) {
        inserted++;
        touched.add(from.entityId);
        touched.add(to.entityId);
      } else {
        // Amounts did not move, but the cycle they are filed under did, so the
        // per-cycle rollups for both ends are now stale.
        repaired++;
        touched.add(from.entityId);
        touched.add(to.entityId);
      }
    } catch (err) {
      skipped++;
      console.warn(`  ! row failed (${row.counterpartyRaw} / ${row.filerRaw}):`, err);
    }
  }

  if (touched.size > 0) {
    await rebuildEdgeRollups(db, [...touched]);
    await refreshEntityTotals(db, [...touched]);
  }
  await refreshTraversability(db);

  const stats = resolver.getStats();
  return {
    rowsFetched: rows.length,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    rowsRepaired: repaired,
    rowsMirrored: mirrored,
    entitiesCreated: stats.created - before,
    resolverStats: stats,
  };
}

/**
 * Recompute entity→entity rollups for the affected nodes.
 *
 * The graph shows one weighted edge per pair, not one per cheque: US Sugar's
 * five separate $250k gifts to the Florida Chamber PAC in 2024 render as a
 * single $1.25M link.
 */
export interface RegistrationIngestResult {
  listed: number;
  entitiesCreated: number;
  registrations: number;
  officers: number;
  /** Officers who held a role at the last load and no longer appear in it. */
  officersSuperseded: number;
  /**
   * Committees name-matching would have merged, kept apart by account number.
   *
   * Each one is a node whose transactions are probably still conflated, since
   * only the registration is split here — the money was filed under names, and
   * separating it is a different job.
   */
  collisions: { name: string; acctNum: string; mergedInto: string }[];
}

/**
 * Create a node for a committee the resolver wanted to merge away.
 *
 * Deliberately bypasses `EntityResolver`: we already know its answer and that
 * the account number contradicts it. The alias is recorded at full confidence
 * because the registry name is the committee's own.
 */
async function createDistinctCommittee(
  db: Db,
  row: RegistryCommitteeDetail,
  ctx: { sourceId: string; jurisdictionId: string },
): Promise<string> {
  const [created] = await db
    .insert(entities)
    .values({
      kind: row.type === 'PTY' ? 'party' : 'committee',
      name: row.name,
      normalizedName: normalizeName(row.name),
      committeeType: (row.type as never) ?? null,
      status: 'active',
      isTraversable: true,
      jurisdictionId: ctx.jurisdictionId,
      city: row.city,
      stateCode: row.state,
      zip: row.zip,
      address: row.addr1,
      sourceId: ctx.sourceId,
    })
    .returning({ id: entities.id });

  await db
    .insert(entityAliases)
    .values({
      entityId: created.id,
      alias: row.name,
      normalizedAlias: normalizeName(row.name),
      origin: 'registry',
      confidence: 1,
    })
    .onConflictDoNothing();

  return created.id;
}

/**
 * Load committee registration records and the people named on them.
 *
 * Separate from the transaction pipeline because it describes committees rather
 * than money, and nothing here becomes a graph edge. That is a deliberate
 * boundary: a shared treasurer is not a payment, and if it ever reaches
 * `edge_rollups` the funding trace will walk it and attribute dollars along it.
 *
 * The load is a snapshot. The source dates none of this, so `effectiveDate`
 * stays null and `isCurrent` carries the state instead — an officer who has
 * stopped appearing is marked not-current rather than given an expiry we would
 * be inventing. What we do know is when we looked, which is `observedAt`.
 */
export async function ingestCommitteeRegistrations(
  db: Db,
  rows: RegistryCommitteeDetail[],
  ctx: { sourceId: string; jurisdictionId: string },
  resolver: EntityResolver,
  onProgress?: (done: number, total: number) => void,
): Promise<RegistrationIngestResult> {
  const result: RegistrationIngestResult = {
    listed: rows.length,
    entitiesCreated: 0,
    registrations: 0,
    officers: 0,
    officersSuperseded: 0,
    collisions: [],
  };

  // Hand-entered spelling corrections, loaded once. Small enough to hold, and
  // consulted on every officer row.
  const aliasRows = await db
    .select({ alias: officerAliases.alias, canonical: officerAliases.canonical })
    .from(officerAliases);
  const canonicalKey = new Map(aliasRows.map((a) => [a.alias, a.canonical]));

  for (const [i, row] of rows.entries()) {
    // 1. The account number is an identity, so prefer it over any name match.
    const claimed = row.acctNum
      ? await db
          .select({ entityId: committeeRegistrations.entityId })
          .from(committeeRegistrations)
          .where(eq(committeeRegistrations.externalId, row.acctNum))
          .limit(1)
      : [];

    let entityId: string;
    if (claimed.length > 0) {
      entityId = claimed[0].entityId;
    } else {
      const resolved = await resolver.resolve({
        rawName: row.name,
        role: 'recipient',
        committeeType: row.type,
        city: row.city,
        state: row.state,
        zip: row.zip,
        address: row.addr1,
        jurisdictionId: ctx.jurisdictionId,
        sourceId: ctx.sourceId,
      });
      if (resolved.created) result.entitiesCreated++;
      entityId = resolved.entityId;

      // 2. Two account numbers are two committees, whatever the names look
      //    like. Name matching alone folds all four regional Florida CPA PACs
      //    onto one node, and "Let Florida Vote II" onto "Let Florida Vote III",
      //    because a numeral or a compass point is precisely what normalization
      //    discards and what the trigram score treats as noise. When the node we
      //    landed on is already spoken for by a different account, the match was
      //    wrong: this committee gets its own node instead.
      if (row.acctNum) {
        const [taken] = await db
          .select({ externalId: committeeRegistrations.externalId })
          .from(committeeRegistrations)
          .where(
            and(
              eq(committeeRegistrations.entityId, entityId),
              eq(committeeRegistrations.isCurrent, true),
            ),
          )
          .limit(1);
        if (taken?.externalId && taken.externalId !== row.acctNum) {
          entityId = await createDistinctCommittee(db, row, ctx);
          result.entitiesCreated++;
          result.collisions.push({
            name: row.name,
            acctNum: row.acctNum,
            mergedInto: taken.externalId,
          });
        }
      }
    }
    const resolved = { entityId };

    // The registry spelling is authoritative — it is the committee's own — so
    // it replaces a name first learned from a truncated transaction column.
    await db
      .update(entities)
      .set({
        kind: row.type === 'PTY' ? 'party' : 'committee',
        committeeType: (row.type as never) ?? null,
        status: 'active',
        isTraversable: true,
        name: row.name,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, resolved.entityId));

    await db
      .insert(committeeRegistrations)
      .values({
        entityId: resolved.entityId,
        sourceId: ctx.sourceId,
        externalId: row.acctNum,
        committeeType: row.type,
        typeDescription: row.typeDescription,
        status: 'active',
        addr1: row.addr1,
        addr2: row.addr2,
        city: row.city,
        stateCode: row.state,
        zip: row.zip,
        countyName: row.county,
        normalizedAddress: normalizeAddress(row.addr1),
        phone: row.phone,
        phoneDigits: normalizePhone(row.phone),
        observedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [committeeRegistrations.entityId, committeeRegistrations.sourceId],
        targetWhere: sql`is_current`,
        set: {
          externalId: row.acctNum,
          committeeType: row.type,
          typeDescription: row.typeDescription,
          status: 'active',
          addr1: row.addr1,
          addr2: row.addr2,
          city: row.city,
          stateCode: row.state,
          zip: row.zip,
          countyName: row.county,
          normalizedAddress: normalizeAddress(row.addr1),
          phone: row.phone,
          phoneDigits: normalizePhone(row.phone),
          observedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    result.registrations++;

    const officers = [
      { role: 'chair' as const, last: row.chairLast, first: row.chairFirst, middle: row.chairMiddle },
      {
        role: 'treasurer' as const,
        last: row.treasurerLast,
        first: row.treasurerFirst,
        middle: row.treasurerMiddle,
      },
    ]
      .map((o) => {
        const raw = officerKey(o.last, o.first);
        // The filed spelling stays in `fullName`; only the matching key moves.
        return { ...o, key: raw === null ? null : (canonicalKey.get(raw) ?? raw) };
      })
      .filter((o): o is typeof o & { key: string } => o.key !== null);

    // Anyone we recorded last time who is not on the list now has left the
    // role. Superseding rather than deleting keeps the fact that they held it.
    const superseded = await db
      .update(committeeOfficers)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(
        and(
          eq(committeeOfficers.entityId, resolved.entityId),
          eq(committeeOfficers.sourceId, ctx.sourceId),
          eq(committeeOfficers.isCurrent, true),
          officers.length > 0
            ? sql`(${committeeOfficers.role}::text, ${committeeOfficers.normalizedName}) NOT IN (${sql.join(
                officers.map((o) => sql`(${o.role}, ${o.key})`),
                sql`, `,
              )})`
            : sql`true`,
        ),
      )
      .returning({ id: committeeOfficers.id });
    result.officersSuperseded += superseded.length;

    for (const o of officers) {
      await db
        .insert(committeeOfficers)
        .values({
          entityId: resolved.entityId,
          sourceId: ctx.sourceId,
          role: o.role,
          nameLast: o.last,
          nameFirst: o.first,
          nameMiddle: o.middle,
          fullName: [o.first, o.middle, o.last].filter(Boolean).join(' '),
          normalizedName: o.key,
          observedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            committeeOfficers.entityId,
            committeeOfficers.sourceId,
            committeeOfficers.role,
            committeeOfficers.normalizedName,
          ],
          targetWhere: sql`is_current`,
          set: {
            nameLast: o.last,
            nameFirst: o.first,
            nameMiddle: o.middle,
            fullName: [o.first, o.middle, o.last].filter(Boolean).join(' '),
            observedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      result.officers++;
    }

    onProgress?.(i + 1, rows.length);
  }

  return result;
}

/**
 * How far apart two filings of the same transfer may be dated and still count as
 * the same money. Filers routinely disagree by a day or two — the payer books the
 * cheque, the recipient books the deposit — but a same-amount transfer between the
 * same two committees weeks apart is more likely a second, genuine gift.
 */
const MIRROR_WINDOW_DAYS = 14;

/**
 * Collapse mirror pairs: one committee→committee transfer that both filers
 * reported — the recipient as a contribution, the payer as an expenditure.
 *
 * They are the same dollars, so keeping both doubles the edge between the two
 * committees and, through it, the recipient's `total_received` and the payer's
 * `total_given`. "Friends of Tammie McClafferty" showed $60k against $30k
 * actually raised for exactly this reason: a $25k and a $5k transfer, each filed
 * from both sides and each counted twice.
 *
 * The inline drop in `ingestTransactionRows` catches the simple case, but it
 * matches on an exact date and only sees contributions already loaded — so a
 * filing dated a day apart, or an expenditure sweep that ran before the
 * contribution sweep, slips a mirror through. This pass is order-independent and
 * date-tolerant: inside each committee→committee pair that carries both
 * directions, it matches every expenditure to one unused contribution of the
 * same amount within `MIRROR_WINDOW_DAYS`, nearest date first, and deletes those
 * expenditures. The pairing is 1:1, so a genuine second transfer of the same
 * amount keeps its own record, and only same-amount rows between the same two
 * traversable nodes are ever touched.
 *
 * Deleting the expenditure (not the contribution) follows the pipeline's standing
 * rule that the recipient's filing wins. Pass `entityIds` to limit the scan to
 * pairs touching those nodes; omit it to sweep the whole graph.
 */
export async function collapseMirrors(
  db: Db,
  entityIds?: string[],
  opts: { dryRun?: boolean } = {},
): Promise<{ deleted: number; pairs: number }> {
  const scoped = entityIds != null && entityIds.length > 0;
  const outerScope = scoped
    ? sql`AND (t.from_entity_id = ANY(${sql.param(entityIds)}::uuid[])
             OR t.to_entity_id = ANY(${sql.param(entityIds)}::uuid[]))`
    : sql``;
  const innerScope = scoped
    ? sql`AND (x.from_entity_id = ANY(${sql.param(entityIds)}::uuid[])
             OR x.to_entity_id = ANY(${sql.param(entityIds)}::uuid[]))`
    : sql``;

  // Every row in a committee→committee pair that carries *both* directions.
  const rows = await db.execute<{
    id: string;
    from_entity_id: string;
    to_entity_id: string;
    amount: string;
    txn_date: string | null;
    direction: 'contribution' | 'expenditure';
  }>(sql`
    SELECT t.id, t.from_entity_id, t.to_entity_id, t.amount::text AS amount,
           t.txn_date::text AS txn_date, t.direction
    FROM transactions t
    WHERE t.from_entity_id IS NOT NULL AND t.to_entity_id IS NOT NULL
      AND t.from_entity_id <> t.to_entity_id
      ${outerScope}
      AND (t.from_entity_id, t.to_entity_id) IN (
        SELECT x.from_entity_id, x.to_entity_id
        FROM transactions x
        JOIN entities ef ON ef.id = x.from_entity_id AND ef.is_traversable
        JOIN entities et ON et.id = x.to_entity_id AND et.is_traversable
        WHERE x.from_entity_id <> x.to_entity_id
          ${innerScope}
        GROUP BY x.from_entity_id, x.to_entity_id
        HAVING bool_or(x.direction = 'contribution')
           AND bool_or(x.direction = 'expenditure')
      )
  `);

  type Contrib = { amount: number; date: number | null; used: boolean };
  type Expend = { id: string; amount: number; date: number | null };
  const groups = new Map<string, { contribs: Contrib[]; expends: Expend[] }>();
  for (const r of rows) {
    const key = `${r.from_entity_id}\0${r.to_entity_id}`;
    let g = groups.get(key);
    if (!g) {
      g = { contribs: [], expends: [] };
      groups.set(key, g);
    }
    const date = r.txn_date ? Date.parse(r.txn_date) : null;
    if (r.direction === 'contribution') {
      g.contribs.push({ amount: Number(r.amount), date, used: false });
    } else {
      g.expends.push({ id: r.id, amount: Number(r.amount), date });
    }
  }

  const window = MIRROR_WINDOW_DAYS * 86_400_000;
  const toDelete: string[] = [];
  let pairsHit = 0;
  for (const g of groups.values()) {
    let hit = false;
    for (const e of g.expends) {
      let best = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < g.contribs.length; i++) {
        const c = g.contribs[i];
        // Same amount, both dated, within the window; when unsure, leave it be.
        if (c.used || c.amount !== e.amount) continue;
        if (c.date === null || e.date === null) continue;
        const diff = Math.abs(c.date - e.date);
        if (diff > window) continue;
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      if (best >= 0) {
        g.contribs[best].used = true;
        toDelete.push(e.id);
        hit = true;
      }
    }
    if (hit) pairsHit++;
  }

  if (toDelete.length > 0 && !opts.dryRun) {
    await db.execute(
      sql`DELETE FROM transactions WHERE id = ANY(${sql.param(toDelete)}::uuid[])`,
    );
  }
  return { deleted: toDelete.length, pairs: pairsHit };
}

export async function rebuildEdgeRollups(db: Db, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  await db.execute(sql`
    INSERT INTO edge_rollups (
      from_entity_id, to_entity_id, election_cycle, total_amount, txn_count,
      first_date, last_date, is_direct_link, updated_at
    )
    SELECT
      t.from_entity_id,
      t.to_entity_id,
      ${derivedCycle}        AS election_cycle,
      SUM(t.amount)          AS total_amount,
      COUNT(*)::int          AS txn_count,
      MIN(t.txn_date)        AS first_date,
      MAX(t.txn_date)        AS last_date,
      -- A self-loop is a candidate funding their own campaign, not a link
      -- between two organizations. Counting it as direct made lone
      -- self-funded candidates look connected in direct link mode.
      BOOL_AND(ef.is_traversable) AND BOOL_AND(et.is_traversable)
        AND t.from_entity_id <> t.to_entity_id AS is_direct_link,
      now()
    FROM transactions t
    JOIN entities ef ON ef.id = t.from_entity_id
    JOIN entities et ON et.id = t.to_entity_id
    WHERE t.from_entity_id IS NOT NULL
      AND t.to_entity_id IS NOT NULL
      AND (t.from_entity_id = ANY(${sql.param(entityIds)}::uuid[])
           OR t.to_entity_id = ANY(${sql.param(entityIds)}::uuid[]))
    GROUP BY t.from_entity_id, t.to_entity_id, ${derivedCycle}
    ON CONFLICT (from_entity_id, to_entity_id, election_cycle) DO UPDATE SET
      total_amount   = EXCLUDED.total_amount,
      txn_count      = EXCLUDED.txn_count,
      first_date     = EXCLUDED.first_date,
      last_date      = EXCLUDED.last_date,
      is_direct_link = EXCLUDED.is_direct_link,
      updated_at     = now()
  `);
}

/**
 * Remove everything one source contributed, so it can be re-ingested cleanly.
 *
 * Needed after a parser fix. Row hashes include the names as parsed, so simply
 * re-running an adapter whose output has changed inserts a second copy of every
 * affected row instead of correcting the first — and a name that parsed wrongly
 * also produced a wrong normalized key, so the entity itself has to go.
 *
 * Entities are only deleted when nothing else references them, so a committee
 * that also appears in state filings survives with its other transactions
 * intact.
 */
export async function purgeSource(
  db: Db,
  sourceKey: string,
): Promise<{ transactions: number; entities: number }> {
  const [src] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, sourceKey));
  if (!src) throw new Error(`unknown source "${sourceKey}"`);

  const deletedTxns = await db.execute<{ count: number }>(sql`
    WITH removed AS (DELETE FROM transactions WHERE source_id = ${src.id} RETURNING 1)
    SELECT COUNT(*)::int AS count FROM removed
  `);

  // Aliases cascade with the entity; rollups reference entities, so clear any
  // that lost an endpoint before deleting.
  await db.execute(sql`
    DELETE FROM edge_rollups r
     WHERE NOT EXISTS (
       SELECT 1 FROM transactions t
        WHERE t.from_entity_id = r.from_entity_id AND t.to_entity_id = r.to_entity_id
     )
  `);

  const deletedEntities = await db.execute<{ count: number }>(sql`
    WITH removed AS (
      DELETE FROM entities e
       WHERE e.source_id = ${src.id}
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.from_entity_id = e.id OR t.to_entity_id = e.id
         )
         AND NOT EXISTS (SELECT 1 FROM saved_searches s WHERE s.seed_entity_id = e.id)
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM removed
  `);

  return {
    transactions: deletedTxns[0]?.count ?? 0,
    entities: deletedEntities[0]?.count ?? 0,
  };
}

/**
 * Recompute every rollup and total from the transaction table.
 *
 * The incremental path only touches entities seen in the current batch, so a
 * crashed or partial run can leave rollups behind. This is the repair path, and
 * the thing to run after changing resolution rules.
 */
export async function rebuildAll(db: Db): Promise<{ edges: number; entities: number }> {
  await refreshTraversability(db);

  // A payer's expenditure and the recipient's contribution for the same transfer
  // are one edge, not two; left in, they double it and both endpoints' totals.
  // Collapse them before the rollups are built off the transaction table.
  const mirrors = await collapseMirrors(db);
  if (mirrors.deleted > 0) {
    console.log(
      `  collapsed ${mirrors.deleted} mirror expenditures across ${mirrors.pairs} committee pairs`,
    );
  }

  await db.execute(sql`TRUNCATE edge_rollups`);
  await db.execute(sql`
    INSERT INTO edge_rollups (
      from_entity_id, to_entity_id, election_cycle, total_amount, txn_count,
      first_date, last_date, is_direct_link, updated_at
    )
    SELECT
      t.from_entity_id,
      t.to_entity_id,
      ${derivedCycle},
      SUM(t.amount),
      COUNT(*)::int,
      MIN(t.txn_date),
      MAX(t.txn_date),
      BOOL_AND(ef.is_traversable) AND BOOL_AND(et.is_traversable)
        AND t.from_entity_id <> t.to_entity_id,
      now()
    FROM transactions t
    JOIN entities ef ON ef.id = t.from_entity_id
    JOIN entities et ON et.id = t.to_entity_id
    WHERE t.from_entity_id IS NOT NULL AND t.to_entity_id IS NOT NULL
    GROUP BY t.from_entity_id, t.to_entity_id, ${derivedCycle}
  `);

  // Aggregate once over the rollups rather than running two lateral lookups
  // per entity. The lateral form plans well — index-only scans on both sides —
  // but it still visits every entity and rewrites every row, and at 626k
  // entities with seven indexes each the write amplification made this the
  // slowest phase of an ingest by a wide margin: over an hour, against a
  // scrape of a government website that took less.
  //
  // Two sequential scans and a hash aggregate produce the same numbers, and
  // the IS DISTINCT FROM guard means only entities whose totals actually moved
  // are written at all.
  await db.execute(sql`
    UPDATE entities e SET
      total_received = agg.received,
      total_given    = agg.given,
      in_degree      = agg.in_deg,
      out_degree     = agg.out_deg,
      first_seen     = agg.first_seen,
      last_seen      = agg.last_seen,
      updated_at     = now()
    FROM (
      SELECT id,
             SUM(received)      AS received,
             SUM(given)         AS given,
             SUM(in_deg)::int   AS in_deg,
             SUM(out_deg)::int  AS out_deg,
             MIN(first_date)    AS first_seen,
             MAX(last_date)     AS last_seen
      FROM (
        SELECT to_entity_id AS id, total_amount AS received, 0::numeric AS given,
               1 AS in_deg, 0 AS out_deg, first_date, last_date
          FROM edge_rollups
        UNION ALL
        SELECT from_entity_id, 0::numeric, total_amount,
               0, 1, first_date, last_date
          FROM edge_rollups
      ) sided
      GROUP BY id
    ) agg
    WHERE e.id = agg.id
      AND (e.total_received IS DISTINCT FROM agg.received
        OR e.total_given    IS DISTINCT FROM agg.given
        OR e.in_degree      IS DISTINCT FROM agg.in_deg
        OR e.out_degree     IS DISTINCT FROM agg.out_deg
        OR e.first_seen     IS DISTINCT FROM agg.first_seen
        OR e.last_seen      IS DISTINCT FROM agg.last_seen)
  `);

  // Per-cycle totals, so a filtered tile agrees with the edges drawn around it.
  // Rebuilt wholesale rather than merged: the set is small next to the rollups
  // it comes from, and a stale row here is a wrong number on screen.
  await db.execute(sql`TRUNCATE entity_cycle_totals`);
  await db.execute(sql`
    INSERT INTO entity_cycle_totals (
      entity_id, election_cycle, total_received, total_given, in_degree, out_degree
    )
    SELECT id, election_cycle,
           SUM(received), SUM(given), SUM(in_deg)::int, SUM(out_deg)::int
    FROM (
      SELECT to_entity_id AS id, election_cycle, total_amount AS received,
             0::numeric AS given, 1 AS in_deg, 0 AS out_deg
        FROM edge_rollups
      UNION ALL
      SELECT from_entity_id, election_cycle, 0::numeric, total_amount, 0, 1
        FROM edge_rollups
    ) sided
    GROUP BY id, election_cycle
  `);

  // Entities that lost their last edge are not in the aggregate at all, so
  // they need clearing separately or they keep stale totals forever.
  await db.execute(sql`
    UPDATE entities e SET
      total_received = 0, total_given = 0, in_degree = 0, out_degree = 0,
      first_seen = NULL, last_seen = NULL, updated_at = now()
    WHERE (e.total_received <> 0 OR e.total_given <> 0
        OR e.in_degree <> 0 OR e.out_degree <> 0)
      AND NOT EXISTS (SELECT 1 FROM edge_rollups r WHERE r.to_entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM edge_rollups r WHERE r.from_entity_id = e.id)
  `);

  const [counts] = await db.execute<{ edges: number; entities: number }>(sql`
    SELECT (SELECT COUNT(*) FROM edge_rollups)::int AS edges,
           (SELECT COUNT(*) FROM entities)::int     AS entities
  `);
  return counts;
}

/** Refresh the denormalized totals and degrees shown on each tile. */
export async function refreshEntityTotals(db: Db, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  await db.execute(sql`
    UPDATE entities e SET
      total_received = COALESCE(agg.received, 0),
      total_given    = COALESCE(agg.given, 0),
      in_degree      = COALESCE(agg.in_deg, 0),
      out_degree     = COALESCE(agg.out_deg, 0),
      first_seen     = agg.first_seen,
      last_seen      = agg.last_seen,
      updated_at     = now()
    FROM (
      SELECT
        x.id,
        inb.received, inb.in_deg, inb.in_first, inb.in_last,
        outb.given, outb.out_deg, outb.out_first, outb.out_last,
        LEAST(inb.in_first, outb.out_first)  AS first_seen,
        GREATEST(inb.in_last, outb.out_last) AS last_seen
      FROM entities x
      LEFT JOIN LATERAL (
        SELECT SUM(total_amount) AS received, COUNT(*)::int AS in_deg,
               MIN(first_date) AS in_first, MAX(last_date) AS in_last
        FROM edge_rollups WHERE to_entity_id = x.id
      ) inb ON true
      LEFT JOIN LATERAL (
        SELECT SUM(total_amount) AS given, COUNT(*)::int AS out_deg,
               MIN(first_date) AS out_first, MAX(last_date) AS out_last
        FROM edge_rollups WHERE from_entity_id = x.id
      ) outb ON true
      WHERE x.id = ANY(${sql.param(entityIds)}::uuid[])
    ) agg
    WHERE e.id = agg.id
  `);
}

/**
 * Backfill `entities.industry` from each entity's occupation, name and kind.
 *
 * A new entity gets this at resolve time (`EntityResolver.create`, in
 * `resolve.ts`); this covers everything that existed before that hook did,
 * or that never had a usable occupation until a later filing supplied one.
 *
 * Idempotent by default — only rows where `industry IS NULL` are touched, so
 * a re-run after new ingest just picks up what's new. `force` reclassifies
 * every entity instead, for when the taxonomy in `industry.ts` changes.
 */
export async function backfillIndustry(
  db: Db,
  opts: { force?: boolean } = {},
  onBatch?: (scanned: number) => void,
): Promise<{ scanned: number; classified: number }> {
  const BATCH = 10_000;
  let cursor = '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  let classified = 0;

  for (;;) {
    const rows = await db.execute<{
      id: string;
      name: string;
      kind: string;
      occupation: string | null;
    }>(sql`
      SELECT id, name, kind::text AS kind, occupation
        FROM entities
       WHERE id > ${cursor}::uuid
         ${opts.force ? sql`` : sql`AND industry IS NULL`}
       ORDER BY id
       LIMIT ${BATCH}
    `);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    const ids: string[] = [];
    const labels: string[] = [];
    for (const r of rows) {
      const label = classifyIndustry(r.occupation, r.name, r.kind);
      if (label) {
        ids.push(r.id);
        labels.push(label);
      }
    }
    if (ids.length > 0) {
      await db.execute(sql`
        UPDATE entities e SET industry = v.industry
        FROM (
          SELECT * FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(labels)}::text[])
            AS v(id, industry)
        ) v
        WHERE e.id = v.id
      `);
      classified += ids.length;
    }
    onBatch?.(scanned);
  }

  return { scanned, classified };
}

/**
 * Reclassify PAC-shaped contributors that were resolved as `organization`.
 *
 * Florida's state contribution export carries no contributor-type code, so
 * entities created from it fall back to `classifyContributor` (`resolve.ts`)
 * — which, before it learned to recognize a committee-shaped name, put every
 * non-person contributor in the same generic `organization` bucket a PAC has
 * no business sharing. That matters beyond the label: a funding-origins trace
 * only walks back through `committee`/`party` kinds, so a PAC stuck at
 * `organization` reads as an original source instead of a conduit — a
 * "$128K from FL CHAMBER OF COMM PAC" line where the chamber's own donors are
 * sitting right there in this same data, unwalked.
 *
 * New ingests get this right at resolve time; this corrects everything that
 * existed before that fix landed. Idempotent: only rows still kinded
 * `organization` are examined, so a re-run after new ingest just picks up
 * what's new.
 */
export async function backfillCommitteeKind(
  db: Db,
  onBatch?: (scanned: number) => void,
): Promise<{ scanned: number; reclassified: number }> {
  const BATCH = 10_000;
  let cursor = '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  let reclassified = 0;

  for (;;) {
    const rows = await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM entities
       WHERE id > ${cursor}::uuid AND kind = 'organization'
       ORDER BY id
       LIMIT ${BATCH}
    `);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    const ids = rows.filter((r) => looksLikeCommittee(r.name)).map((r) => r.id);
    if (ids.length > 0) {
      await db.execute(sql`
        UPDATE entities SET kind = 'committee', updated_at = now()
        WHERE id = ANY(${sql.param(ids)}::uuid[])
      `);
      reclassified += ids.length;
    }
    onBatch?.(scanned);
  }

  // A newly-committee entity that also receives money elsewhere in this data
  // should be crawlable like any other committee, not stuck non-traversable
  // because it was created back when its kind still said `organization`.
  await refreshTraversability(db);

  return { scanned, reclassified };
}

/**
 * Pull a set of transactions off an entity and onto a new one.
 *
 * The opposite failure to the one `mergeEntities` repairs, and the more
 * damaging of the two. Two people who share a name arrive as one node, and
 * every total, every edge and every trace then describes a person who does not
 * exist. A merge can be undone by merging again; this cannot be undone by
 * anything except knowing which filings belonged to whom.
 *
 * The caller decides that, and passes the transaction ids explicitly — there
 * is no predicate here on purpose. Splitting on a guess is how the two got
 * conflated to begin with.
 *
 * Only transactions move. Registrations and officers describe a committee, and
 * a committee that needs splitting is a different problem from a donor who
 * does. `edge_rollups` and `entity_cycle_totals` are left stale for the
 * caller's `rebuildAll`, exactly as with a merge.
 */
export async function splitEntity(
  db: Db,
  fromId: string,
  txnIds: string[],
  fields: {
    name: string;
    kind: 'individual' | 'organization' | 'committee' | 'candidate';
    city?: string | null;
    stateCode?: string | null;
    zip?: string | null;
    occupation?: string | null;
  },
): Promise<{ id: string; moved: number }> {
  if (txnIds.length === 0) throw new Error('splitEntity needs at least one transaction');

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(entities)
      .values({
        kind: fields.kind,
        name: fields.name,
        normalizedName: normalizeName(fields.name),
        city: fields.city ?? null,
        stateCode: fields.stateCode ?? null,
        zip: fields.zip ?? null,
        occupation: fields.occupation ?? null,
        industry: classifyIndustry(fields.occupation ?? null, fields.name, fields.kind),
        // A contributor starts terminal; refreshTraversability promotes it if
        // it turns out to receive money too.
        isTraversable: false,
      })
      .returning({ id: entities.id });

    const moved = await tx.execute(sql`
      UPDATE transactions
         SET from_entity_id = CASE WHEN from_entity_id = ${fromId} THEN ${created.id}
                                   ELSE from_entity_id END,
             to_entity_id   = CASE WHEN to_entity_id   = ${fromId} THEN ${created.id}
                                   ELSE to_entity_id END
       WHERE id = ANY(${sql.param(txnIds)}::uuid[])
         AND (from_entity_id = ${fromId} OR to_entity_id = ${fromId})
    `);

    return { id: created.id, moved: (moved as unknown as { count?: number }).count ?? txnIds.length };
  });
}

/**
 * Merge one or more duplicate entities into a survivor.

 *
 * For a genuine near-duplicate — a typo, an abbreviation, a truncated column,
 * a singular/plural variant — normalization and the fuzzy-match safety net
 * both missed it (that's *why* it's still two rows), so nothing short of a
 * human confirming the pair is safe here. This is the tool for after that
 * confirmation.
 *
 * Every table that references an entity gets the loser's rows reassigned to
 * `keepId` before the loser is deleted — `transactions`, `committee_registrations`
 * and `committee_officers` (real filings, not safe to just cascade-delete),
 * and `saved_searches` (a user's saved search should not silently vanish out
 * from under them). `entity_aliases` gets the loser's spellings folded in too,
 * so a future filing using that same misspelling still resolves straight to
 * the survivor — skipping any that collide with an alias the survivor already
 * has, since `(entity_id, normalized_alias)` is unique. `edge_rollups` and
 * `entity_cycle_totals` are left to cascade away with the loser; both are
 * derived from `transactions` and are wrong until the caller re-derives them
 * — call `rebuildAll` after merging, not per pair, once the whole batch is
 * reassigned.
 *
 * Each (keepId, loserIds) group runs in one transaction: touching six tables
 * per entity, a failure partway through must not leave a transaction pointing
 * at an entity row that no longer exists.
 */
export async function mergeEntities(
  db: Db,
  keepId: string,
  loserIds: string[],
): Promise<{ merged: number }> {
  const ids = loserIds.filter((id) => id !== keepId);
  if (ids.length === 0) return { merged: 0 };

  await db.transaction(async (tx) => {
    for (const loserId of ids) {
      const [loser] = await tx
        .select({ name: entities.name, normalizedName: entities.normalizedName })
        .from(entities)
        .where(eq(entities.id, loserId));
      if (!loser) continue; // already merged away by an earlier group in this batch

      await tx.execute(sql`
        UPDATE transactions SET from_entity_id = ${keepId} WHERE from_entity_id = ${loserId}
      `);
      await tx.execute(sql`
        UPDATE transactions SET to_entity_id = ${keepId} WHERE to_entity_id = ${loserId}
      `);
      await tx.execute(sql`
        UPDATE committee_registrations SET entity_id = ${keepId} WHERE entity_id = ${loserId}
      `);
      await tx.execute(sql`
        UPDATE committee_officers SET entity_id = ${keepId} WHERE entity_id = ${loserId}
      `);
      await tx.execute(sql`
        UPDATE saved_searches SET seed_entity_id = ${keepId} WHERE seed_entity_id = ${loserId}
      `);

      // The loser's own name becomes an alias of the survivor, so the exact
      // spelling that used to create a second node now resolves straight to
      // it. onConflictDoNothing: the survivor may already carry this alias.
      await tx
        .insert(entityAliases)
        .values({
          entityId: keepId,
          alias: loser.name,
          normalizedAlias: loser.normalizedName,
          origin: 'resolved',
          confidence: 1,
        })
        .onConflictDoNothing();

      // Fold in the loser's other aliases the same way — skip anything that
      // would collide with one the survivor already has.
      await tx.execute(sql`
        UPDATE entity_aliases SET entity_id = ${keepId}
         WHERE entity_id = ${loserId}
           AND NOT EXISTS (
             SELECT 1 FROM entity_aliases keep_ea
              WHERE keep_ea.entity_id = ${keepId}
                AND keep_ea.normalized_alias = entity_aliases.normalized_alias
           )
      `);

      // Whatever's left either collides, or belongs to edge_rollups /
      // entity_cycle_totals, which are stale the moment transactions moved —
      // both are recomputed by the caller's rebuildAll, not preserved here.

      // Record the deletion before making it. The deployment box is brought
      // forward by shipping rows that changed, and a deleted row cannot be
      // shipped — without this the duplicate lives on over there forever.
      await tx.execute(sql`
        INSERT INTO entity_tombstones (id, merged_into)
        VALUES (${loserId}, ${keepId})
        ON CONFLICT (id) DO UPDATE SET merged_into = EXCLUDED.merged_into
      `);
      await tx.execute(sql`DELETE FROM entities WHERE id = ${loserId}`);

    }
  });

  return { merged: ids.length };
}

/** Bookkeeping helpers for observability of long scrape jobs. */
export async function startRun(
  db: Db,
  sourceId: string,
  scope: Record<string, unknown>,
): Promise<string> {
  const [run] = await db
    .insert(ingestRuns)
    .values({ sourceId, scope, status: 'running' })
    .returning({ id: ingestRuns.id });
  return run.id;
}

export async function finishRun(
  db: Db,
  runId: string,
  result: Partial<IngestResult> & { error?: string },
): Promise<void> {
  await db
    .update(ingestRuns)
    .set({
      status: result.error ? 'failed' : 'succeeded',
      rowsFetched: result.rowsFetched ?? 0,
      rowsInserted: result.rowsInserted ?? 0,
      rowsSkipped: result.rowsSkipped ?? 0,
      error: result.error,
      finishedAt: new Date(),
    })
    .where(eq(ingestRuns.id, runId));
}

/** Look up entity display rows by id, preserving caller order. */
export async function getEntities(db: Db, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(entities).where(inArray(entities.id, ids));
}
