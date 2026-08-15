/**
 * Seed the graph from the Florida Division of Elections.
 *
 * Usage:
 *   pnpm ingest committee "Florida Chamber"      # money into matching committees
 *   pnpm ingest contributor "SECURE FLORIDA"     # money out of a contributor
 *   pnpm ingest candidate  "DeSantis"            # money into a candidate
 *   pnpm ingest spending "St. Johns Neighborhood Coalition"  # money OUT (expenditures)
 *     --candidate                                  (look the name up as a candidate)
 *   pnpm ingest spending-cycle 20241105-GEN      # sweep a cycle's expenditures
 *     --from / --to / --scope=committee|candidate  (resume an interrupted sweep)
 *   pnpm ingest cycle 20261103-GEN               # sweep a whole state election cycle
 *     --from / --to / --scope=committee|candidate  (resume an interrupted sweep)
 *   pnpm ingest registry                         # sweep the state committee registry
 *   pnpm ingest county stjohns                   # sweep a county (current cycle)
 *   pnpm ingest county stjohns --all             # every cycle the portal offers
 *   pnpm ingest counties                         # list supported counties
 *   pnpm ingest irs rslc                         # a national 527's funders (IRS 8872)
 *   pnpm ingest purge voterfocus-duval           # drop one source, to re-ingest cleanly
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
  ensureIrsSource,
  ingestContributionRows,
  ingestTransactionRows,
  startRun,
  finishRun,
  rebuildAll,
  purgeSource,
} from '@/lib/ingest/pipeline';
import { Irs8872Adapter, TRACKED_ORGS, findOrg } from '@/lib/ingest/irs-8872/adapter';
import { IrsPodClient } from '@/lib/ingest/irs-8872/client';
import { VoterFocusAdapter } from '@/lib/ingest/voterfocus/adapter';
import { VoterFocusClient } from '@/lib/ingest/voterfocus/client';
import { VOTERFOCUS_COUNTIES, findCounty } from '@/lib/ingest/voterfocus/counties';
import { cycleForYear } from '@/lib/cycles';
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

  if (mode === 'spending-cycle') {
    await ingestSpendingCycle(term || election, fl, { sourceId, jurisdictionId }, resolver);
    process.exit(0);
  }

  if (mode === 'spending') {
    if (!term) {
      console.error('usage: pnpm ingest spending "<committee or candidate name>" [--candidate]');
      process.exit(1);
    }
    await ingestSpending(term, fl, { sourceId, jurisdictionId }, resolver);
    process.exit(0);
  }

  if (mode === 'county') {
    // Flags are `--key=value`; a space-separated `--election 33` parses as the
    // boolean true and would otherwise sweep the default cycle without a word,
    // which looks exactly like success.
    if (flags.election === 'true') {
      console.error('use --election=<id> (with the equals sign), e.g. --election=33');
      process.exit(1);
    }
    if (flags.all === 'true') await ingestCountyHistory(term || 'stjohns');
    else await ingestCounty(term || 'stjohns', flags.election);
    process.exit(0);
  }

  if (mode === 'cycle') {
    await ingestCycle(term || election, fl, { sourceId, jurisdictionId }, resolver);
    process.exit(0);
  }

  if (mode === 'irs') {
    await ingestIrsOrg(term || 'rslc');
    process.exit(0);
  }

  if (mode === 'counties') {
    console.log('VoterFocus counties available:');
    for (const c of VOTERFOCUS_COUNTIES) console.log(`  ${c.slug.padEnd(16)} ${c.name}`);
    process.exit(0);
  }

  if (mode === 'purge') {
    if (!term) {
      console.error('purge needs a source key, e.g. voterfocus-duval');
      process.exit(1);
    }
    const res = await purgeSource(db, term);
    console.log(`Purged ${term}: ${res.transactions} transactions, ${res.entities} orphaned entities.`);
    const counts = await rebuildAll(db);
    console.log(`  rebuilt ${counts.edges} edges over ${counts.entities} entities`);
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
 * Sweep an entire state election cycle — every committee and every candidate.
 *
 * This is the broad alternative to seeding on a name and expanding outward: it
 * covers the whole cycle rather than one neighbourhood of it, and it costs tens
 * of requests rather than thousands, because the CGI accepts a blank name.
 *
 * Each window is persisted as it arrives, so an interrupted sweep keeps what it
 * already fetched and can be re-run without duplicating rows.
 */
