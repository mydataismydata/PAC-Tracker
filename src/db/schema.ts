import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  numeric,
  date,
  timestamp,
  jsonb,
  boolean,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/** Level of government a race or committee belongs to. */
export const jurisdictionLevel = pgEnum('jurisdiction_level', [
  'federal',
  'state',
  'county',
  'municipal',
  'special_district',
]);

/**
 * What kind of thing a graph node is.
 *
 * `committee` and `candidate` are traversable — money flows through them and we
 * can keep crawling. `individual` and `organization` are normally leaves: they
 * give money but do not receive it. `unknown` is a contributor string we have
 * not classified yet.
 */
export const entityKind = pgEnum('entity_kind', [
  'committee',
  'candidate',
  'individual',
  'organization',
  'party',
  'unknown',
]);

/** Florida committee type codes, from the DOE committee registry. */
export const committeeType = pgEnum('committee_type', [
  'PAC', // Political Committee
  'CCE', // Committee of Continuous Existence
  'ECO', // Electioneering Communication Organization
  'ECI', // Electioneering Communication Individual
  'IXO', // Independent Expenditure Organization
  'PAP', // Affiliated Party Committee
  'PTY', // Party Executive Committee
]);

export const entityStatus = pgEnum('entity_status', ['active', 'closed', 'unknown']);

/** How an alias got attached to an entity. */
export const aliasOrigin = pgEnum('alias_origin', [
  'registry', // canonical name from an official registry listing
  'observed', // seen as a contributor/recipient string in a transaction
  'resolved', // produced by the entity-resolution pass
  'manual', // a human said so; always wins
]);

/** Direction of a money movement relative to the filer. */
export const txnDirection = pgEnum('txn_direction', ['contribution', 'expenditure']);

/* -------------------------------------------------------------------------- */
/* Reference tables                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every race lives in a jurisdiction. Florida state races come from the
 * Division of Elections; county, municipal and special-district races (school
 * board, city council, mosquito control, airport authority) are filed with 67
 * separate Supervisors of Elections and city clerks, so each gets its own row
 * and its own ingestion source.
 */
