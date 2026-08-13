/**
 * Election cycles, and how a transaction is assigned to one.
 *
 * Florida files a whole cycle under its general-election id, so a contribution
 * dated 2023 for the 2026 election is a 2026-cycle row. The state feed says so
 * directly. Two other sources do not:
 *
 *   - County portals have no cycle parameter at all.
 *   - IRS 8872 rows carry a filing period, which is worth keeping on the
 *     transaction but would split one national committee across four "cycles"
 *     nobody would think to select.
 *
 * Both fall back to the cycle their date lands in. That is an approximation —
 * a filing made late in one cycle for the *next* election lands in the wrong
 * bucket — but excluding them from every filter would make county races vanish
 * from a filtered graph, which is a worse answer than an occasional stray row.
 */

import { sql } from 'drizzle-orm';

export interface Cycle {
  /** The id the state files under, and the value stored on a row. */
  id: string;
  label: string;
  /** Election day. A cycle covers the day after the previous one up to this. */
  date: string;
}

/** Newest first. The first entry is "current". */
export const CYCLES: Cycle[] = [
  { id: '20261103-GEN', label: '2026', date: '2026-11-03' },
  { id: '20241105-GEN', label: '2024', date: '2024-11-05' },
  { id: '20221108-GEN', label: '2022', date: '2022-11-08' },
];

export const CURRENT_CYCLE = CYCLES[0];
export const PREVIOUS_CYCLE = CYCLES[1];

export function cycleLabel(id: string | null | undefined): string {
  if (!id) return 'All cycles';
  return CYCLES.find((c) => c.id === id)?.label ?? id;
}

/** The cycle a date falls in. */
export function cycleForDate(date: string | null): string {
  if (!date) return 'unknown';
  // Cycles are newest first, so walk backwards to find the first one the date
  // does not overrun.
  for (let i = CYCLES.length - 1; i >= 0; i--) {
    if (date <= CYCLES[i].date) return CYCLES[i].id;
  }
  return CYCLES[0].id;
}

/**
 * SQL deciding which cycle a transaction row belongs to.
 *
 * Shared by the rollup builder and by every query that filters transactions
 * directly, so a filtered ledger cannot disagree with the filtered graph drawn
 * beside it.
 */
export function derivedCycleSql(alias = 't') {
  const a = sql.raw(alias);
  return sql`
    CASE
      WHEN ${a}.election_cycle IS NOT NULL AND ${a}.election_cycle NOT LIKE '8872-%'
        THEN ${a}.election_cycle
      WHEN ${a}.txn_date IS NULL THEN 'unknown'
      WHEN ${a}.txn_date > DATE '2024-11-05' THEN '20261103-GEN'
      WHEN ${a}.txn_date > DATE '2022-11-08' THEN '20241105-GEN'
      ELSE '20221108-GEN'
    END
  `;
}
