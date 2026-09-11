/**
 * One committee's report, reachable by the name printed on its mail.
 *
 * Two questions, in the order a mailer's recipient asks them. Who paid for
 * this, and what did they spend it on.
 *
 * "Donors" here is the traced answer, not the filed one. A committee's
 * contributor list names whoever wrote the check, and in Florida's transfer
 * layer that is routinely another committee — so the filed list names the next
 * committee to go and read rather than anybody who originated money. The trace
 * follows those transfers to the end. See `src/lib/graph/trace.ts` for the
 * method and its limits.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { db } from '@/db';
import { ledger, type LedgerSourceRow } from '@/lib/graph/ledger';
import { trace, type TraceResult } from '@/lib/graph/trace';
import {
  committeeById,
  committeeHref,
  committeesBySlug,
  searchCommittees,
  type CommitteeSubject,
} from '@/lib/graph/committee';
import { formatMoney, formatMoneyFull, kindLabel } from '@/lib/graph/types';
import CommitteeSearch from '@/components/CommitteeSearch';

export const dynamic = 'force-dynamic';

/**
 * Rows shown per list.
 *
 * Both lists run long — a committee funded through the transfer layer traces
 * back to hundreds of originators — and the two stacked sections are the whole
 * point of the page. At a hundred rows each, nobody scrolling for the donors
 * ever reaches the payments. The captions carry the full count and the full
 * total, so the cap hides rows without hiding money.
 */
const LIST_ROWS = 25;

/** Rows for the committees whose own funding is unknown. */
const DEAD_ENDS = 10;

/** How far the trace chases a chain, and the floor below which a strand is dropped. */
const TRACE = { maxDepth: 12, minDollars: 100, dateOrdered: true };

type Params = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ id?: string; cycle?: string }>;
};

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Which committee this URL means.
 *
 * `?id=` pins one, and is what the search box and every internal link carry. A
 * bare slug is what a shared or hand-typed link carries, and it can be
 * ambiguous: three separate committees file as "Florida Forward". The page
 * asks rather than guessing, so `matches` comes back whole.
 */
async function resolve(p: Params): Promise<{
  slug: string;
  cycle?: string;
  subject: CommitteeSubject | null;
  matches: CommitteeSubject[];
}> {
  const { slug } = await p.params;
  const { id, cycle } = await p.searchParams;

  if (id && UUID.test(id)) {
    const subject = await committeeById(db, id);
    if (subject) return { slug, cycle, subject, matches: [subject] };
  }

  const matches = await committeesBySlug(db, slug);
  return { slug, cycle, subject: matches.length === 1 ? matches[0] : null, matches };
}

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { subject } = await resolve({ params, searchParams });
  if (!subject) return { title: 'Know Your Mailer — PAC Tracker' };
  return {
    title: `${subject.name} — Know Your Mailer`,
    description: `${subject.name} has raised ${formatMoneyFull(subject.totalReceived)} and paid out ${formatMoneyFull(subject.totalGiven)}.`,
  };
}

function Money({ value, tone }: { value: string | number; tone: 'in' | 'out' | 'flat' }) {
  const color =
    tone === 'in' ? 'text-emerald-400' : tone === 'out' ? 'text-amber-400' : 'text-slate-400';
  return <span className={`font-mono tabular-nums ${color}`}>{formatMoneyFull(value)}</span>;
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">{children}</h2>
  );
}

/**
 * What a truncated list is a slice of.
 *
 * Always states the full count and the full total, so a capped list never
 * reads as the whole of the money.
 */
function Shown({ shown, total, amount }: { shown: number; total: number; amount: number }) {
  return (
    <p className="mt-1 text-xs text-slate-600">
      {shown < total
        ? `showing the largest ${shown.toLocaleString()} of ${total.toLocaleString()}`
        : `${total.toLocaleString()} in total`}
      , {formatMoneyFull(amount)}
    </p>
  );
}