export const jurisdictions = pgTable(
  'jurisdictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(), // 'FL', 'FL-DADE', 'FL-MIAMI'
    name: text('name').notNull(),
    level: jurisdictionLevel('level').notNull(),
    state: text('state').notNull().default('FL'),
    parentId: uuid('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('jurisdictions_code_key').on(t.code)],
);

/**
 * A data source is one ingestible endpoint (FL DOE contributions, a county
 * portal, a purchased dataset). Keeping provenance per-row lets us re-ingest or
 * retract a single source without touching the rest of the graph.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(), // 'fl-doe-contributions'
    name: text('name').notNull(),
    url: text('url'),
    jurisdictionId: uuid('jurisdiction_id').references(() => jurisdictions.id),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => [uniqueIndex('sources_key_key').on(t.key)],
);

/* -------------------------------------------------------------------------- */
/* Entities — the graph nodes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One real-world actor: a committee, a candidate, a company, a person.
 *
 * `normalizedName` is the matching key. Florida's export gives us no stable
 * entity IDs at all — a contributor is a bare string — so resolution runs on
 * normalized names plus address signals. See `entityAliases`.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: entityKind('kind').notNull().default('unknown'),

    /** Display name, best known spelling. */
    name: text('name').notNull(),
    /** Aggressively normalized form used for fuzzy matching. */
    normalizedName: text('normalized_name').notNull(),

    committeeType: committeeType('committee_type'),
    status: entityStatus('status').notNull().default('unknown'),

    jurisdictionId: uuid('jurisdiction_id').references(() => jurisdictions.id),

    // Candidate-specific
    office: text('office'),
    district: text('district'),
    party: text('party'),

    // Contact / disambiguation signals
    address: text('address'),
    city: text('city'),
    stateCode: text('state_code'),
    zip: text('zip'),
    occupation: text('occupation'),
    /**
     * Industry/type derived from `occupation` (and, for a curated set of
     * well-known organizations, real-world identity) by `classifyIndustry` in
     * `src/lib/ingest/industry.ts`. Null means nothing matched — a blank
     * column beats a confident-looking wrong one.
     */
    industry: text('industry'),

    /**
     * True when money can flow *out* of this node as well as in, i.e. it is
     * worth expanding during a crawl. Committees, candidates and parties are
     * traversable; individuals and corporations are normally terminal.
     */
    isTraversable: boolean('is_traversable').notNull().default(false),

    /**
     * A national pool that money enters Florida *from*, whose own funding is
     * disclosed under a different regime entirely.
     *
     * The Republican State Leadership Committee sent $3.5M into six Florida
     * committees while reporting nothing to Florida — it is a 527 filing IRS
     * Form 8872. Its donors can be loaded, but its money is raised nationally
     * and spent across dozens of states, so treating the Florida share as a
     * representative slice of that pool is an assumption the disclosure cannot
     * support. Traces therefore stop here and say so, rather than blending a
     * modelled estimate in with observed Florida transfers.
     */
    isInjectionPoint: boolean('is_injection_point').notNull().default(false),

    sourceId: uuid('source_id').references(() => sources.id),
    /** Native identifier at the source, when the source provides one. */
    sourceRef: text('source_ref'),

    /** Denormalized rollups, refreshed by the ingest job. */
    totalReceived: numeric('total_received', { precision: 16, scale: 2 })
      .notNull()
      .default('0'),
    totalGiven: numeric('total_given', { precision: 16, scale: 2 }).notNull().default('0'),
    inDegree: integer('in_degree').notNull().default(0),
    outDegree: integer('out_degree').notNull().default(0),

    firstSeen: date('first_seen'),
    lastSeen: date('last_seen'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('entities_normalized_name_idx').on(t.normalizedName),
    index('entities_kind_idx').on(t.kind),
    index('entities_traversable_idx').on(t.isTraversable),
    index('entities_jurisdiction_idx').on(t.jurisdictionId),
  ],
);

/**
 * Observed spellings that point at one entity.
 *
 * This table is what makes the graph connected. Florida's contribution export
 * truncates the recipient name at 40 characters ("Florida Chamber of Commerce
 * Alliance, In") and repeats the same donor under slightly different spellings
 * and ZIPs across filings. Every variant we see becomes an alias row, so a
 * later lookup of any spelling lands on the same node.
 */
export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),
    origin: aliasOrigin('origin').notNull().default('observed'),
    /** 0..1 — how sure we are this alias belongs to this entity. */
    confidence: real('confidence').notNull().default(1),
    /** Truncated source strings match by prefix rather than equality. */
    isTruncated: boolean('is_truncated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entity_aliases_entity_norm_key').on(t.entityId, t.normalizedAlias),
    index('entity_aliases_norm_idx').on(t.normalizedAlias),
  ],
);

/* -------------------------------------------------------------------------- */
/* Transactions — the graph edges                                              */
/* -------------------------------------------------------------------------- */

