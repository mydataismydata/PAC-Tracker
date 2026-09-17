/**
 * Know Your Mailer — the way in.
 *
 * A political mailer has to name whoever paid for it, and that disclaimer is
 * usually the only fact its recipient has. The masthead's search takes that
 * name and opens the committee's report: who funded it, and what it spent the
 * money on.
 *
 * The lists here are not decoration. A landing page whose only content is an
 * empty search field shows a reader nothing about what is behind it, and
 * plenty of people arrive without a specific name in hand. There are two, and
 * they answer different questions. The left is the money: which committees
 * spend the most. The right is the people: who signs for a committee twice
 * over, as its chair and as its treasurer, which is the thing a list of
 * committee names cannot show at all.
 *
 * What the database holds is stated outright, above both. A reader who has
 * just been told that a mailer's funder can be looked up is owed the years and
 * the sources before they find out by searching for something that is not
 * there.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { busiestCommittees, committeeHref } from '@/lib/graph/committee';
import { busiestPeople } from '@/lib/graph/officers';
import { methods } from '@/lib/kym/methods';
import { formatMoney, formatMoneyFull, kindLabel } from '@/lib/graph/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Know Your Mailer — PAC Tracker',
  description:
    'Look up the political committee named on a Florida mailer: who funded it, and what it paid for.',
};

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function years(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  return from.slice(0, 4) === to.slice(0, 4)
    ? from.slice(0, 4)
    : `${from.slice(0, 4)} to ${to.slice(0, 4)}`;
}

/**
 * What is in the database, said plainly and counted from the database itself.
 *
 * Every figure is read at request time rather than written into the copy,
 * because a sentence that says two million filings after the fourth sweep of
 * the month is worse than no sentence at all.
 */
function Holdings({
  totals,
  sources,
}: {
  totals: Awaited<ReturnType<typeof methods>>['totals'];
  sources: Awaited<ReturnType<typeof methods>>['sources'];
}) {
  const feeds = sources.filter((s) => s.records > 0);
  return (
    <div className="mt-5 max-w-3xl rounded border border-slate-900 bg-slate-900/40 px-4 py-3">
      <p className="text-sm leading-relaxed text-slate-400">
        {num(totals.records)} filings, {years(totals.firstFiled, totals.lastFiled)}, worth{' '}
        {formatMoneyFull(totals.amount)} between {num(totals.entities)} filers.
      </p>
      <ul className="mt-2 space-y-0.5">
        {feeds.map((s) => (
          <li key={s.key} className="flex items-baseline gap-2 text-xs text-slate-500">
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 font-mono tabular-nums text-slate-600">
              {years(s.firstFiled, s.lastFiled)}
            </span>
            <span className="w-24 shrink-0 text-right font-mono tabular-nums text-slate-500">
              {num(s.records)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-600">
        <Link href="/methods-and-sources" className="text-slate-500 underline-offset-2 hover:text-indigo-300 hover:underline">
          Methods and sources
        </Link>{' '}
        sets out every feed, every filer folded into another, and the nonprofits in this data.
      </p>
    </div>
  );
}

export default async function KymLandingPage() {
  const [busiest, operators, m] = await Promise.all([
    busiestCommittees(db, 10),
    busiestPeople(db, 10),
    methods(db),
  ]);

  return (
    <main className="mt-8">
      {/* The page's whole argument, and a break in the middle of it reads as
          two half-thoughts. `one-line` keeps it on one, shrinking the type
          instead of wrapping. See globals.css. */}
      <p className="one-line leading-relaxed text-slate-400">
        Every political mailer has to name whoever paid for it. Search that name above to see who
        really paid for it, and where that money went.
      </p>

      <Holdings totals={m.totals} sources={m.sources} />

      {/* Two columns above the medium breakpoint and one below it. The lists
          are independent of each other, so stacking them costs a reader
          nothing but a scroll.
          
          `grid-cols-1` rather than a bare `grid`: an implicit column is sized
          `auto`, which a committee named "Florida Republican Senatorial
          Campaign Committee, Inc." pushes past the width of a phone. The
          numbered utilities are `minmax(0, 1fr)`, which is what lets the
          truncation inside actually truncate. */}
      <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
            Biggest PACs
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

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
            Biggest Networks
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            People who control the most PACs as both Chairman and Treasurer. The figure is what
            those committees raised.
          </p>
          <ul className="mt-3 divide-y divide-slate-900 rounded border border-slate-800">
            {operators.map((p) => (
              <li key={p.normalizedName}>
                <Link
                  href={`/kym/person/${p.slug}`}
                  className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-slate-900/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-200">{p.name}</span>
                    <span className="block truncate text-xs text-slate-500">
                      Chair and treasurer of {num(p.bothRoles)} committee
                      {p.bothRoles === 1 ? '' : 's'}
                      {p.committees > p.bothRoles
                        ? ` · named on ${num(p.committees)} in all`
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-amber-400">
                    {formatMoney(p.raised)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="mt-8 max-w-3xl text-xs leading-relaxed text-slate-600">
        Figures are as filed with the Florida Division of Elections and the county supervisors of
        elections, and may be amended.
      </p>
    </main>
  );
}
