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
 *
 *   registration — hops on shared officers instead of money: from a committee
 *            to every other committee naming the same chair or treasurer. This
 *            reaches committees with no payment between them at all, which is
 *            the point — one Tallahassee treasurer is named on 103 committees,
 *            and no transaction says so.
 *
 * Registration mode is the one place affiliations enter the graph, and it does
 * so under a mode the user explicitly picked. Its edges are marked
 * `kind: 'registration'`, carry no money, and are never written to
 * `edge_rollups`, so nothing downstream — the funding trace above all — can
 * mistake a shared accountant for a payment. Money edges *between* the
 * committees it reaches are drawn as well, because "who is in this network" and
 * "what moves inside it" are the two halves of the same question.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { OFFICER_NODE_PREFIX, isOfficerNode } from './types';

type Db = PostgresJsDatabase<typeof schema>;

export type Direction = 'upstream' | 'downstream' | 'both';
export type LinkMode = 'direct' | 'donor' | 'registration';

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
  /**
   * Money or paperwork.
   *
   * A `registration` edge means the two committees name the same officer. It is
   * not a payment and carries no amount, and callers that reason about dollars
   * must filter on this rather than assume every edge is money.
   */
  kind: 'money' | 'registration';
  /** Registration edges only: the role held in common. */
  basis?: 'chair' | 'treasurer';
  /** Registration edges only: who, for the label. */
  sharedWith?: string;
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