/**
 * A single reported money movement.
 *
 * `rawFromName` / `rawToName` preserve exactly what the source said. The
 * resolved `fromEntityId` / `toEntityId` may be rewritten later as entity
 * resolution improves, without needing to re-fetch from the state.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    fromEntityId: uuid('from_entity_id').references(() => entities.id),
    toEntityId: uuid('to_entity_id').references(() => entities.id),

    rawFromName: text('raw_from_name').notNull(),
    rawToName: text('raw_to_name').notNull(),

    amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
    txnDate: date('txn_date'),
    direction: txnDirection('direction').notNull().default('contribution'),

    /** Source's own type code, e.g. Florida's CHE / MON / INK. */
    txnTypeCode: text('txn_type_code'),
    inkindDescription: text('inkind_description'),

    /** Election cycle key as the source labels it, e.g. '20241105-GEN'. */
    electionCycle: text('election_cycle'),

    // Donor detail as reported on this specific transaction.
    fromAddress: text('from_address'),
    fromCity: text('from_city'),
    fromState: text('from_state'),
    fromZip: text('from_zip'),
    fromOccupation: text('from_occupation'),

    sourceId: uuid('source_id').references(() => sources.id),
    /** Stable hash of the raw source row; the dedupe key across re-ingests. */
    sourceRowHash: text('source_row_hash').notNull(),

    /** Confidence that `fromEntityId` is the right node for `rawFromName`. */
    fromConfidence: real('from_confidence').notNull().default(0),
    toConfidence: real('to_confidence').notNull().default(0),

    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * When this row was last changed after loading. Null means never.
     *
     * Maintained by a trigger, not by application code, because the changes
     * that matter most here are hand-written SQL: a human reattributing money
     * from the wrong person to the right one. `ingested_at` cannot see that —
     * the row was loaded weeks ago and its attribution changed today — so a
     * delta keyed on load time ships corrections nowhere.
     *
     * Deliberately nullable with no default. A `DEFAULT now() NOT NULL` column
     * rewrites three million rows on the way in and then claims every one of
     * them changed, which would make the first sync after this ship the entire
     * table.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true }),

  },
  (t) => [
    uniqueIndex('transactions_row_hash_key').on(t.sourceRowHash),
    index('transactions_from_idx').on(t.fromEntityId),
    index('transactions_to_idx').on(t.toEntityId),
    index('transactions_date_idx').on(t.txnDate),
    index('transactions_amount_idx').on(t.amount),
    // Covering indexes for the two directions the crawler walks.
    index('transactions_to_from_amount_idx').on(t.toEntityId, t.fromEntityId, t.amount),
    index('transactions_from_to_amount_idx').on(t.fromEntityId, t.toEntityId, t.amount),
  ],
);

/**
 * Pre-aggregated entity→entity totals.
 *
 * The crawler renders one tile-to-tile edge, not one edge per cheque. US Sugar
 * gave the Florida Chamber PAC five separate $250k cheques in 2024; the graph
 * should show a single $1.25M edge. Materializing that here keeps expansion a
 * single indexed read per hop instead of an aggregate over millions of rows.
 */
export const edgeRollups = pgTable(
  'edge_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromEntityId: uuid('from_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    toEntityId: uuid('to_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /**
     * Which cycle this edge belongs to.
     *
     * Rollups are split per cycle rather than summed across them. Once two
     * cycles share the table, a single figure per pair answers a question
     * nobody asked: "who funds this candidate" means this election, not the
     * last one plus this one. Splitting costs about 20% more rows.
     */
    electionCycle: text('election_cycle').notNull(),
    totalAmount: numeric('total_amount', { precision: 16, scale: 2 }).notNull(),
    txnCount: integer('txn_count').notNull(),
    firstDate: date('first_date'),
    lastDate: date('last_date'),
    /** True when both ends are traversable — a genuine "direct" PAC-to-PAC link. */
    isDirectLink: boolean('is_direct_link').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('edge_rollups_pair_key').on(t.fromEntityId, t.toEntityId, t.electionCycle),
    // The crawler's hot paths: expand upstream, expand downstream, biggest
    // first — with the cycle leading, since a filtered crawl is the common case.
    index('edge_rollups_to_amount_idx').on(t.toEntityId, t.electionCycle, t.totalAmount),
    index('edge_rollups_from_amount_idx').on(t.fromEntityId, t.electionCycle, t.totalAmount),
    index('edge_rollups_direct_idx').on(t.isDirectLink),
  ],
);

/**
 * Per-cycle totals for a tile.
 *
 * `entities.total_received` spans every cycle loaded. With a cycle filter
 * active the tile has to agree with the edges around it, so the filtered view
 * reads here instead — precomputed rather than aggregated per neighbour,
 * because the crawler touches these on every hop.
 */
