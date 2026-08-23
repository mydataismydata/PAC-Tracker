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
import { resolvePerson } from '@/lib/graph/person';
import { ledger, type LedgerResult, type LedgerSourceRow } from '@/lib/graph/ledger';
import { trace, type TraceResult } from '@/lib/graph/trace';
import { formatMoneyFull } from '@/lib/graph/types';

export const dynamic = 'force-dynamic';

/** Rows per list. Enough to read; not so many the page stops being a summary. */
const CEILING = 100;

/**
 * Every cycle on file by default. A sponsor arriving from a bill page is being
 * looked up as a person, not as a campaign, so their whole record is the honest
 * answer; `?cycle=20261103-GEN` narrows it.
 */
const ALL_CYCLES = { label: 'all cycles on file', param: '' };

type Params = {
  params: Promise<{ last: string; first: string }>;
  searchParams: Promise<{ cycle?: string }>;
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
    return <p className="px-4 py-6 text-sm text-slate-500">Nothing filed for this cycle.</p>;
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

function pct(share: number): string {
  const v = share * 100;
  return v >= 10 ? `${Math.round(v)}%` : v >= 1 ? `${v.toFixed(1)}%` : '<1%';
}

/**
 * Where the money started, not who handed it over.
 *
 * A committee's donor list is the next set of committees to read, not an
 * answer. This is the same trace the graph's Funding origins tab runs.
 */
function Origins({ result, scope }: { result: TraceResult; scope: string }) {
  const shown = result.sources.slice(0, CEILING);
  const capped = result.sources.length > shown.length;

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
        Funding origins · {scope}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        Committee-to-committee transfers followed back to whoever originated the money.
        Attribution is pro-rata: a conduit that took $1M and passed on $100k passed on 10% of
        each of its own sources.
      </p>
      <p className="mt-1 text-xs text-slate-600">
        {capped
          ? `showing the largest ${shown.length.toLocaleString()} of ${result.sources.length.toLocaleString()}`
          : `${result.sources.length.toLocaleString()} in total`}
        {result.hops > 0 && `, over ${result.hops} hop${result.hops === 1 ? '' : 's'}`}
      </p>

      <div className="mt-2 rounded border border-slate-800">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            Nothing traced past the direct donors.
          </p>
        ) : (
          <ul className="divide-y divide-slate-900">
            {shown.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{s.name}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-slate-600">
                  {pct(s.share)}
                </span>
                <span className="shrink-0 font-mono text-sm tabular-nums text-emerald-400">
                  {formatMoneyFull(String(s.amount))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Kept out of the list above rather than folded in: for each of these the
          funders are known but the share that reached Florida is not, so adding
          them to the totals would be inventing a number. */}
      {result.injectionPoints.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Part of this money entered Florida through{' '}
          {result.injectionPoints.map((p) => p.name).join(', ')}. What each of those pools was
          itself funded by is disclosed; what share of it reached this chain is not, so they are
          named here rather than counted above.
        </p>
      )}
      {(result.unresolved.length > 0 || result.dispersed > 0) && (
        <p className="mt-2 text-xs leading-relaxed text-slate-600">
          {result.unresolved.length > 0 &&
            `${result.unresolved.length} conduit${result.unresolved.length === 1 ? '' : 's'} had no traceable upstream. `}
          {result.dispersed > 0 &&
            `${formatMoneyFull(String(result.dispersed))} was spread too thin to follow and is not attributed.`}
        </p>
      )}
    </section>
  );
}

export default async function PersonPage({ params, searchParams }: Params) {
  const person = await load(params);
  if (!person) notFound();

  const cycle = (await searchParams).cycle || undefined;
  const scope = cycle ? `${cycle.slice(0, 4)} cycle` : ALL_CYCLES.label;
  const cycleParam = cycle ?? ALL_CYCLES.param;

  const base = {
    view: 'sources' as const,
    sort: 'amount' as const,
    order: 'desc' as const,
    limit: CEILING,
    offset: 0,
    cycle,
  };
  const [received, given, origins] = await Promise.all([
    ledger(db, person.entityIds, { ...base, direction: 'in' }),
    ledger(db, person.entityIds, { ...base, direction: 'out' }),
    // Same options the graph's Funding origins tab uses, so the two agree.
    // A failed trace must not take the whole page down with it.
    trace(db, person.entityIds, {
      maxDepth: 12,
      minDollars: 100,
      dateOrdered: true,
      cycle,
    }).catch(() => null),
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

        <div className="mt-6 grid grid-cols-2 gap-3">
          <div className="rounded border border-emerald-900 bg-emerald-950/30 p-4">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Raised</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-emerald-400">
              {formatMoneyFull(person.totalReceived)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              across {person.parts.length} filing{person.parts.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/40 p-4">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Spent</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-amber-400">
              {formatMoneyFull(person.totalGiven)}
            </div>
            <div className="mt-1 text-xs text-slate-500">{ALL_CYCLES.label}</div>
          </div>
        </div>

        {/* The split is the point: linking to any one of these understates the
            money, usually by a lot. */}
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
            The filings
          </h2>
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {person.parts.map((p) => (
              <li key={p.id} className="flex items-baseline gap-3 px-4 py-3">
                <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wide text-slate-600">
                  {p.kind}
                </span>
                <Link
                  href={`/?seed=${p.id}&cycle=${cycleParam}`}
                  className="min-w-0 flex-1 truncate text-sm text-slate-200 underline-offset-2 hover:text-indigo-300 hover:underline"
                >
                  {p.name}
                </Link>
                <span className="shrink-0 text-sm">
                  <Money value={p.totalReceived} tone="in" />
                </span>
              </li>
            ))}
          </ul>
        </section>

        {origins && <Origins result={origins} scope={scope} />}

        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              Direct donors · {scope}
            </h2>
            <Caption result={received} />
            <div className="mt-2 rounded border border-slate-800">
              <Rows rows={received.rows as LedgerSourceRow[]} tone="in" />
            </div>
          </div>
          <div>
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
          {cycle
            ? `Headline totals cover every cycle on file; the donor and payment lists are the ${scope}.`
            : 'Every cycle on file.'}{' '}
          Figures are as filed with the Florida Division of Elections and may be amended.
        </p>
      </main>
    </div>
  );
}
