/**
 * Trace money through conduits back to the entities that originated it.
 *
 * A committee's donor list is not its funding. Where the donors are themselves
 * committees — the norm for the transfer layer — the list only names the next
 * committees to read. This follows the chain to entities that actually
 * originate money and attributes the seed's dollars back to them.
 *
 * Attribution is pro-rata, because money in an account is fungible: a conduit
 * that took $1M and passed on $100k passed on 10% of each of its own sources.
 * That is a claim about proportions of a pool, not about the route a particular
 * dollar took. It is also bounded by the pool: a conduit that passed on more
 * than its tracked sources put in passed on all of them, and the rest is
 * reported as unexplained rather than invented onto the donors.
 *
 * Implemented as breadth-first mass propagation rather than a recursive CTE.
 * The obvious `WITH RECURSIVE` over the graph does not terminate here: carrying
 * a path array to break cycles makes it enumerate routes instead of nodes, and
 * this layer is dense enough that the route count explodes. Pushing mass one
 * level at a time visits each node once per level and finishes in seconds.
 *
 * Cycles therefore need no special handling. Mass is absorbed at every
 * non-conduit, so it decays on each pass instead of looping forever.
 */

import { sql } from 'drizzle-orm';
import type { db as Database } from '@/db';
import { derivedCycleSql } from '@/lib/cycles';

type Db = typeof Database;

/** Committees and parties pass money through; everything else originates it. */
const CONDUIT_KINDS = new Set(['committee', 'party']);

/**
 * Ceiling on live parcels per level.
 *
 * Date-ordered tracing splits a node into one parcel per distinct cutoff, so a
 * heavily-funded conduit can fan out fast. Parcels are pruned smallest-first,
 * and what is dropped is reported rather than discarded silently.
 */
const MAX_PARCELS = 4000;

export interface TraceOptions {
  maxDepth?: number;
  /** Stop chasing a strand once it is worth less than this. */
  minDollars?: number;
  /**
   * Only credit money a conduit held before it paid out.
   *
   * Without this a source can be credited for a transfer that predates its own
   * contribution, which is the difference between a defensible finding and a
   * coincidence of totals.
   */
  dateOrdered?: boolean;
  /**
   * Restrict to one election cycle.
   *
   * A trace is a question about an election, so mixing cycles answers the
   * wrong one: money raised for 2024 did not fund a 2026 transfer.
   */
  cycle?: string;
  /**
   * Inclusive bounds on the transaction date.
   *
   * Narrows every hop, and the seed's own total with them. The total has to
   * move too: it is the denominator every share is expressed against, and
   * leaving it at the unfiltered figure would report the money the window
   * excluded as a trail that went cold.
   */
  dateFrom?: string;
  dateTo?: string;
}

export interface TracedSource {
  id: string;
  name: string;
  kind: string;
  /** Null when nothing classified it — see `classifyIndustry`. */
  industry: string | null;
  amount: number;
  share: number;
  hop: number;
  /**
   * The route this money took, seed first and this entity last.
   *
   * A source is usually reached by several routes at once, and the amount is
   * the sum over all of them. This records the shallowest one, which is the
   * same route `hop` counts — so the two never disagree about how far away the
   * source is. Names for the conduits in the middle are in `conduits`.
   */
  chain: string[];
}

export interface Funder {
  id: string;
  name: string;
  industry: string | null;
  amount: number;
  share: number;
}


export interface InjectionPoint extends TracedSource {
  /** The pool's own largest funders, as context rather than attribution. */
  funders: Funder[];
}

export interface TraceResult {
  seed: { id: string; name: string; kind: string; total: number; inDegree: number };
  sources: TracedSource[];
  /**
   * National pools the money entered Florida through.
   *
   * Kept apart from `sources` deliberately: their funders are known, but the
   * share of that pool which reached Florida is not, so the two must not be
   * added together.
   */
  injectionPoints: InjectionPoint[];
  /** Conduits with no eligible upstream, or still in flight at maxDepth. */
  unresolved: TracedSource[];
  /** Strands abandoned below minDollars, or pruned at the parcel ceiling. */
  dispersed: number;
  hops: number;
  dateOrdered: boolean;
  truncated: boolean;
  /** Null when every cycle is included. */
  cycle: string | null;
}

interface Parcel {
  entityId: string;
  /** Latest date this money could have been contributed, or null if unbounded. */
  cutoff: string | null;
  amount: number;
  /** How this parcel got here: seed first, `entityId` last. */
  chain: string[];
}


