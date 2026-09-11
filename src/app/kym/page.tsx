/**
 * Know Your Mailer — the way in.
 *
 * A political mailer has to name whoever paid for it, and that disclaimer is
 * usually the only fact its recipient has. The masthead's search takes that
 * name and opens the committee's report: who funded it, and what it spent the
 * money on.
 *
 * The list here is not decoration. A landing page whose only content is an
 * empty search field shows a reader nothing about what is behind it, and
 * plenty of people arrive without a specific name in hand.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { busiestCommittees, committeeHref } from '@/lib/graph/committee';
import { formatMoney, kindLabel } from '@/lib/graph/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Know Your Mailer — PAC Tracker',
  description:
    'Look up the political committee named on a Florida mailer: who funded it, and what it paid for.',
};

export default async function KymLandingPage() {
  const busiest = await busiestCommittees(db, 10);

  return (
    <main className="mt-8 max-w-3xl">
      <p className="max-w-prose text-sm leading-relaxed text-slate-400">
        Every political mailer has to name whoever paid for it. Search that name above to see who
        funded the committee behind it, and what it spent the money on.
      </p>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
          Biggest spenders on file
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Committees that have paid out the most, across every cycle in the database.
        </p>
        <ul className="mt-3 divide-y divide-slate-900 rounded border border-slate-800">
          {busiest.map((c) => (
            <li key={c.id}>
              <Link
                href={committeeHref(c)}
                className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-slate-900/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-200">{c.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {kindLabel({ kind: c.kind, committeeType: c.committeeType })}
                    {c.city ? ` · ${c.city}, ${c.stateCode ?? ''}` : ''}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-sm tabular-nums text-amber-400">
                  {formatMoney(c.totalGiven)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-xs leading-relaxed text-slate-600">
        Figures are as filed with the Florida Division of Elections and the county supervisors of
        elections, and may be amended.
      </p>
    </main>
  );
}
