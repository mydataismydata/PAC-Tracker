/**
 * Who runs a committee, and who else they run.
 *
 * A separate question from the money, kept in a separate place. The ledger and
 * the trace both answer "where did the dollars go"; this answers "whose desk is
 * this", which is the thing that makes a row of interchangeably-named PACs
 * legible as one operation.
 *
 * Nothing here produces a graph edge. That boundary is load-bearing: a shared
 * treasurer is not a payment, and an affiliation reaching `edge_rollups` would
 * have the funding trace attributing dollars along "these two committees use
 * the same accountant" — the same fabrication the injection-point rule exists
 * to prevent. Affiliations reach the canvas only as nodes the user asks for.
 *
 * ## Why every cluster carries its size
 *
 * The signal in a shared attribute is inversely proportional to how many share
 * it. In the live state list 65% of committees share a treasurer with someone,
 * which sounds like a finding and is not one: the largest single treasurer
 * holds 278 committees and is a compliance practice. A UI that draws "shares a
 * treasurer" without saying *with how many* asserts a relationship between
 * hundreds of unrelated committees.
 *
 * So `cluster` is never returned without `total`, and the caller is expected to
 * show it. `strength` grades the same fact for sorting and de-emphasis, but the
 * count is the honest form and must stay on screen.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';

type Db = PostgresJsDatabase<typeof schema>;

/** How many committees may be listed under one shared attribute. */
const MAX_PEERS = 40;

/**
 * Cluster size at which a shared attribute stops being evidence of anything.
 *
 * Chosen from the shape of the live data rather than taste: cluster sizes run
 * 56 at exactly two, 20 at three, 13 at four, then a thin tail to a single
 * cluster of 228. Somewhere past a couple of dozen the only thing a shared
 * treasurer tells you is that both committees hired the same firm.
 */
export const VENDOR_SCALE = 25;

export interface AffiliationPeer {
  id: string;
  name: string;
  kind: string;
  committeeType: string | null;
  totalReceived: string;
  totalGiven: string;
}

export interface AffiliationCluster {
  /** What is shared: a role, an address, a phone line. */
  basis: 'chair' | 'treasurer' | 'address' | 'phone';
  /** The shared value itself, so the claim is auditable on sight. */
  value: string;
  /** Human-facing label, e.g. "William S. Jones". */
  label: string;
  /**
   * How many committees share this value, including the selected one.
   *
   * The number that decides what the match is worth. Always displayed.
   */
  total: number;
  /**
   * 0..1, falling as the cluster grows. Ranking and emphasis only — it is a
   * restatement of `total`, never a substitute for showing it.
   */
  strength: number;
  /** True once the cluster is large enough to read as a service provider. */
  isVendorScale: boolean;
  /** Peers, largest first, capped at `MAX_PEERS`. */
  peers: AffiliationPeer[];
  /** Peers beyond the cap. */
  omitted: number;
}

export interface RegistrationDetail {
  externalId: string | null;
  committeeType: string | null;
  typeDescription: string | null;
  status: string | null;
  addressLines: string[];
  cityStateZip: string | null;
  countyName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  /** When we read this from the filing office. */
  observedAt: string | null;
}

export interface OfficerDetail {
  role: string;
  fullName: string;
  normalizedName: string;
}

export interface AffiliationResult {
  entity: { id: string; name: string };
  /** Null when the entity has no registration on file — county PACs, for now. */
  registration: RegistrationDetail | null;
  officers: OfficerDetail[];
  /** One per shared attribute, strongest first. */
  clusters: AffiliationCluster[];
  /**
   * True when we hold no registration at all, so the panel can say why rather
   * than looking broken. Only state-registered committees are loaded.
   */
  unregistered: boolean;
}

/** Falls from 1 toward 0 as a cluster grows; 2 shared is 1.0, 278 is ~0.12. */
function strengthFor(total: number): number {
  if (total <= 1) return 0;
  if (total === 2) return 1;
  return Math.max(0.05, Math.min(1, Math.log(2) / Math.log(total)));
}

