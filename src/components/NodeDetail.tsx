'use client';

/**
 * Inspector for the selected tile.
 *
 * The ledger below the stats reads from the database, not from the crawl. The
 * graph is always a capped, filtered slice — a candidate with 297 contributors
 * may show one edge in `direct` mode — so the panel has to be able to account
 * for every dollar in the headline totals rather than the handful of edges that
 * happen to be drawn.
 */

import { useMemo, useState } from 'react';
import {
  formatMoney,
  formatMoneyFull,
  kindLabel,
  type GraphNode,
} from '@/lib/graph/types';
import { useTrace, type TraceResult } from '@/lib/graph/useTrace';
import {
  isSourceRow,
  useLedger,
  type LedgerDirection,
  type LedgerRow,
  type LedgerSort,
  type LedgerView,
} from '@/lib/graph/useLedger';

interface Props {
  node: GraphNode | null;
  /** Nodes currently drawn, so the panel can mark which rows are on the canvas. */
  nodes: Map<string, GraphNode>;
  onFocus: (nodeId: string) => void;
  onRecenter: (nodeId: string) => void;
  /** Election cycle the graph is filtered to, or undefined for all. */
  cycle?: string;
}

const DIRECTIONS: { value: LedgerDirection; label: string }[] = [
  { value: 'in', label: 'Money in' },
  { value: 'out', label: 'Money out' },
  { value: 'all', label: 'Both' },
];

type PanelMode = 'sources' | 'transactions' | 'origins';

const PANEL_MODES: { value: PanelMode; label: string; hint: string }[] = [
  { value: 'sources', label: 'By counterparty', hint: 'One row per counterparty, aggregated.' },
  { value: 'transactions', label: 'Every transaction', hint: 'One row per reported line item.' },
  {
    value: 'origins',
    label: 'Funding origins',
    hint: 'Follow the money past committee-to-committee transfers to whoever originated it.',
  },
];

