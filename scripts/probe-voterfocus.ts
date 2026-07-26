/**
 * Live smoke test for the VoterFocus county adapter — no database involved.
 *
 *   pnpm probe:voterfocus            # St. Johns
 *   pnpm probe:voterfocus broward
 */

import { VoterFocusAdapter } from '@/lib/ingest/voterfocus/adapter';
import { VoterFocusClient } from '@/lib/ingest/voterfocus/client';

const slug = process.argv[2] ?? 'stjohns';

async function main() {
  const client = new VoterFocusClient({ delayMs: 800 });
  const fl = new VoterFocusAdapter(slug, client);
  console.log(`\nCounty: ${fl.county.name} (${fl.county.slug})`);

  console.log('\n[1] Election cycles');
  const elections = await fl.elections();
  for (const e of elections.slice(0, 6)) console.log(`    e=${e.id.padStart(2)}  ${e.label}`);

  console.log('\n[2] Candidates and committees');
  const entities = await fl.entities();
  const cands = entities.filter((e) => !e.isCommittee);
  const cmtes = entities.filter((e) => e.isCommittee);
  console.log(`    ${entities.length} total — ${cands.length} candidates, ${cmtes.length} committees`);

  const offices = new Map<string, number>();
  for (const e of cands) offices.set(e.office ?? '(none)', (offices.get(e.office ?? '(none)') ?? 0) + 1);
  console.log('    offices:');
  for (const [o, n] of [...offices].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`      ${String(n).padStart(3)}  ${o}`);
  }

  console.log('\n[3] Transactions for the first few filers');
  let totalRows = 0;
  const kinds = new Map<string, number>();
  let contributions = 0;
  let expenditures = 0;

  for (const e of entities.slice(0, 6)) {
    const rows = await fl.transactionsFor(e);
    totalRows += rows.length;
    for (const r of rows) {
      kinds.set(r.counterpartyKind, (kinds.get(r.counterpartyKind) ?? 0) + 1);
      if (r.direction === 'contribution') contributions++;
      else expenditures++;
    }
    const sum = rows
      .filter((r) => r.direction === 'contribution')
      .reduce((a, r) => a + Number(r.amount), 0);
    console.log(
      `    ${(e.isCommittee ? '[C] ' : '    ') + e.name.slice(0, 34).padEnd(36)}` +
        `${String(rows.length).padStart(4)} rows  in $${sum.toLocaleString()}` +
        `${e.office ? `  · ${e.office.slice(0, 30)}` : ''}`,
    );
    for (const r of rows.slice(0, 2)) {
      console.log(
        `        ${r.date}  ${r.direction === 'contribution' ? '←' : '→'} ` +
          `$${Number(r.amount).toLocaleString().padStart(10)}  ` +
          `${r.counterpartyRaw.slice(0, 30).padEnd(32)}[${r.counterpartyKind}]`,
      );
    }
  }

  console.log(`\n[4] Totals: ${totalRows} rows — ${contributions} contributions, ${expenditures} expenditures`);
  console.log('    counterparty kinds:', Object.fromEntries(kinds));
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
