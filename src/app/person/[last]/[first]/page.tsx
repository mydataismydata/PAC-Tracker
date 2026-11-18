/**
 * One politician's money, on a page you can link to by name.
 *
 * The landing page for links arriving from elsewhere — a bill page naming a
 * sponsor, say. It answers "who funds this person" without the reader having
 * to know that Florida splits them across a campaign account per office sought
 * plus an affiliated committee, and without making them drive a graph.
 *
 * "Who funds" means who the money started with. A legislator's filed donor
 * list is mostly political committees, which only name the next committee to
 * go and read. So the donor column is the traced one the committee reports
 * use: it follows those transfers back to the people and companies that put
 * the money in. See `src/components/kym/report.tsx`.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { db } from '@/db';
import { committeeSlug } from '@/lib/graph/committee';
import { resolvePerson } from '@/lib/graph/person';
import { cyclesOnFile, entityTotals, ledger } from '@/lib/graph/ledger';
import { formatMoneyFull } from '@/lib/graph/types';
import { isNarrowed, periodLabel, readPeriod, withPeriod } from '@/lib/kym/period';
import HostedBy from '@/components/HostedBy';
import PeriodFilter from '@/components/kym/PeriodFilter';
import { Money, MoneyColumns, Tile } from '@/components/kym/report';

export const dynamic = 'force-dynamic';

/**
 * Every date on file by default. A sponsor arriving from a bill page is being
 * looked up as a person, not as a campaign, so their whole record is the honest
 * answer. `?cycle=20261103-GEN` narrows it to a session, and
 * `?from=2025-11-01&to=2026-01-01` to a range of days; a bill page links in
 * with both. See `src/lib/kym/period.ts`.
 */
type Params = {
  params: Promise<{ last: string; first: string }>;
  searchParams: Promise<{ cycle?: string; from?: string; to?: string }>;
};

async function load(p: Params['params']) {
  const { last, first } = await p;
  return resolvePerson(db, decodeURIComponent(last), decodeURIComponent(first));
}

export async function generateMetadata({ params }: Pick<Params, 'params'>): Promise<Metadata> {
  const person = await load(params);
  if (!person) return { title: 'Not found — PAC Tracker' };
  return {
    title: `${person.name} — PAC Tracker`,
    description: `Campaign finance for ${person.name}: ${person.parts.length} filings, ${formatMoneyFull(person.totalReceived)} raised.`,
  };
}

export default async function PersonPage({ params, searchParams }: Params) {
  const person = await load(params);
  if (!person) notFound();

  const period = readPeriod(await searchParams);
  const scope = periodLabel(period);

  // Only the totals are wanted from the ledger. The lists below draw their
  // own rows, and over the same period these totals are what they add up to.
  const totalsOf = (direction: 'in' | 'out') =>
    ledger(db, person.entityIds, {
      view: 'sources',
      direction,
      sort: 'amount',
      order: 'desc',
      limit: 0,
      offset: 0,
      ...period,
    });
  const [received, given, cycles, amounts] = await Promise.all([
    totalsOf('in'),
    totalsOf('out'),
    cyclesOnFile(db, person.entityIds),
    isNarrowed(period) ? entityTotals(db, person.entityIds, period) : null,
  ]);

  // Seed the graph on whichever filing holds the most; it is the one whose
  // neighbourhood is worth drawing.
  const biggest = person.parts[0];

  // Each filing's own figure covers the same period as the totals above it,
  // and the filings re-sort on it, so the account that raised the most in the
  // period comes first.
  const parts = amounts
    ? person.parts
        .map((p) => ({ ...p, totalReceived: amounts.get(p.id)?.received ?? '0' }))
        .sort((a, b) => Number(b.totalReceived) - Number(a.totalReceived))
    : person.parts;

  return (
    // The root layout locks the body to the viewport with overflow-hidden,
    // because the graph explorer owns its own scrolling. This is an ordinary
    // document and has to scroll itself, or everything below the fold is
    // unreachable.
    <div className="h-dvh overflow-y-auto">
      <main className="mx-auto max-w-3xl px-5 py-10 text-slate-100">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
          Florida campaign finance
        </p>
        <HostedBy short className="mt-0.5" />
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{person.name}</h1>
        {person.offices.length > 0 && (
          <p className="mt-1 text-sm text-slate-400">
            {person.parts
              .filter((p) => p.officeLabel)
              .map((p) => `${p.officeLabel}${p.party ? ` (${p.party})` : ''}`)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(' · ')}
          </p>
        )}

        <PeriodFilter period={period} cycles={cycles} />

        {/* Stacks on a narrow phone. Two columns cannot hold a nine-figure sum
            beside another one, and a governor's race produces those. The
            figures are the totals of the two lists below, over the same
            period. */}
        <div className="mt-2 grid grid-cols-2 gap-3 max-[400px]:grid-cols-1">
          <Tile label="Raised" value={received.totalAmount} tone="in">
            across {person.parts.length} filing{person.parts.length === 1 ? '' : 's'}
          </Tile>
          <Tile label="Spent" value={given.totalAmount} tone="out">
            to {given.total.toLocaleString()} recipient{given.total === 1 ? '' : 's'}
          </Tile>
        </div>

        {/* The split is the point: linking to any one of these understates the
            money, usually by a lot. */}
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
            The filings · {scope}
          </h2>
          {/* Rows wrap on a phone. Kind, name and a nine-figure sum on one line
              leaves the name as "Donalds…", which is the one part of the row a
              reader needs to tell two filings apart. */}
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {parts.map((p) => (
              <li key={p.id} className="px-4 py-3 sm:flex sm:items-baseline sm:gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wide text-slate-600 sm:w-16 sm:shrink-0">
                  {p.kind}
                </span>
                {/* Each filing opens as its own report: the donors and payments
                    of that one account, without the graph explorer and
                    without a sign-in. The id is pinned because a candidate
                    files under the same name once per office sought. */}
                <Link
                  href={withPeriod(`/kym/${committeeSlug(p.name)}?id=${p.id}`, period)}
                  className="mt-0.5 block truncate text-sm text-slate-200 underline-offset-2 hover:text-indigo-300 hover:underline sm:mt-0 sm:min-w-0 sm:flex-1"
                >
                  {p.name}
                </Link>
                <span className="mt-0.5 block text-sm sm:mt-0 sm:shrink-0">
                  <Money value={p.totalReceived} tone="in" />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <MoneyColumns
          ids={person.entityIds}
          subject={person.name}
          period={period}
          paymentsHint="Everyone these accounts paid, pooled and largest first. Mail vendors, consultants and transfers to other committees all appear here."
        />

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href={`/?seed=${biggest.id}&cycle=${period.cycle ?? ''}&depth=2&direction=both&linkMode=direct`}
            className="rounded bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Open the money graph
          </Link>
        </div>

        {/* Never silently folded in: same surname, different person. */}
        {person.sameSurname.length > 0 && (
          <p className="mt-8 border-t border-slate-800 pt-4 text-xs leading-relaxed text-slate-500">
            {person.sameSurname.length} other filing
            {person.sameSurname.length === 1 ? '' : 's'} share the surname{' '}
            {person.last.charAt(0).toUpperCase() + person.last.slice(1).toLowerCase()} but a
            different given name, and are not counted above
            {person.sameSurname.length <= 4 && (
              <> — {person.sameSurname.map((s) => s.name).join(', ')}</>
            )}
            .
          </p>
        )}

        <p className="mt-6 text-xs leading-relaxed text-slate-600">
          Figures are as filed with the Florida Division of Elections and may be amended.
        </p>
      </main>
    </div>
  );
}
