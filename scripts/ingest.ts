/**
 * Seed the graph from the Florida Division of Elections.
 *
 * Usage:
 *   pnpm ingest committee "Florida Chamber"      # money into matching committees
 *   pnpm ingest contributor "SECURE FLORIDA"     # money out of a contributor
 *   pnpm ingest candidate  "DeSantis"            # money into a candidate
 *   pnpm ingest registry                         # sweep the state committee registry
 *   pnpm ingest county stjohns                   # sweep a county (VoterFocus)
 *   pnpm ingest counties                         # list supported counties
 *   pnpm ingest expand 2                         # auto-expand frontier N rounds
 *
 * Options: --election=20241105-GEN --limit=2000 --min=1000
 */

import { db } from '@/db';
import { entities } from '@/db/schema';
import { sql, eq, and, desc } from 'drizzle-orm';
import { FlDoeAdapter } from '@/lib/ingest/fl-doe/adapter';
import { FlDoeClient, NAME_MATCH } from '@/lib/ingest/fl-doe/client';
import {
  ensureFloridaSource,
  ensureCountySource,
  ingestContributionRows,
  ingestTransactionRows,
  startRun,
  finishRun,
  rebuildAll,
} from '@/lib/ingest/pipeline';
import { VoterFocusAdapter } from '@/lib/ingest/voterfocus/adapter';
import { VoterFocusClient } from '@/lib/ingest/voterfocus/client';
import { VOTERFOCUS_COUNTIES, findCounty } from '@/lib/ingest/voterfocus/counties';
import { EntityResolver } from '@/lib/ingest/resolve';

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

const mode = positional[0] ?? 'help';
const term = positional[1] ?? '';
const election = flags.election ?? '20241105-GEN';
const rowLimit = Number(flags.limit ?? 2000);
const minAmount = flags.min ? Number(flags.min) : undefined;

