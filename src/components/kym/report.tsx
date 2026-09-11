/**
 * The money report: donors on the left, payments on the right.
 *
 * Shared by the two subjects Know Your Mailer can be about. One committee is a
 * set of size one; a person named on committee filings is the set of every
 * committee that names them. `ledger` and `trace` already work over a set, so
 * the same components serve both and the two pages cannot drift apart.
 *
 * "Donors" is the traced answer, not the filed one. A contributor list names
 * whoever wrote the check, and in Florida's transfer layer that is routinely
 * another committee — so the filed list names the next committee to go and
 * read rather than anybody who originated money. The trace follows those
 * transfers to the end. See `src/lib/graph/trace.ts` for the method and its
 * limits.
 */

import { Suspense } from 'react';
import { db } from '@/db';
import { ledger, type LedgerSourceRow } from '@/lib/graph/ledger';
import type { TraceResult } from '@/lib/graph/trace';
import { cachedTrace } from '@/lib/graph/traceCache';
import { formatMoney, formatMoneyFull } from '@/lib/graph/types';

/**
 * Rows shown per list.
 *
 * Both lists run long — a committee funded through the transfer layer traces
 * back to hundreds of originators — and having both on one screen is the point
 * of the page. The captions carry the full count and the full total, so the cap
 * hides rows without hiding money.
 */
const LIST_ROWS = 25;

/** Rows for the committees whose own funding is unknown. */
const DEAD_ENDS = 10;

/** How far the trace chases a chain, and the floor below which a strand is dropped. */
const TRACE = { maxDepth: 12, minDollars: 100, dateOrdered: true };

/**
 * Three tones, and they are three different kinds of money.
 *
 * In and out are the obvious pair. `self` is money that moved between
 * committees in the same set — real, but it neither entered nor left, so it
 * must not read as either. It shares its color with the rows the payments list
 * marks the same way, so the headline figure and its constituent rows are
 * visibly the same fact.
 */
export type Tone = 'in' | 'out' | 'self' | 'flat';

const TONE_TEXT: Record<Tone, string> = {
  in: 'text-emerald-400',
  out: 'text-amber-400',
  self: 'text-indigo-300',
  flat: 'text-slate-400',
};

export function Money({ value, tone }: { value: string | number; tone: Tone }) {
  return (
    <span className={`font-mono tabular-nums ${TONE_TEXT[tone]}`}>{formatMoneyFull(value)}</span>
  );
}

/**
 * A headline figure.
 *
 * The type size comes off the length of the number rather than the viewport:
 * $196,500 and $125,502,148 need different treatment in the same box, and only
 * one of them is knowable from a breakpoint.
 */
const TILE_FRAME: Record<Tone, string> = {
  in: 'border-emerald-900 bg-emerald-950/30',
  out: 'border-slate-800 bg-slate-900/40',
  self: 'border-indigo-900 bg-indigo-950/30',
  flat: 'border-slate-800 bg-slate-900/40',
};