export const entityCycleTotals = pgTable(
  'entity_cycle_totals',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    electionCycle: text('election_cycle').notNull(),
    totalReceived: numeric('total_received', { precision: 16, scale: 2 }).notNull().default('0'),
    totalGiven: numeric('total_given', { precision: 16, scale: 2 }).notNull().default('0'),
    inDegree: integer('in_degree').notNull().default(0),
    outDegree: integer('out_degree').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.electionCycle] }),
    index('entity_cycle_totals_cycle_idx').on(t.electionCycle),
  ],
);

/* -------------------------------------------------------------------------- */
/* Who runs a committee                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Roles a filing office records for a committee.
 *
 * Florida requires the same appointments at every level, but the two tiers name
 * them differently: the state list has one chair and one treasurer column pair,
 * while a county keeps the underlying forms — `Appointment_of_Committee_Treasurer`,
 * `Appointment_of_Campaign_Treasurer`, `Election_of_Chairperson` — as separate
 * filings. `deputy_treasurer` and `registered_agent` appear on the forms but not
 * in either extract yet.
 */
export const officerRole = pgEnum('officer_role', [
  'chair',
  'treasurer',
  'deputy_treasurer',
  'registered_agent',
  // A director or board member of a corporation, from its Division of
  // Corporations record. Not a campaign-committee appointment — but it links
  // the corporation to everything else the same person governs, exactly as a
  // shared treasurer links committees.
  'director',
  'other',
]);

/**
 * A committee's registration record, as its filing office publishes it.
 *
 * Kept apart from `entities` because the provenance is different in kind.
 * `entities.address` is whatever a contributor happened to write on a cheque;
 * this is what the committee told the state or the county it is. It is also the
 * only place the filing office's own identifier lives — Florida's transaction
 * export carries no entity ids, but its committee list does.
 *
 * Columns cover both tiers, so a county loader has somewhere to put every field
 * it can read. The state list has no email or website; the county pages have no
 * account number or officer names. Neither has validity dates, and today's load
 * is a snapshot — but the county's officer filings are dated appointments and
 * resignations, so the dates are here waiting rather than added later under a
 * table rewrite.
 */