interface InboundRow extends Record<string, unknown> {
  to_id: string;
  from_id: string;
  from_kind: string;
  from_injection: boolean;
  txn_date: string | null;
  amount: string;
}

export async function trace(
  db: Db,
  seedIds: string | string[],
  opts: TraceOptions = {},
): Promise<TraceResult> {
  const maxDepth = opts.maxDepth ?? 12;
  const minDollars = opts.minDollars ?? 100;
  const dateOrdered = opts.dateOrdered ?? true;
  const cycle = opts.cycle;
  const { dateFrom, dateTo } = opts;
  const windowed = dateFrom != null || dateTo != null;


  const ids = Array.isArray(seedIds) ? seedIds : [seedIds];
  if (ids.length === 0) throw new Error('trace needs at least one seed');

  /**
   * What the seed received inside the window.
   *
   * The stored totals cover a whole cycle, so a date filter has to be counted
   * from the transactions instead. This is the denominator every share in the
   * report is expressed against: left at the cycle figure, the money the
   * window excluded would be reported as a trail that went cold rather than as
   * money that was never in scope.
   */
  const receivedInWindow = sql`
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount), 0) AS amount,
             COUNT(DISTINCT t.from_entity_id)::int AS sources
        FROM transactions t
       WHERE t.to_entity_id = e.id
         AND t.from_entity_id IS NOT NULL
         ${cycle ? sql`AND ${derivedCycleSql('t')} = ${cycle}` : sql``}
         ${dateFrom ? sql`AND t.txn_date >= ${dateFrom}` : sql``}
         ${dateTo ? sql`AND t.txn_date <= ${dateTo}` : sql``}
    ) w ON true
  `;

  const seeds = await db.execute<{
    id: string;
    name: string;
    kind: string;
    received: string;
    in_degree: number;
  }>(sql`
    SELECT e.id, e.name, e.kind::text AS kind,
           ${windowed
             ? sql`w.amount::text AS received, w.sources AS in_degree`
             : cycle
               ? sql`COALESCE(ct.total_received, 0)::text AS received,
                     COALESCE(ct.in_degree, 0) AS in_degree`
               : sql`e.total_received::text AS received, e.in_degree`}
    FROM entities e
    ${windowed
      ? receivedInWindow
      : cycle
        ? sql`LEFT JOIN entity_cycle_totals ct
                ON ct.entity_id = e.id AND ct.election_cycle = ${cycle}`
        : sql``}
    WHERE e.id = ANY(${sql.param(ids)}::uuid[])
  `);

  if (seeds.length === 0) throw new Error(`no entity ${ids.join(', ')}`);

  const seedTotal = seeds.reduce((a, s) => a + Number(s.received), 0);
  const origins = new Map<string, Attribution>();
  const injections = new Map<string, Attribution>();
  const dark = new Map<string, Attribution>();
  let dispersed = 0;
  let truncated = false;
  let hops = 0;

  // One parcel per seed, each carrying its own receipts, so a group is traced
  // as the sum of its members rather than as a single averaged pot. Transfers
  // between members resolve naturally: the receiving committee's parcel walks
  // up into the sending one, which is where that money actually came from.
  let parcels: Parcel[] = seeds
    .map((s) => ({ entityId: s.id, cutoff: null, amount: Number(s.received), chain: [s.id] }))
    .filter((p) => p.amount > 0);

  for (let depth = 1; depth <= maxDepth && parcels.length > 0; depth++) {
    hops = depth;
    const inbound = await inboundByRecipient(
      db,
      [...new Set(parcels.map((p) => p.entityId))],
      cycle,
      dateFrom,
      dateTo,
    );
    const next = new Map<string, Parcel>();

    // Each parcel's eligible upstream, worked out before any is attributed, so
    // that a conduit carrying several parcels can be planned as one pool.
    const plans = parcels.map((parcel) => {
      const all = inbound.get(parcel.entityId) ?? [];
      // Self-funding is not an upstream source, and would loop forever. Nor is
      // a refund: a negative line is money leaving, and left in the pool it
      // shrinks the denominator so every real donor's share inflates, then
      // becomes a negative share of its own that no cap can bound.
      let eligible = all.filter((e) => e.from_id !== parcel.entityId && Number(e.amount) > 0);
      if (dateOrdered && parcel.cutoff !== null) {
        // Same-day is allowed: a transfer can be funded by money banked that day.
        eligible = eligible.filter((e) => e.txn_date !== null && e.txn_date <= parcel.cutoff!);
      }
      const known = eligible.reduce((s, e) => s + Number(e.amount), 0);
      return { parcel, eligible, known };
    });

    // Pro-rata is a claim about a pool, and a pool cannot pass on more than was
    // put into it. Sum what every parcel would draw from each inbound edge, and
    // where that exceeds what the edge actually carried, scale the draw down to
    // fit. Without this, a conduit that paid out more than its tracked receipts
    // — its own treasury, money from outside the window — had the excess
    // manufactured onto its donors: a candidate who spent $603 at a supermarket
    // that then gave $400k of its own money was credited with $13,699 of it.
    // Summed across parcels, not per parcel, because a donor gave once whatever
    // number of parcels the conduit happens to be carrying. The shortfall is
    // reported as unexplained at the conduit, which is what it is.
    const demand = new Map<InboundRow, number>();
    for (const { parcel, eligible, known } of plans) {
      if (known <= 0) continue;
      for (const e of eligible) {
        demand.set(e, (demand.get(e) ?? 0) + (Number(e.amount) / known) * parcel.amount);
      }
    }
    const fit = new Map<InboundRow, number>();
    for (const [e, d] of demand) fit.set(e, d > Number(e.amount) ? Number(e.amount) / d : 1);

    for (const { parcel, eligible, known } of plans) {
      if (known <= 0) {
        bump(dark, parcel.entityId, parcel.amount, depth - 1, parcel.chain);
        continue;
      }

      let explained = 0;
      for (const e of eligible) {
        const share = (Number(e.amount) / known) * parcel.amount * (fit.get(e) ?? 1);
        explained += share;
        const chain = [...parcel.chain, e.from_id];
        if (share < minDollars) {
          dispersed += share;
          continue;
        }
        if (e.from_injection) {
          // A national pool. Its own funding is real and loadable, but only a
          // share of it ever reached Florida, and the disclosure does not say
          // which share. Stop here and name it rather than manufacturing a
          // per-donor estimate that would sit alongside observed transfers
          // looking equally solid.
          bump(injections, e.from_id, share, depth, chain);
          continue;
        }
        if (!CONDUIT_KINDS.has(e.from_kind)) {
          bump(origins, e.from_id, share, depth, chain);
          continue;
        }
        // Each hop tightens the cutoff: money can only have funded this
        // transfer if it arrived before the transfer did.
        const cutoff = dateOrdered ? e.txn_date : null;
        const key = `${e.from_id}|${cutoff ?? ''}`;
        const existing = next.get(key);
        if (existing) existing.amount += share;
        else next.set(key, { entityId: e.from_id, cutoff, amount: share, chain });
      }

      // What the tracked receipts could not cover came from somewhere the
      // filings do not show. Half a cent is float, not money.
      const unexplained = parcel.amount - explained;
      if (unexplained > 0.005) bump(dark, parcel.entityId, unexplained, depth - 1, parcel.chain);
    }

    parcels = [...next.values()];
    if (parcels.length > MAX_PARCELS) {
      truncated = true;
      parcels.sort((a, b) => b.amount - a.amount);
      for (const p of parcels.slice(MAX_PARCELS)) dispersed += p.amount;
      parcels = parcels.slice(0, MAX_PARCELS);
    }
  }

  // Anything still moving when depth ran out is unexplained, not resolved.
  for (const p of parcels) bump(dark, p.entityId, p.amount, hops, p.chain);

  const names = await namesFor(db, [...origins.keys(), ...injections.keys(), ...dark.keys()]);
  const funders = await topFunders(db, [...injections.keys()]);
  const toList = (m: Map<string, Attribution>): TracedSource[] =>
    [...m.entries()]
      .map(([id, v]) => ({
        id,
        name: names.get(id)?.name ?? id,
        kind: names.get(id)?.kind ?? 'unknown',
        industry: names.get(id)?.industry ?? null,
        amount: v.amount,
        share: seedTotal > 0 ? v.amount / seedTotal : 0,
        hop: v.hop,
        chain: v.chain,
      }))
      .sort((a, b) => b.amount - a.amount);

  return {
    cycle: cycle ?? null,
    injectionPoints: toList(injections).map((p) => ({ ...p, funders: funders.get(p.id) ?? [] })),
    // With several seeds the identity is the group's, so the caller supplies
    // the name; `id` names the first member only as something to link back to.
    seed: {
      id: seeds[0].id,
      name:
        seeds.length === 1
          ? seeds[0].name
          : `${seeds.length} committees`,
      kind: seeds.length === 1 ? seeds[0].kind : 'group',
      total: seedTotal,
      inDegree: seeds.reduce((a, s) => a + s.in_degree, 0),
    },
    sources: toList(origins),
    unresolved: toList(dark),
    dispersed,

    hops,
    dateOrdered,
    truncated,
  };
}

