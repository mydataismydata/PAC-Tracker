/**
 * The period a page covers, and the ways to change it.
 *
 * Sits directly above the headline figures, because those figures are what it
 * changes. All dates is the default and always first. Then one link per
 * session the subject has money in, and a pair of dates for any other range.
 *
 * Plain links and a plain GET form, so it works before any script loads and
 * every choice is a URL a reader can share. Both are relative to the page
 * they sit on, so one component serves every page without knowing its path.
 */

import Link from 'next/link';
import { CYCLES } from '@/lib/cycles';
import {
  isNarrowed,
  periodLabel,
  periodParams,
  sessionLabel,
  type Period,
} from '@/lib/kym/period';

const CHOICE =
  'rounded border px-2.5 py-1 text-xs underline-offset-2 transition-colors whitespace-nowrap';
const CHOSEN = 'border-indigo-500/70 bg-indigo-950/50 text-indigo-200';
const OPEN = 'border-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200';
const FIELD =
  'rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-200 [color-scheme:dark] focus:border-indigo-500 focus:outline-none';

export default function PeriodFilter({
  period,
  cycles,
  keep = {},
}: {
  period: Period;
  /** Cycle ids the subject has money in, newest first. */
  cycles: string[];
  /** Other query parameters the page needs to keep, such as a pinned `id`. */
  keep?: Record<string, string>;
}) {
  const href = (p: Period) => `?${new URLSearchParams([...Object.entries(keep), ...periodParams(p)])}`;
  const ranged = Boolean(period.dateFrom || period.dateTo);
  // The session being shown stays on offer even when the subject has no money
  // in it, so the choice on screen is always one of the choices listed. It
  // takes its place by date, newest first, like the rest.
  const sessions = CYCLES.map((c) => c.id).filter(
    (id) => cycles.includes(id) || id === period.cycle,
  );

  return (
    <section className="mt-6" aria-label="Period shown">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={href({})} className={`${CHOICE} ${isNarrowed(period) ? OPEN : CHOSEN}`}>
          All dates
        </Link>
        {sessions.map((c) => (
          <Link
            key={c}
            href={href({ cycle: c })}
            className={`${CHOICE} ${period.cycle === c && !ranged ? CHOSEN : OPEN}`}
          >
            {sessionLabel(c)}
          </Link>
        ))}
      </div>

      {/* No action: a GET form with none submits to the page it is on, which
          replaces the query with these fields. The session is not among them,
          so picking a range leaves the session behind. */}
      <form method="get" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {Object.entries(keep).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label className="flex items-center gap-1.5">
          From
          <input type="date" name="from" defaultValue={period.dateFrom} className={FIELD} />
        </label>
        <label className="flex items-center gap-1.5">
          through
          <input type="date" name="to" defaultValue={period.dateTo} className={FIELD} />
        </label>
        <button
          type="submit"
          className={`${CHOICE} ${ranged ? CHOSEN : OPEN} cursor-pointer`}
        >
          Show these dates
        </button>
      </form>

      <p className="mt-5 text-base font-semibold text-slate-200">{periodLabel(period)}</p>
    </section>
  );
}