interface RegistrationRow extends Record<string, unknown> {
  from_id: string;
  neighbor_id: string;
  basis: 'chair' | 'treasurer';
  /** Normalized key — the thing that actually matched. */
  shared_key: string;
  /** As filed, for display. */
  shared_with: string;
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
 * One hop out along shared officers.
 *
 * Deliberately unfiltered by cycle or date: a registration is a fact about a
 * committee now, not about an election, and there is no per-cycle officer
 * history to filter on. The node totals still follow the cycle filter, so the
 * money on a tile agrees with the rest of the graph even though the link that
 * reached it does not.
 *
 * Ordered by the neighbour's receipts so that when `maxPerNode` bites — and on
 * a 103-committee treasurer it will — what survives is the part of the network
 * that actually moves money.
 */
async function fetchRegistrationNeighbors(
  db: Db,
  frontier: string[],
  opts: { cycle?: string; maxPerNode: number },
): Promise<RegistrationRow[]> {
  if (frontier.length === 0) return [];

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

  return db.execute<RegistrationRow>(sql`
    SELECT f.id AS from_id, hop.neighbor_id, hop.basis, hop.shared_key, hop.shared_with,
           e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.status::text AS status, e.office, e.party, e.city, e.state_code,
           ${totalsSelect}
           e.is_traversable
      FROM unnest(${sql.param(frontier)}::uuid[]) AS f(id)
      CROSS JOIN LATERAL (
        SELECT o2.entity_id AS neighbor_id,
               o1.role::text AS basis,
               o1.normalized_name AS shared_key,
               o1.full_name  AS shared_with,
               n.total_received AS rank_amount
          FROM committee_officers o1
          JOIN committee_officers o2
            ON o2.is_current
           AND o2.role = o1.role
           AND o2.normalized_name = o1.normalized_name
           AND o2.entity_id <> f.id
          JOIN entities n ON n.id = o2.entity_id
         WHERE o1.entity_id = f.id
           AND o1.is_current
           AND o1.role IN ('chair', 'treasurer')
         ORDER BY n.total_received DESC NULLS LAST
         LIMIT ${opts.maxPerNode}
      ) AS hop
      JOIN entities e ON e.id = hop.neighbor_id
      ${totalsJoin}
  `);
}

/**
 * Money moving between committees already on the canvas.
 *
 * Registration mode expands on paperwork, so without this the Jones network
 * would draw as a hundred tiles and no transactions — and "who is in this
 * network" is only half of what anyone is asking. Restricted to pairs already
 * drawn, so it annotates the network rather than growing it.
 */
async function fetchInternalMoneyEdges(
  db: Db,
  nodeIds: string[],
  opts: { cycle?: string; minAmount?: number },
): Promise<NeighborRow[]> {
  if (nodeIds.length < 2) return [];
  const cycle = opts.cycle ? sql`AND r.election_cycle = ${opts.cycle}` : sql``;
  const minAmount = opts.minAmount != null ? sql`AND r.total_amount >= ${opts.minAmount}` : sql``;

  return db.execute<NeighborRow>(sql`
    SELECT r.id AS edge_id, r.from_entity_id AS from_id, r.to_entity_id AS to_id,
           r.total_amount::text AS amount, r.txn_count,
           r.first_date::text AS first_date, r.last_date::text AS last_date,
           r.is_direct_link, r.to_entity_id AS neighbor_id,
           '' AS name, '' AS kind, NULL AS committee_type, '' AS status,
           NULL AS office, NULL AS party, NULL AS city, NULL AS state_code,
           '0' AS total_received, '0' AS total_given,
           0 AS in_degree, 0 AS out_degree, false AS is_traversable
      FROM edge_rollups r
     WHERE r.from_entity_id = ANY(${sql.param(nodeIds)}::uuid[])
       AND r.to_entity_id   = ANY(${sql.param(nodeIds)}::uuid[])
       AND r.from_entity_id <> r.to_entity_id
       ${cycle} ${minAmount}
  `);
}

function toRegistrationNode(r: RegistrationRow, level: number): GraphNode {
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

function officerNodeId(role: string, normalizedName: string): string {
  return `${OFFICER_NODE_PREFIX}${role}:${normalizedName}`;
}

/**
 * A person named on many committees, drawn as one node.
 *
 * Everyone sharing an officer shares them with everyone else, so pairwise edges
 * make a clique: the live Jones network is 107 committees and would be 10,308
 * lines, which renders as a solid disc and says nothing. A hub is the same fact
 * in n edges instead of n², and it is also the truer picture — the claim is
 * "one person is named on all of these", not "these five thousand pairs are
 * each related".
 */
function officerHubNode(role: string, normalizedName: string, fullName: string): GraphNode {
  return {
    id: officerNodeId(role, normalizedName),
    name: fullName,
    kind: 'officer',
    committeeType: null,
    status: 'active',
    office: role,
    party: null,
    city: null,
    stateCode: null,
    totalReceived: '0',
    totalGiven: '0',
    inDegree: 0,
    outDegree: 0,
    // Never expanded: the hub is a label for a relationship, not a party to it.
    isTraversable: false,
    level: 0,
  };
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

    if (linkMode === 'registration') {
      const regRows = await fetchRegistrationNeighbors(db, frontier, { cycle, maxPerNode });

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const nextFrontier: string[] = [];
      let truncated = false;

      // Both ends of every shared-officer pair attach to a hub for that person,
      // so the committee side stays a list of spokes rather than a clique.
      const spoke = (committeeId: string, r: RegistrationRow) => {
        const hubId = officerNodeId(r.basis, r.shared_key);
        if (!seenNodes.has(hubId)) {
          seenNodes.add(hubId);
          nodes.push(officerHubNode(r.basis, r.shared_key, r.shared_with));
        }
        const edgeId = `reg:${hubId}:${committeeId}`;
        if (seenEdges.has(edgeId)) return;
        seenEdges.add(edgeId);
        edges.push({
          id: edgeId,
          source: hubId,
          target: committeeId,
          amount: '0',
          txnCount: 0,
          firstDate: null,
          lastDate: null,
          isDirectLink: false,
          kind: 'registration',
          basis: r.basis,
          sharedWith: r.shared_with,
        });
      };

      for (const r of regRows) {
        spoke(r.from_id, r);

        if (!seenNodes.has(r.neighbor_id)) {
          if (seenNodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          seenNodes.add(r.neighbor_id);
          nodes.push(toRegistrationNode(r, level));
          nextFrontier.push(r.neighbor_id);
        }
        spoke(r.neighbor_id, r);
      }

      // Annotate the network with the money moving inside it. Runs over every
      // node drawn so far, so a payment between two committees found on
      // different levels still shows up.
      // Hub ids are not uuids and have no rollups; casting them would error.
      const realNodes = [...seenNodes].filter((id) => !isOfficerNode(id));
      for (const m of await fetchInternalMoneyEdges(db, realNodes, { cycle, minAmount })) {
        if (seenEdges.has(m.edge_id)) continue;
        seenEdges.add(m.edge_id);
        edges.push({
          id: m.edge_id,
          source: m.from_id,
          target: m.to_id,
          amount: m.amount,
          txnCount: m.txn_count,
          firstDate: m.first_date,
          lastDate: m.last_date,
          isDirectLink: m.is_direct_link,
          kind: 'money',
        });
      }

      yield { level, nodes, edges, truncated };
      frontier = nextFrontier;
      continue;
    }

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
          kind: 'money',
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