function fmt(n: number | string) {
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

async function main() {
  const { sourceId, jurisdictionId } = await ensureFloridaSource(db);
  const client = new FlDoeClient();
  const fl = new FlDoeAdapter(client);
  const resolver = new EntityResolver(db);

  const fetchOpts = { election, rowLimit, minAmount, match: NAME_MATCH.containing };

  if (mode === 'help') {
    console.log(__filename.replace(/.*\//, ''), '— see header for usage');
    process.exit(0);
  }

  if (mode === 'registry') {
    console.log('Sweeping committee registry A–Z…');
    const committees = await fl.sweepCommitteeRegistry((p, found, total) =>
      console.log(`  ${p}: +${found} (${total} unique)`),
    );
    let created = 0;
    for (const c of committees) {
      const r = await resolver.resolve({
        rawName: c.name,
        role: 'recipient',
        committeeType: c.type,
        jurisdictionId,
        sourceId,
      });
      if (r.created) created++;
      await db
        .update(entities)
        .set({
          kind: 'committee',
          committeeType: c.type as never,
          status: c.status,
          isTraversable: true,
          // The registry spelling is authoritative and complete, so it wins over
          // a name first learned from a truncated transaction column
          // ("Florida Chamber of Commerce Alliance, In").
          name: c.name,
        })
        .where(eq(entities.id, r.entityId));
    }
    console.log(`\n${committees.length} committees in registry, ${created} new entities.`);
    process.exit(0);
  }

  if (mode === 'county') {
    await ingestCounty(term || 'stjohns', flags.election);
    process.exit(0);
  }

  if (mode === 'counties') {
    console.log('VoterFocus counties available:');
    for (const c of VOTERFOCUS_COUNTIES) console.log(`  ${c.slug.padEnd(16)} ${c.name}`);
    process.exit(0);
  }

  if (mode === 'rebuild') {
    console.log('Rebuilding all edge rollups and totals…');
    const counts = await rebuildAll(db);
    console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
    await summarize();
    process.exit(0);
  }

  if (mode === 'expand') {
    await expand(Number(term || 1), fl, resolver, { sourceId, jurisdictionId }, fetchOpts);
    process.exit(0);
  }

  if (!term) {
    console.error(`mode "${mode}" needs a search term`);
    process.exit(1);
  }

  const runId = await startRun(db, sourceId, { mode, term, election });
  console.log(`\nFetching ${mode} "${term}" (${election})…`);

  try {
    const rows =
      mode === 'committee'
        ? await fl.contributionsToCommittee(term, fetchOpts)
        : mode === 'candidate'
          ? await fl.contributionsToCandidate(term, '', fetchOpts)
          : await fl.contributionsFromContributor(term, fetchOpts);

    console.log(`  ${rows.length} rows parsed; resolving…`);
    const result = await ingestContributionRows(db, rows, {
      sourceId,
      jurisdictionId,
      resolver,
    });
    await finishRun(db, runId, result);

    console.log(
      `\n  inserted ${result.rowsInserted}, skipped ${result.rowsSkipped}, ` +
        `${result.entitiesCreated} new entities`,
    );
    console.log('  resolver:', JSON.stringify(result.resolverStats));
    await summarize();
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }
  process.exit(0);
}

/**
 * Grow the graph outward from what is already stored.
 *
 * Picks the traversable entities with the most money attached that have not yet
 * been fetched as a contributor, and pulls their outbound giving. This is how a
 * seeded node turns into a connected network without hand-listing every PAC.
 */
async function expand(
  rounds: number,
  fl: FlDoeAdapter,
  resolver: EntityResolver,
  ctx: { sourceId: string; jurisdictionId: string },
  fetchOpts: Parameters<FlDoeAdapter['contributionsFromContributor']>[1],
) {
  for (let round = 1; round <= rounds; round++) {
    const frontier = await db
      .select({ id: entities.id, name: entities.name, received: entities.totalReceived })
      .from(entities)
      .where(and(eq(entities.isTraversable, true), sql`${entities.outDegree} = 0`))
      .orderBy(desc(sql`${entities.totalReceived}::numeric`))
      .limit(Number(flags.frontier ?? 8));

    if (frontier.length === 0) {
      console.log('frontier empty — nothing left to expand');
      return;
    }

    console.log(`\n=== round ${round}: expanding ${frontier.length} nodes ===`);
    for (const node of frontier) {
      process.stdout.write(`  ${node.name.slice(0, 40).padEnd(42)} `);
      try {
        const rows = await fl.contributionsFromContributor(node.name, fetchOpts);
        const res = await ingestContributionRows(db, rows, { ...ctx, resolver });
        console.log(`${rows.length} rows -> +${res.rowsInserted} txns, +${res.entitiesCreated} nodes`);
      } catch (err) {
        console.log(`failed: ${String(err).slice(0, 60)}`);
        // Mark it attempted so the next round does not retry the same node.
        await db.update(entities).set({ outDegree: -1 }).where(eq(entities.id, node.id));
      }
    }
  }
  await summarize();
}

/**
 * Sweep one VoterFocus county: every candidate and committee in a cycle,
 * persisted as each export completes so a long sweep survives interruption.
 */
async function ingestCounty(slug: string, electionId?: string) {
  const county = findCounty(slug);
  if (!county) {
    console.error(`unknown county "${slug}". Run \`pnpm ingest counties\` for the list.`);
    process.exit(1);
  }

  const { sourceId, jurisdictionId } = await ensureCountySource(db, county);
  const adapter = new VoterFocusAdapter(county.slug, new VoterFocusClient());
  const resolver = new EntityResolver(db);
  const runId = await startRun(db, sourceId, { county: county.slug, election: electionId });

  console.log(`\nSweeping ${county.name} County${electionId ? ` (e=${electionId})` : ''}…`);

  let totalRows = 0;
  let totalInserted = 0;
  let totalCreated = 0;
  let withData = 0;

  try {
    for await (const { entity, rows } of adapter.sweep(electionId)) {
      if (rows.length === 0) continue;
      withData++;
      const res = await ingestTransactionRows(db, rows, { sourceId, jurisdictionId, resolver });
      totalRows += rows.length;
      totalInserted += res.rowsInserted;
      totalCreated += res.entitiesCreated;
      console.log(
        `  ${(entity.isCommittee ? '[C] ' : '    ') + entity.name.slice(0, 36).padEnd(38)}` +
          `${String(rows.length).padStart(4)} rows -> +${res.rowsInserted} txns, ` +
          `+${res.entitiesCreated} nodes${entity.office ? `  · ${entity.office.slice(0, 28)}` : ''}`,
      );
    }
    await finishRun(db, runId, { rowsFetched: totalRows, rowsInserted: totalInserted });
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }

  console.log(
    `\n  ${withData} filers with data, ${totalRows} rows, ` +
      `${totalInserted} new transactions, ${totalCreated} new entities`,
  );
  await summarize();
}

async function summarize() {
  const [counts] = await db.execute<{
    entities: number;
    committees: number;
    txns: number;
    edges: number;
    total: string;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM entities)::int                                  AS entities,
      (SELECT COUNT(*) FROM entities WHERE is_traversable)::int             AS committees,
      (SELECT COUNT(*) FROM transactions)::int                              AS txns,
      (SELECT COUNT(*) FROM edge_rollups)::int                              AS edges,
      (SELECT COALESCE(SUM(amount),0)::text FROM transactions)              AS total
  `);
  console.log(
    `\n  graph: ${counts.entities} entities (${counts.committees} traversable), ` +
      `${counts.txns} transactions, ${counts.edges} edges, ${fmt(counts.total)} tracked`,
  );

  const top = await db.execute<{ name: string; kind: string; received: string; out: number }>(sql`
    SELECT name, kind::text AS kind, total_received::text AS received, out_degree AS out
    FROM entities ORDER BY total_received DESC NULLS LAST LIMIT 8
  `);
  console.log('\n  top recipients:');
  for (const r of top) {
    console.log(
      `    ${fmt(r.received).padStart(13)}  ${r.name.slice(0, 44).padEnd(46)} ${r.kind}`,
    );
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