export const committeeRegistrations = pgTable(
  'committee_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id),

    /** The filing office's own id: `AcctNum` at the state, `ca=` in a county. */
    externalId: text('external_id'),

    committeeType: text('committee_type'),
    /** Spelled-out type, e.g. "Electioneering Communications Organization". */
    typeDescription: text('type_description'),
    status: text('status'),

    addr1: text('addr1'),
    addr2: text('addr2'),
    city: text('city'),
    stateCode: text('state_code'),
    zip: text('zip'),
    /** County of record, which the state list reports and a county implies. */
    countyName: text('county_name'),
    /**
     * Street address folded to a comparable form.
     *
     * The clustering key. One operation files under "1722 NW 80TH BLVD, SUITE
     * 90", "1722 NORTHWEST 80TH BOULEVARD" and "1722 NORTH WEST 80TH BOULEVARD"
     * in the same extract, so the raw string cannot group anything.
     */
    normalizedAddress: text('normalized_address'),

    phone: text('phone'),
    /** Digits only, so formatting differences do not split a shared line. */
    phoneDigits: text('phone_digits'),
    /** County pages publish these; the state list does not. */
    email: text('email'),
    website: text('website'),

    /**
     * Validity window, when the source dates its record.
     *
     * Null on a snapshot load, which is every load today. `isCurrent` is what
     * queries filter on, so it stays correct whether or not dates are known.
     */
    effectiveDate: date('effective_date'),
    expiredDate: date('expired_date'),
    isCurrent: boolean('is_current').notNull().default(true),

    /** When we read it, which is the only date a snapshot actually has. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live record per entity per source; superseded rows stay for history.
    uniqueIndex('committee_registrations_current_key')
      .on(t.entityId, t.sourceId)
      .where(sql`is_current`),
    index('committee_registrations_entity_idx').on(t.entityId),
    index('committee_registrations_address_idx').on(t.normalizedAddress),
    index('committee_registrations_phone_idx').on(t.phoneDigits),
    index('committee_registrations_external_idx').on(t.externalId),
  ],
);

/**
 * A person a committee reports as running it.
 *
 * One row per person per role, which is what makes the shared-operative
 * question answerable: the same name against many committees is the signal.
 * How much of a signal depends entirely on how many — one treasurer in the
 * live state list holds 278 committees and is a compliance practice, not a
 * network — so callers must weigh a match by how common it is rather than
 * treating any shared name as a relationship.
 *
 * `normalizedName` is the join key and deliberately excludes the middle name,
 * so "JONES, WILLIAM" and "JONES, WILLIAM T" are one person.
 */
export const committeeOfficers = pgTable(
  'committee_officers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id),

    role: officerRole('role').notNull(),

    nameLast: text('name_last'),
    nameFirst: text('name_first'),
    nameMiddle: text('name_middle'),
    /** As filed, or reconstructed from the parts when the source splits them. */
    fullName: text('full_name').notNull(),
    normalizedName: text('normalized_name').notNull(),

    /**
     * Contact details for the officer.
     *
     * On the appointment form but in neither extract: the state list gives only
     * names, and the county's copy is a scanned image. Reserved so an OCR pass
     * has somewhere to write.
     */
    address: text('address'),
    city: text('city'),
    stateCode: text('state_code'),
    zip: text('zip'),
    phone: text('phone'),
    email: text('email'),

    /**
     * Where this came from, when the source is a document rather than a field.
     *
     * County officer data exists only as scanned appointment and resignation
     * PDFs, so anything read out of one needs to point back at it.
     */
    documentUrl: text('document_url'),

    effectiveDate: date('effective_date'),
    expiredDate: date('expired_date'),
    isCurrent: boolean('is_current').notNull().default(true),

    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Role is part of the key: one person is routinely both chair and treasurer.
    uniqueIndex('committee_officers_current_key')
      .on(t.entityId, t.sourceId, t.role, t.normalizedName)
      .where(sql`is_current`),
    index('committee_officers_entity_idx').on(t.entityId),
    // The clustering lookup: every committee this person is named on.
    index('committee_officers_name_idx').on(t.normalizedName),
  ],
);

/**
 * What an entity is when it is a corporation rather than a campaign committee.
 *
 * A nonprofit that moves political money — a 501(c)(4), say — files with the
 * Division of Corporations and the IRS, not the Division of Elections. Its
 * donors are not disclosed, so the graph cannot trace behind it. Its
 * governance is public though, and that is the useful part: the registered
 * agent and the board are what tie these shells to each other and to the
 * people who run them. This holds that corporate and Form 990 record, kept
 * apart from `committee_registrations` because the source is different in kind.
 */
export const orgProfiles = pgTable(
  'org_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),

    /** e.g. "Florida Not-For-Profit Corporation". */
    corpType: text('corp_type'),
    /** e.g. "501(c)(4)". */
    taxStatus: text('tax_status'),
    /** True when the org files with the IRS as a 527 political organization. */
    is527: boolean('is_527'),
    ein: text('ein'),
    /** The Division of Corporations document number. */
    docNumber: text('doc_number'),
    status: text('status'),
    filedDate: date('filed_date'),
    address: text('address'),
    registeredAgent: text('registered_agent'),
    /** The organization's stated mission, from its Form 990. */
    mission: text('mission'),
    website: text('website'),

    /** Board of directors: `[{ name, title }]`. */
    board: jsonb('board').$type<{ name: string; title?: string }[]>(),
    /** Form 990 figures by year, e.g. `{ revenue: { "2024": 2135289 }, ... }`. */
    financials: jsonb('financials').$type<Record<string, Record<string, number>>>(),
    /** True when the 990 Schedule B (contributors) is withheld from the public copy. */
    donorsRestricted: boolean('donors_restricted'),

    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('org_profiles_entity_key').on(t.entityId)],
);

