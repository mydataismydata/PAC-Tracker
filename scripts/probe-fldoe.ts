/**
 * Live smoke test against the Florida DOE service.
 *
 * Exercises the adapter end-to-end without touching the database, so the
 * scraping contract can be re-verified independently of schema or ingest
 * changes. Run with: pnpm probe:fldoe
 */

import { FlDoeAdapter } from '@/lib/ingest/fl-doe/adapter';
import { FlDoeClient, NAME_MATCH } from '@/lib/ingest/fl-doe/client';
import { normalizeName, scoreMatch, looksTruncated } from '@/lib/normalize';

async function main() {
  const client = new FlDoeClient({
    delayMs: 1500,
    onRequest: ({ endpoint, attempt }) =>
      console.log(`  → ${endpoint}${attempt > 1 ? ` (retry ${attempt})` : ''}`),
  });
  const fl = new FlDoeAdapter(client);

  console.log('\n[1] Contributions TO a committee (upstream hop)');
  const into = await fl.contributionsToCommittee('Florida Chamber', {
    election: '20241105-GEN',
    rowLimit: 30,
    match: NAME_MATCH.containing,
  });
  console.log(`    parsed ${into.length} rows`);
  for (const r of into.slice(0, 5)) {
    console.log(
      `    ${r.date}  $${Number(r.amount).toLocaleString().padStart(11)}  ` +
        `${r.contributorRaw.slice(0, 28).padEnd(28)} -> ${r.recipientName.slice(0, 34)}` +
        `${r.recipientTruncated ? '  [TRUNCATED]' : ''}`,
    );
  }

  console.log('\n[2] Contributions FROM a contributor (downstream hop)');
  const outOf = await fl.contributionsFromContributor('SECURE FLORIDA', {
    election: '20241105-GEN',
    rowLimit: 30,
    match: NAME_MATCH.startsWith,
  });
  console.log(`    parsed ${outOf.length} rows`);
  for (const r of outOf.slice(0, 5)) {
    console.log(
      `    ${r.date}  $${Number(r.amount).toLocaleString().padStart(11)}  ` +
        `${r.contributorRaw.slice(0, 28).padEnd(28)} -> ${r.recipientName.slice(0, 34)}`,
    );
  }

  console.log('\n[3] Committee registry prefix lookup');
  const committees = await fl.committeesByPrefix('SECURE');
  console.log(`    ${committees.length} committees starting with "SECURE"`);
  for (const c of committees.slice(0, 6)) {
    console.log(`    ${c.name.slice(0, 44).padEnd(44)} ${c.type}  ${c.status}`);
  }

  console.log('\n[4] Entity-resolution sanity check');
  const donorNames = [...new Set(into.map((r) => r.contributorRaw))];
  const committeeNames = committees.map((c) => c.name);
  for (const d of donorNames.slice(0, 6)) {
    let best = { name: '', score: 0, reasons: [] as string[] };
    for (const c of committeeNames) {
      const s = scoreMatch(d, c, { truncated: looksTruncated(d) });
      if (s.score > best.score) best = { name: c, score: s.score, reasons: s.reasons };
    }
    const verdict = best.score >= 0.88 ? 'LINK' : best.score >= 0.62 ? 'review' : '-';
    console.log(
      `    ${normalizeName(d).slice(0, 30).padEnd(30)} ${verdict.padEnd(7)} ` +
        `${best.score.toFixed(2)}  ${best.name.slice(0, 30)}`,
    );
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
