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
     * True when money can flow *out* of this node as well as in, i.e. it is
     * worth expanding during a crawl. Committees, candidates and parties are
     * traversable; individuals and corporations are normally terminal.
     */
    isTraversable: boolean('is_traversable').notNull().default(false),

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
    totalAmount: numeric('total_amount', { precision: 16, scale: 2 }).notNull(),
    txnCount: integer('txn_count').notNull(),
    firstDate: date('first_date'),
    lastDate: date('last_date'),
    /** True when both ends are traversable — a genuine "direct" PAC-to-PAC link. */
    isDirectLink: boolean('is_direct_link').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('edge_rollups_pair_key').on(t.fromEntityId, t.toEntityId),
    // The crawler's hot paths: expand upstream, expand downstream, biggest first.
    index('edge_rollups_to_amount_idx').on(t.toEntityId, t.totalAmount),
    index('edge_rollups_from_amount_idx').on(t.fromEntityId, t.totalAmount),
    index('edge_rollups_direct_idx').on(t.isDirectLink),
  ],
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

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type EdgeRollup = typeof edgeRollups.$inferSelect;
export type SavedSearch = typeof savedSearches.$inferSelect;
