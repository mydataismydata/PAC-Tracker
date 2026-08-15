/**
 * Dry-run the contribution sweep and diff it against what is stored.
 *
 * The stored rows were loaded when truncation was measured in parsed rows
 * rather than lines delivered, so a capped response could read as a final
 * window and end the walk early. Re-walking with the corrected detection and
 * checking hashes says whether that actually cost anything, and where.
 *
 * Nothing is written. Output is a per-window presence count plus the date of
 * the first window that starts losing rows, which is where a truncated walk
 * would have stopped.
 */
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { FlDoeAdapter } from '@/lib/ingest/fl-doe/adapter';
import { FlDoeClient } from '@/lib/ingest/fl-doe/client';

const RANGES = process.env.SMOKE
  ? [{ election: '20261103-GEN', from: '2026-07-01', to: '2026-07-07' }]
  : [
      { election: '20241105-GEN', from: '2021-01-01', to: '2025-12-31' },
      { election: '20261103-GEN', from: '2023-01-01', to: '2026-08-12' },
    ];

async function storedHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const [{ found }] = await db.execute<{ found: string | null }>(sql`
    SELECT array_to_string(array_agg(DISTINCT source_row_hash), ',') AS found
    FROM transactions
    WHERE source_row_hash = ANY(string_to_array(${hashes.join(',')}, ','))
  `);
  return new Set((found ?? '').split(',').filter(Boolean));
}

/**
 * Is this row stored under some other hash?
 *
 * A filing amended after ingest — a corrected address, a fixed ZIP — rehashes
 * to a new value while the money it describes is already in the graph. That is
 * a stale row, not a missing one, and counting the two together would inflate
 * an apparent gap.
 */
async function storedByContent(r: {
  amount: string;
  date: string | null;
  contributorRaw: string;
  recipientName: string;
}): Promise<boolean> {
  const [{ n }] = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM transactions
    WHERE direction = 'contribution'
      AND amount = ${r.amount}
      AND txn_date = ${r.date}
      AND raw_from_name = ${r.contributorRaw}
  `);
  return n > 0;
}

async function main() {
  const fl = new FlDoeAdapter(new FlDoeClient());
  const onlyCycle = process.argv[2];
  const onlyScope = process.argv[3] as 'committee' | 'candidate' | undefined;

  for (const range of RANGES) {
    if (onlyCycle && range.election !== onlyCycle) continue;

    for (const mode of (onlyScope ? [onlyScope] : ['committee', 'candidate']) as Array<
      'committee' | 'candidate'
    >) {
      console.log(`\n=== ${range.election} ${mode}s  ${range.from}..${range.to} ===`);

      let feedTotal = 0;
      let presentTotal = 0;
      const gaps: Array<{ from: string; to: string; missing: number; distinct: number }> = [];

      for await (const win of fl.sweepCycle(mode, {
        election: range.election,
        from: range.from,
        to: range.to,
        onWindow: (w) => {
          if (w.action === 'truncated' || w.action === 'failed') {
            console.log(`  ${w.from}..${w.to}  ${w.action.toUpperCase()} ${w.error ?? ''}`);
          }
        },
      })) {
        const byHash = new Map(win.rows.map((r) => [r.rowHash, r]));
        const distinct = [...byHash.keys()];
        const stored = await storedHashes(distinct);
        const absent = distinct.filter((h) => !stored.has(h));

        // Separate "the money is in the graph under an older hash" from a
        // window the walk never reached.
        let stale = 0;
        for (const h of absent.slice(0, 50)) {
          if (await storedByContent(byHash.get(h)!)) stale++;
        }
        const sampled = Math.min(absent.length, 50);
        const staleRate = sampled > 0 ? stale / sampled : 0;
        const trulyMissing = Math.round(absent.length * (1 - staleRate));

        feedTotal += distinct.length;
        presentTotal += stored.size;
        if (trulyMissing > 0) {
          gaps.push({ from: win.from, to: win.to, missing: trulyMissing, distinct: distinct.length });
        }

        if (process.env.SMOKE && absent.length > 0) {
          console.log('  sample of absent rows:');
          for (const h of absent.slice(0, 6)) {
            const r = byHash.get(h)!;
            console.log(
              `    ${r.date}  $${r.amount}  typ=${r.typeCode}  ` +
                `"${r.contributorRaw.slice(0, 34)}" -> "${r.recipientName.slice(0, 34)}"`,
            );
          }
        }
        console.log(
          `  ${win.from}..${win.to}  ${String(distinct.length).padStart(6)} distinct, ` +
            `${String(stored.size).padStart(6)} stored, ${String(absent.length).padStart(5)} absent` +
            `${absent.length > 0 ? ` (${Math.round(staleRate * 100)}% rehashed, ~${trulyMissing} real)` : ''}` +
            `${trulyMissing > 0 ? '  <-- GAP' : ''}`,
        );
      }

      console.log(
        `  TOTAL ${feedTotal} distinct, ${presentTotal} stored, ${feedTotal - presentTotal} missing`,
      );
      if (gaps.length > 0) {
        console.log(`  first gap window: ${gaps[0].from}..${gaps[0].to} (${gaps[0].missing} rows)`);
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