/**
 * One officer key that should be read as another.
 *
 * `officerKey` folds a filed name to LAST FIRST, which handles the variation
 * that carries no information — middle names, initials, punctuation. It cannot
 * cross a misspelling, and the state's own list contains several: `Williams S
 * Jones` and `Wiliam S Jones` are the same person as `William S. Jones` and key
 * apart from him, splitting seven committees off a hundred-committee network.
 *
 * Fuzzy-matching officer names automatically is not the answer. Two people
 * genuinely called J. Smith are common, and a wrong merge here asserts that one
 * person runs committees they have nothing to do with — the same class of harm
 * as a wrong entity merge, aimed at a named individual. So corrections are
 * enumerated by hand and applied at ingest, which keeps them reviewable in the
 * one place a reader would look.
 */
export const officerAliases = pgTable(
  'officer_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The key as `officerKey` would derive it from the filed spelling. */
    alias: text('alias').notNull(),
    /** The key it should be treated as. */
    canonical: text('canonical').notNull(),
    /** Why, so the next reader can check rather than trust. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('officer_aliases_alias_key').on(t.alias)],
);

/* -------------------------------------------------------------------------- */
/* Saved searches                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A named, reloadable view: which entity we started from, how we crawled, and
 * where the user dragged the tiles.
 */
export const savedSearches = pgTable(
  'saved_searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    seedEntityId: uuid('seed_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Serialized CrawlParams — depth, direction, link mode, filters. */
    params: jsonb('params').notNull(),
    /** Map of entityId -> {x, y} so a reopened graph keeps its layout. */
    nodePositions: jsonb('node_positions'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('saved_searches_seed_idx').on(t.seedEntityId)],
);

/* -------------------------------------------------------------------------- */
/* Ingestion bookkeeping                                                       */
/* -------------------------------------------------------------------------- */

export const ingestRunStatus = pgEnum('ingest_run_status', [
  'running',
  'succeeded',
  'failed',
  'partial',
]);

/** One execution of one source adapter, for observability and safe resume. */
/**
 * Entities that were deleted, and what they were folded into.
 *
 * `mergeEntities` reassigns a duplicate's rows and then deletes it. On this
 * machine that is the end of it, but the deployment box is a copy that is
 * brought forward by shipping changed rows — and a row that no longer exists
 * cannot be shipped. Without a record of the deletion, the far side keeps the
 * duplicate forever and slowly diverges from what anyone here is looking at.
 *
 * `merged_into` is kept for the trail rather than for lookups: it says which
 * entity now holds that money, which is the question anyone reading a stale
 * link or an old CSV will have.
 */
export const entityTombstones = pgTable('entity_tombstones', {
  /** The id that was deleted. Not a reference — the row it named is gone. */
  id: uuid('id').primaryKey(),
  mergedInto: uuid('merged_into'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ingestRuns = pgTable(

  'ingest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    status: ingestRunStatus('status').notNull().default('running'),
    /** Adapter-specific scope, e.g. { election: '20241105-GEN', prefix: 'A' }. */
    scope: jsonb('scope'),
    rowsFetched: integer('rows_fetched').notNull().default(0),
    rowsInserted: integer('rows_inserted').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('ingest_runs_source_idx').on(t.sourceId, t.startedAt)],
);

/* -------------------------------------------------------------------------- */
/* Application settings                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Small key/value store for operator-managed configuration. Currently holds
 * only the session signing secret.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Someone allowed into the graph explorer.
 *
 * Accounts are created by an operator, the way htpasswd lines used to be. What
 * the old file could not do is let the person change their own password, so a
 * new account starts with a temporary one and `mustChangePassword` forces a
 * replacement before anything else loads.
 *
 * Email is stored already lowercased; addresses are not case sensitive in
 * practice, and a plain unique index then does the right thing.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type EdgeRollup = typeof edgeRollups.$inferSelect;
export type SavedSearch = typeof savedSearches.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type User = typeof users.$inferSelect;
