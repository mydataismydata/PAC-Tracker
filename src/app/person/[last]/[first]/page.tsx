/**
 * One politician's money, on a page you can link to by name.
 *
 * The landing page for links arriving from elsewhere — a bill page naming a
 * sponsor, say. It answers "who funds this person" without the reader having
 * to know that Florida splits them across a campaign account per office sought
 * plus an affiliated committee, and without making them drive a graph.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { db } from '@/db';
import { committeeSlug } from '@/lib/graph/committee';
import { resolvePerson } from '@/lib/graph/person';
import { ledger, type LedgerResult, type LedgerSourceRow } from '@/lib/graph/ledger';
import { formatMoneyFull } from '@/lib/graph/types';
import HostedBy from '@/components/HostedBy';

export const dynamic = 'force-dynamic';

/** Rows per list. Enough to read; not so many the page stops being a summary. */
const CEILING = 100;

/**
 * Every cycle on file by default. A sponsor arriving from a bill page is being
 * looked up as a person, not as a campaign, so their whole record is the honest
 * answer; `?cycle=20261103-GEN` narrows it.
 *
 * `?from=2025-11-01&to=2026-01-01` narrows it to the money dated inside those
 * days, both ends included. A bill page uses it to show who gave in the weeks
 * around the day a bill was filed. Either end works alone.
 */
const ALL_CYCLES = { label: 'all cycles on file', param: '' };

type Params = {
  params: Promise<{ last: string; first: string }>;
  searchParams: Promise<{ cycle?: string; from?: string; to?: string }>;
};

/**
 * A query-string date, or undefined when it is not a real day.
 *
 * Checked here rather than left to Postgres: a cast of 2026-02-30 fails the
 * query, and the reader gets an error page instead of the unfiltered one.
 */
