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
 * dollar took.
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
}

export interface TracedSource {
  id: string;
  name: string;
  kind: string;
  amount: number;
  share: number;
  hop: number;
}

export interface TraceResult {
  seed: { id: string; name: string; kind: string; total: number; inDegree: number };
  sources: TracedSource[];
  /** Conduits with no eligible upstream, or still in flight at maxDepth. */
  unresolved: TracedSource[];
  /** Strands abandoned below minDollars, or pruned at the parcel ceiling. */
  dispersed: number;
  hops: number;
  dateOrdered: boolean;
  truncated: boolean;
}

interface Parcel {
  entityId: string;
  /** Latest date this money could have been contributed, or null if unbounded. */
  cutoff: string | null;
  amount: number;
}

interface InboundRow extends Record<string, unknown> {
  to_id: string;
  from_id: string;
  from_kind: string;
  txn_date: string | null;
  amount: string;
}

export async function trace(
  db: Db,
  seedId: string,
  opts: TraceOptions = {},
): Promise<TraceResult> {
  const maxDepth = opts.maxDepth ?? 12;
  const minDollars = opts.minDollars ?? 100;
  const dateOrdered = opts.dateOrdered ?? true;

  const [seed] = await db.execute<{
    id: string;
    name: string;
    kind: string;
    received: string;
    in_degree: number;
  }>(sql`
    SELECT id, name, kind::text AS kind, total_received::text AS received, in_degree
    FROM entities WHERE id = ${seedId}
  `);
  if (!seed) throw new Error(`no entity ${seedId}`);

  const seedTotal = Number(seed.received);
  const origins = new Map<string, { amount: number; hop: number }>();
  const dark = new Map<string, { amount: number; hop: number }>();
  let dispersed = 0;
  let truncated = false;
  let hops = 0;

  let parcels: Parcel[] = [{ entityId: seedId, cutoff: null, amount: seedTotal }];

  for (let depth = 1; depth <= maxDepth && parcels.length > 0; depth++) {
    hops = depth;
    const inbound = await inboundByRecipient(db, [...new Set(parcels.map((p) => p.entityId))]);
    const next = new Map<string, Parcel>();

    for (const parcel of parcels) {
      const all = inbound.get(parcel.entityId) ?? [];
      // Self-funding is not an upstream source, and would loop forever.
      let eligible = all.filter((e) => e.from_id !== parcel.entityId);
      if (dateOrdered && parcel.cutoff !== null) {
        // Same-day is allowed: a transfer can be funded by money banked that day.
        eligible = eligible.filter((e) => e.txn_date !== null && e.txn_date <= parcel.cutoff!);
      }

      const known = eligible.reduce((s, e) => s + Number(e.amount), 0);
      if (known <= 0) {
        bump(dark, parcel.entityId, parcel.amount, depth - 1);
        continue;
      }

      for (const e of eligible) {
        const share = (Number(e.amount) / known) * parcel.amount;
        if (share < minDollars) {
          dispersed += share;
          continue;
        }
        if (!CONDUIT_KINDS.has(e.from_kind)) {
          bump(origins, e.from_id, share, depth);
          continue;
        }
        // Each hop tightens the cutoff: money can only have funded this
        // transfer if it arrived before the transfer did.
        const cutoff = dateOrdered ? e.txn_date : null;
        const key = `${e.from_id}|${cutoff ?? ''}`;
        const existing = next.get(key);
        if (existing) existing.amount += share;
        else next.set(key, { entityId: e.from_id, cutoff, amount: share });
      }
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
  for (const p of parcels) bump(dark, p.entityId, p.amount, hops);

  const names = await namesFor(db, [...origins.keys(), ...dark.keys()]);
  const toList = (m: Map<string, { amount: number; hop: number }>): TracedSource[] =>
    [...m.entries()]
      .map(([id, v]) => ({
        id,
        name: names.get(id)?.name ?? id,
        kind: names.get(id)?.kind ?? 'unknown',
        amount: v.amount,
        share: seedTotal > 0 ? v.amount / seedTotal : 0,
        hop: v.hop,
      }))
      .sort((a, b) => b.amount - a.amount);

  return {
    seed: {
      id: seed.id,
      name: seed.name,
      kind: seed.kind,
      total: seedTotal,
      inDegree: seed.in_degree,
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
 * Inbound contributions for a whole frontier, collapsed per donor per day.
 *
 * Grouping by date keeps the ordering information the attribution needs while
 * cutting the row count for conduits with large small-donor bases.
 */
async function inboundByRecipient(db: Db, ids: string[]): Promise<Map<string, InboundRow[]>> {
  const rows = await db.execute<InboundRow>(sql`
    SELECT t.to_entity_id AS to_id,
           t.from_entity_id AS from_id,
           d.kind::text AS from_kind,
           t.txn_date::text AS txn_date,
           SUM(t.amount)::text AS amount
      FROM transactions t
      JOIN entities d ON d.id = t.from_entity_id
     WHERE t.to_entity_id = ANY(${sql.param(ids)}::uuid[])
       AND t.direction = 'contribution'
       AND t.from_entity_id IS NOT NULL
     GROUP BY 1, 2, 3, 4
  `);
  const out = new Map<string, InboundRow[]>();
  for (const r of rows) {
    const list = out.get(r.to_id);
    if (list) list.push(r);
    else out.set(r.to_id, [r]);
  }
  return out;
}

async function namesFor(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, { name: string; kind: string }>();
  const rows = await db.execute<{ id: string; name: string; kind: string }>(sql`
    SELECT id, name, kind::text AS kind FROM entities
    WHERE id = ANY(${sql.param(ids)}::uuid[])
  `);
  return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind }]));
}

function bump(
  m: Map<string, { amount: number; hop: number }>,
  k: string,
  v: number,
  hop: number,
) {
  const cur = m.get(k);
  if (cur) cur.amount += v;
  else m.set(k, { amount: v, hop });
}