/* ------------------------------------------------------------------ donors */

/**
 * How much of the money the trace could account for.
 *
 * Sits above the list rather than under it on purpose. A set of origins
 * covering a quarter of the money reads as a complete answer unless what it
 * leaves out is on the screen beside it.
 */
function Coverage({ result }: { result: TraceResult }) {
  const traced = result.sources.reduce((a, b) => a + b.amount, 0);
  const viaPools = result.injectionPoints.reduce((a, b) => a + b.amount, 0);
  const unresolved = result.unresolved.reduce((a, b) => a + b.amount, 0);
  const pct = (n: number) => (result.seed.total > 0 ? (n / result.seed.total) * 100 : 0);

  const bar = (label: string, value: number, className: string) =>
    value <= 0 ? null : (
      <div key={label} className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-[11px] text-slate-500">{label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
          <div className={`h-full ${className}`} style={{ width: `${pct(value)}%` }} />
        </div>
        <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-slate-400">
          {formatMoney(value)} · {pct(value).toFixed(0)}%
        </span>
      </div>
    );

  return (
    <div className="mt-2 space-y-1.5 rounded border border-slate-800 p-3">
      {bar('Traced', traced, 'bg-emerald-500')}
      {bar('National pool', viaPools, 'bg-sky-500')}
      {bar('Trail ends', unresolved, 'bg-slate-500')}
      {bar('Long tail', result.dispersed, 'bg-slate-700')}
      <p className="pt-1 text-[11px] leading-relaxed text-slate-600">
        Money in an account is fungible, so a committee that took $1M and passed on $100K passed on
        10% of each of its own sources. That is the claim here, over {result.hops} hops. It is a
        claim about proportions, not about the route a particular dollar took.
      </p>
    </div>
  );
}

/**
 * Where the committee's money originated, past the conduits.
 *
 * Streamed in its own boundary. A trace walks the whole graph and takes a few
 * seconds; holding the rest of the page back for it would leave a reader
 * staring at nothing while the part they can already be shown sits ready.
 */