function day(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

/** `2025-11-09` → `Nov 9, 2025`. In UTC, so the server's zone cannot shift the day. */
const DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const showDay = (value: string) => DAY.format(new Date(`${value}T00:00:00Z`));

/** The date window as a reader would say it, or '' when there is none. */
function span(from?: string, to?: string): string {
  if (from && to) return `${showDay(from)} – ${showDay(to)}`;
  if (from) return `from ${showDay(from)}`;
  if (to) return `up to ${showDay(to)}`;
  return '';
}

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

function Money({ value, tone }: { value: string; tone: 'in' | 'out' }) {
  return (
    <span
      className={`font-mono tabular-nums ${tone === 'in' ? 'text-emerald-400' : 'text-amber-400'}`}
    >
      {formatMoneyFull(value)}
    </span>
  );
}

function Rows({ rows, tone }: { rows: LedgerSourceRow[]; tone: 'in' | 'out' }) {
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-sm text-slate-500">Nothing filed in this period.</p>;
  }
  return (
    <ul className="divide-y divide-slate-900">
      {rows.map((r) => (
        <li key={`${r.entity_id}-${r.flow}`} className="flex items-baseline gap-3 px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{r.name}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-slate-600">
            ×{r.txn_count}
          </span>
          <span className="shrink-0 text-sm">
            <Money value={r.amount} tone={tone} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A headline figure.
 *
 * The type size comes off the length of the number rather than the viewport:
 * $196,500 and $125,502,148 need different treatment in the same box, and only
 * one of them is knowable from a breakpoint.
 */
function Tile({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone: 'in' | 'out';
  children: React.ReactNode;
}) {
  const text = formatMoneyFull(value);
  const size =
    text.length > 11 ? 'text-lg sm:text-2xl' : text.length > 8 ? 'text-xl sm:text-2xl' : 'text-2xl';

  return (
    <div
      className={`min-w-0 rounded border p-4 ${
        tone === 'in' ? 'border-emerald-900 bg-emerald-950/30' : 'border-slate-800 bg-slate-900/40'
      }`}
    >
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`mt-1 font-mono font-semibold tabular-nums ${size} ${
          tone === 'in' ? 'text-emerald-400' : 'text-amber-400'
        }`}
      >
        {text}
      </div>
      <div className="mt-1 text-xs text-slate-500">{children}</div>
    </div>
  );
}

function Caption({ result }: { result: LedgerResult }) {
  const shown = result.rows.length;
  return (
    <p className="mt-1 text-xs text-slate-600">
      {shown < result.total
        ? `showing the largest ${shown.toLocaleString()} of ${result.total.toLocaleString()}`
        : `${result.total.toLocaleString()} in total`}
      , {formatMoneyFull(result.totalAmount)}
    </p>
  );
}

export default async function PersonPage({ params, searchParams }: Params) {
  const person = await load(params);
  if (!person) notFound();

  const query = await searchParams;
  const cycle = query.cycle || undefined;
  const dateFrom = day(query.from);
  const dateTo = day(query.to);
  const dates = span(dateFrom, dateTo);
  const year = cycle?.slice(0, 4);
  const scope =
    [year ? `${year} cycle` : '', dates].filter(Boolean).join(', ') || ALL_CYCLES.label;
  // The same narrowing, worded for the sentence at the foot of the page.
  const reach = [year ? `the ${year} cycle` : '', dates].filter(Boolean).join(', ');
  const cycleParam = cycle ?? ALL_CYCLES.param;

  const base = {
    view: 'sources' as const,
    sort: 'amount' as const,
    order: 'desc' as const,
    limit: CEILING,
    offset: 0,
    cycle,
    dateFrom,
    dateTo,
  };
  const [received, given] = await Promise.all([
    ledger(db, person.entityIds, { ...base, direction: 'in' }),
    ledger(db, person.entityIds, { ...base, direction: 'out' }),
  ]);

  // Seed the graph on whichever filing holds the most; it is the one whose
  // neighbourhood is worth drawing.
  const biggest = person.parts[0];

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

        {/* Stacks on a narrow phone. Two columns cannot hold a nine-figure sum
            beside another one, and a governor's race produces those. */}
        <div className="mt-6 grid grid-cols-2 gap-3 max-[400px]:grid-cols-1">
          <Tile label="Raised" value={person.totalReceived} tone="in">
            across {person.parts.length} filing{person.parts.length === 1 ? '' : 's'}
          </Tile>
          <Tile label="Spent" value={person.totalGiven} tone="out">
            {ALL_CYCLES.label}
          </Tile>
        </div>

        {/* The split is the point: linking to any one of these understates the
            money, usually by a lot. */}
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
            The filings
          </h2>
          {/* Rows wrap on a phone. Kind, name and a nine-figure sum on one line
              leaves the name as "Donalds…", which is the one part of the row a
              reader needs to tell two filings apart. */}
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {person.parts.map((p) => (
              <li key={p.id} className="px-4 py-3 sm:flex sm:items-baseline sm:gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wide text-slate-600 sm:w-16 sm:shrink-0">
                  {p.kind}
                </span>
                {/* Each filing opens as its own report: the donors and payments
                    of that one account, without the graph explorer and
                    without a sign-in. The id is pinned because a candidate
                    files under the same name once per office sought. */}
                <Link
                  href={`/kym/${committeeSlug(p.name)}?id=${p.id}${cycle ? `&cycle=${cycle}` : ''}`}
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

        {/* min-w-0 on the columns is load-bearing: a grid item's automatic
            minimum size is its content's min-content width, so without it the
            column refuses to shrink below the longest donor name and the
            amounts end up off-screen on a phone. */}
        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              Donors · {scope}
            </h2>
            <Caption result={received} />
            <div className="mt-2 rounded border border-slate-800">
              <Rows rows={received.rows as LedgerSourceRow[]} tone="in" />
            </div>
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              Payments out · {scope}
            </h2>
            <Caption result={given} />
            <div className="mt-2 rounded border border-slate-800">
              <Rows rows={given.rows as LedgerSourceRow[]} tone="out" />
            </div>
          </div>
        </section>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href={`/?seed=${biggest.id}&cycle=${cycleParam}&depth=2&direction=both&linkMode=direct`}
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
          {reach
            ? `Headline totals cover every cycle on file; the donor and payment lists cover ${reach} only.`
            : 'Every cycle on file.'}{' '}
          Figures are as filed with the Florida Division of Elections and may be amended.
        </p>
      </main>
    </div>
  );
}
