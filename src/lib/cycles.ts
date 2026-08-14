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

/** Frozen at build time so the default cycle cannot shift mid-session. */
const BUILD_TODAY = new Date().toISOString().slice(0, 10);

export interface Cycle {
  /** The id the state files under, and the value stored on a row. */
  id: string;
  label: string;
  /** Election day. A cycle covers the day after the previous one up to this. */
  date: string;
}

/**
 * Florida general elections, newest first. The first entry is "current".
 *
 * Dates are the actual general-election days (the Tuesday after the first
 * Monday in November). The county portal agrees for every even year it lists
 * properly; its 2000, 2002 and 2006 entries carry placeholder dates like
 * 1/1/2000, which are start-of-period markers rather than election days.
 */
export const CYCLES: Cycle[] = [
  { id: '20281107-GEN', label: '2028', date: '2028-11-07' },
  { id: '20261103-GEN', label: '2026', date: '2026-11-03' },
  { id: '20241105-GEN', label: '2024', date: '2024-11-05' },
  { id: '20221108-GEN', label: '2022', date: '2022-11-08' },
  { id: '20201103-GEN', label: '2020', date: '2020-11-03' },
  { id: '20181106-GEN', label: '2018', date: '2018-11-06' },
  { id: '20161108-GEN', label: '2016', date: '2016-11-08' },
  { id: '20141104-GEN', label: '2014', date: '2014-11-04' },
  { id: '20121106-GEN', label: '2012', date: '2012-11-06' },
  { id: '20101102-GEN', label: '2010', date: '2010-11-02' },
  { id: '20081104-GEN', label: '2008', date: '2008-11-04' },
  { id: '20061107-GEN', label: '2006', date: '2006-11-07' },
  { id: '20041102-GEN', label: '2004', date: '2004-11-02' },
  { id: '20021105-GEN', label: '2002', date: '2002-11-05' },
  { id: '20001107-GEN', label: '2000', date: '2000-11-07' },
];

/**
 * "Current" is the cycle now being contested, not simply the newest listed.
 *
 * Portals publish the next cycle years early — St. Johns already offers 2028
 * with a single placeholder filer — so defaulting the UI to the newest entry
 * would open on an empty graph and look broken.
 */
export const CURRENT_CYCLE =
  // Newest first, so the *last* entry still in the future is the next election.
  CYCLES.filter((c) => c.date >= BUILD_TODAY).at(-1) ?? CYCLES[0];
export const PREVIOUS_CYCLE = CYCLES[CYCLES.indexOf(CURRENT_CYCLE) + 1] ?? CYCLES[1];

/** The cycle a four-digit year's general election belongs to. */
export function cycleForYear(year: number): Cycle | undefined {
  return CYCLES.find((c) => c.label === String(year));
}

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
  // Values are inlined rather than bound. A bound parameter renumbers per
  // occurrence, so the identical expression in SELECT and GROUP BY becomes two
  // different strings and Postgres refuses to match them. Ids and dates come
  // from the constant above and are asserted to be literal-safe.
  const lit = (v: string) => {
    if (!/^[0-9A-Za-z-]+$/.test(v)) throw new Error(`unsafe cycle literal: ${v}`);
    return sql.raw(`'${v}'`);
  };
  const branches = [...CYCLES]
    .sort((x, y) => x.date.localeCompare(y.date))
    .map((c) => sql`WHEN ${a}.txn_date <= ${lit(c.date)}::date THEN ${lit(c.id)}`);
  return sql`
    CASE
      WHEN ${a}.election_cycle IS NOT NULL AND ${a}.election_cycle NOT LIKE '8872-%'
        THEN ${a}.election_cycle
      WHEN ${a}.txn_date IS NULL THEN 'unknown'
      ${sql.join(branches, sql` `)}
      ELSE ${lit(CYCLES[0].id)}
    END
  `;
}