async function Donors({ subject, cycle }: { subject: CommitteeSubject; cycle?: string }) {
  const result = await trace(db, subject.id, { ...TRACE, cycle });

  if (result.sources.length === 0 && result.injectionPoints.length === 0) {
    return (
      <p className="mt-2 rounded border border-slate-800 px-4 py-6 text-sm text-slate-500">
        No originating donors found. Every path out of this committee ends at one with no recorded
        money coming in.
      </p>
    );
  }

  return (
    <div>
      <Coverage result={result} />

      <Shown
        shown={Math.min(result.sources.length, LIST_ROWS)}
        total={result.sources.length}
        amount={result.sources.reduce((a, b) => a + b.amount, 0)}
      />
      <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
        {result.sources.slice(0, LIST_ROWS).map((s) => (
          <li key={s.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-200">{s.name}</span>
              <span className="block text-xs text-slate-500">
                {s.kind} · {s.hop} hop{s.hop === 1 ? '' : 's'} away
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm">
                <Money value={s.amount} tone="in" />
              </span>
              <span className="block text-xs tabular-nums text-slate-500">
                {(s.share * 100).toFixed(1)}%
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* Kept apart from the list above, and never added to it. The pool's own
          funders are known; the share of the pool that reached Florida is not. */}
      {result.injectionPoints.map((p) => (
        <div key={p.id} className="mt-4 rounded border border-sky-900/60 bg-sky-950/20 p-4">
          <p className="text-[11px] uppercase tracking-wide text-sky-400">
            Entered Florida through a national pool
          </p>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{p.name}</span>
            <span className="shrink-0 font-mono text-sm tabular-nums text-sky-300">
              {formatMoneyFull(p.amount)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Raised nationally and spent across many states. Its own funders are below, as shares of{' '}
            <em>its</em> money — not of {subject.name}. The two cannot be multiplied together,
            because no filing says which share of this pool came to Florida.
          </p>
          <ul className="mt-2 divide-y divide-slate-800/60 border-t border-slate-800/60">
            {p.funders.map((f) => (
              <li key={f.id} className="flex items-baseline gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{f.name}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
                  {formatMoney(f.amount)}
                </span>
                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-500">
                  {(f.share * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {result.unresolved.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Trail ends here</p>
          <p className="mt-1 text-xs text-slate-600">
            These committees paid in, and nothing on file says where they got it.
          </p>
          {/* Shorter than the donor list on purpose. This is a statement about
              the limits of the data, and ten rows make it as well as fifty. */}
          <Shown
            shown={Math.min(result.unresolved.length, DEAD_ENDS)}
            total={result.unresolved.length}
            amount={result.unresolved.reduce((a, b) => a + b.amount, 0)}
          />
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {result.unresolved.slice(0, DEAD_ENDS).map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 px-4 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{s.name}</span>
                <span className="shrink-0 font-mono text-sm tabular-nums text-slate-400">
                  {formatMoney(s.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- payments out */

async function Payments({ subject, cycle }: { subject: CommitteeSubject; cycle?: string }) {
  const result = await ledger(db, [subject.id], {
    view: 'sources',
    direction: 'out',
    sort: 'amount',
    order: 'desc',
    limit: LIST_ROWS,
    offset: 0,
    cycle,
  });
  const rows = result.rows as LedgerSourceRow[];

  if (rows.length === 0) {
    return (
      <p className="mt-2 rounded border border-slate-800 px-4 py-6 text-sm text-slate-500">
        No payments out on file for this committee.
      </p>
    );
  }

  return (
    <div>
      <Shown shown={rows.length} total={result.total} amount={Number(result.totalAmount)} />
      <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
        {rows.map((r) => (
          <li key={`${r.entity_id}-${r.flow}`} className="flex items-start gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-200">{r.name}</span>
              {r.industry && (
                <span className="block truncate text-xs text-slate-500">{r.industry}</span>
              )}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-slate-600">
              ×{r.txn_count}
            </span>
            <span className="shrink-0 text-sm">
              <Money value={r.amount} tone="out" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------ the page */

function Skeleton({ label }: { label: string }) {
  return (
    <p className="mt-2 rounded border border-slate-800 px-4 py-6 text-sm text-slate-500">{label}</p>
  );
}

/** Nobody files under this name. Offer the near misses instead of a bare 404. */
async function NotFound({ slug }: { slug: string }) {
  const near = await searchCommittees(db, slug.replace(/[-_]+/g, ' '), 8);
  return (
    <main className="mt-8">
      <h2 className="text-xl font-semibold text-slate-100">No committee files under that name</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
        Nothing in the database is registered as{' '}
        <span className="text-slate-200">{slug.replace(/[-_]+/g, ' ')}</span>. Committee names on
        mail are often shortened, so try searching for part of it.
      </p>
      <div className="mt-5">
        <CommitteeSearch autoFocus />
      </div>
      {near.length > 0 && (
        <section className="mt-8">
          <SectionHeading>Closest names on file</SectionHeading>
          <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
            {near.map((c) => (
              <li key={c.id}>
                <Link
                  href={committeeHref(c)}
                  className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-slate-900/60"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{c.name}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-emerald-400">
                    {formatMoney(c.totalReceived)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * Several committees file under this one name.
 *
 * Folding them together would invent a committee that does not exist and hand
 * the reader a total nobody ever raised, so the choice goes back to them. The
 * account number is what actually separates these: it is the filing office's
 * own identifier, and it is the only field guaranteed to differ.
 */
function Chooser({ slug, matches }: { slug: string; matches: CommitteeSubject[] }) {
  return (
    <main className="mt-8">
      <h2 className="text-xl font-semibold text-slate-100">
        {matches.length} committees file under this name
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
        They are separate registrations with separate money, and the state lets them share a name.
        Pick the one you mean.
      </p>
      <ul className="mt-5 divide-y divide-slate-900 rounded border border-slate-800">
        {matches.map((c) => (
          <li key={c.id}>
            <Link
              href={`/kym/${slug}?id=${c.id}`}
              className="block px-4 py-3 hover:bg-slate-900/60 sm:flex sm:items-baseline sm:gap-3"
            >
              <span className="sm:min-w-0 sm:flex-1">
                <span className="block truncate text-sm text-slate-200">{c.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {c.accountNumber ? `account ${c.accountNumber}` : 'no account number on file'}
                  {c.city ? ` · ${c.city}, ${c.stateCode ?? ''}` : ''}
                  {c.firstDate ? ` · active from ${c.firstDate}` : ''}
                </span>
              </span>
              <span className="mt-1 block shrink-0 text-sm sm:mt-0">
                <Money value={c.totalReceived} tone="in" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default async function KymCommitteePage({ params, searchParams }: Params) {
  const { slug, cycle, subject, matches } = await resolve({ params, searchParams });

  if (!subject) {
    return matches.length === 0 ? <NotFound slug={slug} /> : <Chooser slug={slug} matches={matches} />;
  }

  const scope = cycle ? `${cycle.slice(0, 4)} cycle` : 'all cycles on file';
  const identity = [
    kindLabel({ kind: subject.kind, committeeType: subject.committeeType }),
    subject.city ? `${subject.city}, ${subject.stateCode ?? ''}`.trim() : null,
    subject.accountNumber ? `account ${subject.accountNumber}` : null,
    subject.status === 'closed' ? 'closed' : null,
  ].filter(Boolean);

  return (
    <main className="mt-8">
      <h2 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
        {subject.name}
      </h2>
      <p className="mt-1 text-sm text-slate-400">{identity.join(' · ')}</p>
      {subject.firstDate && subject.lastDate && (
        <p className="mt-0.5 text-xs text-slate-600">
          Filings on file from {subject.firstDate} to {subject.lastDate}.
        </p>
      )}

      {/* Stacks on a narrow phone. Two columns cannot hold a nine-figure sum
          beside another one, and a statewide committee produces those. */}
      <div className="mt-6 grid grid-cols-2 gap-3 max-[400px]:grid-cols-1">
        <Tile label="Raised" value={subject.totalReceived} tone="in">
          from {subject.inDegree.toLocaleString()} contributor
          {subject.inDegree === 1 ? '' : 's'}
        </Tile>
        <Tile label="Paid out" value={subject.totalGiven} tone="out">
          to {subject.outDegree.toLocaleString()} recipient{subject.outDegree === 1 ? '' : 's'}
        </Tile>
      </div>

      <section className="mt-8">
        <SectionHeading>Donors · {scope}</SectionHeading>
        <p className="mt-1 text-xs text-slate-600">
          Followed past committee-to-committee transfers to whoever originated the money, not
          whoever wrote the check.
        </p>
        <Suspense fallback={<Skeleton label="Following the money…" />}>
          <Donors subject={subject} cycle={cycle} />
        </Suspense>
      </section>

      <section className="mt-8">
        <SectionHeading>Payments out · {scope}</SectionHeading>
        <p className="mt-1 text-xs text-slate-600">
          Everyone this committee paid, largest first. Mail vendors, consultants and transfers to
          other committees all appear here.
        </p>
        <Suspense fallback={<Skeleton label="Reading the ledger…" />}>
          <Payments subject={subject} cycle={cycle} />
        </Suspense>
      </section>

      <div className="mt-8">
        <SectionHeading>Look up another committee</SectionHeading>
        <div className="mt-2">
          <CommitteeSearch />
        </div>
      </div>

      <p className="mt-8 text-xs leading-relaxed text-slate-600">
        Figures are as filed with the Florida Division of Elections and the county supervisors of
        elections, and may be amended.
      </p>
    </main>
  );
}
