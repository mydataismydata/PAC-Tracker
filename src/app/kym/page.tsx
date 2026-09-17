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
import PanelHeading from '@/components/kym/PanelHeading';

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
 * The latest filing date anywhere in the database, as a day rather than a year.
 *
 * What a reader wants from this is whether the figures below it are current, and
 * a year cannot answer that in December. Parsed off the string rather than
 * through `Date`, which would read a bare yyyy-mm-dd as UTC midnight and print
 * the day before it in every American time zone.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function day(date: string | null): string {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '—';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * What is in the database, said plainly and counted from the database itself.
 *
 * Every figure is read at request time rather than written into the copy,
 * because a sentence that says two million filings after the fourth sweep of
 * the month is worse than no sentence at all.
 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-400">
        {label}
      </div>
      {/* One size at every width. The longest of these is $4,852,300,681, which
          wants 151px at `text-lg` and has 128 in a two-up phone layout and 149
          in a four-up desktop one — so the breakpoint that would make the
          others bigger only ever clips this one. */}
      <div className="mt-1 font-mono text-[15px] tabular-nums text-slate-100">{value}</div>
    </div>
  );
}

function Holdings({
  totals,
  sources,
}: {
  totals: Awaited<ReturnType<typeof methods>>['totals'];
  sources: Awaited<ReturnType<typeof methods>>['sources'];
}) {
  const feeds = sources.filter((s) => s.records > 0);
  return (
    <div className="mt-6 max-w-3xl">
      {/* Set as a heading, because that is what it is: everything under it —
          the four figures and the feeds they come from — is the short version
          of what that page says at length. */}
      <Link
        href="/methods-and-sources"
        className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-100
                   underline-offset-4 hover:text-indigo-300 hover:underline"
      >
        Methods and sources
      </Link>

      {/* Two across on a phone, four on anything wider. Four 20-character
          columns on a 375px screen is four columns of nothing. */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Filings" value={num(totals.records)} />
        <Stat label="Latest pull" value={day(totals.lastFiled)} />
        <Stat label="Dollars tracked" value={formatMoneyFull(totals.amount)} />
        <Stat label="Filers" value={num(totals.entities)} />
      </div>

      <ul className="mt-4 space-y-0.5">
        {feeds.map((s) => (
          <li key={s.key} className="flex items-baseline gap-2 text-sm text-slate-300">
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
              {years(s.firstFiled, s.lastFiled)}
            </span>
            <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-slate-300">
              {num(s.records)}
            </span>
          </li>
        ))}
      </ul>
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
          <PanelHeading info="Committees that have paid out the most, across every cycle in the database.">
            Biggest PACs
          </PanelHeading>
          <ul className="mt-3 divide-y divide-slate-900 rounded border border-slate-800">
            {busiest.map((c) => (
              <li key={c.id}>
                <Link
                  href={committeeHref(c)}
                  className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-slate-900/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-200">{c.name}</span>
                    <span className="block truncate text-xs text-slate-400">
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
          <PanelHeading info="People who control the most PACs as both Chairman and Treasurer. The figure is what those committees raised.">
            Biggest Networks
          </PanelHeading>
          <ul className="mt-3 divide-y divide-slate-900 rounded border border-slate-800">
            {operators.map((p) => (
              <li key={p.normalizedName}>
                <Link
                  href={`/kym/person/${p.slug}`}
                  className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-slate-900/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-200">{p.name}</span>
                    <span className="block truncate text-xs text-slate-400">
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

      <p className="mt-8 max-w-3xl text-xs leading-relaxed text-slate-400">
        Figures are as filed with the Florida Division of Elections and the county supervisors of
        elections, and may be amended.
      </p>
    </main>
  );
}
