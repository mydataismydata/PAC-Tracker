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
import { formatMoneyFull } from '@/lib/graph/types';

export const dynamic = 'force-dynamic';

/**
 * Every counterparty goes on the page, not a top-N slice — the point of a
 * summary page is that the reader does not have to drive a graph to see who
 * paid. The ceiling is a blast-radius guard, not an editorial choice: nine
 * entities in this database have over ten thousand distinct donors and the
 * largest has 144,107, which on a public uncached route would be tens of
 * megabytes per request. Where it engages, the page says so.
 */
const CEILING = 5000;

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

        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
              Donors · {scope}
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