async function ingestCycle(
  electionId: string,
  fl: FlDoeAdapter,
  ctx: { sourceId: string; jurisdictionId: string },
  resolver: EntityResolver,
) {
  // Florida files a whole cycle under its general-election id, so the window
  // has to reach back past the previous general to catch early money.
  const from = flags.from ?? '2024-11-01';
  const to = flags.to ?? new Date().toISOString().slice(0, 10);

  const runId = await startRun(db, ctx.sourceId, { mode: 'cycle', election: electionId, from, to });
  console.log(`\nSweeping ${electionId} from ${from} to ${to}…`);

  let totalRows = 0;
  let totalInserted = 0;
  let totalCreated = 0;
  const truncated: string[] = [];
  const failed: string[] = [];

  // Scoping to one universe makes a long sweep resumable: the two are
  // independent walks, so an interrupted run resumes without redoing the other.
  const scopes = (
    flags.scope ? [flags.scope as 'committee' | 'candidate'] : ['committee', 'candidate']
  ) as Array<'committee' | 'candidate'>;

  try {
    for (const scope of scopes) {
      console.log(`\n=== ${scope}s ===`);
      const sweep = fl.sweepCycle(scope, {
        election: electionId,
        from,
        to,
        minAmount,
        onWindow: (w) => {
          if (w.action === 'truncated') {
            const detail = w.error ? ` (${w.error})` : '';
            truncated.push(`${scope} ${w.from}${detail}`);
            console.log(`  ${w.from}  ${w.rows} rows — TRUNCATED${detail}`);
          } else if (w.action === 'failed') {
            failed.push(`${scope} ${w.from}..${w.to}: ${w.error?.slice(0, 80)}`);
            console.log(`  ${w.from}..${w.to}  FAILED`);
          }
        },
      });

      for await (const win of sweep) {
        const res = await ingestContributionRows(db, win.rows, { ...ctx, resolver });
        totalRows += win.rows.length;
        totalInserted += res.rowsInserted;
        totalCreated += res.entitiesCreated;
        console.log(
          `  ${win.from}..${win.to}  ${String(win.rows.length).padStart(6)} rows -> ` +
            `+${res.rowsInserted} txns, +${res.entitiesCreated} nodes`,
        );
      }
    }
    await finishRun(db, runId, { rowsFetched: totalRows, rowsInserted: totalInserted });
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }

  console.log(
    `\n  ${totalRows} rows fetched, ${totalInserted} new transactions, ${totalCreated} new entities`,
  );
  // Coverage gaps are worth more than a clean-looking summary — a silently
  // truncated window looks identical to a complete one downstream.
  if (truncated.length > 0) console.log(`  INCOMPLETE windows: ${truncated.join(', ')}`);
  if (failed.length > 0) console.log(`  FAILED windows: ${failed.join('; ')}`);

  console.log('\nRebuilding rollups…');
  const counts = await rebuildAll(db);
  console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
  await summarize();
}

/**
 * Load a national 527's funders from IRS Form 8872.
 *
 * The organization is marked an injection point, so traces stop at it and
 * report it by name instead of dissolving national pooled money into Florida
 * pro-rata attribution.
 */
