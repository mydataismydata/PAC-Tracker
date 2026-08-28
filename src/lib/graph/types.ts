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
  /**
   * What this entity's money comes from — see `src/lib/ingest/industry.ts`.
   *
   * Already a display label rather than a code, and null wherever nothing
   * classified it. Carried on the node so the bar can name a seed's sector
   * without a second request.
   */
  industry: string | null;
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

/**
 * How a name in the panel connects back to what the reader was already on.
 *
 * Opening a name from the ledger or the origins report moves the whole panel
 * to a different entity, and on a graph this size that is easy to experience
 * as having lost your place. Handing the route over with the click lets the
 * canvas draw the connection instead of jumping to an unexplained tile.
 */
export interface FocusLink {
  /** The whole route: where the reader came from first, the target last. */
  chain?: string[];
  /** What to write on the hop into the target where it has to be drawn in. */
  label?: string;
  /**
   * Identity for an officer hub the graph is not currently drawing.
   *
   * A hub is a person rather than a row in `entities`, so there is nothing to
   * look up by id. Without this, opening a chair or treasurer while the graph
   * is following money does nothing at all.
   */
  officer?: { name: string; role: string };

  /**
   * Which way the money ran along the route, from the target's point of view.
   *
   * Only used to point the arrows the right way. A route is written outwards
   * from the reader, which for money coming in is the opposite of the way it
   * was paid.
   */
  flow?: 'in' | 'out';
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

/**
 * Switch link mode, retuning the per-node cap to suit it.
 *
 * The cap means different things in each mode. On money it trims a long tail
 * of small donors and 25 loses nothing that matters. On registration it is not
 * a tail at all — every hop is a co-registered committee, so 25 would silently
 * show a quarter of a network and look complete. A cap the reader has moved
 * off the default is left alone either way.
 *
 * Lives here rather than in the control panel because the bar over the canvas
 * offers the same switch, and two copies would drift.
 */
export function withLinkMode(settings: CrawlSettings, mode: LinkMode): CrawlSettings {
  const maxPerNode =
    mode === 'registration'
      ? settings.maxPerNode <= DEFAULT_SETTINGS.maxPerNode
        ? REGISTRATION_PER_NODE
        : settings.maxPerNode
      : settings.maxPerNode >= REGISTRATION_PER_NODE
        ? DEFAULT_SETTINGS.maxPerNode
        : settings.maxPerNode;
  return { ...settings, linkMode: mode, maxPerNode };
}

export interface EntitySearchHit {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  status: string;
  city: string | null;
  state_code: string | null;
  industry: string | null;
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
/**
 * Labels that restate what an entity is rather than what its money is from.
 *
 * Eight thousand of the nine thousand committees classify as "Political
 * committee", which is the kind line again in different words. Dropping those
 * leaves the classification saying something wherever it survives — a
 * committee reading "Labor union" or "Agriculture" is worth the line.
 */
const SELF_DESCRIBING = new Set(['political committee', 'candidate committee', 'political party']);

/**
 * What this entity's money is from, or null where the answer adds nothing.
 *
 * See `src/lib/ingest/industry.ts` for how the classification is made.
 */
export function industryLabel(
  node: Pick<GraphNode, 'kind' | 'committeeType' | 'industry'>,
): string | null {
  if (!node.industry) return null;
  const low = node.industry.toLowerCase();
  if (low === kindLabel(node).toLowerCase()) return null;
  if (SELF_DESCRIBING.has(low) && node.kind !== 'organization' && node.kind !== 'individual') {
    return null;
  }
  return node.industry;
}

/**
 * Tile fill by entity kind. Committees are the spine of the graph, so they lead.
 *
 * Shared with the panels, which put the same colour on a dot beside a name, so
 * that a tile and a row naming the same kind read as the same thing.
 */
export const KIND_COLORS: Record<string, string> = {
  committee: '#6366f1',
  candidate: '#10b981',
  organization: '#f59e0b',
  individual: '#64748b',
  party: '#f43f5e',
  /** Not an entity — a person named on filings. See crawl.ts officer hubs. */
  officer: '#7c3aed',
  unknown: '#475569',
};

/** The colour standing for an entity's kind, with a fallback for unknowns. */
export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? KIND_COLORS.unknown;
}

/** "1 committee", "12 committees". */

export function committeeCount(n: number): string {
  return `${n} committee${n === 1 ? '' : 's'}`;
}

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