export function Tile({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone: Tone;
  children: React.ReactNode;
}) {
  const text = formatMoneyFull(value);
  const size =
    text.length > 11 ? 'text-lg sm:text-2xl' : text.length > 8 ? 'text-xl sm:text-2xl' : 'text-2xl';

  return (
    <div className={`min-w-0 rounded border p-4 ${TILE_FRAME[tone]}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 font-mono font-semibold tabular-nums ${size} ${TONE_TEXT[tone]}`}>
        {text}
      </div>
      <div className="mt-1 text-xs leading-relaxed text-slate-500">{children}</div>
    </div>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
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
export function Shown({ shown, total, amount }: { shown: number; total: number; amount: number }) {
  return (
    <p className="mt-1 text-xs text-slate-600">
      {shown < total
        ? `showing the largest ${shown.toLocaleString()} of ${total.toLocaleString()}`
        : `${total.toLocaleString()} in total`}
      , {formatMoneyFull(amount)}
    </p>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 rounded border border-slate-800 px-4 py-6 text-sm leading-relaxed text-slate-500">
      {children}
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

  /**
   * Label and figure sit above the bar rather than either side of it.
   *
   * This lives in one of two columns, so its width is roughly half the page
   * and unknown in advance. Fixed-width gutters for a label and a dollar
   * amount would leave the bar itself a stub at the sizes that matter.
   */
  const bar = (label: string, value: number, className: string) =>
    value <= 0 ? null : (
      <div key={label}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] text-slate-500">{label}</span>
          <span className="text-[11px] tabular-nums text-slate-400">
            {formatMoney(value)} · {pct(value).toFixed(0)}%
          </span>
        </div>
        <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-800">
          <div className={`h-full ${className}`} style={{ width: `${pct(value)}%` }} />
        </div>
      </div>
    );

  return (
    <div className="mt-2 space-y-2 rounded border border-slate-800 p-3">
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
 * Where the money originated, past the conduits.
 *
 * Streamed in its own boundary. A trace walks the whole graph and takes a few
 * seconds; holding the rest of the page back for it would leave a reader
 * staring at nothing while the part they can already be shown sits ready.
 */
async function Donors({
  ids,
  subject,
  cycle,
}: {
  ids: string[];
  subject: string;
  cycle?: string;
}) {
  const result = await cachedTrace(db, ids, { ...TRACE, cycle });

  if (result.sources.length === 0 && result.injectionPoints.length === 0) {
    return (
      <Note>
        No originating donors found. Every path back ends at a committee with no recorded money
        coming in.
      </Note>
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
            <em>its</em> money — not of {subject}. The two cannot be multiplied together, because no
            filing says which share of this pool came to Florida.
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

async function Payments({ ids, cycle }: { ids: string[]; cycle?: string }) {
  const result = await ledger(db, ids, {
    view: 'sources',
    direction: 'out',
    sort: 'amount',
    order: 'desc',
    limit: LIST_ROWS,
    offset: 0,
    cycle,
  });
  const rows = result.rows as LedgerSourceRow[];

  if (rows.length === 0) return <Note>No payments out on file.</Note>;

  const internal = Number(result.internalAmount);

  return (
    <div>
      <Shown shown={rows.length} total={result.total} amount={Number(result.totalAmount)} />
      {/* Money moved between committees in the same set is real, but it neither
          entered nor left the set. Naming it keeps the total honest. */}
      {internal > 0 && (
        <p className="text-xs text-slate-600">
          {formatMoneyFull(internal)} of that went to another committee on this page, marked below.
        </p>
      )}
      <ul className="mt-2 divide-y divide-slate-900 rounded border border-slate-800">
        {rows.map((r) => (
          <li key={`${r.entity_id}-${r.flow}`} className="flex items-start gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-200">{r.name}</span>
              <span className="block truncate text-xs text-slate-500">
                {r.is_self && <span className="text-indigo-400">within this network · </span>}
                {r.industry}
              </span>
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

/* -------------------------------------------------------------- the pair */

/**
 * Money in on the left, money out on the right.
 *
 * min-w-0 on the columns is load-bearing: a grid item's automatic minimum size
 * is its content's min-content width, so without it a column refuses to shrink
 * below the longest donor name and the amounts end up off-screen. items-start
 * keeps each column its own height — the donor side runs longer, and stretching
 * the shorter one to match would hang its border in empty space.
 */
export function MoneyColumns({
  ids,
  subject,
  scope,
  cycle,
  paymentsHint,
  originsInstead,
}: {
  ids: string[];
  /** The subject's name, for the sentence about national pools. */
  subject: string;
  /** What period the lists cover, said in the headings. */
  scope: string;
  cycle?: string;
  paymentsHint: string;
  /**
   * Shown in place of the trace, when running one would not answer anything.
   *
   * A person named on two hundred committees is a filing practice rather than
   * a network, and the pooled origins of all of them describe nobody.
   */
  originsInstead?: React.ReactNode;
}) {
  return (
    <section className="mt-8 grid items-start gap-8 md:grid-cols-2">
      <div className="min-w-0">
        <SectionHeading>Donors · {scope}</SectionHeading>
        <p className="mt-1 text-xs text-slate-600">
          Followed past committee-to-committee transfers to whoever originated the money, not
          whoever wrote the check.
        </p>
        {originsInstead ?? (
          <Suspense fallback={<Note>Following the money…</Note>}>
            <Donors ids={ids} subject={subject} cycle={cycle} />
          </Suspense>
        )}
      </div>

      <div className="min-w-0">
        <SectionHeading>Payments out · {scope}</SectionHeading>
        <p className="mt-1 text-xs text-slate-600">{paymentsHint}</p>
        <Suspense fallback={<Note>Reading the ledger…</Note>}>
          <Payments ids={ids} cycle={cycle} />
        </Suspense>
      </div>
    </section>
  );
}
