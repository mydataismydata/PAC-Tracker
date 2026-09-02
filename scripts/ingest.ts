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
 *   pnpm ingest committees                       # registrations + chairs/treasurers
 *   pnpm ingest county stjohns                   # sweep a county (current cycle)
 *   pnpm ingest county stjohns --all             # every cycle the portal offers
 *   pnpm ingest counties                         # list supported counties
 *   pnpm ingest irs rslc                         # a national 527's funders (IRS 8872)
 *   pnpm ingest purge voterfocus-duval           # drop one source, to re-ingest cleanly
 *   pnpm ingest expand 2                         # auto-expand frontier N rounds
 *   pnpm ingest backfill-industry                # classify entities left over from before this existed
 *   pnpm ingest backfill-industry --force         # reclassify every entity (taxonomy changed)
 *   pnpm ingest backfill-committee-kind           # fix PACs stuck as "organization" from before classifyContributor knew better
 *   pnpm ingest backfill-contributor-kind         # dry run: re-kind organization/individual contributors, write .working/kind-review.csv
 *     --apply --review=<path> --names=<path> --min-review=10000
 *                                                 (write it; review file; name-change file; review floor in dollars)
 *   pnpm ingest backfill-quotes                   # count stored names carrying the export's backslash ("Bono\'s")
 *   pnpm ingest backfill-quotes --apply           # strip it from entity names, aliases, and raw transaction names
 *   pnpm ingest backfill-candidate-accounts       # dry run: committee money paid to a candidate's look-alike node, onto the candidate
 *     --apply --review=.working/candidate-accounts-review.csv --moves=.working/candidate-accounts-moves.csv
 *   pnpm ingest collapse-mirrors                  # dry run of the mirror rule: committee-to-committee transfers filed by both sides
 *     --recipient-lag=60 --payer-lag=14 --scope=keepers --apply
 *                                                 (days the recipient may trail the payer; the reverse; only merge survivors; delete)
 *   pnpm ingest verify                            # confirm no merged-away entity is still present or referenced
 *                                                 (rebuild runs this at the end; on the VPS run it after loading a delta)
 *
 * Repairing resolution, once a human has confirmed what is what:
 *   pnpm ingest merge <keepId> <loserId> [...]   # fold duplicates into one entity
 *   pnpm ingest split <entityId> --city="GOLDEN BEACH" --name="Sean Carpenter"
 *       [--kind=individual] [--occupation="REAL ESTATE AGENT"] [--apply]
 *                                                 # two people sharing a name, pulled apart
 *   pnpm ingest set-kind <entityId> individual   # correct a misclassified entity
 * Both rewrite attribution, so follow them with `pnpm ingest rebuild`.
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
  ingestCommitteeRegistrations,
  startRun,
  finishRun,
  rebuildAll,
  verifyReferentialIntegrity,
  purgeSource,
  backfillIndustry,
  backfillCommitteeKind,
  backfillContributorKind,
  backfillQuotes,
  backfillCandidateAccounts,
  collapseMirrors,
  MIRROR_WINDOW,
  mergeEntities,
  splitEntity,
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

  if (mode === 'committees') {
    console.log('Downloading the committee list…');
    const listed = await fl.committeeList();
    console.log(`${listed.length} active committees. Resolving and recording…`);
    const r = await ingestCommitteeRegistrations(
      db,
      listed,
      { sourceId, jurisdictionId },
      resolver,
      (done, total) => {
        if (done % 200 === 0 || done === total) console.log(`  ${done}/${total}`);
      },
    );
    console.log(
      `\n${r.registrations} registrations, ${r.officers} officer roles, ` +
        `${r.entitiesCreated} new entities, ${r.officersSuperseded} superseded.`,
    );
    if (r.collisions.length > 0) {
      console.log(
        `\n${r.collisions.length} committees kept apart by account number that name ` +
          `matching would have merged. Their registrations are now separate, but the ` +
          `transactions filed under these names are probably still on one node:`,
      );
      for (const c of r.collisions) {
        console.log(`  ${c.acctNum}  ${c.name}  (would have joined acct ${c.mergedInto})`);
      }
    }
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

  if (mode === 'verify') {
    process.exit((await runVerify()) ? 0 : 1);
  }

  if (mode === 'rebuild') {
    console.log('Rebuilding all edge rollups and totals…');
    const counts = await rebuildAll(db);
    console.log(`  ${counts.edges} edges over ${counts.entities} entities`);
    await summarize();
    // Every rebuild ends by confirming no merged-away reference survived — the
    // check runs on the deployment box too, right after it loads a delta.
    const clean = await runVerify();
    process.exit(clean ? 0 : 1);
  }

  if (mode === 'backfill-industry') {
    const force = flags.force === 'true';
    console.log(force ? 'Reclassifying every entity…' : 'Classifying entities with no industry yet…');
    const result = await backfillIndustry(db, { force }, (scanned) => {
      if (scanned % 50_000 === 0) console.log(`  ${scanned} scanned…`);
    });
    console.log(`  ${result.scanned} scanned, ${result.classified} classified`);
    process.exit(0);
  }

  if (mode === 'merge' || mode === 'split' || mode === 'set-kind') {
    await repairEntities(mode);
    process.exit(0);
  }

  if (mode === 'backfill-committee-kind') {

    console.log('Reclassifying PAC-shaped contributors stuck as organization…');
    const result = await backfillCommitteeKind(db, (scanned) => {
      if (scanned % 50_000 === 0) console.log(`  ${scanned} scanned…`);
    });
    console.log(`  ${result.scanned} scanned, ${result.reclassified} reclassified to committee`);
    process.exit(0);
  }

  if (mode === 'backfill-contributor-kind') {
    const apply = flags.apply === 'true';
    const reviewPath = flags.review ?? '.working/kind-review.csv';
    const namesPath = flags.names ?? '.working/kind-names.csv';
    const reviewFloor = Number(flags['min-review'] ?? 10_000);
    console.log(
      apply
        ? 'Re-kinding organization/individual contributors…'
        : `Dry run — flips at or above ${fmt(reviewFloor)} go to ${reviewPath}`,
    );
    const report = await backfillContributorKind(
      db,
      {
        apply,
        reviewPath: apply ? undefined : reviewPath,
        namesPath: apply ? undefined : namesPath,
        reviewFloor,
      },
      (scanned) => {
        if (scanned % 100_000 === 0) console.log(`  ${scanned} scanned…`);
      },
    );
    console.log(`  ${report.scanned} scanned`);
    for (const [k, n] of Object.entries(report.flips).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(8)}  ${k}`);
    }
    console.log('  by the source that created the entity:');
    for (const [k, n] of Object.entries(report.bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(8)}  ${k}`);
    }
    const countyRows = Object.values(report.county).reduce((s, n) => s + n, 0);
    if (countyRows > 0) {
      console.log(`  of which county-coded rows a weak rule flips, every one listed for review (${countyRows}):`);
      for (const [k, n] of Object.entries(report.county).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(8)}  ${k}`);
      }
    }
    if (report.locked > 0) {
      console.log(`  ${report.locked} left alone: kind set by a person in corrections/corrections.jsonl`);
    }
    console.log(`  display names ${apply ? 'changed' : 'that would change'}:`);
    for (const [k, n] of Object.entries(report.nameChanges).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(8)}  ${k}`);
    }
    if (apply) console.log(`  ${report.applied} rows updated. Run \`pnpm ingest rebuild\`, then sync.`);
    else console.log(`  ${report.review} rows written to ${reviewPath}; name changes to ${namesPath}`);
    process.exit(0);
  }

  if (mode === 'backfill-candidate-accounts') {
    const apply = flags.apply === 'true';
    const reviewPath = flags.review ?? '.working/candidate-accounts-review.csv';
    const movesPath = apply ? undefined : (flags.moves ?? '.working/candidate-accounts-moves.csv');
    console.log(apply ? 'Moving committee money onto candidates…' : 'Dry run: committee money that belongs on candidates');
    const r = await backfillCandidateAccounts(db, { apply, reviewPath, movesPath });
    console.log(`  ${r.namedMerged} entities named as a campaign ${apply ? 'folded' : 'would fold'} into their candidate, ${fmt(r.namedDollars)}`);
    console.log(`  ${r.rowsMoved} committee-paid rows on ${r.twinsTouched} bare-name twins ${apply ? 'moved' : 'would move'}, ${fmt(r.rowsDollars)}`);
    console.log(`  ${r.absorbed} of those twins ${apply ? 'had' : 'would have'} nothing left and ${apply ? 'folded' : 'would fold'} away`);
    console.log(`  ${r.review} entities could not be placed; written to ${reviewPath}`);
    if (r.federal > 0) console.log(`  ${r.federal} named for a federal race, left alone: Florida files no node for those`);
    if (movesPath) console.log(`  every fold and move listed in ${movesPath}`);
    if (apply) console.log('  Run `pnpm ingest rebuild`, then sync.');
    process.exit(0);
  }

  if (mode === 'collapse-mirrors') {
    const apply = flags.apply === 'true';
    const window = {
      recipientLag: Number(flags['recipient-lag'] ?? MIRROR_WINDOW.recipientLag),
      payerLag: Number(flags['payer-lag'] ?? MIRROR_WINDOW.payerLag),
    };
    let scope: string[] | undefined;
    if (flags.scope === 'keepers') {
      const rows = await db.execute<{ id: string }>(
        sql`SELECT DISTINCT merged_into AS id FROM entity_tombstones WHERE merged_into IS NOT NULL`,
      );
      scope = rows.map((r) => r.id);
    }
    console.log(
      `${apply ? 'Collapsing' : 'Dry run:'} mirrors, recipient up to ${window.recipientLag} days after the payer, ` +
        `payer up to ${window.payerLag} days after the recipient` +
        (scope ? `, ${scope.length} merge survivors only` : ', whole graph'),
    );
    const r = await collapseMirrors(db, scope, { dryRun: !apply, window });
    console.log(
      `  ${r.deleted} expenditure${r.deleted === 1 ? '' : 's'} ${apply ? 'deleted' : 'would go'} across ${r.pairs} committee pairs, ${fmt(r.dollars)}`,
    );
    if (apply && r.deleted > 0) console.log('  Run `pnpm ingest rebuild`, then sync.');
    process.exit(0);
  }

  if (mode === 'backfill-quotes') {
    const apply = flags.apply === 'true';
    const r = await backfillQuotes(db, apply);
    console.log(
      `  ${apply ? 'fixed' : 'would fix'} ${r.entities} entity names, ${r.aliases} aliases` +
        `${apply ? ` (${r.aliasesDropped} dropped as already carried clean)` : ''}, ` +
        `${r.transactions} transactions' raw names`,
    );
    if (apply) console.log('  Nothing to rebuild. Sync when ready.');
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

/**
 * Report the referential-integrity checks and say whether the graph is clean.
 * Returns true when nothing is wrong. Used on its own (`ingest verify`) and at
 * the end of every rebuild, on this Mac and on the deployment box.
 */
async function runVerify(): Promise<boolean> {
  const report = await verifyReferentialIntegrity(db);
  console.log('Referential integrity:');
  for (const c of report.checks) {
    const mark = c.count === 0 ? 'ok  ' : 'FAIL';
    const eg = c.count > 0 ? `  e.g. ${c.examples.join(', ')}` : '';
    console.log(`  [${mark}] ${c.name}: ${c.count}${eg}`);
    if (c.count > 0) console.log(`         ${c.detail}`);
  }
  if (report.ok) {
    console.log('  clean — no merged-away entity is still present or referenced.');
  } else {
    console.error(
      '\nA tombstoned entity is still present or referenced. On the deployment box this\n' +
        'blocks the tombstone delete and rolls back the whole load. Re-run the sync\n' +
        '(scripts/sync-to-vps.sh repoints stragglers onto the survivor before deleting).',
    );
  }
  return report.ok;
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

/**
 * Repair a resolution mistake a human has confirmed.
 *
 * Kept apart from the ingest commands above because these are the only ones
 * that overwrite a judgement the pipeline already made. `split` prints what it
 * would move and does nothing without `--apply`, because two people wrongly
 * pulled apart is not repaired by pulling them apart again.
 */
async function repairEntities(mode: 'merge' | 'split' | 'set-kind') {
  const describe = async (id: string) => {
    const [e] = await db.execute<{
      name: string;
      kind: string;
      city: string | null;
      given: string;
    }>(sql`
      SELECT name, kind::text AS kind, city, total_given::text AS given
        FROM entities WHERE id = ${id}
    `);
    if (!e) throw new Error(`no entity ${id}`);
    return `${e.name} (${e.kind}${e.city ? `, ${e.city}` : ''}, out ${fmt(e.given)})`;
  };

  if (mode === 'set-kind') {
    const [, id, kind] = positional;
    if (!id || !kind) return console.error('usage: pnpm ingest set-kind <entityId> <kind>');
    console.log(`  ${await describe(id)}`);
    await db.execute(sql`UPDATE entities SET kind = ${kind}::entity_kind WHERE id = ${id}`);
    console.log(`  → kind is now ${kind}`);
    return;
  }

  if (mode === 'merge') {
    const [, keepId, ...losers] = positional;
    if (!keepId || losers.length === 0) {
      return console.error('usage: pnpm ingest merge <keepId> <loserId> [loserId...]');
    }
    console.log(`  keeping ${await describe(keepId)}`);
    for (const l of losers) console.log(`  folding in ${await describe(l)}`);
    const { merged } = await mergeEntities(db, keepId, losers);
    console.log(`  merged ${merged}. Run \`pnpm ingest rebuild\` to re-derive totals.`);
    return;
  }

  const [, fromId] = positional;
  const city = flags.city as string | undefined;
  const name = flags.name as string | undefined;
  if (!fromId || !city || !name) {
    return console.error(
      'usage: pnpm ingest split <entityId> --city="CITY" --name="New Name" [--kind=individual] [--occupation="..."] [--apply]',
    );
  }

  // The filed address is the discriminator, because it is the only field that
  // reliably differs between two people who share a name.
  const rows = await db.execute<{
    id: string;
    txn_date: string | null;
    amount: string;
    counterparty: string;
    occupation: string | null;
    state_code: string | null;
    zip: string | null;
  }>(sql`
    SELECT t.id, t.txn_date::text, t.amount::text,
           COALESCE(e.name, t.raw_to_name) AS counterparty,
           t.from_occupation AS occupation, t.from_state AS state_code, t.from_zip AS zip
      FROM transactions t
      LEFT JOIN entities e ON e.id = t.to_entity_id
     WHERE t.from_entity_id = ${fromId}
       AND upper(t.from_city) = upper(${city})
     ORDER BY t.txn_date
  `);

  console.log(`  from ${await describe(fromId)}`);
  console.log(`  ${rows.length} transaction(s) filed from ${city}:`);
  for (const r of rows) {
    console.log(
      `    ${r.txn_date ?? '(no date)'}  ${fmt(r.amount).padStart(11)}  ` +
        `${r.counterparty.slice(0, 40).padEnd(42)} ${r.occupation ?? ''}`,
    );
  }
  if (rows.length === 0) return;

  if (!flags.apply) {
    console.log('\n  Nothing written. Re-run with --apply once the list above is right.');
    return;
  }

  const result = await splitEntity(db, fromId, rows.map((r) => r.id), {
    name,
    kind: (flags.kind as 'individual') ?? 'individual',
    city,
    stateCode: rows[0].state_code,
    zip: rows[0].zip,
    occupation: (flags.occupation as string) ?? rows.find((r) => r.occupation)?.occupation ?? null,
  });
  console.log(`\n  moved ${result.moved} onto new entity ${result.id}`);
  console.log('  Run `pnpm ingest rebuild` to re-derive totals.');
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});

