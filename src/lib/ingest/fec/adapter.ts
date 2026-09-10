/**
 * FEC source adapter, scoped to named federal candidates.
 *
 * Like the IRS 8872 adapter, this is not a bulk import. It answers one
 * question the Florida data cannot: who funds a federal candidate whose money
 * touches Florida politics. Florida shows the outgoing side only — a
 * congressional committee giving to a state or county filer — and never the
 * raising side.
 *
 * Money loaded through here belongs to a national pool, the same as the RSLC's,
 * and the sweep marks the committee `isInjectionPoint` for that reason: it is
 * raised nationally and spent federally, so treating a Florida share as a
 * representative slice of it is an assumption the disclosure cannot support.
 */

import { FecClient } from './client';
import {
  scheduleAToRow,
  scheduleBToRow,
  type ScheduleARow,
  type ScheduleBRow,
} from './parse';
import type { RawTransactionRow } from '../types';
import { cycleForYear } from '@/lib/cycles';

/**
 * Candidates worth loading, with the committee their money actually moves
 * through. `committeeId` is the principal campaign committee — the `C…` id the
 * FEC keys filings by — and `name` is what the node will be called.
 */
export const TRACKED_CANDIDATES = [
  {
    slug: 'fine',
    candidateId: 'H6FL06258',
    committeeId: 'C00893271',
    name: 'Randy Fine for Congress',
    office: 'U.S. House FL-06',
    /** Two-year periods the committee has filed for. */
    cycles: [2024, 2026],
    note: 'Florida state senator through 2025, then FL-06. Florida sees only the outgoing side.',
  },
] as const;

export type TrackedCandidate = (typeof TRACKED_CANDIDATES)[number];

export function findCandidate(slug: string): TrackedCandidate | undefined {
  return TRACKED_CANDIDATES.find((c) => c.slug === slug.toLowerCase());
}

export interface SweepOptions {
  /** Restrict to these two-year periods. Defaults to the candidate's own. */
  cycles?: readonly number[];
  /** Skip rows below this, in dollars. Applied to receipts only. */
  minAmount?: number;
  /** Load only receipts, or only disbursements. Both by default. */
  schedules?: readonly ('A' | 'B')[];
  onProgress?: (msg: string) => void;
}

export class FecAdapter {
  readonly sourceKey = 'fec';

  constructor(private readonly client: FecClient = new FecClient()) {}

  /**
   * Every receipt and disbursement for one candidate, cycle by cycle.
   *
   * Yields per cycle and per schedule rather than buffering the lot, so a
   * sweep can be written to the database as it goes and resumed at a cycle
   * boundary if the API gives out partway.
   */
  async *sweep(
    candidate: TrackedCandidate,
    opts: SweepOptions = {},
  ): AsyncGenerator<{ cycle: number; schedule: 'A' | 'B'; rows: RawTransactionRow[] }> {
    const cycles = opts.cycles ?? candidate.cycles;
    const schedules = opts.schedules ?? (['A', 'B'] as const);

    for (const cycle of cycles) {
      // Keyed to the Florida cycle for the same election, not a namespace of
      // its own. An FEC two-year transaction period *is* an election cycle —
      // the 2026 period runs from January 2025 to December 2026, the same
      // election `20261103-GEN` covers — so the two are one cycle under two
      // names. The 8872 loader namespaces because an IRS filing period is a
      // quarter ending on an arbitrary date and genuinely is not a cycle;
      // copying that here hid every federal dollar from the cycle filter, and
      // a committee with $2.7M in showed $0 for 2026.
      const key = cycleForYear(cycle)?.id;
      if (!key) throw new Error(`no election cycle known for ${cycle} — add it to cycles.ts`);
      const ctx = { filerName: candidate.name, electionCycle: key };

      if (schedules.includes('A')) {
        const rows: RawTransactionRow[] = [];
        let memos = 0;
        for await (const r of this.client.paginate<ScheduleARow>(
          '/schedules/schedule_a/',
          {
            committee_id: candidate.committeeId,
            two_year_transaction_period: cycle,
            per_page: 100,
            sort: 'contribution_receipt_date',
            min_amount: opts.minAmount,
          },
          (fetched, total) =>
            opts.onProgress?.(`${cycle} receipts ${fetched}/${total}`),
        )) {
          const row = scheduleAToRow(r, ctx);
          if (row) rows.push(row);
          else memos++;
        }
        opts.onProgress?.(
          `${cycle} receipts: ${rows.length} rows${memos ? `, ${memos} rows skipped as memo or candidate loan` : ''}`,
        );
        yield { cycle, schedule: 'A', rows };
      }

      if (schedules.includes('B')) {
        const rows: RawTransactionRow[] = [];
        let memos = 0;
        // `two_year_transaction_period` is not optional here: without it this
        // endpoint answers 504. See the note in client.ts.
        for await (const r of this.client.paginate<ScheduleBRow>(
          '/schedules/schedule_b/',
          {
            committee_id: candidate.committeeId,
            two_year_transaction_period: cycle,
            per_page: 100,
            sort: 'disbursement_date',
          },
          (fetched, total) =>
            opts.onProgress?.(`${cycle} disbursements ${fetched}/${total}`),
        )) {
          const row = scheduleBToRow(r, ctx);
          if (row) rows.push(row);
          else memos++;
        }
        opts.onProgress?.(
          `${cycle} disbursements: ${rows.length} rows${memos ? `, ${memos} rows skipped as memo or candidate loan` : ''}`,
        );
        yield { cycle, schedule: 'B', rows };
      }
    }
  }
}