export default function NodeDetail({ node, nodes, onFocus, onRecenter, cycle }: Props) {
  const [mode, setMode] = useState<PanelMode>('sources');
  const [direction, setDirection] = useState<LedgerDirection>('in');
  const [sort, setSort] = useState<LedgerSort>('amount');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [dateOrdered, setDateOrdered] = useState(true);

  // The origins tab is a different question over the same entity, so the ledger
  // keeps its last view rather than being torn down and refetched on return.
  const view: LedgerView = mode === 'origins' ? 'sources' : mode;
  const showLedger = mode !== 'origins';

  const query = useMemo(
    () => ({ view, direction, q, sort, cycle }),
    [view, direction, q, sort, cycle],
  );
  const ledger = useLedger(node?.id ?? null, query);
  const traceQuery = useMemo(
    () => ({ depth: 12, min: 100, dateOrdered, cycle }),
    [dateOrdered, cycle],
  );
  const traced = useTrace(node?.id ?? null, traceQuery, mode === 'origins');

  if (!node) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Select a tile to inspect it. Double-click a tile to re-center the crawl there.
      </div>
    );
  }

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await ledger.fetchAll();
      const header = isSourceRow(all[0] ?? ({} as LedgerRow))
        ? ['counterparty', 'kind', 'direction', 'amount', 'transactions', 'first_date', 'last_date']
        : [
            'date',
            'direction',
            'counterparty',
            'amount',
            'type',
            'occupation',
            'address',
            'city',
            'state',
            'zip',
            'source',
          ];

      const lines = all.map((r) =>
        isSourceRow(r)
          ? [r.name, r.kind, r.flow, r.amount, r.txn_count, r.first_date ?? '', r.last_date ?? '']
          : [
              r.txn_date ?? '',
              r.flow,
              r.counterparty_name,
              r.amount,
              r.txn_type_code ?? '',
              r.occupation ?? '',
              r.address ?? '',
              r.city ?? '',
              r.state_code ?? '',
              // Quoted by the writer below, so ZIP+4 and leading zeros survive.
              r.zip ?? '',
              r.source_key ?? '',
            ],
      );

      const csv = [header, ...lines]
        .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${node.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${view}-${direction}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* ------------------------------------------------------------ header */}
      <div className="shrink-0 space-y-3 border-b border-slate-800 p-4">
        <div>
          <h3 className="text-sm font-semibold leading-snug text-slate-100">{node.name}</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {kindLabel(node)}
            {node.office && ` · ${node.office}`}
            {node.status === 'closed' && ' · closed'}
            {node.city && ` · ${node.city}, ${node.stateCode ?? ''}`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('in')}
            className={`rounded border p-2 text-left transition ${
              direction === 'in'
                ? 'border-emerald-600 bg-emerald-950/40'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Received</div>
            <div className="text-sm font-semibold text-emerald-400">
              {formatMoneyFull(node.totalReceived)}
            </div>
            <div className="text-[10px] text-slate-500">{node.inDegree} sources</div>
          </button>
          <button
            type="button"
            onClick={() => setDirection('out')}
            className={`rounded border p-2 text-left transition ${
              direction === 'out'
                ? 'border-amber-600 bg-amber-950/40'
                : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Given</div>
            <div className="text-sm font-semibold text-amber-400">
              {formatMoneyFull(node.totalGiven)}
            </div>
            <div className="text-[10px] text-slate-500">{node.outDegree} recipients</div>
          </button>
        </div>

        <button
          type="button"
          onClick={() => onRecenter(node.id)}
          className="w-full rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white
                     hover:bg-indigo-500"
        >
          Re-center crawl here
        </button>
      </div>

      {/* ------------------------------------------------------------ controls */}
      <div className="shrink-0 space-y-2 border-b border-slate-800 p-3">
        <div className="grid grid-cols-3 gap-1">
          {DIRECTIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDirection(d.value)}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                direction === d.value
                  ? 'bg-slate-700 text-slate-100'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-1">
          {PANEL_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              title={m.hint}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                mode === m.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {showLedger && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name…"
          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs
                     text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
        />
        )}

        {showLedger && (
        <div className="flex items-center justify-between gap-2">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as LedgerSort)}
            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px]
                       text-slate-300 outline-none focus:border-indigo-500"
          >
            <option value="amount">Largest first</option>
            <option value="date">Most recent</option>
            <option value="name">Name A–Z</option>
            {view === 'sources' && <option value="count">Most transactions</option>}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || ledger.total === 0}
            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300
                       hover:bg-slate-800 disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
        )}

        {/* Reconciles against the tile totals above. */}
        {showLedger && (
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-slate-400">
            {ledger.total.toLocaleString()}{' '}
            {view === 'sources'
              ? direction === 'out'
                ? 'recipients'
                : 'counterparties'
              : 'transactions'}
            {q && ' matching'}
          </span>
          <span
            className={
              direction === 'out'
                ? 'font-semibold text-amber-400'
                : direction === 'in'
                  ? 'font-semibold text-emerald-400'
                  : 'font-semibold text-slate-300'
            }
          >
            {formatMoneyFull(ledger.totalAmount)}
          </span>
        </div>
        )}
      </div>

      {/* ------------------------------------------------------------ rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!showLedger && (
          <OriginsReport
            state={traced}
            dateOrdered={dateOrdered}
            onToggleDateOrdered={() => setDateOrdered((v) => !v)}
            onFocus={onFocus}
            nodes={nodes}
          />
        )}

        {showLedger && (<>
        {ledger.error && <p className="p-3 text-xs text-red-400">{ledger.error}</p>}

        {!ledger.loading && ledger.rows.length === 0 && (
          <p className="p-3 text-xs text-slate-600">
            {q ? 'No matches.' : 'Nothing recorded in this direction.'}
          </p>
        )}

        <ul className="divide-y divide-slate-800/60">
          {ledger.rows.map((r) => (
            <LedgerRowItem
              key={isSourceRow(r) ? `${r.entity_id}-${r.flow}` : r.id}
              row={r}
              onFocus={onFocus}
              inGraph={isSourceRow(r) ? nodes.has(r.entity_id) : false}
            />
          ))}
        </ul>

        {ledger.hasMore && (
          <button
            type="button"
            onClick={ledger.loadMore}
            disabled={ledger.loading}
            className="w-full py-2 text-xs text-indigo-400 hover:bg-slate-900 disabled:opacity-50"
          >
            {ledger.loading
              ? 'Loading…'
              : `Load ${Math.min(100, ledger.total - ledger.rows.length)} more of ${ledger.total.toLocaleString()}`}
          </button>
        )}

        {ledger.loading && ledger.rows.length === 0 && (
          <p className="p-3 text-xs text-slate-500">Loading…</p>
        )}
        </>)}
      </div>
    </div>
  );
}

/**
 * Where this entity's money came from, past the conduits.
 *
 * Presented apart from the ledger because it answers a different question. The
 * ledger says who wrote the cheque; for a committee funded by other committees
 * that is routinely not who paid. The unresolved and dispersed figures are
 * shown alongside the sources on purpose — a list of origins accounting for a
 * quarter of the money reads as an answer unless the rest is on screen too.
 */
function OriginsReport({
  state,
  dateOrdered,
  onToggleDateOrdered,
  onFocus,
  nodes,
}: {
  state: { result: TraceResult | null; loading: boolean; error: string | null };
  dateOrdered: boolean;
  onToggleDateOrdered: () => void;
  onFocus: (nodeId: string) => void;
  nodes: Map<string, GraphNode>;
}) {
  if (state.error) return <p className="p-3 text-xs text-red-400">{state.error}</p>;
  if (state.loading && !state.result) {
    return <p className="p-3 text-xs text-slate-500">Following the money…</p>;
  }
  if (!state.result) return null;

  const r = state.result;
  const attributed = r.sources.reduce((a, b) => a + b.amount, 0);
  const viaPools = r.injectionPoints.reduce((a, b) => a + b.amount, 0);
  const unresolved = r.unresolved.reduce((a, b) => a + b.amount, 0);
  const pct = (n: number) => (r.seed.total > 0 ? (n / r.seed.total) * 100 : 0);

  const bar = (label: string, value: number, className: string) => (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[10px] text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${className}`} style={{ width: `${pct(value)}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[10px] tabular-nums text-slate-400">
        {formatMoney(String(value))} · {pct(value).toFixed(0)}%
      </span>
    </div>
  );

  return (
    <div>
      <div className="space-y-2 border-b border-slate-800 p-3">
        <div className="space-y-1">
          {bar('Traced', attributed, 'bg-emerald-500')}
          {viaPools > 0 && bar('National pool', viaPools, 'bg-sky-500')}
          {bar('Unresolved', unresolved, 'bg-slate-500')}
          {bar('Long tail', r.dispersed, 'bg-slate-700')}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={dateOrdered}
            onChange={onToggleDateOrdered}
            className="accent-indigo-500"
          />
          Only credit money a conduit held before it paid out
        </label>
        <p className="text-[10px] leading-relaxed text-slate-600">
          Pro-rata across {r.hops} hops: what share of the pool each source funded, not the route a
          particular dollar took.
          {r.truncated && ' Hit the strand ceiling — some paths folded into the long tail.'}
        </p>
      </div>

      {r.sources.length === 0 && (
        <p className="p-3 text-xs text-slate-600">
          No originating sources found. Every path ends at a committee with no recorded upstream.
        </p>
      )}

      <ul className="divide-y divide-slate-800/60">
        {r.sources.map((s) => (
          <li key={s.id} className="hover:bg-slate-800/50">
            <button
              type="button"
              onClick={() => onFocus(s.id)}
              className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-slate-200">{s.name}</span>
                  {nodes.has(s.id) && (
                    <span className="shrink-0 text-[9px] text-indigo-400" title="On the canvas">
                      ●
                    </span>
                  )}
                </span>
                <span className="block truncate text-[10px] text-slate-500">
                  {s.kind} · {s.hop} hop{s.hop === 1 ? '' : 's'} away
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-xs font-medium tabular-nums text-emerald-400">
                  {formatMoney(String(s.amount))}
                </span>
                <span className="block text-[10px] tabular-nums text-slate-500">
                  {(s.share * 100).toFixed(1)}%
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {r.injectionPoints.map((p) => (
        <div key={p.id} className="border-t border-sky-900/60 bg-sky-950/20">
          <div className="px-3 pb-1 pt-2">
            <p className="text-[10px] uppercase tracking-wide text-sky-400">
              Entered Florida through a national pool
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <button
                type="button"
                onClick={() => onFocus(p.id)}
                className="min-w-0 flex-1 truncate text-left text-xs text-slate-200 hover:underline"
              >
                {p.name}
              </button>
              <span className="shrink-0 text-xs font-medium tabular-nums text-sky-300">
                {formatMoney(String(p.amount))} · {(p.share * 100).toFixed(1)}%
              </span>
            </div>
            {/* Shares are of the pool, never of the seed: how much of this
                pool reached Florida is not disclosed anywhere. */}
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Raised nationally and spent across many states. Its own funders are below, as
              shares of <em>its</em> money — not of {r.seed.name}. The two cannot be multiplied
              together, because no filing says which share of this pool came to Florida.
            </p>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {p.funders.map((f) => (
              <li key={f.id} className="hover:bg-slate-800/50">
                <button
                  type="button"
                  onClick={() => onFocus(f.id)}
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                    {formatMoney(String(f.amount))}
                  </span>
                  <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                    {(f.share * 100).toFixed(1)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {r.unresolved.length > 0 && (
        <div className="border-t border-slate-800">
          <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-slate-500">
            Trail ends here
          </p>
          <ul className="divide-y divide-slate-800/60">
            {r.unresolved.map((s) => (
              <li key={s.id} className="hover:bg-slate-800/50">
                <button
                  type="button"
                  onClick={() => onFocus(s.id)}
                  className="flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-slate-300">{s.name}</span>
                    <span className="block truncate text-[10px] text-slate-600">
                      no recorded upstream in this data
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs font-medium tabular-nums text-slate-400">
                      {formatMoney(String(s.amount))}
                    </span>
                    <span className="block text-[10px] tabular-nums text-slate-600">
                      {(s.share * 100).toFixed(1)}%
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Assemble a contributor's mailing address from the parts the state reports.
 *
 * Every part is independently optional — plenty of rows have a city and no
 * street, and a few have neither — so this drops empties rather than emitting
 * stray commas.
 */
function formatAddress(row: LedgerRow): string {
  if (isSourceRow(row)) return '';
  const cityState = [row.city, [row.state_code, row.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [row.address, cityState].filter(Boolean).join(' · ');
}

function LedgerRowItem({
  row,
  onFocus,
  inGraph,
}: {
  row: LedgerRow;
  onFocus: (nodeId: string) => void;
  inGraph: boolean;
}) {
  const source = isSourceRow(row);
  const name = source ? row.name : row.counterparty_name;
  const amountColor = row.flow === 'in' ? 'text-emerald-400' : 'text-amber-400';

  const body = (
    <div className="flex items-start justify-between gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-slate-200">{name}</span>
          {source && row.is_self && (
            <span className="shrink-0 rounded bg-slate-800 px-1 text-[9px] text-slate-400">
              self
            </span>
          )}
          {inGraph && (
            <span
              className="shrink-0 text-[9px] text-indigo-400"
              title="Currently drawn on the canvas"
            >
              ●
            </span>
          )}
        </span>
        <span className="block truncate text-[10px] text-slate-500">
          {source
            ? `${row.kind}${row.txn_count > 1 ? ` · ${row.txn_count} transactions` : ''}${
                row.last_date ? ` · ${row.last_date}` : ''
              }`
            : [row.txn_date, row.txn_type_code, row.occupation].filter(Boolean).join(' · ')}
        </span>
        {/* The mailing address earns its own line: on one line it pushed the
            date and occupation out of a row this narrow. */}
        {!source && formatAddress(row) && (
          <span className="block truncate text-[10px] text-slate-600" title={formatAddress(row)}>
            {formatAddress(row)}
          </span>
        )}
      </span>
      <span className={`shrink-0 text-xs font-medium tabular-nums ${amountColor}`}>
        {row.flow === 'out' ? '−' : ''}
        {formatMoney(row.amount)}
      </span>
    </div>
  );

  // Counterparty rows navigate; individual transactions are not themselves nodes.
  return (
    <li className="hover:bg-slate-800/50">
      {source ? (
        <button type="button" onClick={() => onFocus(row.entity_id)} className="w-full text-left">
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}