async function ingestIrsOrg(slug: string) {
  const org = findOrg(slug);
  if (!org) {
    console.error(
      `unknown org "${slug}". Known: ${TRACKED_ORGS.map((o) => o.slug).join(', ')}`,
    );
    process.exit(1);
  }

  const { sourceId, jurisdictionId } = await ensureIrsSource(db, org);
  const adapter = new Irs8872Adapter(new IrsPodClient());
  const resolver = new EntityResolver(db);
  const minAmount = flags.min ? Number(flags.min) : 10000;
  const from = flags.from ?? '2025-01-01';
  const to = flags.to;

  const runId = await startRun(db, sourceId, { org: org.slug, ein: org.ein, from, to, minAmount });
  console.log(`\n${org.name} (EIN ${org.ein})`);
  console.log(`filings ending ${from}${to ? ` to ${to}` : ' onward'}, contributions >= ${fmt(minAmount)}\n`);

  let totalRows = 0;
  let totalInserted = 0;
  let totalCreated = 0;
  let filings = 0;

  try {
    for await (const { link, filing } of adapter.sweepOrganization(org.ein, {
      from,
      to,
      minAmount,
      onProgress: (m) => console.log(`  ${m}`),
    })) {
      filings++;
      const rows = filing.contributions.map((c) => ({
        recipientRaw: filing.orgName ?? org.name,
        recipientName: filing.orgName ?? org.name,
        recipientTypeTag: null,
        recipientTruncated: false,
        // Placeholders are collapsed onto one clearly-labelled node per org.
        // The money is real and worth showing — RSLC left an entire half-year
        // unitemized — but it is not a donor, and per-period names would
        // scatter it across the graph as several phantom mega-donors.
        // Keyed on the EIN, not the org name: a label containing the org's own
        // name resolves straight back onto it and books the whole unitemized
        // total as a self-loop, which then shows up as its largest funder.
        contributorRaw: c.isAggregate
          ? `Unitemized contributions (EIN ${org.ein})`
          : c.contributorName,
        amount: c.amount,
        date: c.date,
        typeCode: null,
        address: c.address,
        city: c.city,
        state: c.state,
        zip: c.zip,
        occupation: c.occupation ?? c.employer,
        inkindDescription: null,
        // Namespaced so these never collide with a Florida election cycle.
        electionCycle: `8872-${filing.periodEnd ?? link.periodEnd ?? 'unknown'}`,
        rowHash: c.rowHash,
      }));

      const res = await ingestContributionRows(db, rows, { sourceId, jurisdictionId, resolver });
      totalRows += rows.length;
      totalInserted += res.rowsInserted;
      totalCreated += res.entitiesCreated;
      const sum = rows.reduce((a, r) => a + Number(r.amount), 0);
      const agg = filing.contributions.filter((c) => c.isAggregate);
      const aggSum = agg.reduce((a, c) => a + Number(c.amount), 0);
      console.log(
        `  ${filing.periodBegin ?? '?'}..${filing.periodEnd ?? '?'}  ` +
          `${String(rows.length).padStart(4)} rows ${fmt(sum).padStart(12)} -> ` +
          `+${res.rowsInserted} txns, +${res.entitiesCreated} nodes` +
          `${filing.skipped ? `  (${filing.skipped} unparsed)` : ''}` +
          `${agg.length ? `  [${fmt(aggSum)} unitemized]` : ''}`,
      );
    }
    await finishRun(db, runId, { rowsFetched: totalRows, rowsInserted: totalInserted });
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }

  // Mark every name variant, so a trace stops here however the name resolved.
  const marked = await db.execute<{ id: string; name: string }>(sql`
    UPDATE entities SET is_injection_point = true, is_traversable = true
    WHERE id IN (
      SELECT DISTINCT t.to_entity_id FROM transactions t
      WHERE t.source_id = ${sourceId} AND t.to_entity_id IS NOT NULL
    )
    RETURNING id, name
  `);
  for (const m of marked) console.log(`\n  marked injection point: ${m.name}`);

  console.log(
    `\n  ${filings} filings, ${totalRows} rows, ${totalInserted} new transactions, ` +
      `${totalCreated} new entities`,
  );
  console.log('\nRebuilding rollups…');
  const counts = await rebuildAll(db);
  console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
}

/**
 * Sweep a whole cycle's expenditures.
 *
 * Mirrors `ingestCycle`, and shares its resumability: the committee and
 * candidate universes are independent walks, so `--scope` restarts one without
 * redoing the other.
 */
