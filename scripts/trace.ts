/**
 * Trace a committee's money back to the entities that originated it.
 *
 * The algorithm lives in `src/lib/graph/trace.ts` so the panel and the CLI
 * cannot drift apart; this is the terminal front-end for it.
 *
 * Usage:
 *   pnpm trace "First Coast Leadership"
 *   pnpm trace "First Coast Leadership" --depth=15 --min=500
 *   pnpm trace "First Coast Leadership" --no-dates    # ignore transfer order
 */

import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { trace, type TracedSource } from '@/lib/graph/trace';

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

const fmt = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function main() {
  const name = positional[0];
  if (!name) {
    console.error('usage: pnpm trace "<entity name>" [--depth=12] [--min=100] [--no-dates]');
    process.exit(1);
  }

  const matches = await db.execute<{ id: string; name: string; received: string }>(sql`
    SELECT id, name, total_received::text AS received
    FROM entities
    WHERE name ILIKE ${name} OR normalized_name LIKE ${'%' + name.toUpperCase() + '%'}
    ORDER BY total_received DESC NULLS LAST
    LIMIT 5
  `);
  if (matches.length === 0) {
    console.error(`no entity matching "${name}"`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log(`(${matches.length} matches; using "${matches[0].name}")`);
  }

  const result = await trace(db, matches[0].id, {
    maxDepth: Number(flags.depth ?? 12),
    minDollars: Number(flags.min ?? 100),
    dateOrdered: flags['no-dates'] !== 'true',
  });

  const { seed } = result;
  console.log(`\n${seed.name}  (${seed.kind})`);
  console.log(`received ${fmt(seed.total)} from ${seed.inDegree} direct donors`);
  console.log(
    `${result.dateOrdered ? 'Date-ordered' : 'NOT date-ordered'} · traced through ${result.hops} hops\n`,
  );

  const row = (s: TracedSource, withHop = true) =>
    `  ${fmt(s.amount).padStart(11)}  ${(s.share * 100).toFixed(1).padStart(5)}%  ` +
    `${s.name.slice(0, 46).padEnd(48)} ${s.kind}${withHop ? `  (hop ${s.hop})` : ''}`;

  console.log('ORIGINAL SOURCES\n');
  for (const s of result.sources) console.log(row(s));

  if (result.unresolved.length > 0) {
    console.log('\nUNRESOLVED — no eligible upstream, or past --depth\n');
    for (const s of result.unresolved) console.log(row(s, false));
  }

  const total = (list: TracedSource[]) => list.reduce((a, b) => a + b.amount, 0);
  const pct = (n: number) => `${((n / seed.total) * 100).toFixed(1)}%`;
  const attributed = total(result.sources);
  const unresolved = total(result.unresolved);

  console.log(
    `\n  attributed ${fmt(attributed)} (${pct(attributed)}) · ` +
      `unresolved ${fmt(unresolved)} (${pct(unresolved)}) · ` +
      `dispersed ${fmt(result.dispersed)} (${pct(result.dispersed)}) · of ${fmt(seed.total)}`,
  );
  if (result.truncated) {
    console.log('  NOTE: hit the parcel ceiling; some strands were folded into dispersed.');
  }
  console.log(
    '\n  Pro-rata attribution: what share of the pool each source funded, not\n' +
      '  the route a particular dollar took.\n',
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