export async function affiliations(db: Db, entityId: string): Promise<AffiliationResult | null> {
  const [entity] = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM entities WHERE id = ${entityId}
  `);
  if (!entity) return null;

  const [reg] = await db.execute<{
    external_id: string | null;
    committee_type: string | null;
    type_description: string | null;
    status: string | null;
    addr1: string | null;
    addr2: string | null;
    city: string | null;
    state_code: string | null;
    zip: string | null;
    county_name: string | null;
    normalized_address: string | null;
    phone: string | null;
    phone_digits: string | null;
    email: string | null;
    website: string | null;
    observed_at: string | null;
  }>(sql`
    SELECT external_id, committee_type, type_description, status,
           addr1, addr2, city, state_code, zip, county_name,
           normalized_address, phone, phone_digits, email, website,
           observed_at
      FROM committee_registrations
     WHERE entity_id = ${entityId} AND is_current
     LIMIT 1
  `);

  const officers = await db.execute<{
    role: string;
    full_name: string;
    normalized_name: string;
  }>(sql`
    SELECT role::text AS role, full_name, normalized_name
      FROM committee_officers
     WHERE entity_id = ${entityId} AND is_current
     ORDER BY CASE role::text WHEN 'chair' THEN 0 WHEN 'treasurer' THEN 1 ELSE 2 END
  `);

  const clusters: AffiliationCluster[] = [];

  // Officers: every committee naming the same person in the same role.
  for (const o of officers) {
    const peers = await db.execute<AffiliationPeerRow>(sql`
      SELECT e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
             e.total_received, e.total_given
        FROM committee_officers o
        JOIN entities e ON e.id = o.entity_id
       WHERE o.is_current
         AND o.role::text = ${o.role}
         AND o.normalized_name = ${o.normalized_name}
         AND o.entity_id <> ${entityId}
       ORDER BY e.total_received DESC NULLS LAST
       LIMIT ${MAX_PEERS + 1}
    `);
    const [{ n: total }] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM committee_officers
       WHERE is_current AND role::text = ${o.role} AND normalized_name = ${o.normalized_name}
    `);
    if (total > 1) {
      clusters.push(
        buildCluster(o.role === 'chair' ? 'chair' : 'treasurer', o.normalized_name, o.full_name, total, peers),
      );
    }
  }

  // Address and phone: shared premises rather than shared people. Weaker on
  // their own — an office building is not a network — which is exactly why the
  // count travels with them.
  if (reg?.normalized_address) {
    const cluster = await premisesCluster(
      db,
      entityId,
      'address',
      sql`normalized_address = ${reg.normalized_address}`,
      reg.normalized_address,
      [reg.addr1, reg.city].filter(Boolean).join(', ') || reg.normalized_address,
    );
    if (cluster) clusters.push(cluster);
  }
  if (reg?.phone_digits) {
    const cluster = await premisesCluster(
      db,
      entityId,
      'phone',
      sql`phone_digits = ${reg.phone_digits}`,
      reg.phone_digits,
      reg.phone ?? reg.phone_digits,
    );
    if (cluster) clusters.push(cluster);
  }

  clusters.sort((a, b) => b.strength - a.strength || a.total - b.total);

  return {
    entity: { id: entity.id, name: entity.name },
    registration: reg
      ? {
          externalId: reg.external_id,
          committeeType: reg.committee_type,
          typeDescription: reg.type_description,
          status: reg.status,
          addressLines: [reg.addr1, reg.addr2].filter((v): v is string => Boolean(v)),
          cityStateZip:
            [reg.city, [reg.state_code, reg.zip].filter(Boolean).join(' ')]
              .filter(Boolean)
              .join(', ') || null,
          countyName: reg.county_name,
          phone: reg.phone,
          email: reg.email,
          website: reg.website,
          observedAt: reg.observed_at,
        }
      : null,
    officers: officers.map((o) => ({
      role: o.role,
      fullName: o.full_name,
      normalizedName: o.normalized_name,
    })),
    clusters,
    unregistered: !reg && officers.length === 0,
  };
}

interface AffiliationPeerRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
  committee_type: string | null;
  total_received: string;
  total_given: string;
}

function buildCluster(
  basis: AffiliationCluster['basis'],
  value: string,
  label: string,
  total: number,
  peerRows: AffiliationPeerRow[],
): AffiliationCluster {
  const peers = peerRows.slice(0, MAX_PEERS).map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    committeeType: p.committee_type,
    totalReceived: p.total_received ?? '0',
    totalGiven: p.total_given ?? '0',
  }));
  return {
    basis,
    value,
    label,
    total,
    strength: strengthFor(total),
    isVendorScale: total >= VENDOR_SCALE,
    peers,
    omitted: Math.max(0, total - 1 - peers.length),
  };
}

async function premisesCluster(
  db: Db,
  entityId: string,
  basis: 'address' | 'phone',
  match: ReturnType<typeof sql>,
  value: string,
  label: string,
): Promise<AffiliationCluster | null> {
  const [{ n: total }] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM committee_registrations
     WHERE is_current AND ${match}
  `);
  if (total <= 1) return null;

  const peers = await db.execute<AffiliationPeerRow>(sql`
    SELECT e.id, e.name, e.kind::text AS kind, e.committee_type::text AS committee_type,
           e.total_received, e.total_given
      FROM committee_registrations r
      JOIN entities e ON e.id = r.entity_id
     WHERE r.is_current AND ${match} AND r.entity_id <> ${entityId}
     ORDER BY e.total_received DESC NULLS LAST
     LIMIT ${MAX_PEERS + 1}
  `);
  return buildCluster(basis, value, label, total, peers);
}
