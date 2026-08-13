/**
 * Breadth-first money-flow crawler.
 *
 * Walks outward from a seed entity, one level at a time, yielding each level as
 * soon as it is known so the UI can paint immediately and keep filling in the
 * background rather than waiting for the whole neighbourhood.
 *
 * Link modes implement the distinction between following the political money
 * chain and following the whole donor base:
 *
 *   direct — only hops where *both* ends are traversable. Following
 *            Joe Candidate upstream yields GovPAC1, then ThemPAC2 and
 *            SomePAC3, and keeps going through committees. Individual and
 *            corporate donors are excluded, so the chain stays readable.
 *
 *   donor  — additionally attaches the donors feeding each node reached. That
 *            is where the volume lives: one PAC can have thousands of
 *            individual contributors, so this mode is capped per node.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

type Db = PostgresJsDatabase<typeof schema>;

export type Direction = 'upstream' | 'downstream' | 'both';
export type LinkMode = 'direct' | 'donor';

export interface CrawlParams {
  seedEntityId: string;
  /** How many hops out from the seed. */
  depth: number;
  direction: Direction;
  linkMode: LinkMode;
  /** Ignore edges smaller than this dollar total. */
  minAmount?: number;
  dateFrom?: string;
  dateTo?: string;
  /**
   * Restrict to one election cycle.
   *
   * Rollups are stored per cycle, so this is an index-range narrowing rather
   * than a post-filter, and tile totals come from `entity_cycle_totals` so the
   * numbers on a node agree with the edges drawn around it.
   */
  cycle?: string;
  /**
   * Cap on new neighbours pulled per node per level. Without it a single hop
   * into a major PAC drags in every small-dollar donor it ever had.
   */
  maxPerNode?: number;
  /** Hard ceiling on graph size, to keep the browser responsive. */
  maxNodes?: number;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  committeeType: string | null;
  status: string;
  office: string | null;
  party: string | null;
  city: string | null;
  stateCode: string | null;
  totalReceived: string;
  totalGiven: string;
  inDegree: number;
  outDegree: number;
  isTraversable: boolean;
  /** BFS distance from the seed. */
  level: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  amount: string;
  txnCount: number;
  firstDate: string | null;
  lastDate: string | null;
  isDirectLink: boolean;
}

export interface CrawlLevel {
  level: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the level was cut short by maxPerNode / maxNodes. */
  truncated: boolean;
}

export const CRAWL_DEFAULTS = {
  depth: 2,
  direction: 'both' as Direction,
  linkMode: 'direct' as LinkMode,
  maxPerNode: 25,
  maxNodes: 600,
};

interface NeighborRow extends Record<string, unknown> {
  edge_id: string;
  from_id: string;
  to_id: string;
  amount: string;
  txn_count: number;
  first_date: string | null;
  last_date: string | null;
  is_direct_link: boolean;
  neighbor_id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  status: string;
  office: string | null;
  party: string | null;
  city: string | null;
  state_code: string | null;
  total_received: string;
  total_given: string;
  in_degree: number;
  out_degree: number;
  is_traversable: boolean;
}

/**
 * Fetch one hop out from a frontier.
 *
 * A lateral join per frontier node applies `maxPerNode` *per node* rather than
 * to the whole result set, so one hub does not starve its siblings of slots.
 */