async function ingestSpendingCycle(
  electionId: string,
  fl: FlDoeAdapter,
  ctx: { sourceId: string; jurisdictionId: string },
  resolver: EntityResolver,
) {
  const from = flags.from ?? '2022-11-09';
  const to = flags.to ?? new Date().toISOString().slice(0, 10);

  const runId = await startRun(db, ctx.sourceId, {
    mode: 'spending-cycle',
    election: electionId,
    from,
    to,
  });
  console.log(`\nSweeping ${electionId} EXPENDITURES from ${from} to ${to}…`);

  let totalRows = 0;
  let totalInserted = 0;
  let totalMirrored = 0;
  let totalCreated = 0;
  const truncated: string[] = [];
  const failed: string[] = [];

  const scopes = (
    flags.scope ? [flags.scope as 'committee' | 'candidate'] : ['committee', 'candidate']
  ) as Array<'committee' | 'candidate'>;

  try {
    for (const scope of scopes) {
      console.log(`\n=== ${scope}s ===`);
      const sweep = fl.sweepExpenditureCycle(scope, {
        election: electionId,
        from,
        to,
        minAmount,
        onWindow: (w) => {
          if (w.action === 'truncated') {
            const detail = w.error ? ` (${w.error})` : '';
            truncated.push(`${scope} ${w.from}${detail}`);
            console.log(`  ${w.from}  ${w.rows} rows — TRUNCATED${detail}`);
          } else if (w.action === 'failed') {
            failed.push(`${scope} ${w.from}..${w.to}: ${w.error?.slice(0, 80)}`);
            console.log(`  ${w.from}..${w.to}  FAILED`);
          }
        },
      });

      for await (const win of sweep) {
        const res = await ingestTransactionRows(db, win.rows, { ...ctx, resolver });
        totalRows += win.rows.length;
        totalInserted += res.rowsInserted;
        totalMirrored += res.rowsMirrored;
        totalCreated += res.entitiesCreated;
        console.log(
          `  ${win.from}..${win.to}  ${String(win.rows.length).padStart(6)} rows -> ` +
            `+${res.rowsInserted} txns, +${res.entitiesCreated} nodes` +
            `${res.rowsMirrored ? `, ${res.rowsMirrored} mirrored` : ''}`,
        );
      }
    }
    await finishRun(db, runId, { rowsFetched: totalRows, rowsInserted: totalInserted });
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }

  console.log(
    `\n  ${totalRows} rows fetched, ${totalInserted} new transactions, ` +
      `${totalCreated} new entities` +
      `${totalMirrored ? `, ${totalMirrored} dropped as already filed by the recipient` : ''}`,
  );
  if (truncated.length > 0) console.log(`  INCOMPLETE windows: ${truncated.join(', ')}`);
  if (failed.length > 0) console.log(`  FAILED windows: ${failed.join('; ')}`);

  console.log('\nRebuilding rollups…');
  const counts = await rebuildAll(db);
  console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
  await summarize();
}

/**
 * Load one filer's reported spending from the state feed.
 *
 * Separate from the contribution modes because it answers a question they
 * cannot: a transfer between committees is reported by whoever received it, so
 * the contribution feed sees it, but a payment to a vendor or consultant exists
 * only on the payer's own report. Without this a committee looks like it raises
 * money and never spends any.
 */
async function ingestSpending(
  name: string,
  fl: FlDoeAdapter,
  ctx: { sourceId: string; jurisdictionId: string },
  resolver: EntityResolver,
) {
  const asCandidate = flags.candidate === 'true';
  const runId = await startRun(db, ctx.sourceId, {
    mode: 'spending',
    name,
    election,
    kind: asCandidate ? 'candidate' : 'committee',
  });

  console.log(`\nSpending by ${asCandidate ? 'candidate' : 'committee'} "${name}" [${election}]…`);

  const opts = { election, rowLimit, minAmount, match: NAME_MATCH.containing };

  try {
    const rows = asCandidate
      ? await fl.expendituresByCandidate(name, '', opts)
      : await fl.expendituresByCommittee(name, opts);

    if (rows.length === 0) {
      console.log('  no expenditures reported for that name in this cycle.');
      await finishRun(db, runId, { rowsFetched: 0, rowsInserted: 0 });
      return;
    }

    const res = await ingestTransactionRows(db, rows, { ...ctx, resolver });
    await finishRun(db, runId, { rowsFetched: rows.length, rowsInserted: res.rowsInserted });

    console.log(
      `  ${rows.length} rows -> +${res.rowsInserted} txns, +${res.entitiesCreated} nodes` +
        `${res.rowsRepaired ? `, ${res.rowsRepaired} back-labelled` : ''}`,
    );

    // Largest payees first: for a committee that exists to move money, this is
    // the whole story, and it is the part the contribution feed never shows.
    const byPayee = new Map<string, { total: number; n: number }>();
    for (const r of rows) {
      const cur = byPayee.get(r.counterpartyRaw) ?? { total: 0, n: 0 };
      cur.total += Number(r.amount);
      cur.n++;
      byPayee.set(r.counterpartyRaw, cur);
    }
    console.log('\n  top payees:');
    for (const [payee, v] of [...byPayee].sort((a, b) => b[1].total - a[1].total).slice(0, 10)) {
      console.log(`    ${fmt(v.total).padStart(14)}  ${payee}  (${v.n})`);
    }
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }

  console.log('\nRebuilding rollups…');
  const counts = await rebuildAll(db);
  console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
}

