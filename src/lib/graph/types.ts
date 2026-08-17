import { CURRENT_CYCLE } from '@/lib/cycles';
/** Shared graph types between the crawler, the API and the UI. */

export type Direction = 'upstream' | 'downstream' | 'both';
export type LinkMode = 'direct' | 'donor' | 'registration';

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
  level: number;
}

/**
 * Officer hub nodes carry this id prefix instead of an entity uuid.
 *
 * They stand for a person named on filings, not a party to any money, and have
 * no row anywhere. Anything that would hit `/api/entities/:id` has to check
 * this first — the ledger, the trace and the affiliations routes all reject a
 * non-uuid with a 400.
 */
export const OFFICER_NODE_PREFIX = 'officer:';

export function isOfficerNode(id: string): boolean {
  return id.startsWith(OFFICER_NODE_PREFIX);
}

/**
 * API prefix for whichever kind of subject a node id names.
 *
 * Entities and officers answer the same questions — what came in, what went
 * out, where it originated — over different underlying sets, so the panel and
 * its hooks stay identical and only the base path changes.
 */
export function subjectApiBase(id: string): string {
  return isOfficerNode(id)
    ? `/api/officers/${encodeURIComponent(id.slice(OFFICER_NODE_PREFIX.length))}`
    : `/api/entities/${id}`;
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
  /** Money, or a shared officer. Never conflate the two — see crawl.ts. */
  kind: 'money' | 'registration';
  basis?: 'chair' | 'treasurer';
  sharedWith?: string;
}

/**
 * What the canvas should do with the viewport once the graph settles.
 *
 * A single monotonic token rather than separate fit/focus signals, because the
 * two compete: picking an entity from search both re-roots the crawl (which
 * wants to frame everything) and asks to be shown that entity (which wants to
 * zoom in). Whichever intent is newest wins, with no race.
 */
export type ViewIntent =
  | { kind: 'fit'; token: number }
  | { kind: 'focus'; nodeId: string; token: number };

export interface CrawlSettings {
  depth: number;
  direction: Direction;
  linkMode: LinkMode;
  minAmount?: number;
  dateFrom?: string;
  dateTo?: string;
  /**
   * Election cycle to restrict to, or undefined for all of them.
   *
   * Defaults to the current cycle: with several cycles loaded, "who funds this
   * candidate" almost always means this election, and an unfiltered graph
   * silently answers a different question by adding the last one in.
   */
  cycle?: string;
  maxPerNode: number;
  maxNodes: number;
}

/**
 * Per-node cap used by registration mode.
 *
 * High enough to hold the largest real co-registration cluster in the live
 * data: one Tallahassee treasurer is named on 103 committees, and a network
 * shown at a quarter of its size looks complete while being wrong.
 */
export const REGISTRATION_PER_NODE = 200;

export const DEFAULT_SETTINGS: CrawlSettings = {
  depth: 2,
  direction: 'both',
  linkMode: 'direct',
  minAmount: undefined,
  cycle: CURRENT_CYCLE.id,
  maxPerNode: 25,
  maxNodes: 600,
};

export interface EntitySearchHit {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  status: string;
  city: string | null;
  state_code: string | null;
  total_received: string;
  total_given: string;
  in_degree: number;
  out_degree: number;
  is_traversable: boolean;
  score: number;
}

/** Compact currency for tile labels: $1.2M, $450K, $900. */
export function formatMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n === 0) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export function formatMoneyFull(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/** Human label for an entity's type. */
export function kindLabel(node: Pick<GraphNode, 'kind' | 'committeeType'>): string {
  if (node.committeeType) {
    const names: Record<string, string> = {
      PAC: 'Political Committee',
      CCE: 'Committee of Continuous Existence',
      ECO: 'Electioneering Comm. Org.',
      ECI: 'Electioneering Comm. Individual',
      IXO: 'Independent Expenditure Org.',
      PAP: 'Affiliated Party Committee',
      PTY: 'Party Executive Committee',
    };
    return names[node.committeeType] ?? node.committeeType;
  }
  const kinds: Record<string, string> = {
    committee: 'Committee',
    candidate: 'Candidate',
    individual: 'Individual',
    organization: 'Organization',
    party: 'Party',
    unknown: 'Unknown',
  };
  return kinds[node.kind] ?? node.kind;
}