async function fetchNeighbors(
  db: Db,
  frontier: string[],
  opts: {
    direction: Direction;
    linkMode: LinkMode;
    minAmount?: number;
    dateFrom?: string;
    dateTo?: string;
    cycle?: string;
    maxPerNode: number;
  },
): Promise<NeighborRow[]> {
  if (frontier.length === 0) return [];

  const wantUpstream = opts.direction === 'upstream' || opts.direction === 'both';
  const wantDownstream = opts.direction === 'downstream' || opts.direction === 'both';

  // In direct mode only committee-to-committee style hops are followed.
  const directOnly = opts.linkMode === 'direct' ? sql`AND r.is_direct_link` : sql``;
  const minAmount =
    opts.minAmount != null ? sql`AND r.total_amount >= ${opts.minAmount}` : sql``;
  const dateFrom = opts.dateFrom ? sql`AND r.last_date >= ${opts.dateFrom}` : sql``;
  const dateTo = opts.dateTo ? sql`AND r.first_date <= ${opts.dateTo}` : sql``;
  const cycle = opts.cycle ? sql`AND r.election_cycle = ${opts.cycle}` : sql``;

  // Money flowing *into* a frontier node: neighbour is the sender.
  const upstream = sql`
    SELECT r.id AS edge_id, r.from_entity_id AS from_id, r.to_entity_id AS to_id,
           r.total_amount, r.txn_count, r.first_date, r.last_date, r.is_direct_link,
           r.from_entity_id AS neighbor_id
      FROM edge_rollups r
     WHERE r.to_entity_id = f.id ${cycle} ${directOnly} ${minAmount} ${dateFrom} ${dateTo}
     ORDER BY r.total_amount DESC
     LIMIT ${opts.maxPerNode}
  `;

  // Money flowing *out of* a frontier node: neighbour is the recipient.
  const downstream = sql`
    SELECT r.id AS edge_id, r.from_entity_id AS from_id, r.to_entity_id AS to_id,
           r.total_amount, r.txn_count, r.first_date, r.last_date, r.is_direct_link,
           r.to_entity_id AS neighbor_id
      FROM edge_rollups r
     WHERE r.from_entity_id = f.id ${cycle} ${directOnly} ${minAmount} ${dateFrom} ${dateTo}
     ORDER BY r.total_amount DESC
     LIMIT ${opts.maxPerNode}
  `;

  // With a cycle selected the tile must report that cycle, not every cycle
  // loaded, or a filtered graph shows edges worth one figure under a node
  // labelled with another.
  const totalsSelect = opts.cycle
    ? sql`COALESCE(ct.total_received, 0)::text AS total_received,
          COALESCE(ct.total_given, 0)::text    AS total_given,
          COALESCE(ct.in_degree, 0)  AS in_degree,
          COALESCE(ct.out_degree, 0) AS out_degree,`
    : sql`e.total_received::text AS total_received,
          e.total_given::text    AS total_given,
          e.in_degree, e.out_degree,`;
  const totalsJoin = opts.cycle
    ? sql`LEFT JOIN entity_cycle_totals ct
            ON ct.entity_id = hop.neighbor_id AND ct.election_cycle = ${opts.cycle}`
    : sql``;

  const branch =
    wantUpstream && wantDownstream
      ? sql`(${upstream}) UNION ALL (${downstream})`
      : wantUpstream
        ? upstream
        : downstream;

  return db.execute<NeighborRow>(sql`
    SELECT hop.edge_id, hop.from_id, hop.to_id,
           hop.total_amount::text AS amount, hop.txn_count,
           hop.first_date::text   AS first_date,
           hop.last_date::text    AS last_date,
           hop.is_direct_link, hop.neighbor_id,
           e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.office, e.party, e.city, e.state_code,
           ${totalsSelect}
           e.is_traversable
      FROM unnest(${sql.param(frontier)}::uuid[]) AS f(id)
      CROSS JOIN LATERAL (${branch}) AS hop
      JOIN entities e ON e.id = hop.neighbor_id
      ${totalsJoin}
  `);
}

function toNode(r: NeighborRow, level: number): GraphNode {
  return {
    id: r.neighbor_id,
    name: r.name,
    kind: r.kind,
    committeeType: r.committee_type,
    status: r.status,
    office: r.office,
    party: r.party,
    city: r.city,
    stateCode: r.state_code,
    totalReceived: r.total_received,
    totalGiven: r.total_given,
    inDegree: r.in_degree,
    outDegree: r.out_degree,
    isTraversable: r.is_traversable,
    level,
  };
}

/** Columns describing an entity, shared by the seed and neighbour queries. */
interface EntityRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  status: string;
  office: string | null;
  party: string | null;
  city: string | null;
  state_code: string | null;
  total_received: string;
  total_given: string;
  in_degree: number;
  out_degree: number;
  is_traversable: boolean;
}