/**
 * Inbound money for a whole frontier, collapsed per payer per day.
 *
 * Grouping by date keeps the ordering information the attribution needs while
 * cutting the row count for conduits with large small-donor bases.
 *
 * Both directions count. A transfer between committees is normally filed by
 * the recipient as a contribution, but when the recipient is not a registered
 * committee it files nothing, and the money exists only as an expenditure on
 * the payer's report — which is exactly the hop worth tracing, since it is
 * where money leaves the committee system. Reading contributions alone left
 * those entities looking unfunded. Nothing double-counts: where both parties
 * filed the same transfer, ingest already kept only the recipient's copy.
 */
async function inboundByRecipient(
  db: Db,
  ids: string[],
  cycle?: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<Map<string, InboundRow[]>> {
  const cyc = sql.join(
    [
      cycle ? sql`AND ${derivedCycleSql('t')} = ${cycle}` : sql``,
      dateFrom ? sql`AND t.txn_date >= ${dateFrom}` : sql``,
      dateTo ? sql`AND t.txn_date <= ${dateTo}` : sql``,
    ],
    sql` `,
  );

  const rows = await db.execute<InboundRow>(sql`
    SELECT t.to_entity_id AS to_id,
           t.from_entity_id AS from_id,
           d.kind::text AS from_kind,
           d.is_injection_point AS from_injection,
           t.txn_date::text AS txn_date,
           SUM(t.amount)::text AS amount
      FROM transactions t
      JOIN entities d ON d.id = t.from_entity_id
     WHERE t.to_entity_id = ANY(${sql.param(ids)}::uuid[])
       AND t.from_entity_id IS NOT NULL
       ${cyc}
     GROUP BY 1, 2, 3, 4, 5
  `);
  const out = new Map<string, InboundRow[]>();
  for (const r of rows) {
    const list = out.get(r.to_id);
    if (list) list.push(r);
    else out.set(r.to_id, [r]);
  }
  return out;
}

/**
 * The largest direct funders of each injection point.
 *
 * Shown as context — "this came from RSLC, which is funded by…" — not folded
 * into the seed's attribution.
 */
async function topFunders(db: Db, ids: string[]): Promise<Map<string, Funder[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<{
    pool_id: string;
    id: string;
    name: string;
    industry: string | null;
    amount: string;
    pool_total: string;
  }>(sql`
    SELECT e.to_entity_id AS pool_id,
           e.from_entity_id AS id,
           d.name,
           d.industry,
           e.total_amount::text AS amount,
           SUM(e.total_amount) OVER (PARTITION BY e.to_entity_id)::text AS pool_total
      FROM edge_rollups e
      JOIN entities d ON d.id = e.from_entity_id
     WHERE e.to_entity_id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY e.total_amount DESC
  `);
  const out = new Map<string, Funder[]>();
  for (const r of rows) {
    const list = out.get(r.pool_id) ?? [];
    if (list.length >= 12) continue;
    const total = Number(r.pool_total);
    list.push({
      id: r.id,
      name: r.name,
      industry: r.industry,
      amount: Number(r.amount),
      share: total > 0 ? Number(r.amount) / total : 0,
    });
    out.set(r.pool_id, list);
  }
  return out;
}

async function namesFor(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, { name: string; kind: string; industry: string | null }>();
  const rows = await db.execute<{ id: string; name: string; kind: string; industry: string | null }>(sql`
    SELECT id, name, kind::text AS kind, industry FROM entities
    WHERE id = ANY(${sql.param(ids)}::uuid[])
  `);
  return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind, industry: r.industry }]));
}

interface Attribution {
  amount: number;
  hop: number;
  chain: string[];
}

/**
 * Add one strand's worth of money to an entity's attribution.
 *
 * Depth ascends, so the first sighting of an entity is always its shallowest.
 * Both `hop` and `chain` are kept from that first sighting and never revised,
 * which is what stops the recorded route from contradicting the hop count.
 */
function bump(m: Map<string, Attribution>, k: string, v: number, hop: number, chain: string[]) {
  const cur = m.get(k);
  if (cur) cur.amount += v;
  else m.set(k, { amount: v, hop, chain });
}