/**
 * Every cycle a county portal offers, oldest first.
 *
 * Sweeps run per cycle because that is how the portal is addressed, and doing
 * them oldest-first means entity resolution meets each recurring donor at its
 * earliest spelling rather than back-filling later.
 */
async function ingestCountyHistory(slug: string) {
  const county = findCounty(slug);
  if (!county) {
    console.error(`unknown county "${slug}". Run \`pnpm ingest counties\` for the list.`);
    process.exit(1);
  }

  const adapter = new VoterFocusAdapter(county.slug, new VoterFocusClient());
  const offered = await adapter.elections();
  const wanted = offered
    .filter((e) => e.year != null)
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));

  console.log(`\n${county.name} County — ${wanted.length} cycles offered`);
  for (const e of wanted) console.log(`  ${e.year}  ${e.label}`);

  for (const e of wanted) {
    console.log(`\n${'='.repeat(60)}`);
    try {
      await ingestCounty(slug, String(e.id));
    } catch (err) {
      // One bad cycle should not cost the other eighteen.
      console.log(`  cycle ${e.year} FAILED: ${String(err).slice(0, 120)}`);
    }
  }

  console.log('\nRebuilding rollups…');
  const counts = await rebuildAll(db);
  console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
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

  // A sweep is scoped to one election, so its cycle is known rather than
  // inferred. That matters at the boundaries: a closing cycle's final reports
  // are filed *after* its election and would otherwise be booked to the next.
  const offered = await adapter.elections();
  const chosen = electionId ? offered.find((e) => String(e.id) === String(electionId)) : undefined;
  const cycle = chosen?.year ? cycleForYear(chosen.year)?.id : undefined;

  const runId = await startRun(db, sourceId, {
    county: county.slug,
    election: electionId,
    cycle,
  });

  console.log(
    `\nSweeping ${county.name} County` +
      `${chosen ? ` — ${chosen.label}` : electionId ? ` (e=${electionId})` : ''}` +
      `${cycle ? ` [${cycle}]` : ''}…`,
  );

  let totalRows = 0;
  let totalInserted = 0;
  let totalRepaired = 0;
  let totalCreated = 0;
  let withData = 0;

  try {
    for await (const { entity, rows } of adapter.sweep(electionId)) {
      if (rows.length === 0) continue;
      withData++;
      const res = await ingestTransactionRows(
        db,
        cycle ? rows.map((r) => ({ ...r, electionCycle: cycle })) : rows,
        { sourceId, jurisdictionId, jurisdictionCode: county.code, resolver },
      );
      totalRows += rows.length;
      totalInserted += res.rowsInserted;
      totalRepaired += res.rowsRepaired;
      totalCreated += res.entitiesCreated;
      console.log(
        `  ${(entity.isCommittee ? '[C] ' : '    ') + entity.name.slice(0, 36).padEnd(38)}` +
          `${String(rows.length).padStart(4)} rows -> +${res.rowsInserted} txns, ` +
          `+${res.entitiesCreated} nodes` +
          `${res.rowsRepaired ? `, ${res.rowsRepaired} cycled` : ''}` +
          `${entity.office ? `  · ${entity.office.slice(0, 28)}` : ''}`,
      );
    }
    await finishRun(db, runId, { rowsFetched: totalRows, rowsInserted: totalInserted });
  } catch (err) {
    await finishRun(db, runId, { error: String(err) });
    throw err;
  }

  console.log(
    `\n  ${withData} filers with data, ${totalRows} rows, ` +
      `${totalInserted} new transactions, ${totalCreated} new entities` +
      `${totalRepaired ? `, ${totalRepaired} back-labelled with their cycle` : ''}`,
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