/** Load the seed as a level-0 node. */
async function fetchSeed(db: Db, id: string, cycle?: string): Promise<GraphNode | null> {
  const totals = cycle
    ? sql`COALESCE(ct.total_received, 0)::text AS total_received,
          COALESCE(ct.total_given, 0)::text    AS total_given,
          COALESCE(ct.in_degree, 0) AS in_degree, COALESCE(ct.out_degree, 0) AS out_degree`
    : sql`e.total_received::text AS total_received, e.total_given::text AS total_given,
          e.in_degree, e.out_degree`;
  const join = cycle
    ? sql`LEFT JOIN entity_cycle_totals ct
            ON ct.entity_id = e.id AND ct.election_cycle = ${cycle}`
    : sql``;
  const rows = await db.execute<EntityRow>(sql`
    SELECT e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.office, e.party, e.city, e.state_code,
           ${totals}, e.is_traversable
      FROM entities e ${join} WHERE e.id = ${id}
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    committeeType: r.committee_type,
    status: r.status,
    office: r.office,
    party: r.party,
    city: r.city,
    stateCode: r.state_code,
    totalReceived: r.total_received,
    totalGiven: r.total_given,
    inDegree: r.in_degree,
    outDegree: r.out_degree,
    isTraversable: r.is_traversable,
    level: 0,
  };
}

/**
 * Crawl the graph, yielding one level at a time.
 *
 * Consumers stream each yielded level straight to the client; nothing waits for
 * the crawl to finish.
 */
export async function* crawl(db: Db, params: CrawlParams): AsyncGenerator<CrawlLevel> {
  const {
    seedEntityId,
    depth,
    direction,
    linkMode,
    minAmount,
    dateFrom,
    dateTo,
    cycle,
    maxPerNode = CRAWL_DEFAULTS.maxPerNode,
    maxNodes = CRAWL_DEFAULTS.maxNodes,
  } = params;

  const seed = await fetchSeed(db, seedEntityId, cycle);
  if (!seed) return;

  const seenNodes = new Set<string>([seed.id]);
  const seenEdges = new Set<string>();

  yield { level: 0, nodes: [seed], edges: [], truncated: false };

  let frontier = [seed.id];

  for (let level = 1; level <= depth; level++) {
    if (frontier.length === 0) break;

    const rows = await fetchNeighbors(db, frontier, {
      direction,
      linkMode,
      minAmount,
      dateFrom,
      dateTo,
      cycle,
      maxPerNode,
    });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nextFrontier: string[] = [];
    let truncated = false;

    for (const r of rows) {
      // Edges are emitted even when they close a cycle back onto a known node —
      // those links are exactly what reveals circular PAC funding.
      if (!seenEdges.has(r.edge_id)) {
        seenEdges.add(r.edge_id);
        edges.push({
          id: r.edge_id,
          source: r.from_id,
          target: r.to_id,
          amount: r.amount,
          txnCount: r.txn_count,
          firstDate: r.first_date,
          lastDate: r.last_date,
          isDirectLink: r.is_direct_link,
        });
      }

      if (seenNodes.has(r.neighbor_id)) continue;

      if (seenNodes.size >= maxNodes) {
        truncated = true;
        continue;
      }

      seenNodes.add(r.neighbor_id);
      nodes.push(toNode(r, level));

      // Only traversable nodes are worth expanding again; a private individual
      // is a dead end by construction.
      if (r.is_traversable) nextFrontier.push(r.neighbor_id);
    }

    yield { level, nodes, edges, truncated };
    frontier = nextFrontier;
  }
}

/** Convenience wrapper that materializes a whole crawl. */
export async function crawlAll(
  db: Db,
  params: CrawlParams,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let truncated = false;
  for await (const lvl of crawl(db, params)) {
    nodes.push(...lvl.nodes);
    edges.push(...lvl.edges);
    truncated ||= lvl.truncated;
  }
  return { nodes, edges, truncated };
}
