/**
 * Trace money through PAC-to-PAC transfers back to its original sources.
 *
 * A committee's donor list is not its funding. When every donor is itself a
 * committee — which is the norm for the transfer layer — reading the list tells
 * you nothing except which other committees to read next. This walks the chain
 * to entities that actually originate money (corporations, individuals) and
 * attributes the seed's dollars back to them.
 *
 * Method: pro-rata flow attribution. Money in a committee's account is
 * fungible, so a dollar it passes on is composed of its own funding sources in
 * proportion to their share of its total inflow. A conduit that took $1M and
 * sent you $100k sent you 10% of each of its own donors.
 *
 * Mass is pushed backwards a level at a time and absorbed when it reaches
 * something that is not a conduit, or a conduit with no known upstream. Cycles
 * (A -> B -> A, which do occur) are handled by that absorption: mass decays on
 * every pass rather than looping forever.
 *
 * Usage:
 *   pnpm trace "First Coast Leadership"
 *   pnpm trace "First Coast Leadership" --depth=15 --min=250
 */

import { db } from '@/db';
import { sql } from 'drizzle-orm';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v = 'true'] = a.replace(/^--/, '').split('=');
      return [k, v];
    }),
);

const seedName = positional[0];
const maxDepth = Number(flags.depth ?? 12);
/** Stop chasing a strand once it is worth less than this. */
const minDollars = Number(flags.min ?? 100);

/** Committees and parties pass money through; everything else originates it. */
const CONDUIT_KINDS = new Set(['committee', 'party']);

interface Node extends Record<string, unknown> {
  id: string;
  name: string;
  kind: string;
}

const fmt = (n: number) =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function main() {
  if (!seedName) {
    console.error('usage: pnpm trace "<entity name>" [--depth=12] [--min=100]');
    process.exit(1);
  }

  const seed = await resolveSeed(seedName);
  const seedTotal = Number(seed.received);
  console.log(`\n${seed.name}  (${seed.kind})`);
  console.log(`received ${fmt(seedTotal)} from ${seed.in_degree} direct donors\n`);

  // entityId -> dollars still to be explained
  let pending = new Map<string, number>([[seed.id, seedTotal]]);
  const origins = new Map<string, number>();
  const dark = new Map<string, number>();
  /** Shares too small to keep chasing. Tracked so the total still reconciles. */
  let dispersed = 0;
  const depthReached = new Map<string, number>();
  let hops = 0;

  for (let depth = 1; depth <= maxDepth && pending.size > 0; depth++) {
    hops = depth;
    const ids = [...pending.keys()];
    const inbound = await inboundEdges(ids);
    const next = new Map<string, number>();

    for (const [nodeId, amount] of pending) {
      const edges = inbound.get(nodeId) ?? [];
      // Self-funding is not an upstream source; it would also loop forever.
      const external = edges.filter((e) => e.from_id !== nodeId);
      const known = external.reduce((s, e) => s + Number(e.amount), 0);

      if (known <= 0) {
        // Nothing upstream in the data: the trail ends here, honestly labelled.
        bump(dark, nodeId, amount);
        continue;
      }

      for (const e of external) {
        const share = (Number(e.amount) / known) * amount;
        if (share < minDollars) {
          dispersed += share;
          continue;
        }
        if (CONDUIT_KINDS.has(e.from_kind)) {
          bump(next, e.from_id, share);
          depthReached.set(e.from_id, depth);
        } else {
          bump(origins, e.from_id, share);
          depthReached.set(e.from_id, depth);
        }
      }
    }
    pending = next;
  }

  // Anything still moving when we ran out of depth is unexplained, not resolved.
  for (const [id, amt] of pending) bump(dark, id, amt);

  const names = await namesFor([...origins.keys(), ...dark.keys()]);
  const originTotal = [...origins.values()].reduce((a, b) => a + b, 0);
  const darkTotal = [...dark.values()].reduce((a, b) => a + b, 0);

  console.log(`ORIGINAL SOURCES — traced through ${hops} hops\n`);
  const ranked = [...origins.entries()].sort((a, b) => b[1] - a[1]);
  for (const [id, amt] of ranked) {
    const n = names.get(id);
    console.log(
      `  ${fmt(amt).padStart(11)}  ${((amt / seedTotal) * 100).toFixed(1).padStart(5)}%  ` +
        `${(n?.name ?? id).slice(0, 46).padEnd(48)} ${n?.kind ?? ''}  (hop ${depthReached.get(id)})`,
    );
  }

  if (darkTotal > 0) {
    console.log(`\nUNRESOLVED — no upstream in the data, or past --depth\n`);
    for (const [id, amt] of [...dark.entries()].sort((a, b) => b[1] - a[1])) {
      const n = names.get(id);
      console.log(
        `  ${fmt(amt).padStart(11)}  ${((amt / seedTotal) * 100).toFixed(1).padStart(5)}%  ` +
          `${(n?.name ?? id).slice(0, 46).padEnd(48)} ${n?.kind ?? ''}`,
      );
    }
  }

  const pct = (n: number) => `${((n / seedTotal) * 100).toFixed(1)}%`;
  console.log(
    `\n  attributed ${fmt(originTotal)} (${pct(originTotal)}) · ` +
      `unresolved ${fmt(darkTotal)} (${pct(darkTotal)}) · ` +
      `dispersed below --min ${fmt(dispersed)} (${pct(dispersed)}) · ` +
      `of ${fmt(seedTotal)}`,
  );
  console.log(
    '\n  Attribution is pro-rata, not a claim that a specific dollar took a\n' +
      '  specific path. It also ignores transfer dates, so it can credit money a\n' +
      '  conduit received after it paid out.\n',
  );
  process.exit(0);
}

async function resolveSeed(name: string) {
  const rows = await db.execute<{
    id: string;
    name: string;
    kind: string;
    received: string;
    in_degree: number;
  }>(sql`
    SELECT id, name, kind::text AS kind, total_received::text AS received, in_degree
    FROM entities
    WHERE name ILIKE ${name} OR normalized_name LIKE ${'%' + name.toUpperCase() + '%'}
    ORDER BY total_received DESC NULLS LAST
    LIMIT 5
  `);
  if (rows.length === 0) {
    console.error(`no entity matching "${name}"`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.log(`(${rows.length} matches; using the largest)`);
  }
  return rows[0];
}

interface InboundEdge extends Record<string, unknown> {
  to_id: string;
  from_id: string;
  from_kind: string;
  amount: string;
}

/** All inbound edges for a whole frontier in one indexed read. */
async function inboundEdges(ids: string[]): Promise<Map<string, InboundEdge[]>> {
  const rows = await db.execute<InboundEdge>(sql`
    SELECT e.to_entity_id AS to_id,
           e.from_entity_id AS from_id,
           d.kind::text AS from_kind,
           e.total_amount::text AS amount
    FROM edge_rollups e
    JOIN entities d ON d.id = e.from_entity_id
    WHERE e.to_entity_id = ANY(${sql.param(ids)}::uuid[])
  `);
  const out = new Map<string, InboundEdge[]>();
  for (const r of rows) {
    const list = out.get(r.to_id);
    if (list) list.push(r);
    else out.set(r.to_id, [r]);
  }
  return out;
}

async function namesFor(ids: string[]): Promise<Map<string, Node>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<Node>(sql`
    SELECT id, name, kind::text AS kind
    FROM entities WHERE id = ANY(${sql.param(ids)}::uuid[])
  `);
  return new Map(rows.map((r) => [r.id, r]));
}

function bump(m: Map<string, number>, k: string, v: number) {
  m.set(k, (m.get(k) ?? 0) + v);
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
